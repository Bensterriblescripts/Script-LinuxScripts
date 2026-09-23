import type { ExtensionAPI, ExtensionContext, KeybindingsManager, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { CustomEditor, DynamicBorder, ExtensionEditorComponent, getAgentDir, getMarkdownTheme, SettingsManager, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	Markdown,
	matchesKey,
	isKeyRelease,
	Text,
	truncateToWidth,
	wrapTextWithAnsi,
	type EditorOptions,
	type EditorTheme,
	type TUI,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

type Intent = "auto" | "plan" | "learn" | "research" | "content" | "decide";
type ResearchMode = "off" | "ask" | "auto";
type BuildPhase = "research" | "interview" | "output-selection" | "output";

interface BuildTopicHistory {
	load(): Promise<string[]>;
	save(text: string): Promise<void>;
}

interface BuildAlternative {
	value: string;
	label: string;
	description?: string;
}

interface BuildState {
	pendingPlan?: { path: string; markdown: string };
	active: boolean;
	hasPriorConversation: boolean;
	topic: string;
	intent: Intent;
	outputPreference: string;
	researchMode: ResearchMode;
	checkpoint: string;
	phase: BuildPhase;
	outputPhase: boolean;
	outputSelection?: {
		readinessRationale: string;
		recommendedOutputs: string;
		recommendedStrategy: string;
		question: string;
	};
	approvedOutputPlan?: string;
	alternatives: BuildAlternative[];
	currentQuestion?: string;
	alternativesPresented?: boolean;
	updatedAt: number;
	lastChangeSummary?: string;
}

const STATE_ENTRY_TYPE = "build-state";
const DISPLAY_ENTRY_TYPE = "build-display";
const BUILD_TOOLS = ["build_finish_research", "build_update_checkpoint", "build_set_alternatives", "build_finish_output_phase"];

const DEFAULT_STATE: BuildState = {
	active: false,
	hasPriorConversation: false,
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



function cloneState(state: BuildState): BuildState {
	return { ...state };
}

function describeOutputPreference(state: BuildState): string {
	const preference = typeof state.outputPreference === "string" ? state.outputPreference.trim() : "";
	return preference || "implementation plan with automatic fresh-session implementation";
}

function currentPhase(state: BuildState): BuildPhase {
	if (state.outputPhase) return "output";
	return state.phase ?? "interview";
}

function phaseLabel(state: BuildState): string {
	return `${currentPhase(state)}; read-only until automatic fresh-session handoff`;
}

function initialCheckpoint(topic: string): string {
	return `# Shared Understanding

## Topic

${topic}

## Current Understanding

The requested topic is recorded above. Supporting evidence and any confirmed prior conversation decisions have not yet been incorporated into this checkpoint.

## Decisions

None recorded yet.

## Assumptions

None recorded yet.

## Risks / Unknowns

- The user's desired outcome mode and output set may still be ambiguous.
- Some branches may need to be explicitly deferred if they are not worth resolving now.

## Coverage Checklist

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

function statusMarkdown(state: BuildState): string {
	return `# Build Status

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
- Answer alternatives: ${state.alternatives.length ? state.alternatives.map((a) => a.label).join(" | ") : "(none set)"}
- Checkpoint last updated: ${state.updatedAt ? new Date(state.updatedAt).toLocaleString() : "never"}
${state.lastChangeSummary ? `- Last checkpoint change: ${state.lastChangeSummary}
` : ""}`;
}

function normalizeAlternatives(alternatives: BuildAlternative[]): BuildAlternative[] {
	return alternatives
		.map((alt) => ({
			value: String(alt.value ?? ""),
			label: String(alt.label ?? alt.value ?? "").trim(),
			description: alt.description ? String(alt.description).trim() : undefined,
		}))
		.filter((alt) => alt.value.trim() && alt.label)
		.slice(0, 5);
}

const FOCUS_SHORTCUT = "alt+g";

interface BuildChoices {
	ready: boolean;
	focused: boolean;
	selected: number;
	submitting: boolean;
	submittedValue?: string;
}

function emptyChoices(): BuildChoices {
	return { ready: false, focused: false, selected: 0, submitting: false };
}

class BuildReplyEditor extends CustomEditor {
	private pasting = false;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly getBuildState: () => BuildState,
		private readonly getChoices: () => BuildChoices,
		private readonly refresh: () => void,
		private readonly reportError: (error: unknown) => void,
		options?: EditorOptions,
	) {
		super(tui, theme, keybindings, options);
	}

	override handleInput(data: string): void {
		const state = this.getBuildState();
		const choices = this.getChoices();
		const available = state.active && state.alternatives.length > 0 && choices.ready;
		if (data.includes("\x1b[200~")) this.pasting = true;
		if (this.pasting) {
			choices.focused = false;
			if (data.includes("\x1b[201~")) this.pasting = false;
			Editor.prototype.handleInput.call(this, data);
			this.refresh();
			return;
		}
		if (available && !isKeyRelease(data)) {
			if (choices.submitting && matchesKey(data, "enter")) return;
			if (matchesKey(data, FOCUS_SHORTCUT)) {
				choices.focused = !choices.focused;
				this.refresh();
				return;
			}
			if (choices.focused) {
				if (matchesKey(data, "up") || matchesKey(data, "shift+tab")) {
					choices.selected = (choices.selected + state.alternatives.length) % (state.alternatives.length + 1);
					this.refresh();
					return;
				}
				if (matchesKey(data, "down") || matchesKey(data, "tab")) {
					choices.selected = (choices.selected + 1) % (state.alternatives.length + 1);
					this.refresh();
					return;
				}
				if (matchesKey(data, "enter")) {
					const alternative = state.alternatives[choices.selected];
					choices.focused = false;
					if (alternative && this.onSubmit && !this.disableSubmit) {
						choices.submitting = true;
						choices.submittedValue = alternative.value;
						this.setText("");
						const failed = (error: unknown) => {
							if (this.getChoices() !== choices) return;
							choices.submittedValue = undefined;
							if (!this.getText()) this.setText(alternative.value);
							this.reportError(error);
						};
						try {
							Promise.resolve(this.onSubmit(alternative.value)).catch(failed).finally(() => {
								if (this.getChoices() !== choices) return;
								choices.submitting = false;
								this.refresh();
							});
						} catch (error) {
							choices.submitting = false;
							failed(error);
						}
					}
					this.refresh();
					return;
				}
				choices.focused = false;
				this.refresh();
				if (data.length > 1 && /[\r\n]/.test(data) && !data.includes("\x1b")) {
					Editor.prototype.handleInput.call(this, `\x1b[200~${data}\x1b[201~`);
					return;
				}
			}
		}
		super.handleInput(data);
	}
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
		return false;
	}
	return true;
}

export default function buildExtension(pi: ExtensionAPI): void {
	let state: BuildState = cloneState(DEFAULT_STATE);
	let savingPlan = false;
	let choices = emptyChoices();
	let presentedAlternatives: BuildAlternative[] | undefined;
	let answeringAlternatives: BuildAlternative[] | undefined;

	function resetChoices(): void {
		choices = emptyChoices();
		presentedAlternatives = undefined;
		answeringAlternatives = undefined;
	}

	function syncTools(): void {
		const active = pi.getActiveTools();
		const selected = active.filter((name) => !BUILD_TOOLS.includes(name));
		if (state.active) selected.push(...BUILD_TOOLS);
		if (active.length !== selected.length || selected.some((name) => !active.includes(name))) {
			pi.setActiveTools(selected);
		}
	}

	pi.registerEntryRenderer<{ markdown: string }>(DISPLAY_ENTRY_TYPE, (entry) => {
		return new Markdown(entry.data?.markdown ?? "", 1, 0, getMarkdownTheme());
	});

	function showDisplay(markdown: string, ctx: ExtensionContext): void {
		pi.appendEntry(DISPLAY_ENTRY_TYPE, { markdown });
		if (ctx.mode === "rpc") ctx.ui.notify(markdown, "info");
	}

	function persist(): void {
		if (!state.active || state.alternatives.length === 0) {
			state.alternativesPresented = false;
			resetChoices();
		}
		syncTools();
		state.updatedAt = Date.now();
		pi.appendEntry(STATE_ENTRY_TYPE, cloneState(state));
	}

	function updateUi(ctx: ExtensionContext): void {
		if (ctx.mode === "tui") {
			if (!state.active || !choices.ready || choices.submitting || state.alternatives.length === 0) {
				ctx.ui.setWidget("build-choices", undefined);
			} else {
				ctx.ui.setWidget("build-choices", (tui, theme) => {
					const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
					const items = [
						...state.alternatives.map((alt) => ({ ...alt, label: clean(alt.label), description: alt.description ? clean(alt.description) : undefined })),
						{ value: "", label: "Custom answer", description: "Write your own reply" },
					];
					return {
						render(width: number) {
							if (width < 1) return [];
							const height = Math.max(1, tui.terminal.rows - 12);
							const selected = Math.min(choices.selected, items.length - 1);
							const hint = choices.focused ? "Alt+G edit • Choices" : "Alt+G choices • Custom editing";
							const hints = [
								theme.fg(choices.focused ? "accent" : "dim", `${hint} (${selected + 1}/${items.length})`),
								...(choices.focused ? [theme.fg("dim", `↑↓ / Tab / Shift+Tab • Enter ${selected === items.length - 1 ? "edits" : "sends"} • type for custom`)] : []),
							].slice(0, Math.max(0, height - 1));
							const prefixWidth = Math.min(2, Math.max(0, width - 2));
							const rows = items.map((item, index) => {
								const text = item.label + (item.description ? ` — ${item.description}` : "");
								const wrapped = wrapTextWithAnsi(text, width - prefixWidth);
								if (prefixWidth === 0 && index === selected) wrapped.unshift("");
								return wrapped.map((line, row) => {
									const prefix = index === selected && row === 0 ? "→ ".slice(0, Math.max(1, prefixWidth)) : " ".repeat(prefixWidth);
									const entry = truncateToWidth(prefix + line, width, "");
									return index === selected
										? choices.focused ? theme.bg("selectedBg", theme.fg("accent", theme.bold(entry))) : theme.fg("muted", entry)
										: entry;
								});
							});
							const lines = rows.flat();
							const available = height - hints.length;
							const selectedStart = rows.slice(0, selected).reduce((sum, row) => sum + row.length, 0);
							const padding = Math.floor(Math.max(0, available - rows[selected].length) / 2);
							const start = Math.max(0, Math.min(selectedStart - padding, lines.length - available));
							return [...hints, ...lines.slice(start, start + available)].map((line) => truncateToWidth(line, width, ""));
						},
						invalidate() {},
					};
				}, { placement: "aboveEditor" });
			}
		}
		if (!state.active) {
			ctx.ui.setStatus("build", undefined);
			ctx.ui.setWidget("build", undefined);
			return;
		}

		const phase = currentPhase(state);
		const status = phase === "research" ? "Build: researching" : "Build";
		ctx.ui.setStatus("build", ctx.ui.theme.fg(phase === "output" ? "warning" : phase === "output-selection" ? "success" : "accent", status));

		const topic = state.topic.length > 90 ? `${state.topic.slice(0, 87)}...` : state.topic;
		const lines = [
			ctx.ui.theme.fg("accent", `Build: ${topic || "active"}`),
		];
		ctx.ui.setWidget("build", lines, { placement: "belowEditor" });
	}

	function startSession(topic: string, ctx: ExtensionContext, partial: Partial<BuildState> = {}): void {
		resetChoices();
		state = {
			...cloneState(DEFAULT_STATE),
			...partial,
			active: true,
			hasPriorConversation: ctx.sessionManager.buildSessionProjection().messages.some((message) => {
				if (message.role === "compactionSummary" || message.role === "branchSummary") return message.summary.trim().length > 0;
				if (message.role !== "user" && message.role !== "assistant") return false;
				return typeof message.content === "string"
					? message.content.trim().length > 0
					: message.content.some((block) => block.type !== "text" || block.text.trim().length > 0);
			}),
			topic,
			phase: "interview",
			outputPhase: false,
			outputSelection: undefined,
			approvedOutputPlan: undefined,
		};
		state.phase = state.researchMode === "off" ? "interview" : "research";
		state.checkpoint = initialCheckpoint(topic);
		state.lastChangeSummary = "Started Build session";
		persist();
		updateUi(ctx);

		pi.sendUserMessage(`Start a Build session for this requested change:\n\n${topic}`, { deliverAs: "steer" });
	}

	async function showCheckpointOverlay(ctx: ExtensionContext): Promise<"edit" | undefined> {
		if (ctx.mode !== "tui") {
			showDisplay(state.checkpoint, ctx);
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
							truncateToWidth(theme.fg("accent", theme.bold("Build Checkpoint")), width),
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
			ctx.ui.notify("No Build checkpoint yet.", "warning");
			return;
		}

		const selected = mode?.trim().toLowerCase() || "overlay";
		if (selected.includes("edit")) {
			const edited = await ctx.ui.editor("Edit Build checkpoint", state.checkpoint);
			if (edited !== undefined) {
				state.checkpoint = edited.trim() || state.checkpoint;
				state.lastChangeSummary = "Checkpoint edited by user";
				persist();
				updateUi(ctx);
				ctx.ui.notify("Build checkpoint updated.", "info");
			}
			return;
		}

		if (selected.includes("chat")) {
			showDisplay(state.checkpoint, ctx);
			return;
		}

		const action = await showCheckpointOverlay(ctx);
		if (action === "edit") {
			await showCheckpoint(ctx, "edit");
		}
	}

	pi.registerCommand("checkpoint", {
		description: "Show the current Build checkpoint in an overlay",
		handler: async (args, ctx) => {
			await showCheckpoint(ctx, args.trim());
		},
	});

	const buildCommand: Omit<RegisteredCommand, "name" | "sourceInfo"> = {
		description: "Start or control a Socratic Build planning session (/b is shorthand)",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const command = firstWord(trimmed);
			const rest = trimmed.slice(command.length).trim();

			if (command === "help") {
				showDisplay(`# Build commands\n\n/b is equivalent shorthand for /build, with the same arguments and subcommands.\n\n- /build <topic>\n- /build help\n- /build stop\n- /checkpoint [edit|chat]\n- /build checkpoint [edit|chat]\n- /build status\n- /build intent auto|plan|learn|research|content|decide\n- /build output <one or more outputs> (deliverables to include in the implementation plan)\n- /build research off|ask|auto\n- /build-implement (retry a cancelled handoff of a saved plan)\n\nBuild uses one thorough default Socratic style. When requirements are resolved, it saves the plan and immediately starts implementation in a fresh session, without a final menu or approval question. /build stop cancels without implementation.`, ctx);
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
				state.lastChangeSummary = "Stopped Build session";
				persist();
				updateUi(ctx);
				ctx.ui.notify("Build mode stopped.", "info");
				return;
			}

			if (command === "status") {
				showDisplay(statusMarkdown(state), ctx);
				return;
			}

			if (command === "checkpoint") {
				await showCheckpoint(ctx, rest);
				return;
			}

			if (command === "intent") {
				const value = asIntent(rest);
				if (!value) {
					ctx.ui.notify(`Usage: /build intent ${INTENTS.join("|")}`, "warning");
					return;
				}
				state.intent = value;
				state.lastChangeSummary = `Intent set to ${value}`;
				persist();
				updateUi(ctx);
				ctx.ui.notify(`Build intent: ${value}`, "info");
				return;
			}

			if (command === "output") {
				if (!rest) {
					ctx.ui.notify("Usage: /build output <one or more outputs, e.g. design-doc,issues>", "warning");
					return;
				}
				state.outputPreference = rest;
				state.lastChangeSummary = `Output preference set to ${rest}`;
				persist();
				updateUi(ctx);
				ctx.ui.notify(`Build output preference: ${rest}. These deliverables will be included in the plan for automatic fresh-session implementation.`, "info");
				return;
			}

			if (command === "research") {
				const value = asResearchMode(rest);
				if (!value) {
					ctx.ui.notify(`Usage: /build research ${RESEARCH_MODES.join("|")}`, "warning");
					return;
				}
				state.researchMode = value;
				if (value === "off" && state.phase === "research") {
					state.phase = "interview";
					state.currentQuestion = undefined;
					state.alternatives = [];
				}
				state.lastChangeSummary = `Research mode set to ${value}`;
				persist();
				updateUi(ctx);
				ctx.ui.notify(`Build research mode: ${value}`, "info");
				return;
			}

			const parsed = parseArgs(trimmed);
			const partial: Partial<BuildState> = {};
			const intent = asIntent(parsed.flags.intent);
			const researchMode = asResearchMode(parsed.flags.research);
			if (intent) partial.intent = intent;
			if (researchMode) partial.researchMode = researchMode;
			if (typeof parsed.flags.output === "string") partial.outputPreference = parsed.flags.output;

			let topic = parsed.rest;
			if (!topic) {
				if (!ctx.hasUI) {
					showDisplay("Provide the requested change with /build <change>.", ctx);
					return;
				} else {
					const request: { ctx: ExtensionContext; history?: BuildTopicHistory } = { ctx };
					if (ctx.mode === "tui") pi.events.emit("global-input-history:build-topic", request);
					const history = request.history;
					const title = "What change would you like to make?";
					let edited: string | undefined;
					if (history) {
						const entries = await history.load();
						const externalEditor = SettingsManager.create(ctx.cwd, getAgentDir(), {
							projectTrusted: ctx.isProjectTrusted(),
						}).getExternalEditorCommand();
						edited = await ctx.ui.custom<string | undefined>((tui, _theme, keybindings, done) => {
							const dialog = new ExtensionEditorComponent(tui, keybindings, title, "", done,
								() => done(undefined), undefined, externalEditor);
							for (const child of dialog.children) {
								if (child instanceof Editor) {
									for (const entry of entries) child.addToHistory(entry);
								}
							}
							return dialog;
						});
					} else {
						edited = await ctx.ui.editor(title, "");
					}
					if (!edited?.trim()) {
						ctx.ui.notify("Cancelled Build start.", "info");
						return;
					}
					topic = edited.trim();
					await history?.save(topic);
				}
			}

			startSession(topic, ctx, partial);
		},
	};
	pi.registerCommand("build", buildCommand);
	pi.registerCommand("b", buildCommand);

	pi.registerTool({
		name: "build_finish_research",
		label: "Finish Build Research",
		description: "Record initial research findings and transition to the normal Build interview. Supply the full replacement markdown and concise changeSummary together in the same call.",
		constrainedSampling: { type: "json_schema", strict: "require" },
		parameters: Type.Object({
			markdown: Type.String({ minLength: 1, description: "Full replacement checkpoint preserving requirements and decisions, with research findings, relevant paths, external sources if used, constraints, and unresolved questions. Explicitly record unavailable evidence or declined research." }),
			changeSummary: Type.String({ minLength: 1, description: "Brief visible summary of research findings." }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			if (!state.active || currentPhase(state) !== "research") throw new Error("An active initial Build research phase is required.");
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
				content: [{ type: "text", text: `Research recorded: ${summary}. Initial research is complete.` }],
				details: { checkpoint: state.checkpoint, phase: state.phase, changeSummary: summary },
			};
		},
	});

	pi.registerTool({
		name: "build_update_checkpoint",
		label: "Update Build Checkpoint",
		description: "Replace the Build shared-understanding checkpoint. Supply the full replacement markdown and concise changeSummary together in the same call.",
		constrainedSampling: { type: "json_schema", strict: "require" },
		parameters: Type.Object({
			markdown: Type.String({ description: "The full replacement Markdown checkpoint." }),
			changeSummary: Type.String({ description: "Brief visible summary of what changed." }),
		}),
		async execute(_toolCallId, params) {
			if (!state.active) {
				return {
					content: [{ type: "text", text: "No active Build session. Start one with /build <topic>." }],
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
			return new Text(theme.fg("toolTitle", theme.bold("build_update_checkpoint ")) + theme.fg("muted", args.changeSummary ?? ""), 0, 0);
		},
		renderResult(result, _options, theme, context) {
			if (context.isError) {
				const text = result.content.flatMap((block) => block.type === "text" && block.text ? [block.text] : []).join("\n");
				return new Text(theme.fg("error", text || "Checkpoint update failed"), 0, 0);
			}
			const summary = (result.details as any)?.changeSummary;
			const text = summary ? `✓ ${summary}` : result.content[0]?.type === "text" ? result.content[0].text : "Checkpoint updated";
			return new Text(theme.fg("success", text), 0, 0);
		},
	});

	pi.registerTool({
		name: "build_set_alternatives",
		label: "Set Build Alternatives",
		description: "Set answer alternatives before the next Build question. TUI shows label — description in one inline arrow/Tab selector; ask only the question in chat. Other modes need the same choices in text.",
		parameters: Type.Object({
			question: Type.String({ description: "The question these alternatives answer." }),
			alternatives: Type.Array(
				Type.Object({
					value: Type.String({ description: "The exact reply submitted immediately when selected with Enter." }),
					label: Type.String({ description: "Concise answer wording displayed in the selector or text choices." }),
					description: Type.Optional(Type.String({ description: "Helpful option-specific context or recommendation, displayed after the label." })),
				}),
				{ description: "2-5 suggested replies, including a recommended option in its label or description." },
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!state.active) {
				return {
					content: [{ type: "text", text: "No active Build session. Start one with /build <topic>." }],
					details: { alternatives: [] },
				};
			}
			resetChoices();
			state.currentQuestion = params.question;
			state.alternatives = normalizeAlternatives(params.alternatives as BuildAlternative[]);
			state.alternativesPresented = false;
			state.lastChangeSummary = `Set ${state.alternatives.length} answer alternatives`;
			persist();
			if (ctx) updateUi(ctx);
			return {
				content: [{ type: "text", text: `Answer alternatives updated: ${state.alternatives.map((a) => a.label).join(", ")}` }],
				details: { question: state.currentQuestion, alternatives: state.alternatives },
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("build_set_alternatives ")) + theme.fg("muted", args.question ?? ""), 0, 0);
		},
		renderResult(result, _options, theme) {
			const alternatives = ((result.details as any)?.alternatives ?? []) as BuildAlternative[];
			const text = alternatives.length ? `✓ ${alternatives.length} answer options set` : "No alternatives set";
			return new Text(theme.fg(alternatives.length ? "success" : "warning", text), 0, 0);
		},
	});

	// Session replacement must run in a command, outside the tool/event lifecycle.
	pi.registerCommand("build-implement", {
		description: "Start the pending saved Build plan in a fresh implementation session (also retries a cancelled handoff)",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const pending = state.pendingPlan;
			if (!pending) {
				ctx.ui.notify("No saved Build plan is pending implementation.", "warning");
				return;
			}
			// Never run a different plan if the file was edited after completion.
			if (await readFile(pending.path, "utf8") !== pending.markdown + "\n") {
				throw new Error(`Saved plan changed; handoff stopped: ${pending.path}`);
			}
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
					ctx.ui.notify("Session switch cancelled. Plan saved; /build-implement retries.", "warning");
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
		name: "build_finish_output_phase",
		label: "Finish Build Output Phase",
		description: "Complete Build: save the final Markdown implementation plan and automatically start a fresh session to implement it. Not for cancellation.",
		parameters: Type.Object({
			plan: Type.String({ minLength: 1, description: "Full finalized self-contained implementation plan in Markdown, not a filename or brief summary." }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (savingPlan) throw new Error("A Build plan is already being saved.");
			if (!state.active) throw new Error("An active Build interview is required.");
			if (currentPhase(state) === "research") throw new Error("Complete initial research with build_finish_research before saving the final plan.");
			if (ctx.mode !== "tui" && ctx.mode !== "rpc") throw new Error("Automatic session handoff requires interactive Pi (TUI or RPC).");
			const markdown = params.plan.trim();
			if (!markdown) throw new Error("The final plan must not be empty.");
			signal?.throwIfAborted();
			const directory = join(homedir(), ".pi", "agent", "plans");
			const path = join(directory, `build-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.md`);
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
				throw new Error(`Build changed while saving; plan saved but handoff cancelled: ${path}`);
			}
			state.pendingPlan = { path, markdown };
			state.active = false;
			state.phase = "interview";
			state.outputPhase = false;
			state.outputSelection = undefined;
			state.approvedOutputPlan = undefined;
			state.alternatives = [];
			state.currentQuestion = undefined;
			state.lastChangeSummary = `Finished Build; saved implementation plan to ${path}`;
			persist();
			updateUi(ctx);
			// Command dispatch is opt-in. sendUserMessage is fire-and-forget;
			// the command waits for idle while this tool returns and terminates the run.
			pi.sendUserMessage("/build-implement", { deliverAs: "followUp", expandPromptTemplates: true });
			return {
				content: [{ type: "text", text: state.lastChangeSummary }],
				details: { planPath: path, handoffQueued: true },
				terminate: true,
			};
		},
	});

	pi.on("tool_call", async (event) => {
		if (!state.active) return;

		if (event.toolName === "build_finish_output_phase" && currentPhase(state) === "research") {
			return {
				block: true,
				reason: "Complete initial research with build_finish_research in a separate tool call before saving the final plan.",
			};
		}

		if (event.toolName === "edit" || event.toolName === "write") {
			return {
				block: true,
				reason: "Build remains read-only throughout the interview. When requirements are resolved, call build_finish_output_phase with the complete plan to save it and start implementation in a fresh session.",
			};
		}

		if (event.toolName === "bash") {
			const command = String((event.input as any)?.command ?? "");
			if (!isProbablyReadOnlyBash(command)) {
				return {
					block: true,
					reason: `Build read-only mode blocked a potentially mutating command. When requirements are resolved, call build_finish_output_phase with the complete plan; implementation runs in a fresh session, not the interview.\nCommand: ${command}`,
				};
			}
		}
	});

	pi.on("before_agent_start", () => {
		syncTools();
	});

	pi.on("context_with_system", async (event, ctx) => {
		if (!state.active) return;

		const thoroughBuildGuidance = [
			"Be curious but collaborative: challenge vague answers, surface contradictions, and test assumptions without substituting your preferred approach for the user's intent.",
			"Ask follow-up questions that resolve consequential ambiguities, not low-level implementation details solely to make a plan exhaustive. Do not re-ask settled questions unless new information affects them.",
			"Walk dependent branches one at a time. If an answer changes upstream assumptions, revisit affected downstream decisions before moving on.",
		].join("\n- ");

		const researchGuidance: Record<ResearchMode, string> = {
			off: "Do not proactively inspect files or research. Ask the user instead unless they explicitly provide context.",
			ask: "Ask permission before inspecting local files/code or doing web research. Honor the approved scope and do not repeatedly ask for permission already granted. If research is declined, record the limitation and use available context only.",
			auto: "Proactively research instead of asking questions that available evidence can answer.",
		};

		const evidenceGuidance = state.researchMode === "off" ? "" : "\n- Within the permitted scope, inspect relevant local code, configuration and documentation first; use web_search to gather relevant factual context and anecdotal perspectives when useful. Keep research focused. Record unavailable or failed evidence rather than claiming verification. Do not send private code, conversation content or secrets in web queries.";
		const stageGuidance = currentPhase(state) === "research"
			? "Initial research is pending. Before normal interview questions, ask only for research permission or essential missing context that prevents research (such as the project directory). Do not produce a final plan yet. Call build_finish_research alone, supplying the full replacement markdown and concise changeSummary together in the same call, when the focused research pass is complete, or when unavailable/declined evidence has been explicitly recorded. Include findings, relevant paths, sources if used, constraints, and unresolved questions while preserving requirements and decisions."
			: "Continue the adaptive interview; do not restart initial research. If build_finish_research just succeeded, briefly summarize its findings and continue immediately without approval. Targeted follow-up research remains subject to the research mode.";

		const prompt = `[BUILD EXTENSION ACTIVE]
Current runtime state (tool calls and results in the transcript are historical records):
- Topic: ${state.topic}
- Intent preset: ${state.intent}
- Research mode: ${state.researchMode}
- Output preference: ${describeOutputPreference(state)}
- Stage: ${currentPhase(state)}
- Prior conversation available: ${state.hasPriorConversation ? "yes" : "no"}
- Current question: ${state.currentQuestion || "(None set.)"}

Current checkpoint:
${state.checkpoint || "(No checkpoint yet.)"}

Current answer alternatives:
${state.alternatives.length ? state.alternatives.map((a) => `- ${a.label}: ${a.value}${a.description ? ` (${a.description})` : ""}`).join("\n") : "(None set.)"}

Interview policy:
- The explicit requested topic defines scope. Use existing conversation and available summaries as background, preserving confirmed user decisions and constraints without treating assistant suggestions as confirmed requirements or substituting an inferred topic.
- Apply a thorough Socratic method to reach shared understanding of the user's intended outcome, reasoning, and constraints. Understanding the user is the interview's primary goal; the final plan expresses that understanding.
- Avoid hardcoded interview phases. Adapt dimensions to the subject and the user's expertise, including desired outcome mode: learning, building, researching, content/tutorial creation, decision review, etc.
- Ask mostly one focused question at a time. Small grouped questions are allowed only when inseparable.
- Before each interview question, call build_set_alternatives with 2-5 concise, concrete replies. Put concise answer wording in label and helpful option-specific explanation or recommendation in description. Mark one recommended answer in its label or description. Offer useful defaults rather than exhaustive menus. Do not supply a Custom answer alternative.
- ${ctx.mode === "tui"
	? "Ask the question in chat without listing or paraphrasing its alternatives. Essential question context can remain in chat, but option-specific explanations belong only in the selector. After the question finishes, users select with arrows or Tab/Shift+Tab and Enter immediately submits the exact value. The UI-owned Custom answer option or typing switches to free-form editing; Alt+G toggles list/editor focus without replacing the draft."
	: "Show the question and its choices in chat using the same label — description wording supplied to build_set_alternatives (label only when description is absent). Users answer normally in text and may write their own reply; there is no selectable list in this mode."}
- ${thoroughBuildGuidance}
- Remain read-only throughout this session. Do not implement, write artifacts, create issues, install packages, or run mutating commands here.

Research policy:
- ${researchGuidance[state.researchMode]}${evidenceGuidance}
- ${stageGuidance}

Checkpoint policy:
- The checkpoint is durable shared understanding, not runtime configuration. Reflect user corrections and distinguish confirmed decisions from recommendations, assumptions, and explicitly deferred questions.
- Whenever understanding meaningfully changes (decision, clarification, assumption, risk, or open question), call build_update_checkpoint with the full replacement markdown and concise changeSummary together in the same call before the next question. No update is needed otherwise.
- For both checkpoint tools, require a successful result before treating the checkpoint as recorded or moving to the next dependent step. On argument-validation failure, correct and resubmit the complete call with both markdown and changeSummary; do not continue as though it succeeded.
- If the provider cannot support required strict JSON-schema constrained sampling, stop and report the provider limitation. Do not repeatedly retry, downgrade to unconstrained generation, or change the required-field contract.
- Use adaptive Markdown sections, a coverage checklist, and a decision-branch ledger; mark branches resolved, open, contradicted, or intentionally deferred. A contradiction remains unresolved until clarified or explicitly deferred.

Completion policy:
- Resolve consequential ambiguities in objective, scope, constraints, dependencies, risks, and validation; explicitly defer non-blocking questions.
- Once consequential requirements are resolved or explicitly deferred, update the checkpoint and call build_finish_output_phase alone with the complete self-contained Markdown implementation plan. It saves the plan and automatically starts fresh-session implementation. Do not ask for output selection, readiness confirmation, or implementation approval.
- Include requested deliverables and /build output preferences in the plan's scope. Preserve agreed requirements, rationale, constraints, non-goals, steps, validation, decisions versus assumptions and deferred items, and context a fresh session needs without interview history.
- Do not expand scope or bypass permission, authentication, or repository setup gates; preserve these constraints in the handoff plan.
- If the user cancels, do not call this tool; use /build stop.
- If the user asks to stop or cancel, do not finish or queue implementation. /build stop cancels without implementation. If the user adds context before completion, incorporate it and continue resolving consequential questions.
[/BUILD EXTENSION ACTIVE]`;
		return {
			messages: [...event.messages, { role: "system", content: "", sections: { "build.active": prompt }, timestamp: Date.now() }],
		};
	});

	pi.on("input", (event) => {
		answeringAlternatives = undefined;
		if (!state.active || state.alternatives.length === 0 || event.source === "extension" || /^[!/]/.test(event.text.trimStart())) return;
		answeringAlternatives = state.alternatives;
		const value = choices.submittedValue;
		choices.submittedValue = undefined;
		if (value !== undefined && event.text === value.trim()) return { action: "transform", text: value };
	});

	pi.on("message_start", (event, ctx) => {
		if (event.message.role !== "user") return;
		if (answeringAlternatives === state.alternatives) {
			state.alternatives = [];
			state.currentQuestion = undefined;
			persist();
			updateUi(ctx);
		}
		answeringAlternatives = undefined;
	});

	pi.on("agent_start", (_event, ctx) => {
		choices.ready = false;
		choices.focused = false;
		presentedAlternatives = undefined;
		if (state.alternativesPresented) {
			state.alternativesPresented = false;
			persist();
		}
		updateUi(ctx);
	});

	pi.on("agent_before_settle", (event) => {
		presentedAlternatives = undefined;
		if (!state.active || state.alternatives.length === 0) return;
		const last = event.context.contextMessages.at(-1);
		const presented = event.outcome === "completed" && !event.continue && last?.role === "assistant"
			&& last.stopReason === "stop" && last.content.some((block) => block.type === "text" && block.text.trim());
		if (presented) presentedAlternatives = state.alternatives;
		if (state.alternativesPresented === presented) return;
		state.alternativesPresented = presented;
		state.updatedAt = Date.now();
		return { entries: [...event.entries, { type: "custom", customType: STATE_ENTRY_TYPE, data: cloneState(state) }] };
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (presentedAlternatives !== state.alternatives || !state.active || ctx.signal?.aborted) return;
		presentedAlternatives = undefined;
		if (!choices.ready) {
			choices.ready = true;
			choices.focused = ctx.mode === "tui" && ctx.ui.getEditorText().length === 0;
		}
		updateUi(ctx);
	});

	function restoreState(ctx: ExtensionContext): void {
		resetChoices();
		state = cloneState(DEFAULT_STATE);
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE && entry.data) {
				state = cloneState(entry.data as BuildState);
			}
		}
		const lastMessage = ctx.sessionManager.getBranch().filter((entry) => entry.type === "message").at(-1);
		if (state.active && state.alternatives.length > 0 && state.alternativesPresented && ctx.isIdle()
			&& lastMessage?.type === "message" && lastMessage.message.role === "assistant" && lastMessage.message.stopReason === "stop") {
			choices.ready = true;
			choices.focused = ctx.mode === "tui" && ctx.ui.getEditorText().length === 0;
		}
		syncTools();
		updateUi(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		restoreState(ctx);
		if (ctx.mode !== "tui") return;
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new BuildReplyEditor(
			tui, theme, keybindings, () => state, () => choices, () => updateUi(ctx),
			(error) => ctx.ui.notify(`Could not submit Build answer: ${error}`, "error"),
		));
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreState(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (state.alternativesPresented && !choices.ready) {
			state.alternativesPresented = false;
			persist();
		}
		resetChoices();
		if (ctx.mode === "tui") ctx.ui.setWidget("build-choices", undefined);
	});
}
