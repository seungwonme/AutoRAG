import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type DecideStarOptions,
	decideStar,
	type PrepareStarOptions,
	prepareStar,
	STAR_REPOSITORY,
	STAR_URL,
	type StarChoice,
	type StarDependencies,
	type StarRuntime,
} from "../../src/star.ts";

type GhResponse = { status: number; stdout: string; stderr: string };
const AUTH_ARGS = ["auth", "status", "--hostname", "github.com"];
const TOKEN_ARGS = ["auth", "token", "--hostname", "github.com"];
const USER_ARGS = ["api", "--hostname", "github.com", "/user"];
const ENDPOINT = `/user/starred/${STAR_REPOSITORY}`;
const TIME = "2026-10-26T21:20:00.000Z";
const roots: string[] = [];

function http(status: number, exitStatus = status >= 400 ? 1 : 0): GhResponse {
	return { status: exitStatus, stdout: `HTTP/2.0 ${status} Status\r\nContent-Length: 0\r\n\r\n`, stderr: "" };
}

function harness() {
	const root = mkdtempSync(join(tmpdir(), "autorag-star-"));
	roots.push(root);
	const home = join(root, "home");
	const path = join(home, "star-state.json");
	const behavior = {
		account: { id: 1234, login: "actual-user" },
		auth: { status: 0, stdout: "", stderr: "" } as GhResponse,
		token: { status: 0, stdout: "fixture-token\n", stderr: "" } as GhResponse | Error,
		get: http(404) as GhResponse | Error,
		put: http(204) as GhResponse | Error,
	};
	const gh = vi.fn(async (args: readonly string[], _env?: NodeJS.ProcessEnv): Promise<GhResponse> => {
		if (JSON.stringify(args) === JSON.stringify(AUTH_ARGS)) return behavior.auth;
		if (JSON.stringify(args) === JSON.stringify(TOKEN_ARGS)) {
			if (behavior.token instanceof Error) throw behavior.token;
			return behavior.token;
		}
		if (JSON.stringify(args) === JSON.stringify(USER_ARGS)) {
			return { status: 0, stdout: JSON.stringify(behavior.account), stderr: "" };
		}
		const method = args[args.indexOf("--method") + 1];
		if (args[0] !== "api" || args.at(-1) !== ENDPOINT || (method !== "GET" && method !== "PUT")) {
			throw new Error(`Unexpected mock gh arguments: ${JSON.stringify(args)}`);
		}
		const response = method === "GET" ? behavior.get : behavior.put;
		if (response instanceof Error) throw response;
		return response;
	});
	const deps: StarDependencies = {
		env: { AUTORAG_HOME: home },
		now: () => new Date(TIME),
		uuid: () => "offer-1234",
		gh,
	};
	const runtime: StarRuntime = { host: "codex", interactive: true, questionTool: "request_user_input" };
	const prepare = () => prepareStar({ runtime, completed: "setup" }, deps);
	const decide = (choice: StarChoice = "star", extra: Partial<DecideStarOptions> = {}) =>
		decideStar(
			{ offerId: "offer-1234", choice, questionTool: runtime.questionTool, questionId: "native-result-1", ...extra },
			deps,
		);
	const state = () => JSON.parse(readFileSync(path, "utf8"));
	const puts = () => gh.mock.calls.filter(([args]) => args.includes("PUT"));
	return { root, home, path, behavior, gh, deps, runtime, prepare, decide, state, puts };
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("prepareStar", () => {
	it.each([
		{ host: "codex", interactive: false, questionTool: "request_user_input" },
		{ host: "codex", interactive: true },
		{ host: "codex", interactive: true, questionTool: "" },
		{ host: "codex", interactive: true, questionTool: "  " },
		{ host: "codex", interactive: true, questionTool: "shell\nquestion" },
	] as StarRuntime[])("does not touch gh or state without a usable native question: %o", async (runtime) => {
		const h = harness();
		expect(await prepareStar({ runtime, completed: "setup" }, h.deps)).toMatchObject({
			action: "skip",
			reason: "native_question_unavailable",
		});
		expect(h.gh).not.toHaveBeenCalled();
		expect(existsSync(h.home)).toBe(false);
	});

	it.each([
		{},
		{ completed: "install" },
		{ runtime: { host: "other", interactive: true, questionTool: "ask" }, completed: "setup" },
	])("rejects incomplete or invalid scope %o", async (options) => {
		const h = harness();
		expect(await prepareStar(options as PrepareStarOptions, h.deps)).toMatchObject({
			action: "skip",
			reason: "incomplete_scope",
		});
		expect(h.gh).not.toHaveBeenCalled();
		expect(existsSync(h.home)).toBe(false);
	});

	it.each([
		"CI",
		"GITHUB_ACTIONS",
		"GITLAB_CI",
		"CIRCLECI",
		"TRAVIS",
		"BUILDKITE",
		"TF_BUILD",
		"JENKINS_URL",
		"TEAMCITY_VERSION",
		"AUTORAG_NO_STAR",
	])("fails closed with %s even when its value is false", async (key) => {
		const h = harness();
		h.deps.env = { AUTORAG_HOME: h.home, [key]: "false" };
		expect((await h.prepare()).action).toBe("skip");
		expect(h.gh).not.toHaveBeenCalled();
		expect(existsSync(h.home)).toBe(false);
	});

	it("skips a confirmed HTTP 204 already-starred account without an offer", async () => {
		const h = harness();
		h.behavior.get = http(204);
		expect(await h.prepare()).toMatchObject({ action: "skip", reason: "already_starred", account: "actual-user" });
		expect(existsSync(h.path)).toBe(false);
		expect(h.puts()).toHaveLength(0);
	});

	it.each([
		http(401),
		http(403),
		http(429),
		http(500),
		http(200),
		http(302),
		http(404, 0),
		http(404, 2),
		http(204, 1),
		{ status: 1, stdout: "", stderr: "HTTP 404: Not Found" },
		{ status: 0, stdout: "404", stderr: "" },
		{ status: 0, stdout: "HTTP/2.0 404 Status\n", stderr: "" },
		{ status: 1, stdout: "HTTP/2.0 404 Status\n\nHTTP/2.0 200 Status\n\n", stderr: "" },
		new Error("timeout"),
	])("does not offer on unknown, failed or ambiguous star status %o", async (response) => {
		const h = harness();
		h.behavior.get = response;
		expect(await h.prepare()).toMatchObject({ action: "skip", reason: "star_status_unknown" });
		expect(existsSync(h.path)).toBe(false);
		expect(h.puts()).toHaveLength(0);
	});

	it("records the exact account and attempt before returning a neutral native question", async () => {
		const h = harness();
		const offer = await h.prepare();
		expect(offer).toMatchObject({
			action: "ask",
			repository: STAR_REPOSITORY,
			url: STAR_URL,
			offerId: "offer-1234",
			questionTool: "request_user_input",
			account: "actual-user",
			choices: ["Star repository", "No thanks", "Show link only"],
		});
		expect(offer.question).toContain("actual-user");
		expect(offer.question).toContain(STAR_REPOSITORY);
		expect(offer.question).toContain(`[offer:${offer.offerId}]`);
		expect(h.state()).toEqual({
			version: 1,
			record: {
				repository: STAR_REPOSITORY,
				offerId: "offer-1234",
				host: "codex",
				questionTool: "request_user_input",
				account: { id: 1234, login: "actual-user" },
				attemptedAt: TIME,
				outcome: "attempted",
			},
		});
		expect(h.gh.mock.calls.map(([args]) => args)).toEqual([
			AUTH_ARGS,
			TOKEN_ARGS,
			USER_ARGS,
			["api", "--hostname", "github.com", "--include", "--method", "GET", ENDPOINT],
		]);
		expect(h.puts()).toHaveLength(0);
		if (process.platform !== "win32") {
			expect(statSync(h.home).mode & 0o777).toBe(0o700);
			expect(statSync(h.path).mode & 0o777).toBe(0o600);
		}
		expect(readdirSync(h.home)).toEqual(["star-state.json"]);
	});

	it("suppresses another host using the same home before checking gh", async () => {
		const h = harness();
		await h.prepare();
		h.gh.mockClear();
		expect(
			await prepareStar(
				{ completed: "search", runtime: { host: "cursor", interactive: true, questionTool: "ask_question" } },
				h.deps,
			),
		).toMatchObject({ action: "skip", reason: "already_attempted" });
		expect(h.gh).not.toHaveBeenCalled();
	});

	it.each(["missing-gh", "auth-failed", "invalid-user"])("returns only a manual link for %s", async (failure) => {
		const h = harness();
		if (failure === "missing-gh") h.gh.mockRejectedValue(new Error("ENOENT"));
		if (failure === "auth-failed") h.behavior.auth = { status: 1, stdout: "", stderr: "not logged in" };
		if (failure === "invalid-user")
			h.gh.mockImplementation(async (args) =>
				args[0] === "auth"
					? { status: 0, stdout: args[1] === "token" ? "fixture-token\n" : "", stderr: "" }
					: { status: 0, stdout: '{"id": "1234", "login": "other"}', stderr: "" },
			);
		const answer = await h.prepare();
		expect(answer).toMatchObject({ action: "link_only", url: STAR_URL });
		expect(answer.diagnostic).toContain(STAR_URL);
		expect(answer.diagnostic).not.toContain("gh auth login");
		expect(answer.offerId).toBeUndefined();
		expect(answer.question).toBeUndefined();
		expect(existsSync(h.path)).toBe(false);
		expect(h.puts()).toHaveLength(0);
	});

	it.each([
		{ status: 1, stdout: "fixture-token", stderr: "fixture-token unavailable" },
		{ status: 0, stdout: "\n", stderr: "" },
		{ status: 0, stdout: "fixture-token\ninjected-token", stderr: "" },
		new Error("fixture-token snapshot failed"),
	])("fails closed without leaking a failed credential snapshot %o", async (token) => {
		const h = harness();
		h.behavior.token = token;
		const answer = await h.prepare();
		expect(answer.action).toBe("link_only");
		expect(JSON.stringify(answer)).not.toContain("fixture-token");
		expect(h.gh.mock.calls.map(([args]) => args)).toEqual([AUTH_ARGS, TOKEN_ARGS]);
		expect(existsSync(h.path)).toBe(false);
		expect(h.puts()).toHaveLength(0);
	});

	it("returns no offer for oversized gh output", async () => {
		const h = harness();
		h.behavior.get = { status: 1, stdout: `HTTP/2.0 404 Status\n\n${"x".repeat(65536)}`, stderr: "" };
		expect((await h.prepare()).action).toBe("skip");
		expect(existsSync(h.path)).toBe(false);
	});

	it.each(["{", '{"version": 2}', '{"version": 1, "record": {}}', '{"version": 1, "record": null}'])(
		"does not overwrite corrupt or unknown state %s",
		async (contents) => {
			const h = harness();
			mkdirSync(h.home);
			writeFileSync(h.path, contents);
			expect((await h.prepare()).action).toBe("error");
			expect(readFileSync(h.path, "utf8")).toBe(contents);
			expect(h.gh).not.toHaveBeenCalled();
		},
	);

	it.each(["symlink", "directory"])("rejects a %s state path without altering it", async (kind) => {
		const h = harness();
		mkdirSync(h.home);
		const target = join(h.root, "target.json");
		writeFileSync(target, "untouched");
		if (kind === "symlink") symlinkSync(target, h.path);
		else mkdirSync(h.path);
		expect((await h.prepare()).action).toBe("error");
		expect(readFileSync(target, "utf8")).toBe("untouched");
		expect(kind === "symlink" ? lstatSync(h.path).isSymbolicLink() : lstatSync(h.path).isDirectory()).toBe(true);
		expect(h.gh).not.toHaveBeenCalled();
	});

	it("fails without asking when the parent cannot be created", async () => {
		const h = harness();
		writeFileSync(h.home, "not a directory");
		expect((await h.prepare()).action).toBe("error");
		expect(h.gh).not.toHaveBeenCalled();
		expect(readFileSync(h.home, "utf8")).toBe("not a directory");
	});

	it("never overwrites a state path that becomes unsafe before an offer can be persisted", async () => {
		const h = harness();
		h.gh.mockImplementation(async (args) => {
			if (args[1] === "token") return { status: 0, stdout: "fixture-token\n", stderr: "" };
			if (args[0] === "auth") return h.behavior.auth;
			if (args.at(-1) === "/user") return { status: 0, stdout: JSON.stringify(h.behavior.account), stderr: "" };
			mkdirSync(h.path);
			return http(404);
		});
		expect((await h.prepare()).action).toBe("error");
		expect(lstatSync(h.path).isDirectory()).toBe(true);
		expect(h.puts()).toHaveLength(0);
	});

	it("allows at most one ask from concurrent prepares", async () => {
		const h = harness();
		const results = await Promise.all([h.prepare(), h.prepare()]);
		expect(results.filter((item) => item.action === "ask")).toHaveLength(1);
		expect(results.filter((item) => item.reason === "already_attempted")).toHaveLength(1);
		expect(h.state().record.outcome).toBe("attempted");
		expect(h.puts()).toHaveLength(0);
	});
});

describe("decideStar", () => {
	it.each([
		["no", "declined"],
		["dismiss", "dismissed"],
		["link", "link"],
	] as const)("persists %s as %s without any gh call", async (choice, action) => {
		const h = harness();
		await h.prepare();
		h.gh.mockClear();
		expect(await h.decide(choice)).toMatchObject({ action, offerId: "offer-1234" });
		expect(h.state().record).toMatchObject({
			outcome: action,
			decision: choice,
			questionId: "native-result-1",
			decidedAt: TIME,
			completedAt: TIME,
		});
		expect(h.gh).not.toHaveBeenCalled();
		expect((await h.decide()).reason).toBe("already_answered");
		expect((await h.prepare()).reason).toBe("already_attempted");
		expect(h.gh).not.toHaveBeenCalled();
	});

	it.each(["yes", "Star repository", "", null, 1, {}, ["star"]].map((choice) => ({ choice })))(
		"rejects malformed choices without consuming consent %o",
		async ({ choice }) => {
			const h = harness();
			await h.prepare();
			h.gh.mockClear();
			expect(await h.decide(choice as StarChoice)).toMatchObject({ action: "skip", reason: "invalid_choice" });
			expect(h.state().record.outcome).toBe("attempted");
			expect(h.gh).not.toHaveBeenCalled();
		},
	);

	it.each(["star", "no", "dismiss", "link"] as const)(
		"requires a completed native result and matching tool for %s",
		async (choice) => {
			const h = harness();
			await h.prepare();
			h.gh.mockClear();
			for (const extra of [
				{ questionId: undefined },
				{ questionId: "" },
				{ questionId: "  " },
				{ questionId: "bad\nresult" },
				{ questionTool: undefined },
			]) {
				expect(await h.decide(choice, extra)).toMatchObject({ action: "skip", reason: "native_result_required" });
			}
			expect(await h.decide(choice, { offerId: "other-offer" })).toMatchObject({
				action: "skip",
				reason: "offer_mismatch",
			});
			expect(await h.decide(choice, { questionTool: "other-native-tool" })).toMatchObject({
				action: "skip",
				reason: "question_tool_mismatch",
			});
			expect(h.state().record.outcome).toBe("attempted");
			expect(h.gh).not.toHaveBeenCalled();
		},
	);

	it("does not manufacture consent when no offer exists", async () => {
		const h = harness();
		expect(await h.decide()).toMatchObject({ action: "skip", reason: "offer_mismatch" });
		expect(existsSync(h.path)).toBe(false);
		expect(h.gh).not.toHaveBeenCalled();
	});

	it("consumes consent before account verification and sends exactly one empty-body PUT", async () => {
		const h = harness();
		await h.prepare();
		h.gh.mockClear();
		h.gh.mockImplementation(async (args) => {
			expect(h.state().record).toMatchObject({
				outcome: "consumed",
				decision: "star",
				questionId: "native-result-1",
			});
			if (args[1] === "token") return { status: 0, stdout: "fixture-token\n", stderr: "" };
			if (args[0] === "auth") return h.behavior.auth;
			if (args.at(-1) === "/user") return { status: 0, stdout: JSON.stringify(h.behavior.account), stderr: "" };
			return http(204);
		});
		expect(await h.decide()).toMatchObject({
			action: "starred",
			repository: STAR_REPOSITORY,
			account: "actual-user",
		});
		expect(h.gh.mock.calls.map(([args]) => args)).toEqual([
			AUTH_ARGS,
			TOKEN_ARGS,
			USER_ARGS,
			["api", "--hostname", "github.com", "--include", "--method", "PUT", ENDPOINT],
		]);
		expect(h.state().record).toMatchObject({ outcome: "starred", decidedAt: TIME, completedAt: TIME });
		expect(await h.decide()).toMatchObject({ action: "skip", reason: "already_answered" });
		expect(h.puts()).toHaveLength(1);
	});

	it("pins API credentials across default-auth switches and refreshes the pin for decide", async () => {
		const h = harness();
		const originalEnv = {
			AUTORAG_HOME: h.home,
			GH_TOKEN: "fixture-inherited-token",
			GITHUB_TOKEN: "fixture-conflicting-token",
			GH_DEBUG: "api",
		};
		h.deps.env = originalEnv;
		let defaultToken = "fixture-prepare-token";
		let putAccount: number | undefined;
		const apiTokens: string[] = [];
		h.gh.mockImplementation(async (args, childEnv) => {
			expect(childEnv?.GH_DEBUG).toBeUndefined();
			if (args[0] === "auth" && args[1] === "status") return h.behavior.auth;
			if (args[0] === "auth" && args[1] === "token") {
				if (defaultToken === "fixture-decide-token") expect(h.state().record.outcome).toBe("consumed");
				return { status: 0, stdout: `${defaultToken}\n`, stderr: "" };
			}
			expect(childEnv?.GITHUB_TOKEN).toBeUndefined();
			const token = childEnv?.GH_TOKEN ?? defaultToken;
			apiTokens.push(token);
			const id = token === "fixture-switched-token" ? 9876 : 1234;
			if (args.at(-1) === "/user") {
				// A normal gh auth switch immediately after verification must not redirect the request.
				defaultToken = "fixture-switched-token";
				return {
					status: 0,
					stdout: JSON.stringify({ id, login: id === 1234 ? "actual-user" : "other-user" }),
					stderr: "",
				};
			}
			if (args.includes("GET")) return http(404);
			expect(h.state().record.outcome).toBe("consumed");
			putAccount = id;
			return http(204);
		});
		const offer = await h.prepare();
		expect(offer.action).toBe("ask");
		defaultToken = "fixture-decide-token";
		const answer = await h.decide();
		expect(answer.action).toBe("starred");
		expect(putAccount).toBe(1234);
		expect(apiTokens).toEqual([
			"fixture-prepare-token",
			"fixture-prepare-token",
			"fixture-decide-token",
			"fixture-decide-token",
		]);
		expect(h.gh.mock.calls.filter(([args]) => args[1] === "token")).toHaveLength(2);
		expect(await h.decide()).toMatchObject({ action: "skip", reason: "already_answered" });
		expect(h.puts()).toHaveLength(1);
		expect(originalEnv.GH_TOKEN).toBe("fixture-inherited-token");
		expect(originalEnv.GITHUB_TOKEN).toBe("fixture-conflicting-token");
		expect(originalEnv.GH_DEBUG).toBe("api");
		expect(JSON.stringify([offer, answer])).not.toContain("fixture-");
		expect(readFileSync(h.path, "utf8")).not.toContain("fixture-");
		expect(h.gh.mock.calls.every(([args]) => !args.some((arg) => arg.includes("fixture-")))).toBe(true);
	});

	it("allows only one PUT from concurrent decisions", async () => {
		const h = harness();
		await h.prepare();
		const results = await Promise.all([h.decide(), h.decide()]);
		expect(results.filter((item) => item.action === "starred")).toHaveLength(1);
		expect(results.filter((item) => item.reason === "already_answered")).toHaveLength(1);
		expect(h.puts()).toHaveLength(1);
	});

	it("aborts an account switch durably even if the login still matches", async () => {
		const h = harness();
		await h.prepare();
		h.behavior.account = { id: 9876, login: "actual-user" };
		expect(await h.decide()).toMatchObject({ action: "error", reason: "consent_consumed" });
		expect(h.state().record.outcome).toBe("error");
		h.behavior.account = { id: 1234, login: "actual-user" };
		expect((await h.decide()).reason).toBe("already_answered");
		expect(h.puts()).toHaveLength(0);
	});

	it.each([
		{ status: 1, stdout: "fixture-token", stderr: "fixture-token unavailable" },
		{ status: 0, stdout: "", stderr: "" },
		new Error("fixture-token snapshot failed"),
	])("consumes approval without PUT or credential disclosure when pinning fails %o", async (token) => {
		const h = harness();
		await h.prepare();
		h.gh.mockClear();
		h.behavior.token = token;
		const answer = await h.decide();
		expect(answer).toMatchObject({ action: "error", reason: "consent_consumed" });
		expect(h.state().record.outcome).toBe("error");
		expect(JSON.stringify(answer)).not.toContain("fixture-token");
		expect(h.gh.mock.calls.map(([args]) => args)).toEqual([AUTH_ARGS, TOKEN_ARGS]);
		expect((await h.decide()).reason).toBe("already_answered");
		expect(h.puts()).toHaveLength(0);
	});

	it.each(["auth", "timeout", "invalid-user"])(
		"consumes without PUT when account recheck fails: %s",
		async (failure) => {
			const h = harness();
			await h.prepare();
			if (failure === "auth") h.behavior.auth = { status: 1, stdout: "", stderr: "auth expired" };
			if (failure === "timeout") h.gh.mockRejectedValue(new Error("timeout"));
			if (failure === "invalid-user") h.behavior.account = { id: 0, login: "invalid" };
			expect((await h.decide()).action).toBe("error");
			expect(h.state().record.outcome).toBe("error");
			expect((await h.decide()).reason).toBe("already_answered");
			expect(h.puts()).toHaveLength(0);
		},
	);

	it.each(["CI", "AUTORAG_NO_STAR"])("consumes without gh when %s appears after the offer", async (key) => {
		const h = harness();
		await h.prepare();
		h.gh.mockClear();
		h.deps.env = { AUTORAG_HOME: h.home, [key]: "1" };
		expect(await h.decide()).toMatchObject({ action: "error", reason: "consent_consumed" });
		expect(h.state().record.outcome).toBe("error");
		expect(h.gh).not.toHaveBeenCalled();
	});

	it.each([
		http(401),
		http(403),
		http(429),
		http(500),
		http(200),
		http(204, 1),
		{ status: 0, stdout: "", stderr: "" },
		new Error("timeout"),
	])("does not retry a failed or ambiguous PUT %o", async (response) => {
		const h = harness();
		await h.prepare();
		h.behavior.put = response;
		expect(await h.decide()).toMatchObject({ action: "error", reason: "consent_consumed" });
		expect(h.state().record.outcome).toBe("error");
		expect((await h.decide()).reason).toBe("already_answered");
		expect((await h.prepare()).reason).toBe("already_attempted");
		expect(h.puts()).toHaveLength(1);
	});

	it("requires a safe state file before consuming consent", async () => {
		const h = harness();
		await h.prepare();
		const contents = readFileSync(h.path, "utf8");
		const target = join(h.root, "offered-state.json");
		writeFileSync(target, contents);
		rmSync(h.path);
		symlinkSync(target, h.path);
		h.gh.mockClear();
		expect((await h.decide()).action).toBe("error");
		expect(readFileSync(target, "utf8")).toBe(contents);
		expect(h.gh).not.toHaveBeenCalled();
	});
});
