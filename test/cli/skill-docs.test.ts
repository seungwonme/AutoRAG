import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SearchDocumentsResponse } from "../../src/agent/search-documents.ts";
import { normalizeIndexingConfig } from "../../src/cli/config.ts";
import { renderSearch } from "../../src/cli/output.ts";
import { BUILTIN_DATASOURCE_SKILL_NAMES } from "../../src/datasource/skills/factory.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

const SKILL_NAMES = ["autorag", "autorag-setup", "autorag-lite-setup", "autorag-doctor"] as const;

type SkillName = (typeof SKILL_NAMES)[number];

function readSkill(name: SkillName | string): string {
	return readFileSync(join(repoRoot, "skills", name, "SKILL.md"), "utf8").replace(/\r\n?/g, "\n");
}

/** Every folder under `skills/`, which is what the npm package ships to parent agents. */
function skillFolders(): string[] {
	return readdirSync(join(repoRoot, "skills"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
}

/** Parse the leading YAML frontmatter block of a SKILL.md into flat string fields. */
function parseFrontmatter(markdown: string): Record<string, string> | undefined {
	const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
	if (!match) return undefined;
	const fields: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (pair) fields[pair[1]] = pair[2].trim();
	}
	return fields;
}

/** The real CLI surface, parsed from the shipped dispatcher rather than restated here. */
function cliSurface(): { commands: Set<string>; flags: Set<string> } {
	const source = readFileSync(join(repoRoot, "src/cli/index.ts"), "utf8");
	const listOf = (name: string): string[] => {
		const block = new RegExp(`${name}\\s*=\\s*(?:new Set\\()?\\[([\\s\\S]*?)\\]`).exec(source);
		if (!block) throw new Error(`cannot parse ${name} from src/cli/index.ts`);
		return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
	};
	return {
		commands: new Set(listOf("COMMANDS")),
		flags: new Set([...listOf("BOOLEAN_FLAGS"), ...listOf("VALUE_FLAGS")]),
	};
}

/** Collect `autorag <command> ... --flag` invocations out of markdown prose and fences. */
function autoragInvocations(markdown: string): { command: string; flags: string[] }[] {
	const calls: { command: string; flags: string[] }[] = [];
	for (const line of markdown.split("\n")) {
		const match = /(?:^|[`$\s(|])autorag\s+([a-z][a-z0-9-]*)((?:\s+[^`\n]*)?)/.exec(line);
		if (!match) continue;
		if (match[1] === "init" && line.includes("npm")) continue;
		const flags = [...match[2].matchAll(/\s--([a-z][a-z0-9-]*)/g)].map((m) => m[1]);
		calls.push({ command: match[1], flags });
	}
	return calls;
}

/** Extract one `## <heading>` section body from a markdown document. */
function section(markdown: string, heading: string): string {
	const pattern = new RegExp(`^## ${heading}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m");
	return pattern.exec(markdown)?.[1] ?? "";
}

/**
 * Extract one `### <heading>` subsection body from a markdown document. Only
 * `##`/`###` headings end it, so a `# comment` inside a bash fence is kept.
 */
function subsection(markdown: string, heading: string): string {
	return new RegExp(`\\n### ${heading}\\s*\\n([\\s\\S]*?)(?=\\n#{2,3} |$)`).exec(markdown)?.[1] ?? "";
}

/** Every string literal used as a diagnostic/warning code anywhere in the shipped source. */
function sourceStringLiterals(): Set<string> {
	const literals = new Set<string>();
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".ts") && statSync(full).isFile()) {
				for (const m of readFileSync(full, "utf8").matchAll(/"([a-z][a-z0-9]*(?:-[a-z0-9]+)+)"/g))
					literals.add(m[1]);
			}
		}
	};
	walk(join(repoRoot, "src"));
	return literals;
}

