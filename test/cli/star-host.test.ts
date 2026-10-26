import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyStarHost, readStarAncestors, type StarProcess } from "../../src/cli/star-host.ts";

const { procRead } = vi.hoisted(() => ({ procRead: vi.fn() }));
vi.mock("node:fs", () => ({ readFileSync: procRead }));
afterEach(() => procRead.mockReset());

const ancestor = (argv: readonly string[]): StarProcess => ({ pid: 200, parentPid: 100, argv });

describe("optional Star native host boundary", () => {
	it.each(["failure", "limit", "cycle"])("discards a recognized child when ancestry ends in %s", (mode) => {
		procRead.mockImplementation((path: string) => {
			if (path === "/proc/200/cmdline") return "gjc\0";
			if (path === "/proc/200/stat") return `200 (gjc) S ${mode === "cycle" ? 200 : 100} 0`;
			throw new Error("ancestor unavailable");
		});
		const rows = readStarAncestors({ parentPid: 200, platform: "linux", limit: mode === "limit" ? 1 : 16 });
		expect(rows).toEqual([]);
		expect(classifyStarHost({ host: "gjc", questionTool: "ask" }, rows).interactive).toBe(false);
	});

	it("retains ancestry only when the chain reaches init", () => {
		procRead.mockImplementation((path: string) => (path.endsWith("cmdline") ? "gjc\0" : "200 (gjc) S 1 0"));
		expect(readStarAncestors({ parentPid: 200, platform: "linux" })).toEqual([
			{ pid: 200, parentPid: 1, argv: ["gjc"] },
		]);
	});

	it.each([
		["claude-code", "AskUserQuestion", ["/opt/claude"]],
		["codex", "request_user_input", ["/opt/codex", "-p", "work", "--enable", "default_mode_request_user_input"]],
		["kimi", "AskUserQuestion", ["/opt/kimi", "--skills-dir", "/workspace/.agents/skills"]],
		["kimi", "AskUserQuestion", ["node", "/opt/node_modules/@moonshot-ai/kimi-code/dist/main.mjs"]],
		["claude-code", "AskUserQuestion", ["node", "/opt/node_modules/@anthropic-ai/claude-code/cli.js"]],
		["grok", "ask_user_question", ["/opt/grok"]],
		["omo", "ask_question", ["node", "/opt/node_modules/omo-ai/bin/omo.js"]],
		["omp", "ask", ["/opt/omp"]],
		["gjc", "ask", ["/opt/gjc", "--thinking", "off"]],
		["gjc", "ask", ["bun", "/opt/node_modules/@gajae-code/coding-agent/dist/cli.js"]],
	] as const)("identifies %s through an ordinary shell ancestor", (host, questionTool, argv) => {
		expect(
			classifyStarHost({ host, questionTool }, [ancestor(["bash", "-c", "autorag star prepare"]), ancestor(argv)]),
		).toMatchObject({ host, questionTool, interactive: true });
	});

	it.each([
		["gjc", "ask", ["gjc", "--print", "setup"]],
		["gjc", "ask", ["gjc", "--mode=acp"]],
		["claude-code", "AskUserQuestion", ["claude", "-p", "setup"]],
		["kimi", "AskUserQuestion", ["kimi", "--prompt", "setup"]],
		["kimi", "AskUserQuestion", ["kimi", "--auto"]],
		["agy", "ask_user", ["agy", "--print=setup"]],
		["grok", "ask_user_question", ["grok", "--single", "setup"]],
		["grok", "ask_user_question", ["grok", "--prompt-file", "/tmp/prompt"]],
		["grok", "ask_user_question", ["grok", "agent"]],
		["omp", "ask", ["omp", "--mode=rpc-ui"]],
		["kiro", "ask_user", ["kiro-cli", "--no-interactive"]],
		["codex", "request_user_input", ["codex", "exec", "setup"]],
		["codex", "request_user_input", ["codex", "app-server"]],
		["omo", "ask_question", ["omo", "--mode", "rpc"]],
		["omp", "ask", ["omp", "--mode=json"]],
		["cursor", "AskQuestion", ["cursor-agent", "--output-format", "stream-json"]],
	] as const)("never treats a headless %s process as answerable", (host, questionTool, argv) => {
		expect(classifyStarHost({ host, questionTool }, [ancestor(argv)])).toMatchObject({
			interactive: false,
			reason: "noninteractive-host",
		});
	});

	it("does not accept a tool from another host or a guessed name", () => {
		expect(classifyStarHost({ host: "gjc", questionTool: "AskUserQuestion" }, [ancestor(["gjc"])]).interactive).toBe(
			false,
		);
		expect(
			classifyStarHost({ host: "kiro", questionTool: "AskUserQuestion" }, [ancestor(["kiro-cli"])]).interactive,
		).toBe(false);
		expect(classifyStarHost({ host: "agy", questionTool: "ask_user" }, [ancestor(["agy"])]).interactive).toBe(false);
		expect(
			classifyStarHost({ host: "cursor", questionTool: "AskQuestion" }, [ancestor(["cursor-agent"])]).interactive,
		).toBe(false);
	});

	it("skips Codex when the question mode cannot be verified", () => {
		expect(
			classifyStarHost({ host: "codex", questionTool: "request_user_input" }, [ancestor(["codex"])]).reason,
		).toBe("native-mode-unverified");
	});

	it("does not trust an explicit host flag without actual ancestor evidence", () => {
		expect(classifyStarHost({ host: "claude-code", questionTool: "AskUserQuestion" }, [])).toMatchObject({
			interactive: false,
			reason: "host-process-unavailable",
		});
		expect(
			classifyStarHost({ host: "claude-code", questionTool: "AskUserQuestion" }, [ancestor(["gjc"])]).reason,
		).toBe("host-mismatch");
	});

	it("uses the closest harness and rejects that harness print mode despite an outer interactive host", () => {
		expect(
			classifyStarHost({ host: "gjc", questionTool: "ask" }, [ancestor(["gjc", "-p", "setup"]), ancestor(["gjc"])]),
		).toMatchObject({ interactive: false, reason: "noninteractive-host" });
	});

	it("does not let an SDK child hide an enclosing print-mode harness", () => {
		expect(
			classifyStarHost({ host: "gjc", questionTool: "ask" }, [
				ancestor(["gjc"]),
				ancestor(["gjc", "--print", "install"]),
			]),
		).toMatchObject({ interactive: false, reason: "noninteractive-host" });
	});

	it("does not mistake prose mentioning a CLI for an executable", () => {
		expect(
			classifyStarHost({ host: "gjc", questionTool: "ask" }, [ancestor(["bash", "-c", "echo gjc"])]).reason,
		).toBe("host-process-unavailable");
	});
});
