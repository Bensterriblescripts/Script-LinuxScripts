import type { ExtensionAPI, ExtensionContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { CustomEditor, DynamicBorder, getMarkdownTheme, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	matchesKey,
	Text,
	truncateToWidth,
	type AutocompleteItem,
	type AutocompleteProvider,
	type EditorOptions,
	type EditorTheme,
	type TUI,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

type Intent = "auto" | "plan" | "learn" | "research" | "content" | "decide";
type ResearchMode = "off" | "ask" | "auto";
type GrillPhase = "research" | "interview" | "output-selection" | "output";

interface GrillAlternative {
	value: string;
	label: string;
	description?: string;
}

interface GrillState {
	pendingPlan?: { path: string; markdown: string };
	active: boolean;
	topic: string;
	intent: Intent;
	outputPreference: string;
	researchMode: ResearchMode;
	checkpoint: string;
	phase: GrillPhase;
	outputPhase: boolean;
	outputSelection?: {
		readinessRationale: string;
		recommendedOutputs: string;
		recommendedStrategy: string;
		question: string;
	};
	approvedOutputPlan?: string;
	alternatives: GrillAlternative[];
	currentQuestion?: string;
	updatedAt: number;
	lastChangeSummary?: string;
}

const STATE_ENTRY_TYPE = "grill-me-state";
const LEGACY_DEFAULT_OUTPUT_PREFERENCE = "design-doc by default; adapt/recommend near readiness";

const DEFAULT_STATE: GrillState = {
	active: false,
	topic: "",
	intent: "auto",
	outputPreference: "",
	researchMode: "auto",
	checkpoint: "",
	phase: "interview",
	outputPhase: false,
	outputSelection: undefined,
	approvedOutputPlan: undefined,
	alternatives: [],
	currentQuestion: undefined,
	updatedAt: Date.now(),
};

const INTENTS = ["auto", "plan", "learn", "research", "content", "decide"] as const;
const RESEARCH_MODES = ["off", "ask", "auto"] as const;



function cloneState(state: GrillState): GrillState {
	return { ...state };
}

function describeOutputPreference(state: GrillState): string {
	const preference = typeof state.outputPreference === "string" ? state.outputPreference.trim() : "";
	return preference || "implementation plan with automatic fresh-session implementation";
}

function currentPhase(state: GrillState): GrillPhase {
	if (state.outputPhase) return "output";
	return state.phase ?? "interview";
}

function phaseLabel(state: GrillState): string {
	return `${currentPhase(state)}; read-only until automatic fresh-session handoff`;
}

function initialCheckpoint(topic: string, state: GrillState): string {
	return `# Shared Understanding

## Topic

${topic}

## Current Understanding

We are starting a grill-me session to reach shared understanding before producing outputs or implementation work.

## Working Configuration

- Intent: ${state.intent}
- Grilling style: thorough Socratic interview
- Research mode: ${state.researchMode}
- Initial research: ${state.phase === "research" ? "pending; inspect relevant local code/docs first, then use web search to gather relevant factual context and anecdotal perspectives when useful" : "skipped; research mode is off"}
- Output preference: ${describeOutputPreference(state)}

## Decisions

- Grill mode uses a single thorough default style.
- Grill mode should adapt to the subject rather than force hardcoded interview phases.
- When shared understanding is sufficient, save the implementation plan and immediately start implementation in a fresh session.
- Do not present a final output menu, readiness choice, or implementation approval question. /grill stop cancels without implementation.

## Assumptions

- The checkpoint should evolve as meaningful understanding changes.
- Follow-up questions should resolve consequential ambiguities; non-blocking details may be explicitly deferred.

## Risks / Unknowns

- The user's desired outcome mode and output set may still be ambiguous.
- Some branches may need to be explicitly deferred if they are not worth resolving now.

## Coverage Checklist

Use this as an adaptive checklist, not a rigid phase order. Mark each branch resolved, intentionally deferred, or still open.

- [ ] Desired outcome and success criteria
- [ ] Scope boundaries and non-goals
- [ ] User/audience/stakeholder context
- [ ] Constraints, dependencies, and available resources
- [ ] Alternatives, tradeoffs, and decision criteria
- [ ] Risks, failure modes, edge cases, and open unknowns
- [ ] Validation, testing, or evidence plan
- [ ] Rollout/next steps and ownership
- [ ] Self-contained implementation plan ready for automatic handoff

## Decision Branches

- Root: clarify the user's desired outcome and success criteria, then follow dependent branches one at a time.

## Open Questions

- What outcome is the user ultimately trying to achieve with this topic?
- What constraints or risks should shape the next branch of questioning?
- What context must the fresh implementation session retain?
`;
}

function statusMarkdown(state: GrillState): string {
	return `# Grill Status

- Active: ${state.active ? "yes" : "no"}
- Topic: ${state.topic || "(none)"}
- Intent: ${state.intent}
- Style: thorough default
- Research: ${state.researchMode}
- Phase: ${phaseLabel(state)}
- Output preference: ${describeOutputPreference(state)}
${state.outputSelection ? `- Output selection rationale: ${state.outputSelection.readinessRationale}
- Recommended outputs: ${state.outputSelection.recommendedOutputs}
- Recommended strategy: ${state.outputSelection.recommendedStrategy}
` : ""}${state.approvedOutputPlan ? `- Approved output plan: ${state.approvedOutputPlan}
` : ""}- Current question: ${state.currentQuestion || "(none)"}
- Tab alternatives: ${state.alternatives.length ? state.alternatives.map((a) => a.label).join(" | ") : "(none set)"}
- Checkpoint last updated: ${state.updatedAt ? new Date(state.updatedAt).toLocaleString() : "never"}
${state.lastChangeSummary ? `- Last checkpoint change: ${state.lastChangeSummary}
` : ""}`;
}

function normalizeAlternatives(alternatives: GrillAlternative[]): GrillAlternative[] {
	return alternatives
		.map((alt) => ({
			value: String(alt.value ?? "").trim(),
			label: String(alt.label ?? alt.value ?? "").trim(),
			description: alt.description ? String(alt.description).trim() : undefined,
		}))
		.filter((alt) => alt.value && alt.label)
		.slice(0, 5);
}

function comparableReplyText(text: string): string {
	return text.replace(/\r\n/g, "\n").trim();
}

function nextAlternativeIndexForText(text: string, alternatives: GrillAlternative[], direction: 1 | -1): number {
	if (alternatives.length === 0) return -1;

	const current = comparableReplyText(text);
	if (!current) return direction > 0 ? 0 : alternatives.length - 1;

	const exactIndex = alternatives.findIndex((alt) => comparableReplyText(alt.value) === current);
	if (exactIndex >= 0) return (exactIndex + direction + alternatives.length) % alternatives.length;

	// Let Tab accept a short typed filter, but avoid replacing a free-form sentence.
	if (/\s/.test(current)) return -1;

	const query = current.toLowerCase();
	return alternatives.findIndex((alt) => alt.label.toLowerCase().includes(query) || alt.value.toLowerCase().includes(query));
}

class GrillReplyEditor extends CustomEditor {
	constructor(
		tui: TUI,
		theme: EditorTheme,
		private readonly grillKeybindings: KeybindingsManager,
		private readonly getGrillState: () => GrillState,
		options?: EditorOptions,
	) {
		super(tui, theme, grillKeybindings, options);
	}

	override handleInput(data: string): void {
		if (!this.isShowingAutocomplete()) {
			if (this.grillKeybindings.matches(data, "tui.input.tab") && this.cycleGrillAlternative(1)) return;
			if (matchesKey(data, "shift+tab") && this.cycleGrillAlternative(-1)) return;
		}

		super.handleInput(data);
	}

	private cycleGrillAlternative(direction: 1 | -1): boolean {
		const activeState = this.getGrillState();
		if (!activeState.active || activeState.alternatives.length === 0) return false;

		const nextIndex = nextAlternativeIndexForText(this.getText(), activeState.alternatives, direction);
		if (nextIndex < 0) return false;

		this.setText(activeState.alternatives[nextIndex].value);
		this.tui.requestRender();
		return true;
	}
}

function createGrillAutocompleteProvider(current: AutocompleteProvider, getState: () => GrillState): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const activeState = getState();
			if (!activeState.active || activeState.alternatives.length === 0) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const line = lines[cursorLine] ?? "";
			const beforeCursor = line.slice(0, cursorCol);
			const afterCursor = line.slice(cursorCol);
			const tokenMatch = beforeCursor.match(/([^\s]*)$/);
			const token = tokenMatch?.[1] ?? "";
			const textBeforeToken = beforeCursor.slice(0, beforeCursor.length - token.length);
			const onlyTypingReply = lines.slice(0, cursorLine).join("\n").trim() === "" && textBeforeToken.trim() === "" && afterCursor.trim() === "" && lines.slice(cursorLine + 1).join("\n").trim() === "";
			if (!onlyTypingReply) return current.getSuggestions(lines, cursorLine, cursorCol, options);

			const query = token.toLowerCase();
			const items = activeState.alternatives
				.filter((alt) => !query || alt.label.toLowerCase().includes(query) || alt.value.toLowerCase().includes(query))
				.map((alt): AutocompleteItem => ({ value: alt.value, label: alt.label, description: alt.description }));
			if (items.length === 0) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			return { prefix: token, items };
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

function parseArgs(args: string): { flags: Record<string, string | true>; rest: string } {
	const tokens = args.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
	const flags: Record<string, string | true> = {};
	const rest: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i].replace(/^"|"$/g, "");
		if (token.startsWith("--")) {
			const eq = token.indexOf("=");
			if (eq > 2) {
				flags[token.slice(2, eq)] = token.slice(eq + 1);
			} else {
				const key = token.slice(2);
				const next = tokens[i + 1]?.replace(/^"|"$/g, "");
				if (next && !next.startsWith("--")) {
					flags[key] = next;
					i++;
				} else {
					flags[key] = true;
				}
			}
		} else {
			rest.push(token);
		}
	}
	return { flags, rest: rest.join(" ").trim() };
}