const searchResponse: SearchDocumentsResponse = {
	sessionId: "session-1",
	query: "q",
	answer: "[1] answer",
	results: [
		{
			number: 1,
			title: "A",
			summary: "answer",
			evidence: [{ excerpt: "answer" }],
			confidence: 1,
			source: "/docs/a.md",
		},
	],
	searched: 1,
	warnings: [],
	diagnostics: [],
};

describe("parent-agent skill docs", () => {
	it("keeps skill folder names aligned with frontmatter", () => {
		for (const name of SKILL_NAMES) {
			expect(readSkill(name)).toMatch(new RegExp(`^---\\nname: ${name}\\n`, "m"));
		}
	});

	it("documents MinSync auto-install as on by default", () => {
		expect(normalizeIndexingConfig({}).minSync.autoInstall).toBe(true);
		const setup = readSkill("autorag-setup");
		expect(setup).not.toMatch(/MinSync auto-install is off by default/);
	});

	it.each(["autorag-setup", "autorag-lite-setup"] as const)(
		"%s separates CLI-only installation from configuration and full setup",
		(name) => {
			const skill = readSkill(name);
			const workflow = section(skill, "Requested scope workflow");
			const cliOnly = /1\.([\s\S]*?)(?=\n2\.)/.exec(workflow)?.[1] ?? "";
			expect(cliOnly).toMatch(/CLI-only installation/);
			expect(cliOnly).toMatch(/user's explicit\s+source \(package, fork, or checkout\)/);
			expect(cliOnly).toContain("autorag --version");
			expect(cliOnly).toContain("autorag --help");
			expect(cliOnly).toMatch(/do not configure a model,\s+roots, indexes, datasources, schedules, or MCP/);
			const install = section(
				skill,
				name === "autorag-setup" ? "Install the CLI if needed" : "Install the package if needed",
			);
			expect(install).toContain("autorag --version");
			expect(install).toContain("autorag --help");
			expect(install).toMatch(/For CLI-only installation,[\s\S]*?optional Star step after\s+both checks pass/);
			const completion = section(skill, "Completion condition");
			const cliCompletion = completion.split("**Full")[0];
			expect(cliCompletion).toContain("**CLI-only:**");
			expect(cliCompletion).toMatch(/No model, roots, indexes, datasources,\s+schedule, or MCP setup is required/);
			expect(cliCompletion).toContain("Optional Star does not affect completion");
		},
	);

	it.each(["autorag-setup", "autorag-lite-setup"] as const)(
		"%s keeps optional Star outside successful scope and full completion",
		(name) => {
			const skill = readSkill(name);
			const workflow = section(skill, "Requested scope workflow");
			expect(workflow).toMatch(/After the requested scope succeeds/);
			const support = section(skill, "Star the repository \\(final step\\)");
			expect(support.length).toBeGreaterThan(0);
			const full = section(skill, "Completion condition").split("**Full")[1] ?? "";
			expect(full).toMatch(/roots are approved/);
			expect(full).toMatch(/every datasource has\s+been probed/);
			expect(full).toContain("dupey");
			expect(full).toMatch(/schedule/);
			if (name === "autorag-setup") {
				expect(full).toMatch(/single-model config is written/);
				expect(full).toMatch(/live `health`\s+passes/);
				expect(full).toMatch(/`refresh` builds the requested indexes/);
				expect(full).toMatch(/one real structured search\s+succeeds/);
				expect(full).toMatch(/successful MCP discovery and a\s+known-source MCP search/);
			} else {
				expect(full).toMatch(/stdio executable are installed/);
				expect(full).toContain("trusted model-free config is written");
				expect(full).toMatch(/connect, discover tools, refresh requested\s+indexes/);
				expect(full).toMatch(/retrieve known source content via\s+MCP/);
			}
		},
	);

	it("keeps successful-search support optional, parent-host owned, and outside machine output", () => {
		const support = section(readSkill("autorag"), "Optional support after successful search");
		expect(support).toMatch(/interactive/);
		expect(support).toContain("../autorag-setup/SKILL.md#star-the-repository-final-step");
		expect(support).toContain("not part of retrieval success");
		expect(support).toMatch(/CI/);
		expect(support).toMatch(/headless/);
		expect(support).toMatch(/machine-only/);
	});

	it("keeps one optional-support policy reachable from independently copied skills", () => {
		for (const name of ["autorag-lite-setup", "autorag"] as const) {
			const skill = readSkill(name);
			expect(skill).toContain("../autorag-setup/SKILL.md#star-the-repository-final-step");
			expect(skill).toContain("https://github.com/Marker-Inc-Korea/AutoRAG");
			expect(skill).not.toMatch(/gh\s+api[^\n`]*--method PUT/);
		}
		for (const name of ["autorag-setup", "autorag-lite-setup", "autorag"] as const) {
			expect(readSkill(name)).not.toMatch(/autorag star|offerId|question-tool|star-state\.json/);
		}
		const support = section(readSkill("autorag-setup"), "Star the repository \\(final step\\)");
		expect(support).toContain("gh api --hostname github.com --method PUT /user/starred/Marker-Inc-Korea/AutoRAG");
		expect(support).toContain("https://github.com/cli/cli#installation");
		expect(support).toMatch(/explicit/i);
		expect(support).not.toMatch(/gh auth token|--with-token|\|\| true/);
	});

	it("offers Yes first and recommended without treating a default as consent", () => {
		const support = section(readSkill("autorag-setup"), "Star the repository \\(final step\\)");
		expect(support).toContain("exactly two visible response choices");
		expect(support).toMatch(/Put `Yes` \(`네`\) first, marked recommended and initially focused/);
		expect(support).toContain("`Other:` (`기타:`), free text");
		expect(support).toContain("`recommended: 0`");
		expect(support).toMatch(/Reuse an automatic Other input instead of duplicating it/);
		expect(support).toMatch(/Follow the actual tool contract/);
		expect(support).toContain("`1. 네 (추천)` and `2. 기타:`");
		expect(support).toMatch(/Claude Code `AskUserQuestion` and GJC `ask` require at least/);
		expect(support).toMatch(/Do not call them for this step/);
		expect(support).toContain("WAIT for a real submitted answer");
		expect(support).toMatch(/Never infer Yes from the default selection/);
		expect(support).toMatch(/this Yes is installation\/login approval, not Star consent/);
		expect(support).not.toMatch(/Offer `Star repository`, `Open link`/);
		expect(section(readSkill("autorag-setup"), "Requested scope workflow")).toContain(
			"If this skill was truncated, retrieve",
		);
	});

	it("separates human replies from skill replay and skips unknown interaction modes", () => {
		const support = section(readSkill("autorag-setup"), "Star the repository \\(final step\\)");
		expect(support).toMatch(/Before any GitHub command or marker write/);
		expect(support).toContain("machine-only, or unknown interaction modes");
		expect(support).toMatch(/Replace `<login>` with the account verified in step 2 before displaying it/);
		expect(support).toContain("END THE TURN after that question");
		expect(support).toMatch(/skill load\/replay, tool result, system continuation/);
		expect(support).toContain("Do not answer your own question");
		expect(support).toMatch(/same account and repository were shown before\s+the answer/);
		expect(support).toContain("then finish without a Star question");
	});

	it("documents search JSON sessionId as debug-only", () => {
		const json = JSON.parse(renderSearch(searchResponse, { json: true, debug: false })) as {
			sessionId?: string;
		};
		const debugJson = JSON.parse(renderSearch(searchResponse, { json: true, debug: true })) as {
			sessionId?: string;
		};
		expect(json.sessionId).toBeUndefined();
		expect(debugJson.sessionId).toBe("session-1");

		const search = readSkill("autorag");
		expect(search).toContain("autorag search");
		expect(search).toContain("--json --debug");
		expect(search).toMatch(/`--json` alone omits `sessionId`/);
		expect(search).not.toMatch(/The response contains a `sessionId`/);
	});

	it("does not claim unknown datasource names fail config resolution", () => {
		const setup = readSkill("autorag-setup");
		expect(setup).not.toMatch(/Unknown skill names fail config resolution/);
		expect(setup).toContain("unknown-datasource-skill");
		expect(setup).toMatch(/they do not fail config resolution/);
	});

	it("lists builtin datasource templates and probes them wizard-style", () => {
		const setup = readSkill("autorag-setup");
		expect(setup).toContain("wizard-style");
		expect(setup).toContain("do not recommend it for datasource");
		expect(setup).not.toContain("autorag ui --no-open");
		for (const name of BUILTIN_DATASOURCE_SKILL_NAMES) {
			expect(setup).toContain(name);
		}
	});

	it("keeps the README skill-install snippet pointing at skills that exist", () => {
		const readme = readFileSync(join(repoRoot, "README.md"), "utf8").replace(/\r\n?/g, "\n");
		const install = subsection(readme, "Install the skills into your coding agent");
		expect(install.length, "README needs a skill-install subsection").toBeGreaterThan(0);
		expect(install, "the install subsection must name Claude Code's skill directory").toContain(".claude/skills");
		const copied = [...install.matchAll(/skills\/(autorag[a-z0-9-]*)/g)].map((match) => match[1]);
		expect(copied.length, "the install snippet must name the skill folders it copies").toBeGreaterThan(0);
		for (const name of new Set(copied)) {
			expect(skillFolders(), `README install snippet copies unknown skill "${name}"`).toContain(name);
			expect(existsSync(join(repoRoot, "skills", name, "SKILL.md")), `${name}: missing SKILL.md`).toBe(true);
		}
	});

	it("ships every skill folder in the npm package", () => {
		const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
			files: string[];
		};
		expect(pkg.files).toContain("skills");
	});

	it("keeps the librarian's own skills out of the parent-agent folder but shipped", () => {
		// `skills/` is what parent agents copy; a skill that is only the librarian's
		// own turn rules belongs in `internal-skills/`, which the package still ships.
		const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
			files: string[];
		};
		const internal = readdirSync(join(repoRoot, "internal-skills"), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
		expect(internal.length).toBeGreaterThan(0);
		for (const name of internal) {
			expect(skillFolders()).not.toContain(name);
			const fields = parseFrontmatter(
				readFileSync(join(repoRoot, "internal-skills", name, "SKILL.md"), "utf8").replace(/\r\n?/g, "\n"),
			);
			expect(fields, `internal-skills/${name}: missing frontmatter`).toBeDefined();
			expect(fields?.name).toBe(name);
			expect((fields?.description ?? "").length, `internal-skills/${name}: description length`).toBeGreaterThan(0);
		}
		expect(pkg.files).toContain("internal-skills");
	});

	it("documents the lite refresh method values and force flags", () => {
		const setup = readSkill("autorag-lite-setup");
		for (const method of ["parsed", "minsync", "datasources", "jikji", "all"]) {
			expect(setup).toContain(method);
		}
		expect(setup).toContain("--full");
		expect(setup).toContain("--force");
		expect(setup).toContain("unknown-datasource-skill");
		expect(setup).toContain("autorag lite watch --once");
	});

	it("keeps every shipped skill folder valid under the agent-skill frontmatter spec", () => {
		const folders = skillFolders();
		expect(folders).toEqual([...SKILL_NAMES].sort());
		for (const folder of folders) {
			const fields = parseFrontmatter(readSkill(folder));
			expect(fields, `${folder}: missing frontmatter`).toBeDefined();
			expect(fields?.name).toBe(folder);
			expect(folder).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
			expect(folder.length).toBeLessThanOrEqual(64);
			const description = fields?.description ?? "";
			expect(description.length, `${folder}: description length`).toBeGreaterThan(0);
			expect(description.length, `${folder}: description length`).toBeLessThanOrEqual(1024);
			expect(description, `${folder}: angle brackets are prohibited`).not.toMatch(/[<>]/);
		}
	});

	it("keeps doctor-skill and README troubleshooting commands inside the real CLI surface", () => {
		const { commands, flags } = cliSurface();
		const readme = readFileSync(join(repoRoot, "README.md"), "utf8").replace(/\r\n?/g, "\n");
		const troubleshooting = section(readme, "Troubleshooting");
		expect(troubleshooting.length, "README needs a ## Troubleshooting section").toBeGreaterThan(0);
		expect(troubleshooting).toContain("autorag-doctor");

		for (const [label, markdown] of [
			["skills/autorag-doctor/SKILL.md", readSkill("autorag-doctor")],
			["README ## Troubleshooting", troubleshooting],
		] as const) {
			const calls = autoragInvocations(markdown);
			expect(calls.length, `${label}: no autorag invocations found`).toBeGreaterThan(0);
			for (const call of calls) {
				expect(commands, `${label}: unknown command "autorag ${call.command}"`).toContain(call.command);
				for (const flag of call.flags) {
					expect(flags, `${label}: unknown flag "--${flag}" on autorag ${call.command}`).toContain(flag);
				}
			}
		}
	});

	it("cites only diagnostic codes that exist in the shipped source", () => {
		const literals = sourceStringLiterals();
		const codes = section(readSkill("autorag-doctor"), "Diagnostic codes");
		expect(codes.length, "doctor skill needs a ## Diagnostic codes section").toBeGreaterThan(0);
		const cited = [...codes.matchAll(/`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`/g)].map((m) => m[1]);
		expect(cited.length).toBeGreaterThan(4);
		for (const code of cited) {
			expect(literals, `doctor skill cites unknown diagnostic code "${code}"`).toContain(code);
		}
	});

	it("presents hwp as a supported parsed format and not a legacy exclusion", () => {
		const setup = readSkill("autorag-setup");
		expect(setup).toMatch(/`hwp`, `hwpx`/);
		expect(setup).not.toMatch(/or `hwp` as fully supported parsed formats/);
		expect(setup).toMatch(/`xlsx`, `xls`, `hwp`, `hwpx`/);
		expect(setup).toMatch(/Do not present legacy\n`\.doc` as a supported parsed format/s);
	});

	it("names Qwen3 at 1024 dimensions as the default embedding and never tells users to manage a model cache", () => {
		for (const name of ["autorag-setup", "autorag-lite-setup"] as const) {
			const skill = readSkill(name);
			expect(skill).toMatch(/Qwen3/);
			expect(skill).toMatch(/1024/);
			// The removed `models prefetch|import|verify` and `gateway` commands must not be taught.
			expect(skill).not.toMatch(/autorag models (prefetch|import|verify)/);
			expect(skill).not.toMatch(/autorag gateway/);
		}
	});

	it("keeps moved retrieval knowledge reachable from setup before model or indexing changes", () => {
		const setup = readSkill("autorag-setup");
		expect(setup).toMatch(
			/Before configuring indexing or models, read\s+\[Retrieval configuration\]\(references\/retrieval-configuration\.md\)/,
		);
		const reference = readFileSync(
			join(repoRoot, "skills/autorag-setup/references/retrieval-configuration.md"),
			"utf8",
		).replace(/\r\n?/g, "\n");
		for (const heading of [
			"Retrieval defaults",
			"Jev routing and question decomposition (on by default)",
			"Retrieval and ingest caps",
			"Refresh safety limits",
		]) {
			expect(reference).toContain(`### ${heading}`);
		}
		expect(reference).toContain("Qwen/Qwen3-Embedding-0.6B");
		expect(reference).toContain("1024 dimensions");
		expect(reference).toContain("queryDecomposition");
		expect(reference).toContain("mergedEvidenceCeiling");
		expect(reference).toContain("mass-delete-suppressed");
		expect(reference).toContain("search-root-unavailable");
	});

	it("documents autorag setup command and CLI-backed credential ownership", () => {
		const setup = readSkill("autorag-setup");
		expect(setup).toContain("autorag setup");
		expect(setup).toMatch(/CLI-backed datasources own their own/);
		expect(setup).toMatch(/Discord uses discrawl's local\s+desktop wiretap archive/);
		const mainSkill = readSkill("autorag");
		expect(mainSkill).toContain("autorag setup --format json");
		expect(mainSkill).not.toMatch(/autorag gateway/);
	});
});

describe("optional-support marker from the shipped skill", () => {
	function isolated(
		run: (fixture: { home: string; markerHome: string; claim: (overrides?: NodeJS.ProcessEnv) => string }) => void,
	): void {
		const root = mkdtempSync(join(tmpdir(), "autorag-support-skill-"));
		try {
			const support = section(readSkill("autorag-setup"), "Star the repository \\(final step\\)");
			const snippets = [...support.matchAll(/```javascript\r?\n([\s\S]*?)```/g)];
			expect(snippets).toHaveLength(1);
			const script = join(root, "claim.mjs");
			writeFileSync(script, snippets[0][1]);
			const home = join(root, "home");
			const markerHome = join(root, "autorag");
			mkdirSync(home);
			const claim = (overrides: NodeJS.ProcessEnv = {}): string => {
				const child = spawnSync(process.execPath, [script], {
					cwd: root,
					encoding: "utf8",
					timeout: 5000,
					env: {
						HOME: home,
						USERPROFILE: home,
						AUTORAG_HOME: markerHome,
						AUTORAG_CONFIG: join(markerHome, "config.json"),
						PATH: root,
						SystemRoot: process.env.SystemRoot,
						WINDIR: process.env.WINDIR,
						...overrides,
					},
				});
				expect(child.error).toBeUndefined();
				expect(child.status).toBe(0);
				expect(child.stderr).toBe("");
				return child.stdout.trim();
			};
			run({ home, markerHome, claim });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}

	it("claims once before an answer without touching an existing AutoRAG config", () => {
		isolated(({ markerHome, claim }) => {
			mkdirSync(markerHome);
			const config = join(markerHome, "config.json");
			writeFileSync(config, '{"keep":"unchanged"}\n');
			expect(claim()).toBe("ask");
			expect(claim()).toBe("skip");
			expect(readFileSync(config, "utf8")).toBe('{"keep":"unchanged"}\n');
			expect(readdirSync(markerHome).sort()).toEqual(["config.json", "star-prompted"]);
		});
	});

	it("preserves an existing marker rather than resetting a prior decline", () => {
		isolated(({ markerHome, claim }) => {
			mkdirSync(markerHome);
			const marker = join(markerHome, "star-prompted");
			writeFileSync(marker, "declined\n");
			expect(claim()).toBe("skip");
			expect(readFileSync(marker, "utf8")).toBe("declined\n");
		});
	});

	it.each([{ CI: "" }, { CI: "false" }, { AUTORAG_NO_STAR: "" }, { AUTORAG_NO_STAR: "0" }])(
		"does not create state when an opt-out variable is present: %o",
		(overrides) => {
			isolated(({ markerHome, claim }) => {
				expect(claim(overrides)).toBe("skip");
				expect(existsSync(markerHome)).toBe(false);
			});
		},
	);

	it("skips a storage error without replacing the conflicting file", () => {
		isolated(({ markerHome, claim }) => {
			writeFileSync(markerHome, "not a directory\n");
			expect(claim()).toBe("skip");
			expect(readFileSync(markerHome, "utf8")).toBe("not a directory\n");
		});
	});

	it("shares the default home marker across fresh processes", () => {
		isolated(({ home, claim }) => {
			expect(claim({ AUTORAG_HOME: undefined })).toBe("ask");
			expect(claim({ AUTORAG_HOME: undefined })).toBe("skip");
			expect(existsSync(join(home, ".autorag", "star-prompted"))).toBe(true);
		});
	});
});
