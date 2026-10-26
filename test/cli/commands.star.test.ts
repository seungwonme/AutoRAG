import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runStar } from "../../src/cli/commands/star.ts";
import type { CommandContext } from "../../src/cli/commands/types.ts";
import { STAR_HOST_TOOLS, type StarProcess } from "../../src/cli/star-host.ts";
import { STAR_REPOSITORY, STAR_URL, type StarResult } from "../../src/star.ts";

const mocks = vi.hoisted(() => ({
	prepareStar: vi.fn<typeof import("../../src/star.ts").prepareStar>(),
	decideStar: vi.fn<typeof import("../../src/star.ts").decideStar>(),
	readStarAncestors: vi.fn<typeof import("../../src/cli/star-host.ts").readStarAncestors>(),
	spawn: vi.fn(() => {
		throw new Error("Star command tests must not spawn GitHub or other processes");
	}),
	spawnSync: vi.fn(() => {
		throw new Error("Star command tests must not inspect real process ancestry");
	}),
}));

// Do not import the real core: it owns shared home state and GitHub writes.
vi.mock("../../src/star.ts", () => ({
	STAR_REPOSITORY: "Marker-Inc-Korea/AutoRAG",
	STAR_URL: "https://github.com/Marker-Inc-Korea/AutoRAG",
	prepareStar: mocks.prepareStar,
	decideStar: mocks.decideStar,
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn, spawnSync: mocks.spawnSync }));
vi.mock("../../src/cli/star-host.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/cli/star-host.ts")>()),
	readStarAncestors: mocks.readStarAncestors,
}));

function ancestors(argv: string[]): StarProcess[] {
	return argv.length === 0 ? [] : [{ pid: 123, parentPid: 1, argv }];
}

function context(positionals: string[], flags: CommandContext["flags"] = {}) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const prompt = vi.fn(async () => true);
	const ctx: CommandContext = {
		positionals,
		flags,
		json: flags.json === true,
		debug: false,
		cwd: "/virtual/star-command-test",
		stdout: (line) => stdout.push(line),
		stderr: (line) => stderr.push(line),
		promptYesNo: prompt,
	};
	return { ctx, stdout, stderr, prompt };
}

function output(run: ReturnType<typeof context>): Record<string, unknown> {
	expect(run.stdout).toHaveLength(1);
	expect(run.stderr).toEqual([]);
	expect(run.prompt).not.toHaveBeenCalled();
	return JSON.parse(run.stdout[0]) as Record<string, unknown>;
}

function result(action: string, fields: Partial<StarResult> = {}): StarResult {
	return { action, repository: STAR_REPOSITORY, url: STAR_URL, ...fields };
}

const nativeFlags: CommandContext["flags"] = {
	host: "gjc",
	"question-tool": "ask",
	"offer-id": "offer-1",
	choice: "star",
	"question-id": "native-question-1",
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.prepareStar.mockReset();
	mocks.decideStar.mockReset();
	mocks.readStarAncestors.mockReset().mockReturnValue(ancestors(["gjc"]));
});

afterEach(() => {
	expect(mocks.spawn).not.toHaveBeenCalled();
	expect(mocks.spawnSync).not.toHaveBeenCalled();
});