function asIntent(value: unknown): Intent | undefined {
	return typeof value === "string" && (INTENTS as readonly string[]).includes(value) ? (value as Intent) : undefined;
}


function asResearchMode(value: unknown): ResearchMode | undefined {
	return typeof value === "string" && (RESEARCH_MODES as readonly string[]).includes(value) ? (value as ResearchMode) : undefined;
}

function firstWord(text: string): string {
	return text.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
}

function shellSegments(command: string): string[] {
	return command
		.split(/&&|\|\||;|\n/) // pipelines are handled separately to avoid flagging read-only grep pipelines as mutating.
		.map((s) => s.trim())
		.filter(Boolean);
}

function isReadOnlyGit(args: string[]): boolean {
	const sub = args[1];
	return ["status", "log", "diff", "show", "branch", "grep", "ls-files", "remote", "rev-parse", "describe"].includes(sub);
}

function isReadOnlyGh(args: string[]): boolean {
	const sub = args[1];
	const sub2 = args[2];
	if (["status", "auth", "repo", "pr", "issue", "label", "milestone"].includes(sub) === false) return false;
	if (sub === "repo") return [undefined, "view", "list"].includes(sub2);
	if (sub === "issue") return [undefined, "list", "view", "status"].includes(sub2);
	if (sub === "pr") return [undefined, "list", "view", "status", "diff", "checks"].includes(sub2);
	if (sub === "label" || sub === "milestone") return [undefined, "list", "view"].includes(sub2);
	return true;
}

