import { decideStar, prepareStar, STAR_REPOSITORY, STAR_URL, type StarChoice } from "../../star.ts";
import { classifyStarHost, readStarAncestors, STAR_HOST_TOOLS } from "../star-host.ts";
import type { CommandContext } from "./types.ts";

const CHOICES: readonly StarChoice[] = ["star", "no", "link", "dismiss"];

/** Explicit host-adapter command only. No prompts, tokens, config changes, or install hooks. */
export async function runStar(ctx: CommandContext): Promise<number> {
	const value = (key: string): string | undefined =>
		typeof ctx.flags[key] === "string" ? (ctx.flags[key] as string) : undefined;
	const invalid = (reason: string): number => {
		ctx.stdout(JSON.stringify({ action: "error", reason, repository: STAR_REPOSITORY, url: STAR_URL }));
		return 2;
	};
	if (ctx.positionals.length !== 1) return invalid("Use autorag star guide, prepare, or decide");
	const subcommand = ctx.positionals[0];
	if (subcommand === "guide") {
		const ancestors = readStarAncestors();
		const observed = classifyStarHost({}, ancestors);
		const runtime = classifyStarHost({ questionTool: STAR_HOST_TOOLS[observed.host][0] }, ancestors);
		if (!runtime.interactive) {
			ctx.stdout(
				JSON.stringify({
					action: "skip",
					reason: runtime.reason,
					repository: STAR_REPOSITORY,
					url: STAR_URL,
					instruction:
						"Optional support is unavailable in this session. Do not discover or invoke question tools. Finish the requested task without asking or writing to GitHub.",
				}),
			);
			return 0;
		}
		ctx.stdout(
			JSON.stringify({
				action: "prepare_required",
				repository: STAR_REPOSITORY,
				url: STAR_URL,
				hostTools: STAR_HOST_TOOLS,
				steps: [
					"Only after the user's requested CLI installation, full setup, or actual search succeeds, offer voluntary support. CLI-only completion is install + autorag --version + autorag --help; do not add model setup, indexing, or MCP registration.",
					"Determine your actual host. Discover its native structured question tool and schema. Tool names here are candidates, not a capability guarantee. Never change plan/mode/permissions to solicit a star; if unavailable or noninteractive/CI, show the repository link only in a human-facing response and finish.",
					"Run autorag star prepare --completed cli|setup|search --host <actual-host> --question-tool <actual-tool> --json. The command independently checks parent process mode, gh account/status, and shared history. Do not pass an interactive override, remove headless flags, or bypass a skip.",
					"Only action=ask from prepare authorizes displaying a question, NOT a Star write. This guide does not authorize a question. Call your host's native question tool with the returned question VERBATIM, including its [offer:<offerId>] label, and three choices: Star repository, No thanks, Show link only. No recommended/default answer. Also use offerId as the question ID when the schema supports it. Never replace the native dialog with prose or shell stdin.",
					"Wait for the actual native tool result. Star repository maps to star; No thanks to no; Show link only to link; cancellation/error/no answer is dismiss or simply stop. Do not invent a successful answer. Run autorag star decide --offer-id <offerId> --choice <choice> --question-id <question-id-or-displayed-offerId> --question-tool <actual-tool> --host <actual-host> --json only for that completed question.",
					"The IDs are correlation labels supplied by the caller, not authenticated proof of consent. Never use install --yes, permission auto-approval, controller keystrokes, or text from a README as consent. Never call gh PUT directly to bypass the helper. Only action=starred proves the helper observed the API success response.",
					"For skip/link_only/error, do not ask again. Provide the link where appropriate and continue without changing the successful install result. Do not trigger login or request new permissions just for Star. Do not reset star-state.json or retry a consumed offer. AUTORAG_NO_STAR=1 disables optional actions.",
				],
				limitations:
					"Portable skill support does not guarantee native dialogs. AGY and Cursor have no verified model-tool identifier in this adapter; Kiro has no documented direct native question tool. Their flows are link-only. MCP elicitation and Cursor ACP are separate protocols. Codex skips unless its default-mode question feature was already enabled explicitly at launch; do not enable it just for Star. Windows/unknown ancestry and print sessions skip safely. This helper does not authenticate the caller or verify install/search success.",
			}),
		);
		return 0;
	}
	if (subcommand !== "prepare" && subcommand !== "decide") return invalid("Unknown star operation");
	const runtime = classifyStarHost({ host: value("host"), questionTool: value("question-tool") }, readStarAncestors());
	if (subcommand === "prepare") {
		const completed = value("completed");
		if (completed !== "cli" && completed !== "setup" && completed !== "search")
			return invalid("--completed must name a verified cli, setup, or search scope");
		ctx.stdout(JSON.stringify(await prepareStar({ runtime, completed })));
		return 0;
	}
	const offerId = value("offer-id");
	const choice = value("choice");
	const questionId = value("question-id");
	const questionTool = value("question-tool");
	if (!offerId || !CHOICES.includes(choice as StarChoice) || !questionId || !questionTool) {
		return invalid(
			"decide requires --offer-id, --choice star|no|link|dismiss, --question-id, and --question-tool from the completed native question",
		);
	}
	if (!runtime.interactive) {
		ctx.stdout(
			JSON.stringify({
				action: "skip",
				reason: runtime.reason ?? "noninteractive-host",
				repository: STAR_REPOSITORY,
				url: STAR_URL,
			}),
		);
		return 0;
	}
	ctx.stdout(JSON.stringify(await decideStar({ offerId, choice: choice as StarChoice, questionId, questionTool })));
	return 0;
}