describe("star command", () => {
	it.each([true, false])("prints read-only guide JSON with json=%s without core or GitHub calls", async (json) => {
		const run = context(["guide"], { json });
		expect(await runStar(run.ctx)).toBe(0);
		const guide = output(run);
		expect(guide).toMatchObject({
			action: "prepare_required",
			repository: STAR_REPOSITORY,
			url: STAR_URL,
			hostTools: STAR_HOST_TOOLS,
		});
		expect(guide.steps).toEqual(expect.arrayContaining([expect.stringContaining("Only action=ask")]));
		expect((guide.steps as string[]).join("\n")).toContain("not authenticated proof of consent");
		expect(guide.limitations).toEqual(expect.any(String));
		expect(mocks.prepareStar).not.toHaveBeenCalled();
		expect(mocks.decideStar).not.toHaveBeenCalled();
		expect(mocks.readStarAncestors).toHaveBeenCalledOnce();
	});

	it.each([[], ["gjc", "--print"], ["codex"], ["agy"], ["cursor-agent"], ["kiro-cli"]])(
		"returns only a stop instruction for an unavailable guide host %j",
		(...argv) => {
			mocks.readStarAncestors.mockReturnValue(ancestors(argv));
			const run = context(["guide"], { json: true });
			return runStar(run.ctx).then((code) => {
				expect(code).toBe(0);
				const guide = output(run);
				expect(guide.action).toBe("skip");
				expect(guide.steps).toBeUndefined();
				expect(guide.hostTools).toBeUndefined();
				expect(mocks.prepareStar).not.toHaveBeenCalled();
				expect(mocks.decideStar).not.toHaveBeenCalled();
			});
		},
	);

	it.each([
		{ positionals: [] },
		{ positionals: ["unknown"] },
		{ positionals: ["guide", "extra"] },
		{ positionals: ["decide", "extra"] },
	])("rejects invalid operation arguments $positionals as JSON with exit 2", async ({ positionals }) => {
		const run = context(positionals, { json: true });
		expect(await runStar(run.ctx)).toBe(2);
		expect(output(run)).toEqual(result("error", { reason: expect.any(String) }));
		expect(mocks.prepareStar).not.toHaveBeenCalled();
		expect(mocks.decideStar).not.toHaveBeenCalled();
		expect(mocks.readStarAncestors).not.toHaveBeenCalled();
	});

	it.each([undefined, true, false, "", "install", "cli,setup"])(
		"rejects invalid completed scope %j without calling the core",
		async (completed) => {
			const run = context(["prepare"], { ...nativeFlags, completed });
			expect(await runStar(run.ctx)).toBe(2);
			expect(output(run)).toEqual(result("error", { reason: expect.stringContaining("--completed") }));
			expect(mocks.prepareStar).not.toHaveBeenCalled();
			expect(mocks.decideStar).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ label: "missing offer", flags: { "offer-id": undefined } },
		{ label: "empty offer", flags: { "offer-id": "" } },
		{ label: "boolean offer", flags: { "offer-id": true } },
		{ label: "missing choice", flags: { choice: undefined } },
		{ label: "invalid choice", flags: { choice: "yes" } },
		{ label: "boolean choice", flags: { choice: true } },
		{ label: "missing question ID", flags: { "question-id": undefined } },
		{ label: "empty question ID", flags: { "question-id": "" } },
		{ label: "boolean question ID", flags: { "question-id": true } },
		{ label: "missing question tool", flags: { "question-tool": undefined } },
		{ label: "empty question tool", flags: { "question-tool": "" } },
		{ label: "boolean question tool", flags: { "question-tool": true } },
	])("rejects $label rather than treating install approval as an answer", async ({ flags }) => {
		const run = context(["decide"], { ...nativeFlags, yes: true, ...flags });
		expect(await runStar(run.ctx)).toBe(2);
		expect(output(run)).toEqual(result("error", { reason: expect.stringContaining("completed native question") }));
		expect(mocks.prepareStar).not.toHaveBeenCalled();
		expect(mocks.decideStar).not.toHaveBeenCalled();
	});

	it.each([
		{ label: "headless", argv: ["gjc", "--headless"], host: "gjc", tool: "ask", reason: "noninteractive-host" },
		{ label: "print", argv: ["gjc", "--print"], host: "gjc", tool: "ask", reason: "noninteractive-host" },
		{ label: "unknown host", argv: ["gjc"], host: "unknown", tool: "ask", reason: "unknown-host" },
		{
			label: "mismatched host",
			argv: ["gjc"],
			host: "claude-code",
			tool: "AskUserQuestion",
			reason: "host-mismatch",
		},
		{ label: "unavailable ancestry", argv: [], host: "gjc", tool: "ask", reason: "host-process-unavailable" },
		{
			label: "wrong native tool",
			argv: ["gjc"],
			host: "gjc",
			tool: "AskUserQuestion",
			reason: "native-question-unavailable",
		},
		{ label: "AGY", argv: ["agy"], host: "agy", tool: "ask_user", reason: "native-question-unavailable" },
		{
			label: "Cursor",
			argv: ["cursor-agent"],
			host: "cursor",
			tool: "AskQuestion",
			reason: "native-question-unavailable",
		},
		{
			label: "Codex without pre-existing feature",
			argv: ["codex"],
			host: "codex",
			tool: "request_user_input",
			reason: "native-mode-unverified",
		},
	])("skips $label without passing a decision to the core", async ({ argv, host, tool, reason }) => {
		mocks.readStarAncestors.mockReturnValue(ancestors(argv));
		const run = context(["decide"], { ...nativeFlags, host, "question-tool": tool, json: true });
		expect(await runStar(run.ctx)).toBe(0);
		expect(output(run)).toEqual(result("skip", { reason }));
		expect(mocks.prepareStar).not.toHaveBeenCalled();
		expect(mocks.decideStar).not.toHaveBeenCalled();
	});

	it.each(["cli", "setup", "search"] as const)(
		"forwards exactly the %s completion and observed GJC runtime",
		async (completed) => {
			const receipt = result("ask", { offerId: "offer-1", questionTool: "ask", question: "Optional support?" });
			mocks.prepareStar.mockResolvedValue(receipt);
			const run = context(["prepare"], { host: "gjc", "question-tool": "ask", completed, json: true });
			expect(await runStar(run.ctx)).toBe(0);
			expect(output(run)).toEqual(receipt);
			expect(mocks.prepareStar).toHaveBeenCalledTimes(1);
			expect(mocks.prepareStar).toHaveBeenCalledWith({
				completed,
				runtime: { host: "gjc", interactive: true, questionTool: "ask" },
			});
			expect(mocks.readStarAncestors).toHaveBeenCalledWith();
			expect(mocks.decideStar).not.toHaveBeenCalled();
		},
	);

	it.each(["star", "no", "link", "dismiss"] as const)(
		"forwards the exact %s answer correlation fields",
		async (choice) => {
			// These labels exercise forwarding only; they do not prove a native dialog occurred.
			const receipt = result("skip", { reason: "mocked_decision", offerId: "offer-1" });
			mocks.decideStar.mockResolvedValue(receipt);
			const run = context(["decide"], { ...nativeFlags, choice, json: true });
			expect(await runStar(run.ctx)).toBe(0);
			expect(output(run)).toEqual(receipt);
			expect(mocks.decideStar).toHaveBeenCalledTimes(1);
			expect(mocks.decideStar).toHaveBeenCalledWith({
				offerId: "offer-1",
				choice,
				questionId: "native-question-1",
				questionTool: "ask",
			});
			expect(mocks.prepareStar).not.toHaveBeenCalled();
		},
	);

	describe.each(["prepare", "decide"] as const)("%s optional outcomes", (operation) => {
		it.each([
			{ action: "skip", reason: "ci" },
			{ action: "link_only", reason: "github_auth_unavailable" },
			{ action: "error", reason: "state_unavailable" },
		])("prints $action unchanged and exits 0, not an installation error or retry", async ({ action, reason }) => {
			const receipt = result(action, { reason, diagnostic: "Optional action unavailable" });
			const core = operation === "prepare" ? mocks.prepareStar : mocks.decideStar;
			core.mockResolvedValue(receipt);
			const run = context([operation], { ...nativeFlags, completed: "cli" });
			expect(await runStar(run.ctx)).toBe(0);
			expect(output(run)).toEqual(receipt);
			expect(core).toHaveBeenCalledTimes(1);
		});
	});
});