function isProbablyReadOnlyBash(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed) return true;

	// Redirection and common write helpers are mutations even if the command itself is read-only.
	if (/(^|[^<])>(>|&)?\s*\S/.test(trimmed) || /\btee\b/.test(trimmed)) return false;

	const definitelyMutating = /\b(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|sudo|kill|pkill|reboot|shutdown|curl\s+.*\|\s*(sh|bash)|wget\s+.*\|\s*(sh|bash))\b/;
	if (definitelyMutating.test(trimmed)) return false;

	const unsafePhrases = [
		"git add",
		"git commit",
		"git push",
		"git checkout",
		"git switch",
		"git reset",
		"git merge",
		"git rebase",
		"npm install",
		"npm i",
		"npm add",
		"pnpm install",
		"pnpm add",
		"yarn add",
		"yarn install",
		"pip install",
		"cargo install",
		"cargo add",
		"gh issue create",
		"gh issue edit",
		"gh issue close",
		"gh pr create",
		"gh pr edit",
	];
	const lower = trimmed.toLowerCase();
	if (unsafePhrases.some((phrase) => lower.includes(phrase))) return false;

	for (const segment of shellSegments(trimmed)) {
		const args = segment.split(/\s+/);
		const cmd = args[0];
		if (!cmd) continue;
		if (["cat", "head", "tail", "less", "more", "grep", "rg", "find", "fd", "ls", "pwd", "tree", "wc", "sort", "uniq", "cut", "awk", "sed", "date", "whoami", "uname", "which", "where", "echo"].includes(cmd)) {
			continue;
		}
		if (["npm", "pnpm", "yarn"].includes(cmd)) {
			if (["list", "outdated", "view", "info", "why"].includes(args[1])) continue;
			return false;
		}
		if (cmd === "git") {
			if (isReadOnlyGit(args)) continue;
			return false;
		}
		if (cmd === "gh") {
			if (isReadOnlyGh(args)) continue;
			return false;
		}
		// Unknown commands may mutate; block in grill interview mode.
		return false;
	}
	return true;
}

