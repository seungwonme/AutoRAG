import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { StarHost, StarRuntime } from "../star.ts";

export const STAR_HOST_TOOLS: Readonly<Record<StarHost, readonly string[]>> = {
	"claude-code": ["AskUserQuestion"],
	codex: ["request_user_input"],
	kimi: ["AskUserQuestion"],
	agy: [],
	grok: ["ask_user_question"],
	cursor: [],
	kiro: [],
	omo: ["ask_user_question"],
	omp: ["ask"],
	gjc: ["ask"],
};

export interface StarProcess {
	readonly pid: number;
	readonly parentPid: number;
	readonly argv: readonly string[];
}

export interface StarHostRequest {
	readonly host?: string;
	readonly questionTool?: string;
}

function executableHost(argv: readonly string[]): StarHost | undefined {
	const first = basename(argv[0] ?? "").replace(/\.(exe|cmd)$/i, "");
	const entry = /^(node|bun|python3?|uv)$/.test(first) ? (argv[1] ?? "") : (argv[0] ?? "");
	const name = basename(entry).replace(/\.(js|cjs|mjs|exe|cmd)$/i, "");
	if (name === "claude" || name === "claude-code") return "claude-code";
	if (name === "cursor-agent" || (name === "agent" && /cursor/i.test(entry))) return "cursor";
	if (name === "kiro" || name === "kiro-cli") return "kiro";
	if (["codex", "kimi", "agy", "grok", "omo", "omp", "gjc"].includes(name)) return name as StarHost;
	if (/[/\\]@moonshot-ai[/\\]kimi-code[/\\]/.test(entry)) return "kimi";
	if (/[/\\]@anthropic-ai[/\\]claude-code[/\\]/.test(entry)) return "claude-code";
	if (/[/\\](omo-ai|@code-yeongyu[/\\]senpi)[/\\]/.test(entry)) return "omo";
	if (/[/\\](gajae-code|@gajae[/\\]|@gajae-code[/\\])/.test(entry)) return "gjc";
	return undefined;
}

/** Classification only: never use a shell tool's stdin.isTTY as the host's UI capability. */
export function classifyStarHost(request: StarHostRequest, ancestors: readonly StarProcess[]): StarRuntime {
	const explicit = request.host;
	const recognized = explicit !== undefined && Object.hasOwn(STAR_HOST_TOOLS, explicit);
	const fallback = recognized ? (explicit as StarHost) : "gjc";
	if (explicit !== undefined && !recognized) return { host: fallback, interactive: false, reason: "unknown-host" };
	const process = ancestors.find((row) => executableHost(row.argv) !== undefined);
	if (process === undefined) return { host: fallback, interactive: false, reason: "host-process-unavailable" };
	const host = executableHost(process.argv) as StarHost;
	if (explicit !== undefined && explicit !== host) return { host, interactive: false, reason: "host-mismatch" };
	const args = process.argv;
	// SDK/tool subprocesses can omit the outer harness's print flags. A native
	// question must not escape the mode restriction of any enclosing harness.
	const noninteractive = ancestors.some((row) => {
		const host = executableHost(row.argv);
		if (!host) return false;
		const args = row.argv;
		return args.some(
			(arg, index) =>
				arg === "--print" ||
				arg.startsWith("--print=") ||
				arg === "--headless" ||
				arg === "--non-interactive" ||
				arg === "--no-interactive" ||
				arg === "--output-format" ||
				arg.startsWith("--output-format=") ||
				(arg === "-p" && host !== "codex") ||
				(host === "kimi" && (arg === "--prompt" || arg === "--auto" || arg === "acp" || arg === "web")) ||
				(host === "codex" && ["exec", "e", "review", "app-server", "exec-server"].includes(arg)) ||
				(host === "agy" && (arg === "--prompt" || arg.startsWith("--prompt="))) ||
				(host === "grok" &&
					(arg === "--single" ||
						arg.startsWith("--single=") ||
						arg === "--prompt-file" ||
						arg.startsWith("--prompt-file=") ||
						arg === "--prompt-json" ||
						arg.startsWith("--prompt-json=") ||
						arg === "agent")) ||
				arg === "--no-ui" ||
				(arg === "--mode" && ["json", "rpc", "rpc-ui", "acp"].includes(args[index + 1] ?? "")) ||
				/^--mode=(json|rpc|rpc-ui|acp)$/.test(arg),
		);
	});
	if (noninteractive) return { host, interactive: false, reason: "noninteractive-host" };
	// Codex's default-mode question feature is off by default. An argv opt-in is
	// observable; plan mode and profile/config-file switches are not. Skip rather
	// than asking the caller to change modes or reading private host settings.
	if (
		host === "codex" &&
		!args.some(
			(arg, index) =>
				(arg === "--enable" && args[index + 1] === "default_mode_request_user_input") ||
				arg === "--enable=default_mode_request_user_input",
		)
	) {
		return { host, interactive: false, reason: "native-mode-unverified" };
	}
	const questionTool = request.questionTool;
	if (questionTool === undefined || !STAR_HOST_TOOLS[host].includes(questionTool)) {
		return { host, interactive: false, reason: "native-question-unavailable" };
	}
	return { host, interactive: true, questionTool };
}

/** Read only this process's ancestors; argv is never returned in the public receipt or logged. */
export function readStarAncestors(
	options: { parentPid?: number; platform?: NodeJS.Platform; limit?: number } = {},
): StarProcess[] {
	const platform = options.platform ?? process.platform;
	let pid = options.parentPid ?? process.ppid;
	const rows: StarProcess[] = [];
	const visited = new Set<number>();
	for (let i = 0; i < (options.limit ?? 16) && pid > 1 && !visited.has(pid); i++) {
		visited.add(pid);
		try {
			let parentPid: number;
			let argv: string[];
			if (platform === "linux") {
				argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
				const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
				parentPid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
			} else if (platform === "darwin" || platform === "freebsd") {
				const found = spawnSync("ps", ["-ww", "-p", String(pid), "-o", "ppid=,args="], {
					encoding: "utf8",
					timeout: 1000,
					maxBuffer: 64 * 1024,
				});
				if (found.status !== 0) return [];
				const parts = found.stdout.trim().split(/\s+/);
				parentPid = Number(parts.shift());
				argv = parts;
			} else {
				// Do not guess UI capabilities on an unverified platform.
				return [];
			}
			if (!Number.isSafeInteger(parentPid) || parentPid < 1 || argv.length === 0) return [];
			rows.push({ pid, parentPid, argv });
			pid = parentPid;
		} catch {
			return [];
		}
	}
	// Never authorize from a partial chain: an unseen enclosing host may be in
	// print mode. PID 1 is the verified boundary; limits and cycles fail closed.
	return pid === 1 ? rows : [];
}
