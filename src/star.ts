import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { resolveAutoRAGHome } from "./config/home.ts";
import { acquireFileLock, type FileLockHandle } from "./filesystem/file-lock.ts";
import { renameWithRetry } from "./mirror/atomic-write.ts";

export const STAR_REPOSITORY = "Marker-Inc-Korea/AutoRAG";
export const STAR_URL = `https://github.com/${STAR_REPOSITORY}`;

export type StarHost = "claude-code" | "codex" | "kimi" | "agy" | "grok" | "cursor" | "kiro" | "omo" | "omp" | "gjc";
export type StarChoice = "star" | "no" | "link" | "dismiss";

export interface StarRuntime {
	host: StarHost;
	interactive: boolean;
	questionTool?: string;
	reason?: string;
}

export interface StarDependencies {
	env?: NodeJS.ProcessEnv;
	now?: () => Date;
	uuid?: () => string;
	gh?: (
		args: readonly string[],
		env?: NodeJS.ProcessEnv,
	) => Promise<{ status: number; stdout: string; stderr: string }>;
}

export interface PrepareStarOptions {
	runtime: StarRuntime;
	completed: "cli" | "setup" | "search";
}

export interface DecideStarOptions {
	offerId: string;
	choice: StarChoice;
	/** Caller-supplied correlation label for a completed native result, not authenticated proof of consent. */
	questionId?: string;
	questionTool?: string;
}

export interface StarResult {
	action: string;
	reason?: string;
	repository: string;
	url: string;
	offerId?: string;
	questionTool?: string;
	question?: string;
	account?: string;
	choices?: readonly string[];
	diagnostic?: string;
}

type GhResponse = Awaited<ReturnType<NonNullable<StarDependencies["gh"]>>>;
type Gh = (args: readonly string[]) => Promise<GhResponse>;
type StarOutcome = "attempted" | "consumed" | "declined" | "dismissed" | "link" | "starred" | "error";

interface StarAccount {
	id: number;
	login: string;
}

interface StarRecord {
	repository: typeof STAR_REPOSITORY;
	offerId: string;
	host: StarHost;
	questionTool: string;
	account: StarAccount;
	attemptedAt: string;
	outcome: StarOutcome;
	decision?: StarChoice;
	questionId?: string;
	decidedAt?: string;
	completedAt?: string;
}

interface StarState {
	version: 1;
	record: StarRecord;
}

interface StateSnapshot {
	state?: StarState;
	contents?: string;
	device?: number;
	inode?: number;
}

const HOSTS: readonly string[] = ["claude-code", "codex", "kimi", "agy", "grok", "cursor", "kiro", "omo", "omp", "gjc"];
const CHOICES: readonly string[] = ["star", "no", "link", "dismiss"];
const QUESTION_CHOICES = ["Star repository", "No thanks", "Show link only"] as const;
const STAR_ENDPOINT = `/user/starred/${STAR_REPOSITORY}`;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_STATE_BYTES = 16 * 1024;
const CI_VARIABLES = [
	"CI",
	"GITHUB_ACTIONS",
	"GITLAB_CI",
	"CIRCLECI",
	"TRAVIS",
	"BUILDKITE",
	"TF_BUILD",
	"JENKINS_URL",
	"TEAMCITY_VERSION",
];

function result(action: string, fields: Omit<Partial<StarResult>, "action" | "repository" | "url"> = {}): StarResult {
	return { action, repository: STAR_REPOSITORY, url: STAR_URL, ...fields };
}

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identifier(value: unknown, maxLength = 256): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= maxLength &&
		value === value.trim() &&
		!/[\u0000-\u001f\u007f-\u009f]/.test(value)
	);
}

function account(value: unknown): value is StarAccount {
	return (
		object(value) &&
		Number.isSafeInteger(value.id) &&
		typeof value.id === "number" &&
		value.id > 0 &&
		typeof value.login === "string" &&
		/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value.login)
	);
}

function timestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validState(value: unknown): value is StarState {
	if (!object(value) || value.version !== 1 || !object(value.record)) return false;
	if (Object.keys(value).some((key) => key !== "version" && key !== "record")) return false;
	const record = value.record;
	const keys = [
		"repository",
		"offerId",
		"host",
		"questionTool",
		"account",
		"attemptedAt",
		"outcome",
		"decision",
		"questionId",
		"decidedAt",
		"completedAt",
	];
	if (Object.keys(record).some((key) => !keys.includes(key))) return false;
	if (
		record.repository !== STAR_REPOSITORY ||
		!identifier(record.offerId) ||
		typeof record.host !== "string" ||
		!HOSTS.includes(record.host) ||
		!identifier(record.questionTool) ||
		!account(record.account) ||
		Object.keys(record.account).some((key) => key !== "id" && key !== "login") ||
		!timestamp(record.attemptedAt)
	)
		return false;
	if (record.outcome === "attempted") {
		return (
			record.decision === undefined &&
			record.questionId === undefined &&
			record.decidedAt === undefined &&
			record.completedAt === undefined
		);
	}
	if (!identifier(record.questionId, 1024) || !timestamp(record.decidedAt)) return false;
	if (record.outcome === "consumed") return record.decision === "star" && record.completedAt === undefined;
	if (!timestamp(record.completedAt)) return false;
	return (
		(record.outcome === "declined" && record.decision === "no") ||
		(record.outcome === "dismissed" && record.decision === "dismiss") ||
		(record.outcome === "link" && record.decision === "link") ||
		((record.outcome === "starred" || record.outcome === "error") && record.decision === "star")
	);
}

function hasCode(error: unknown, code: string): boolean {
	return object(error) && error.code === code;
}

function readState(path: string): StateSnapshot {
	let before: ReturnType<typeof lstatSync>;
	try {
		before = lstatSync(path);
	} catch (error) {
		if (hasCode(error, "ENOENT")) return {};
		throw error;
	}
	if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_STATE_BYTES) {
		throw new Error("Star state must be a bounded regular file, not a symlink or directory.");
	}
	const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	let contents: string;
	try {
		const opened = fstatSync(descriptor);
		if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
			throw new Error("Star state changed while opening it.");
		}
		const buffer = Buffer.alloc(MAX_STATE_BYTES + 1);
		let bytes = 0;
		while (bytes < buffer.length) {
			const count = readSync(descriptor, buffer, bytes, buffer.length - bytes, bytes);
			if (count === 0) break;
			bytes += count;
		}
		if (bytes > MAX_STATE_BYTES) throw new Error("Star state exceeds its size limit.");
		contents = buffer.subarray(0, bytes).toString("utf8");
		const after = lstatSync(path);
		if (
			!after.isFile() ||
			after.dev !== before.dev ||
			after.ino !== before.ino ||
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs
		) {
			throw new Error("Star state changed while reading it.");
		}
	} finally {
		closeSync(descriptor);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(contents);
	} catch {
		throw new Error("Star state is malformed; it was not overwritten.");
	}
	if (!validState(parsed))
		throw new Error("Star state has an unknown version or invalid contents; it was not overwritten.");
	return { state: parsed, contents, device: before.dev, inode: before.ino };
}

function writeState(path: string, home: string, state: StarState, snapshot: StateSnapshot, lock: FileLockHandle): void {
	if (!validState(state)) throw new Error("Refusing to persist invalid star state.");
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		lock.assertOwned();
		const descriptor = openSync(temporary, "wx", 0o600);
		try {
			writeFileSync(descriptor, `${JSON.stringify(state)}\n`, "utf8");
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		const current = readState(path);
		if (
			current.contents !== snapshot.contents ||
			current.device !== snapshot.device ||
			current.inode !== snapshot.inode
		) {
			throw new Error("Star state changed before commit.");
		}
		lock.assertOwned();
		// Consent must never use the mirror writer's in-place fallback.
		renameWithRetry(temporary, path);
		if (process.platform !== "win32") {
			const directory = openSync(home, constants.O_RDONLY);
			try {
				fsyncSync(directory);
			} finally {
				closeSync(directory);
			}
		}
	} finally {
		rmSync(temporary, { force: true });
	}
}