export default function grillMeExtension(pi: ExtensionAPI): void {
	let state: GrillState = cloneState(DEFAULT_STATE);
	let savingPlan = false;

	function persist(): void {
		state.updatedAt = Date.now();
		pi.appendEntry(STATE_ENTRY_TYPE, cloneState(state));
	}

	function updateUi(ctx: ExtensionContext): void {
		if (!state.active) {
			ctx.ui.setStatus("grill-me", undefined);
			ctx.ui.setWidget("grill-me", undefined);
			return;
		}

		const phase = currentPhase(state);
		const status = phase === "research" ? "🔥 grill: researching" : "🔥 grill";
		ctx.ui.setStatus("grill-me", ctx.ui.theme.fg(phase === "output" ? "warning" : phase === "output-selection" ? "success" : "accent", status));

		const topic = state.topic.length > 90 ? `${state.topic.slice(0, 87)}...` : state.topic;
		const lines = [
			ctx.ui.theme.fg("accent", `🔥 Grill Me: ${topic || "active"}`),
			ctx.ui.theme.fg("muted", `intent=${state.intent} style=thorough research=${state.researchMode}`),
			ctx.ui.theme.fg("dim", `Phase: ${phaseLabel(state)}`),
		];
		if (state.alternatives.length > 0) {
			lines.push(ctx.ui.theme.fg("accent", "Tab: fill/cycle replies • Shift+Tab previous • Enter sends"));
			for (const alternative of state.alternatives) {
				const description = alternative.description ? ` — ${alternative.description}` : "";
				lines.push(ctx.ui.theme.fg("muted", `  • ${alternative.label}${description}`));
			}
		}
		ctx.ui.setWidget("grill-me", lines, { placement: "belowEditor" });
	}

	function startSession(topic: string, ctx: ExtensionContext, partial: Partial<GrillState> = {}): void {
		state = {
			...cloneState(DEFAULT_STATE),
			...partial,
			active: true,
			topic,
			phase: "interview",
			outputPhase: false,
			outputSelection: undefined,
			approvedOutputPlan: undefined,
		};
		state.phase = state.researchMode === "off" ? "interview" : "research";
		state.checkpoint = initialCheckpoint(topic, state);
		state.lastChangeSummary = "Started grill session";
		persist();
		updateUi(ctx);

		const kickoff = state.phase === "research"
			? "Begin the initial read-only research stage before normal interview questions. Inspect relevant local code and documentation first; use web_search to gather relevant factual context and anecdotal perspectives when useful. Respect research-mode permission requirements."
			: "Initial research is skipped because research mode is off. Begin the interview.";
		pi.sendUserMessage(`Start a Grill Me session for this requested change:\n\n${topic}\n\nUse the existing conversation and available summaries as background context, preserving prior user decisions and constraints. The explicit change above defines the scope; do not substitute an inferred topic or treat assistant suggestions as confirmed requirements.\n\n${kickoff}`, { deliverAs: "steer" });
	}

	async function showCheckpointOverlay(ctx: ExtensionContext): Promise<"edit" | undefined> {
		if (!ctx.hasUI) {
			pi.sendMessage({ customType: "grill-me-checkpoint", content: state.checkpoint, display: true });
			return undefined;
		}

		return await ctx.ui.custom<"edit" | undefined>(
			(tui, theme, _keybindings, done) => {
				const border = new DynamicBorder((s: string) => theme.fg("accent", s));
				const markdown = new Markdown(state.checkpoint, 1, 0, getMarkdownTheme());
				let scrollOffset = 0;
				let cachedWidth = 0;
				let cachedBody: string[] = [];
				const maxBodyLines = 16;

				function bodyLines(width: number): string[] {
					if (cachedWidth !== width || cachedBody.length === 0) {
						cachedWidth = width;
						cachedBody = markdown.render(width);
					}
					return cachedBody;
				}

				function maxOffset(): number {
					return Math.max(0, cachedBody.length - maxBodyLines);
				}

				function move(delta: number): void {
					scrollOffset = Math.max(0, Math.min(maxOffset(), scrollOffset + delta));
					tui.requestRender();
				}

				return {
					render(width: number) {
						const body = bodyLines(width);
						scrollOffset = Math.min(scrollOffset, maxOffset());
						const visible = body.slice(scrollOffset, scrollOffset + maxBodyLines);
						const range = body.length > maxBodyLines ? `lines ${scrollOffset + 1}-${Math.min(scrollOffset + maxBodyLines, body.length)} of ${body.length}` : "full checkpoint";
						return [
							...border.render(width),
							truncateToWidth(theme.fg("accent", theme.bold("🔥 Grill Me Checkpoint")), width),
							truncateToWidth(theme.fg("dim", `${range} • ↑↓/PgUp/PgDn scroll • e edit • Enter/Esc close`), width),
							...visible.map((line) => truncateToWidth(line, width, "")),
							...border.render(width),
						];
					},
					invalidate() {
						border.invalidate();
						markdown.invalidate();
						cachedWidth = 0;
						cachedBody = [];
					},
					handleInput(data: string) {
						if (matchesKey(data, "escape") || matchesKey(data, "enter")) done(undefined);
						else if (matchesKey(data, "e")) done("edit");
						else if (matchesKey(data, "up")) move(-1);
						else if (matchesKey(data, "down")) move(1);
						else if (matchesKey(data, "pageUp")) move(-maxBodyLines);
						else if (matchesKey(data, "pageDown")) move(maxBodyLines);
					},
				};
			},
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: "80%", minWidth: 50, maxHeight: "80%", margin: 2 },
			},
		);
	}

	async function showCheckpoint(ctx: ExtensionContext, mode?: string): Promise<void> {
		if (!state.checkpoint.trim()) {
			ctx.ui.notify("No grill checkpoint yet.", "warning");
			return;
		}

		const selected = mode?.trim().toLowerCase() || "overlay";
		if (selected.includes("edit")) {
			const edited = await ctx.ui.editor("Edit Grill Me checkpoint", state.checkpoint);
			if (edited !== undefined) {
				state.checkpoint = edited.trim() || state.checkpoint;
				state.lastChangeSummary = "Checkpoint edited by user";
				persist();
				updateUi(ctx);
				ctx.ui.notify("Grill checkpoint updated.", "info");
			}
			return;
		}

		if (selected.includes("chat")) {
			pi.sendMessage({ customType: "grill-me-checkpoint", content: state.checkpoint, display: true });
			return;
		}

		const action = await showCheckpointOverlay(ctx);
		if (action === "edit") {
			await showCheckpoint(ctx, "edit");
		}
	}

	pi.registerCommand("checkpoint", {
		description: "Show the current Grill Me checkpoint in an overlay",
		handler: async (args, ctx) => {
			await showCheckpoint(ctx, args.trim());
		},
	});

	pi.registerCommand("grill", {
		description: "Start or control a Socratic Grill Me planning session",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const command = firstWord(trimmed);
			const rest = trimmed.slice(command.length).trim();

			if (command === "help") {
				pi.sendMessage({
					customType: "grill-me-help",
					content: `# Grill Me commands\n\n- /grill <topic>\n- /grill stop\n- /checkpoint [edit|chat]\n- /grill checkpoint [edit|chat]\n- /grill status\n- /grill intent auto|plan|learn|research|content|decide\n- /grill output <one or more outputs> (deliverables to include in the implementation plan)\n- /grill research off|ask|auto\n\nGrill Me uses one thorough default Socratic style. When requirements are resolved, it saves the plan and immediately starts implementation in a fresh session, without a final menu or approval question. /grill stop cancels without implementation.`,
					display: true,
				});
				return;
			}

			if (command === "stop") {
				state.pendingPlan = undefined;
				state.active = false;
				state.phase = "interview";
				state.outputPhase = false;
				state.outputSelection = undefined;
				state.approvedOutputPlan = undefined;
				state.currentQuestion = undefined;
				state.alternatives = [];
				state.lastChangeSummary = "Stopped grill session";
				persist();
				updateUi(ctx);
				ctx.ui.notify("Grill mode stopped.", "info");
				return;
			}

			if (command === "status") {
				pi.sendMessage({ customType: "grill-me-status", content: statusMarkdown(state), display: true });
				return;
			}

			if (command === "checkpoint") {
				await showCheckpoint(ctx, rest);
				return;
			}

			if (command === "intent") {
				const value = asIntent(rest);
				if (!value) {
					ctx.ui.notify(`Usage: /grill intent ${INTENTS.join("|")}`, "warning");
					return;
				}
				state.intent = value;
				state.lastChangeSummary = `Intent set to ${value}`;
				persist();
				updateUi(ctx);
				ctx.ui.notify(`Grill intent: ${value}`, "info");
				return;
			}

			if (command === "output") {
				if (!rest) {
					ctx.ui.notify("Usage: /grill output <one or more outputs, e.g. design-doc,issues>", "warning");
					return;
				}
				state.outputPreference = rest;
				state.lastChangeSummary = `Output preference set to ${rest}`;
				persist();
				updateUi(ctx);
				ctx.ui.notify(`Grill output preference: ${rest}. These deliverables will be included in the plan for automatic fresh-session implementation.`, "info");
				return;
			}

			if (command === "research") {
				const value = asResearchMode(rest);
				if (!value) {
					ctx.ui.notify(`Usage: /grill research ${RESEARCH_MODES.join("|")}`, "warning");
					return;
				}
				state.researchMode = value;
				if (value === "off" && state.phase === "research") {
					state.phase = "interview";
					state.currentQuestion = undefined;
					state.alternatives = [];
					state.checkpoint += "\n\n## Initial Research Override\n\nRemaining initial research skipped by /grill research off. Continue the interview with available evidence.\n";
				}
				state.lastChangeSummary = `Research mode set to ${value}`;
				persist();
				updateUi(ctx);
				ctx.ui.notify(`Grill research mode: ${value}`, "info");
				return;
			}

			const parsed = parseArgs(trimmed);
			const partial: Partial<GrillState> = {};
			const intent = asIntent(parsed.flags.intent);
			const researchMode = asResearchMode(parsed.flags.research);
			if (intent) partial.intent = intent;
			if (researchMode) partial.researchMode = researchMode;
			if (typeof parsed.flags.output === "string") partial.outputPreference = parsed.flags.output;

			let topic = parsed.rest;
			if (!topic) {
				if (!ctx.hasUI) {
					pi.sendMessage({ customType: "grill-me", content: "Provide the requested change with /grill <change>.", display: true });
					return;
				} else {
					const edited = await ctx.ui.editor("What change would you like to make?", "");
					if (!edited?.trim()) {
						ctx.ui.notify("Cancelled grill start.", "info");
						return;
					}
					topic = edited.trim();
				}
			}

			startSession(topic, ctx, partial);
		},
	});

	pi.registerTool({
		name: "grill_finish_research",
		label: "Finish Grill Research",
		description: "Record initial research findings in the full shared-understanding checkpoint and transition to the normal Grill interview.",
		promptSnippet: "Complete initial local-first research before normal Grill interview questions",
		promptGuidelines: [
			"During the initial Grill research phase, call grill_finish_research alone after inspecting relevant local code/docs first and using web_search to gather relevant factual context and anecdotal perspectives when useful. Record evidence, paths, sources, constraints and unresolved questions; then briefly summarize findings and continue the interview without approval.",
		],
		parameters: Type.Object({
			markdown: Type.String({ minLength: 1, description: "Full replacement checkpoint preserving requirements and decisions, with research findings, relevant paths, external sources if used, constraints, and unresolved questions. Explicitly record unavailable evidence or declined research." }),
			changeSummary: Type.String({ minLength: 1, description: "Brief visible summary of research findings." }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			if (!state.active || currentPhase(state) !== "research") throw new Error("An active initial Grill research phase is required.");
			const markdown = params.markdown.trim();
			const summary = params.changeSummary.trim();
			if (!markdown || !summary) throw new Error("Research checkpoint and summary must not be empty.");
			state.checkpoint = markdown;
			state.phase = "interview";
			state.alternatives = [];
			state.currentQuestion = undefined;
			state.lastChangeSummary = summary;
			persist();
			updateUi(ctx);
			return {
				content: [{ type: "text", text: `Research recorded: ${summary}\nInitial research is complete. Briefly summarize findings, then continue the normal interview now, using grill_set_alternatives before the next question. Do not ask for approval to continue.` }],
				details: { checkpoint: state.checkpoint, phase: state.phase, changeSummary: summary },
			};
		},
	});

	pi.registerTool({
		name: "grill_update_checkpoint",
		label: "Update Grill Checkpoint",
		description: "Replace the Grill Me shared-understanding checkpoint. Use before asking the next grill question whenever meaningful understanding changes.",
		promptSnippet: "Persist the evolving Grill Me shared-understanding Markdown checkpoint",
		promptGuidelines: [
			"Use grill_update_checkpoint before asking the next question whenever an active Grill Me session reaches a meaningful new decision, clarification, assumption, risk, or open question.",
		],
		parameters: Type.Object({
			markdown: Type.String({ description: "The full replacement Markdown checkpoint." }),
			changeSummary: Type.String({ description: "Brief visible summary of what changed." }),
		}),
		async execute(_toolCallId, params) {
			if (!state.active) {
				return {
					content: [{ type: "text", text: "No active Grill Me session. Start one with /grill <topic>." }],
					details: { checkpoint: state.checkpoint, changeSummary: "No active session", updatedAt: state.updatedAt },
				};
			}
			state.checkpoint = params.markdown;
			state.lastChangeSummary = params.changeSummary;
			persist();
			return {
				content: [{ type: "text", text: `Recorded checkpoint update: ${params.changeSummary}` }],
				details: { checkpoint: state.checkpoint, changeSummary: params.changeSummary, updatedAt: state.updatedAt },
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("grill_update_checkpoint ")) + theme.fg("muted", args.changeSummary ?? ""), 0, 0);
		},
		renderResult(result, _options, theme) {
			const summary = (result.details as any)?.changeSummary;
			const text = summary ? `✓ ${summary}` : result.content[0]?.type === "text" ? result.content[0].text : "Checkpoint updated";
			return new Text(theme.fg("success", text), 0, 0);
		},
	});

	pi.registerTool({
		name: "grill_set_alternatives",
		label: "Set Grill Alternatives",
		description: "Set the visible Grill Me answer alternatives offered to the user via Tab autocomplete for the next question.",
		promptSnippet: "Present answer alternatives through the Grill Me Tab autocomplete UX",
		promptGuidelines: [
			"Before asking each grill question, call grill_set_alternatives with 2-5 concise, concrete alternatives the user can accept or edit with Tab autocomplete.",
			"Include one recommended alternative and make it clear in the label or description.",
			"Use alternatives that are useful defaults, not exhaustive menus; the user can still type a custom answer.",
		],
		parameters: Type.Object({
			question: Type.String({ description: "The question these alternatives answer." }),
			alternatives: Type.Array(
				Type.Object({
					value: Type.String({ description: "The exact reply inserted into the user's editor when selected." }),
					label: Type.String({ description: "Short visible label for the alternative." }),
					description: Type.Optional(Type.String({ description: "Brief explanation or recommendation note." })),
				}),
				{ description: "2-5 suggested replies. Include a recommended/default option." },
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!state.active) {
				return {
					content: [{ type: "text", text: "No active Grill Me session. Start one with /grill <topic>." }],
					details: { alternatives: [] },
				};
			}
			state.currentQuestion = params.question;
			state.alternatives = normalizeAlternatives(params.alternatives as GrillAlternative[]);
			state.lastChangeSummary = `Set ${state.alternatives.length} Tab alternatives`;
			persist();
			if (ctx) updateUi(ctx);
			return {
				content: [{ type: "text", text: `Tab alternatives updated: ${state.alternatives.map((a) => a.label).join(", ")}` }],
				details: { question: state.currentQuestion, alternatives: state.alternatives },
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("grill_set_alternatives ")) + theme.fg("muted", args.question ?? ""), 0, 0);
		},
		renderResult(result, _options, theme) {
			const alternatives = ((result.details as any)?.alternatives ?? []) as GrillAlternative[];
			const text = alternatives.length ? `✓ Tab alternatives: ${alternatives.map((a) => a.label).join(" | ")}` : "No alternatives set";
			return new Text(theme.fg(alternatives.length ? "success" : "warning", text), 0, 0);
		},
	});

	// Session replacement must run in a command, outside the tool/event lifecycle.
	pi.registerCommand("grill-implement", {
		description: "Start the pending saved Grill plan in a fresh implementation session (also retries a cancelled handoff)",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const pending = state.pendingPlan;
			if (!pending) {
				ctx.ui.notify("No saved Grill plan is pending implementation.", "warning");
				return;
			}
			// Never run a different plan if the file was edited after completion.
			if (await readFile(pending.path, "utf8") !== pending.markdown + "\n") {
				throw new Error(`Saved plan changed; handoff stopped: ${pending.path}`);
			}
			// A stop/new grill or another handoff may have run while reading.
			if (state.pendingPlan !== pending) return;
			const kickoff = pending.markdown + "\n\nImplement this plan.";
			const parentSession = ctx.sessionManager.getSessionFile();
			state.pendingPlan = undefined;
			persist();
			let replaced = false;
			try {
				const result = await ctx.newSession({
					parentSession,
					withSession: async (fresh) => {
						replaced = true;
						fresh.ui.notify(`Implementing plan saved to ${pending.path}`, "info");
						try {
							await fresh.sendUserMessage(kickoff);
						} catch (error) {
							fresh.ui.setEditorText(kickoff);
							fresh.ui.notify(`Could not start implementation; prompt restored in editor: ${error}`, "error");
						}
					},
				});
				if (result.cancelled) {
					state.pendingPlan = pending;
					persist();
					ctx.ui.notify("Session switch cancelled. Plan saved; /grill-implement retries.", "warning");
				}
			} catch (error) {
				if (!replaced) {
					state.pendingPlan = pending;
					persist();
				}
				throw error;
			}
		},
	});

	pi.registerTool({
		name: "grill_finish_output_phase",
		label: "Finish Grill Output Phase",
		description: "Complete Grill Me: save the final Markdown implementation plan and automatically start a fresh session to implement it. Not for cancellation.",
		promptSnippet: "Save the final Grill plan and hand it off for implementation in a fresh session",
		promptGuidelines: [
			"At successful Grill completion, call grill_finish_output_phase alone with the complete self-contained Markdown plan, including decisions, scope, steps, constraints and validation. Do not implement in the interview session.",
			"Once consequential requirements are resolved or explicitly deferred, update the checkpoint and call grill_finish_output_phase directly. Do not ask for output selection, readiness confirmation, or implementation approval. If the user cancels, do not call this tool; use /grill stop.",
		],
		parameters: Type.Object({
			plan: Type.String({ minLength: 1, description: "Full finalized self-contained implementation plan in Markdown, not a filename or brief summary." }),
			summary: Type.Optional(Type.String({ description: "Brief summary of outputs created." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (savingPlan) throw new Error("A Grill plan is already being saved.");
			if (!state.active) throw new Error("An active Grill interview is required.");
			if (currentPhase(state) === "research") throw new Error("Complete initial research with grill_finish_research before saving the final plan.");
			if (ctx.mode !== "tui" && ctx.mode !== "rpc") throw new Error("Automatic session handoff requires interactive Pi (TUI or RPC).");
			const markdown = params.plan.trim();
			if (!markdown) throw new Error("The final plan must not be empty.");
			signal?.throwIfAborted();
			const directory = join(homedir(), ".pi", "agent", "plans");
			const path = join(directory, `grill-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.md`);
			const completingState = state;
			savingPlan = true;
			try {
				await withFileMutationQueue(path, async () => {
					await mkdir(directory, { recursive: true });
					await writeFile(path, markdown + "\n", { encoding: "utf8", flag: "wx", mode: 0o600, signal });
				});
			} finally {
				savingPlan = false;
			}
			signal?.throwIfAborted();
			if (state !== completingState || !state.active) {
				throw new Error(`Grill changed while saving; plan saved but handoff cancelled: ${path}`);
			}
			state.pendingPlan = { path, markdown };
			state.active = false;
			state.phase = "interview";
			state.outputPhase = false;
			state.outputSelection = undefined;
			state.approvedOutputPlan = undefined;
			state.alternatives = [];
			state.currentQuestion = undefined;
			state.lastChangeSummary = `Finished Grill; saved implementation plan to ${path}`;
			persist();
			updateUi(ctx);
			// Command dispatch is opt-in. sendUserMessage is fire-and-forget;
			// the command waits for idle while this tool returns and terminates the run.
			pi.sendUserMessage("/grill-implement", { deliverAs: "followUp", expandPromptTemplates: true });
			return {
				content: [{ type: "text", text: state.lastChangeSummary }],
				details: { planPath: path, handoffQueued: true },
				terminate: true,
			};
		},
	});

	pi.on("tool_call", async (event) => {
		if (!state.active) return;

		if (event.toolName === "grill_finish_output_phase" && currentPhase(state) === "research") {
			return {
				block: true,
				reason: "Complete initial research with grill_finish_research in a separate tool call before saving the final plan.",
			};
		}

		if (event.toolName === "edit" || event.toolName === "write") {
			return {
				block: true,
				reason: "Grill Me remains read-only throughout the interview. When requirements are resolved, call grill_finish_output_phase with the complete plan to save it and start implementation in a fresh session.",
			};
		}

		if (event.toolName === "bash") {
			const command = String((event.input as any)?.command ?? "");
			if (!isProbablyReadOnlyBash(command)) {
				return {
					block: true,
					reason: `Grill Me read-only mode blocked a potentially mutating command. When requirements are resolved, call grill_finish_output_phase with the complete plan; implementation runs in a fresh session, not the interview.\nCommand: ${command}`,
				};
			}
		}
	});

	pi.on("before_agent_start", async (event) => {
		if (!state.active) return;

		const thoroughGrillingGuidance = [
			"Be curious but collaborative: challenge vague answers, surface contradictions, and test assumptions without substituting your preferred approach for the user's intent.",
			"Ask follow-up questions that resolve consequential ambiguities, not low-level implementation details solely to make a plan exhaustive. Do not re-ask settled questions unless new information affects them.",
			"Walk dependent branches one at a time. If an answer changes upstream assumptions, revisit affected downstream decisions before moving on.",
		].join("\n- ");

		const researchGuidance: Record<ResearchMode, string> = {
			off: "Do not proactively inspect files or research. Ask the user instead unless they explicitly provide context.",
			ask: "Ask permission before inspecting local files/code or doing web research. Honor the approved scope and do not repeatedly ask for permission already granted. If research is declined, record the limitation and complete initial research with available context only.",
			auto: "Inspect relevant local code, configuration and documentation first instead of asking questions that files can answer. Use web_search to gather relevant factual context and anecdotal perspectives when useful. Keep research focused and read-only. If web_search is unavailable or fails, record the limitation rather than installing tools or claiming verification. Do not send private code, conversation content or secrets in web queries.",
		};

		const outputPhaseGuidance = "You are in read-only interview mode. Do not implement, write artifacts, create issues, install packages, or run mutating commands here.";

		const prompt = `\n\n[GRILL ME EXTENSION ACTIVE]\nTopic:\n${state.topic}\n\nConfiguration:\n- Intent preset: ${state.intent}\n- Research mode: ${state.researchMode}\n- Output preference: ${describeOutputPreference(state)}\n\nCurrent checkpoint:\n${state.checkpoint || "(No checkpoint yet.)"}\n\nCurrent Tab alternatives:\n${state.alternatives.length ? state.alternatives.map((a) => `- ${a.label}: ${a.value}${a.description ? ` (${a.description})` : ""}`).join("\n") : "(None set.)"}\n\nBehavior:\n- Apply the Socratic method to reach shared understanding of the user's intended outcome, reasoning, and constraints. Understanding the user is the interview's primary goal; the final plan expresses that understanding.\n- Avoid hardcoded interview phases. Adapt the dimensions you explore to the subject and to the user's expertise.\n- Treat desired outcome mode as important: learning, building, researching, content/tutorial creation, decision review, etc.\n- The completion artifact is a self-contained implementation plan. Include requested deliverables and /grill output preferences within its scope; do not produce those artifacts in the interview session.\n- Ask mostly one focused question at a time. Small grouped questions are allowed only when inseparable.\n- Every grill question must present 2-5 concrete answer alternatives. Before asking the question, call grill_set_alternatives so the user can fill/cycle those alternatives with Tab and send the selected or edited reply with Enter. Also show the same alternatives briefly in chat.\n- Include your recommended answer by default with each grill question and mark it as recommended.\n- ${thoroughGrillingGuidance}\n- ${researchGuidance[state.researchMode]}\n- ${outputPhaseGuidance}\n\nCheckpoint rule:\n- The checkpoint is the source of durable shared understanding. Reflect user corrections and distinguish confirmed decisions from recommendations, assumptions, and explicitly deferred questions.\n- Whenever the user's answer meaningfully changes shared understanding, call grill_update_checkpoint with a full replacement Markdown checkpoint and a concise changeSummary BEFORE asking the next grill question.\n- The checkpoint should be adaptive Markdown. Add/remove sections as appropriate for the topic.\n- Maintain an adaptive coverage checklist and decision-branch ledger in the checkpoint; mark branches resolved, open, contradicted, or intentionally deferred. A contradiction remains unresolved until clarified or explicitly deferred.\n- If there is no meaningful change, you may ask the next question without updating.\n\nReadiness/output rule:\n- Resolve consequential ambiguities in objective, scope, constraints, dependencies, risks, and validation during the interview. Explicitly defer non-blocking questions; do not re-ask settled questions or invent a final confirmation step.\n- The plan must preserve agreed requirements, rationale, constraints, non-goals, steps and validation. Distinguish decisions from assumptions and deferred items, and include the context a fresh session needs without interview history.\n- Do not expand scope or bypass permission, authentication, or repository setup gates; preserve these constraints in the handoff plan.\n- If the user asks to stop or cancel, do not finish or queue implementation. /grill stop cancels without implementation. If the user adds context before completion, incorporate it and continue resolving consequential questions.\n[/GRILL ME EXTENSION ACTIVE]`;

		const stageGuidance = currentPhase(state) === "research"
			? "Initial research is pending. Before normal interview questions, research the explicit requested change using the conversation and available summaries as background. Preserve confirmed user decisions separately from suggestions. Ask only for research permission or essential missing context that prevents research (such as the project directory), using Tab alternatives. Inspect relevant local code/docs first, then use web_search to gather relevant factual context and anecdotal perspectives when useful. Respect research-mode permission requirements. Record findings, paths, sources, constraints, and unresolved questions in the checkpoint. Do not implement or produce a final plan yet. Call grill_finish_research alone when the focused research pass is complete, or when unavailable/declined evidence has been explicitly recorded. After that tool succeeds, this initial-stage restriction is satisfied: briefly summarize the findings and continue the normal adaptive interview immediately, without approval. Do not repeat initial research on subsequent turns; targeted follow-up research may still be useful."
			: "Initial research is completed, skipped, or not required for this restored interview. Continue the normal adaptive interview; do not restart the initial research stage. Targeted follow-up research remains subject to the research mode.";
		return { systemPrompt: event.systemPrompt + prompt + `\n\nGrill stage: ${currentPhase(state)}\n${stageGuidance}` };
	});

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new GrillReplyEditor(tui, theme, keybindings, () => state));
		ctx.ui.addAutocompleteProvider((current) => createGrillAutocompleteProvider(current, () => state));
		state = cloneState(DEFAULT_STATE);
		const entries = ctx.sessionManager.getBranch();
		for (const entry of entries as any[]) {
			if (entry?.type === "custom" && entry.customType === STATE_ENTRY_TYPE && entry.data) {
				state = { ...cloneState(DEFAULT_STATE), ...entry.data };
				if (state.outputPreference === LEGACY_DEFAULT_OUTPUT_PREFERENCE) state.outputPreference = "";
				if (!state.phase) state.phase = state.outputPhase ? "output" : "interview";
				if (state.phase !== "output") state.outputPhase = false;
			}
		}
		// Old saved sessions may contain the removed output-selection/output phases.
		// Resume them as read-only interviews, without stale artifact-menu replies.
		if ((state.phase !== "interview" && state.phase !== "research") || state.outputPhase || state.outputSelection) {
			state.phase = "interview";
			state.outputPhase = false;
			state.outputSelection = undefined;
			state.approvedOutputPlan = undefined;
			state.alternatives = [];
			state.currentQuestion = undefined;
		}
		updateUi(ctx);
	});
}