function withState<T>(
	env: NodeJS.ProcessEnv,
	operation: (state: StarState | undefined, save: (state: StarState) => void) => T,
): T {
	const home = resolveAutoRAGHome(env);
	mkdirSync(home, { recursive: true, mode: 0o700 });
	const directory = lstatSync(home);
	if (!directory.isDirectory() || directory.isSymbolicLink())
		throw new Error("AutoRAG home must be a directory, not a symlink.");
	const path = join(home, "star-state.json");
	const lock = acquireFileLock(`${path}.lock`, {
		timeoutMs: 1000,
		staleMs: 60_000,
		timeoutError: () => new Error("Star state is locked by another process."),
	});
	try {
		const snapshot = readState(path);
		return operation(snapshot.state, (state) => writeState(path, home, state, snapshot, lock));
	} finally {
		lock.release();
	}
}

function date(dependencies: StarDependencies): string {
	return (dependencies.now ?? (() => new Date()))().toISOString();
}

function disabled(env: NodeJS.ProcessEnv): string | undefined {
	if (env.AUTORAG_NO_STAR !== undefined) return "opt_out";
	if (CI_VARIABLES.some((key) => env[key] !== undefined)) return "ci";
	return undefined;
}

function runGh(args: readonly string[], env: NodeJS.ProcessEnv): Promise<GhResponse> {
	return new Promise((resolve, reject) => {
		const child = spawn("gh", [...args], { env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let bytes = 0;
		let settled = false;
		const fail = (message: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.kill("SIGKILL");
			reject(new Error(message));
		};
		const timer = setTimeout(() => fail("GitHub CLI timed out after 5 seconds."), 5000);
		const collect = (target: Buffer[], chunk: Buffer) => {
			if (settled) return;
			bytes += chunk.length;
			if (bytes > MAX_OUTPUT_BYTES) fail("GitHub CLI output exceeded its size limit.");
			else target.push(chunk);
		};
		child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
		child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
		child.on("error", (error) =>
			fail(hasCode(error, "ENOENT") ? "GitHub CLI (gh) is not installed." : "GitHub CLI could not be started."),
		);
		child.on("close", (status, signal) => {
			if (settled) return;
			if (signal || status === null) {
				fail("GitHub CLI did not complete.");
				return;
			}
			settled = true;
			clearTimeout(timer);
			resolve({
				status,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
			});
		});
	});
}

function ghFor(dependencies: StarDependencies, env: NodeJS.ProcessEnv): Gh {
	const childEnv = { ...env };
	delete childEnv.GH_DEBUG;
	const gh =
		dependencies.gh ??
		((args: readonly string[], suppliedEnv?: NodeJS.ProcessEnv) => runGh(args, suppliedEnv ?? childEnv));
	const invoke = async (args: readonly string[], suppliedEnv: NodeJS.ProcessEnv): Promise<GhResponse> => {
		const response = await gh(args, { ...suppliedEnv });
		if (
			!object(response) ||
			!Number.isInteger(response.status) ||
			typeof response.stdout !== "string" ||
			typeof response.stderr !== "string" ||
			Buffer.byteLength(response.stdout) + Buffer.byteLength(response.stderr) > MAX_OUTPUT_BYTES
		)
			throw new Error("GitHub CLI returned an invalid or oversized response.");
		return response;
	};
	let pinnedEnv: Promise<NodeJS.ProcessEnv> | undefined;
	const pin = async (): Promise<NodeJS.ProcessEnv> => {
		const response = await invoke(["auth", "token", "--hostname", "github.com"], childEnv);
		const token = response.stdout.trim();
		if (response.status !== 0 || !/^[\x21-\x7e]{1,4096}$/.test(token)) {
			throw new Error("GitHub credentials could not be pinned for this optional action.");
		}
		const fixedEnv: NodeJS.ProcessEnv = { ...childEnv, GH_TOKEN: token };
		delete fixedEnv.GITHUB_TOKEN;
		return fixedEnv;
	};
	return async (args) => {
		if (args[0] !== "api") return invoke(args, childEnv);
		// Snapshot once per prepare/decide, so an ordinary gh auth switch cannot change the API account.
		pinnedEnv ??= pin();
		return invoke(args, await pinnedEnv);
	};
}

async function readAccount(gh: Gh): Promise<StarAccount | undefined> {
	if ((await gh(["auth", "status", "--hostname", "github.com"])).status !== 0) return undefined;
	const response = await gh(["api", "--hostname", "github.com", "/user"]);
	if (response.status !== 0) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(response.stdout);
	} catch {
		return undefined;
	}
	return account(parsed) ? { id: parsed.id, login: parsed.login } : undefined;
}

function httpStatus(response: GhResponse): number | undefined {
	if (response.status !== 0 && response.status !== 1) return undefined;
	const match = /^HTTP\/(?:1\.[01]|[23](?:\.0)?) ([1-5][0-9]{2})(?: [^\r\n]*)?\r?\n/.exec(response.stdout);
	if (!match || !/\r?\n\r?\n/.test(response.stdout)) return undefined;
	if (/\r?\nHTTP\//.test(response.stdout)) return undefined;
	return Number(match[1]);
}

function diagnostic(error: unknown): string {
	return error instanceof Error ? error.message : "The optional star helper could not complete safely.";
}

export async function prepareStar(
	options: PrepareStarOptions,
	dependencies: StarDependencies = {},
): Promise<StarResult> {
	try {
		if (
			!options ||
			!["cli", "setup", "search"].includes(options.completed) ||
			!options.runtime ||
			!HOSTS.includes(options.runtime.host)
		) {
			return result("skip", { reason: "incomplete_scope" });
		}
		const env = dependencies.env ?? process.env;
		const reason = disabled(env);
		if (reason) return result("skip", { reason });
		const runtime = options.runtime;
		if (runtime.interactive !== true || !identifier(runtime.questionTool)) {
			return result("skip", {
				reason: "native_question_unavailable",
				diagnostic: runtime.reason ?? "An interactive native question tool is required.",
			});
		}
		if (withState(env, (state) => state !== undefined)) return result("skip", { reason: "already_attempted" });
		const gh = ghFor(dependencies, env);
		let currentAccount: StarAccount | undefined;
		try {
			currentAccount = await readAccount(gh);
		} catch {
			return result("link_only", {
				reason: "github_unavailable",
				diagnostic: `GitHub CLI could not verify the account. Open ${STAR_URL} manually; do not install or authenticate tools just for this optional action.`,
			});
		}
		if (!currentAccount) {
			return result("link_only", {
				reason: "github_auth_unavailable",
				diagnostic: `GitHub authentication could not be verified. Open ${STAR_URL} manually; no login or additional permissions are requested.`,
			});
		}
		let response: GhResponse;
		try {
			response = await gh(["api", "--hostname", "github.com", "--include", "--method", "GET", STAR_ENDPOINT]);
		} catch {
			return result("skip", {
				reason: "star_status_unknown",
				diagnostic: `GitHub star status could not be verified. Open ${STAR_URL} manually.`,
			});
		}
		const status = httpStatus(response);
		if (status === 204 && response.status === 0)
			return result("skip", { reason: "already_starred", account: currentAccount.login });
		if (status !== 404 || response.status !== 1)
			return result("skip", {
				reason: "star_status_unknown",
				diagnostic: "GitHub did not confirm an unstarred repository; no offer was recorded.",
			});
		const questionTool = runtime.questionTool;
		const verifiedAccount = currentAccount;
		return withState(env, (state, save) => {
			if (state) return result("skip", { reason: "already_attempted" });
			const offerId = (dependencies.uuid ?? randomUUID)();
			if (!identifier(offerId)) throw new Error("The star offer identifier is invalid.");
			save({
				version: 1,
				record: {
					repository: STAR_REPOSITORY,
					offerId,
					host: runtime.host,
					questionTool,
					account: verifiedAccount,
					attemptedAt: date(dependencies),
					outcome: "attempted",
				},
			});
			return result("ask", {
				offerId,
				questionTool,
				account: verifiedAccount.login,
				question: `[offer:${offerId}] GitHub account ${verifiedAccount.login} is signed in. Would you like to star ${STAR_REPOSITORY} on GitHub? This is optional and does not affect AutoRAG.`,
				choices: QUESTION_CHOICES,
			});
		});
	} catch (error) {
		return result("error", { reason: "state_unavailable", diagnostic: diagnostic(error) });
	}
}

function finish(
	env: NodeJS.ProcessEnv,
	offerId: string,
	outcome: "starred" | "error",
	dependencies: StarDependencies,
): void {
	withState(env, (state, save) => {
		if (!state || state.record.offerId !== offerId || state.record.outcome !== "consumed")
			throw new Error("Consumed star consent changed before recording its outcome.");
		save({ version: 1, record: { ...state.record, outcome, completedAt: date(dependencies) } });
	});
}

export async function decideStar(options: DecideStarOptions, dependencies: StarDependencies = {}): Promise<StarResult> {
	try {
		if (!options || !CHOICES.includes(options.choice)) return result("skip", { reason: "invalid_choice" });
		if (!identifier(options.offerId) || !identifier(options.questionTool) || !identifier(options.questionId, 1024)) {
			return result("skip", {
				reason: "native_result_required",
				diagnostic:
					"A completed native question result, its identifier, and the matching question tool are required.",
			});
		}
		const env = dependencies.env ?? process.env;
		const decision = withState(env, (state, save) => {
			if (!state || state.record.offerId !== options.offerId) return result("skip", { reason: "offer_mismatch" });
			if (state.record.outcome !== "attempted") return result("skip", { reason: "already_answered" });
			if (state.record.questionTool !== options.questionTool)
				return result("skip", { reason: "question_tool_mismatch" });
			const outcome =
				options.choice === "star"
					? "consumed"
					: options.choice === "no"
						? "declined"
						: options.choice === "dismiss"
							? "dismissed"
							: "link";
			const decidedAt = date(dependencies);
			const record: StarRecord = {
				...state.record,
				decision: options.choice,
				questionId: options.questionId,
				decidedAt,
				outcome,
			};
			if (outcome !== "consumed") record.completedAt = decidedAt;
			// The caller supplies this correlation label; it cannot authenticate the native response.
			save({ version: 1, record });
			return result(outcome, { offerId: record.offerId, account: record.account.login });
		});
		if (decision.action !== "consumed") return decision;
		let failure: string | undefined;
		const reason = disabled(env);
		if (reason)
			failure = `Star consent was consumed without writing because ${reason === "ci" ? "a CI environment is active" : "AUTORAG_NO_STAR is set"}.`;
		const gh = ghFor(dependencies, env);
		if (!failure) {
			try {
				const offered = withState(env, (state) => {
					if (!state || state.record.offerId !== options.offerId || state.record.outcome !== "consumed")
						throw new Error("Consumed star consent is unavailable.");
					return state.record.account;
				});
				const currentAccount = await readAccount(gh);
				if (!currentAccount)
					failure = "The current GitHub account could not be verified; consent is consumed and no star was sent.";
				else if (currentAccount.id !== offered.id)
					failure = "The GitHub account changed after the offer; consent is consumed and no star was sent.";
			} catch {
				failure = "The current GitHub account could not be verified; consent is consumed and no star was sent.";
			}
		}
		if (failure) {
			finish(env, options.offerId, "error", dependencies);
			return result("error", { reason: "consent_consumed", offerId: options.offerId, diagnostic: failure });
		}
		let response: GhResponse | undefined;
		try {
			// No fields or input: GitHub receives one empty-body PUT for this fixed endpoint.
			response = await gh(["api", "--hostname", "github.com", "--include", "--method", "PUT", STAR_ENDPOINT]);
		} catch {
			// An ambiguous request is consumed, never retried automatically.
		}
		const starred = response !== undefined && response.status === 0 && httpStatus(response) === 204;
		finish(env, options.offerId, starred ? "starred" : "error", dependencies);
		return starred
			? result("starred", { offerId: options.offerId, account: decision.account })
			: result("error", {
					reason: "consent_consumed",
					offerId: options.offerId,
					diagnostic:
						"GitHub did not confirm HTTP 204. Consent is consumed; the star request will not be retried automatically.",
				});
	} catch (error) {
		return result("error", { reason: "state_unavailable", diagnostic: diagnostic(error) });
	}
}
