import type { ExtensionAPI, ExtensionContext, KeybindingsManager, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { clipboardPaths, prepareClipboardImages } from "./clipboard-images.ts";
import { collectFileContext, fileContextContent, type FileContext } from "./file-context.ts";
import { registerBuildWorkflow, WORKFLOW_ENTRY } from "./workflow.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { CustomEditor, DynamicBorder, getMarkdownTheme, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	Markdown,
	matchesKey,
	parseKey,
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
type BuildPhase = "research" | "interview";

interface BuildAlternative {
	value: string;
	label: string;
	description?: string;
}

interface BuildState {
	pendingPlan?: { path: string; markdown: string; fileContext: FileContext };
	active: boolean;
	hasPriorConversation: boolean;
	topic: string;
	intent: Intent;
	outputPreference: string;
	researchMode: ResearchMode;
	checkpoint: string;
	phase: BuildPhase;
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
- Current question: ${state.currentQuestion || "(none)"}
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

function literalOptionText(text: string): string {
	return text.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,
		(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function optionText(alternative: BuildAlternative): string {
	return `${literalOptionText(alternative.label)}${alternative.description === undefined ? "" : `\n${literalOptionText(alternative.description)}`}\n${literalOptionText(alternative.value)}`;
}

const FOCUS_SHORTCUT = "alt+g";

interface BuildChoices {
	ready: boolean;
	focused: boolean;
	selected: number;
	submitting: boolean;
	scroll: number;
	pageSize: number;
	submittedValue?: string;
}

function emptyChoices(): BuildChoices {
	return { ready: false, focused: false, selected: 0, submitting: false, scroll: 0, pageSize: 1 };
}

class BuildReplyEditor extends CustomEditor {
	private pasting = false;
	private handlingInput = false;
	revision = 0;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly getBuildState: () => BuildState,
		private readonly getChoices: () => BuildChoices,
		private readonly refresh: () => void,
		private readonly reportError: (error: unknown) => void,
		private readonly enteringTopic: () => boolean,
		private readonly recordSubmission: (text: string) => void,
		private readonly handleSubmissionControl: (data: string) => void,
		options?: EditorOptions,
	) {
		super(tui, theme, keybindings, options);
		let changed = this.onChange;
		let previousText = this.getExpandedText();
		Object.defineProperty(this, "onChange", {
			configurable: true,
			get: () => (text: string) => {
				const expanded = this.getExpandedText();
				if (expanded !== previousText) this.revision++;
				previousText = expanded;
				changed?.call(this, text);
			},
			set: (callback) => { changed = callback; },
		});
	}

	override addToHistory(text: string): void {
		if (this.handlingInput) this.recordSubmission(text);
		super.addToHistory(text);
	}

	override handleInput(data: string): void {
		this.handlingInput = true;
		try {
			this.handleSubmissionControl(data);
			this.handleBuildInput(data);
		} finally {
			this.handlingInput = false;
		}
	}

	private seedHighlightedAnswer(state: BuildState, choices: BuildChoices): void {
		const alternative = choices.focused ? state.alternatives[choices.selected] : undefined;
		if (alternative) this.setText(alternative.value);
	}

	private handleBuildInput(data: string): void {
		const state = this.getBuildState();
		const choices = this.getChoices();
		const available = !this.enteringTopic() && state.active && state.alternatives.length > 0 && choices.ready;
		if (data.includes("\x1b[200~")) this.pasting = true;
		if (this.pasting) {
			if (available) this.seedHighlightedAnswer(state, choices);
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
				if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
					choices.scroll = Math.max(0, choices.scroll + (matchesKey(data, "pageUp") ? -1 : 1) * choices.pageSize);
					this.refresh();
					return;
				}
				if (matchesKey(data, "up") || matchesKey(data, "shift+tab")) {
					choices.selected = (choices.selected + state.alternatives.length) % (state.alternatives.length + 1);
					choices.scroll = 0;
					this.refresh();
					return;
				}
				if (matchesKey(data, "down") || matchesKey(data, "tab")) {
					choices.selected = (choices.selected + 1) % (state.alternatives.length + 1);
					choices.scroll = 0;
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
				const multiline = data.length > 1 && /[\r\n]/.test(data) && !data.includes("\x1b");
				const key = data.startsWith("\x1b") ? parseKey(data)?.replace(/^shift\+/, "") : undefined;
				const textInput = /^[^\x00-\x1f\x7f-\x9f]+$/u.test(data)
					|| key === "space" || (key !== undefined && [...key].length === 1);
				if (multiline || textInput) this.seedHighlightedAnswer(state, choices);
				choices.focused = false;
				this.refresh();
				if (multiline) {
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

export default function buildExtension(pi: ExtensionAPI): void {
	let state: BuildState = cloneState(DEFAULT_STATE);
	const workflow = registerBuildWorkflow(pi, () => state, (markdown, implementation) => ({
		...cloneState(DEFAULT_STATE),
		active: !implementation,
		topic: state.topic,
		intent: state.intent,
		outputPreference: state.outputPreference,
		researchMode: state.researchMode,
		phase: "interview",
		checkpoint: implementation ? "" : markdown,
		lastChangeSummary: "Continued Build with authoritative remainder state",
	}));
	let savingPlan = false;
	let choices = emptyChoices();
	let presentedAlternatives: BuildAlternative[] | undefined;
	let answeringAlternatives: BuildAlternative[] | undefined;
	let pendingTopic: Partial<BuildState> | undefined;
	let generation = 0;
	let live = false;
	let editor: BuildReplyEditor | undefined;
	const preparations = new Set<AbortController>();
	let submissions: { text: string; generation: number; revision: number }[] = [];

	function cancelPreparations(): void {
		for (const controller of preparations) controller.abort();
		preparations.clear();
	}

	function clearTopicEntry(): void {
		generation++;
		pendingTopic = undefined;
		cancelPreparations();
	}

	function isControl(text: string): boolean {
		const trimmed = text.trimStart();
		return trimmed.startsWith("!") || (trimmed.startsWith("/") && !clipboardPaths(trimmed).some((path) => trimmed.startsWith(path)));
	}

	async function prepareDraft(text: string, images: ImageContent[] | undefined, recovery: string, ctx: ExtensionContext, revision = editor?.revision): Promise<ImageContent[] | undefined> {
		const controller = new AbortController();
		const currentGeneration = generation;
		const currentEditor = editor;
		const signal = ctx.signal ? AbortSignal.any([controller.signal, ctx.signal]) : controller.signal;
		preparations.add(controller);
		try {
			const prepared = await prepareClipboardImages(text, images, signal);
			if (generation !== currentGeneration || signal.aborted) return;
			return prepared;
		} catch (error) {
			if (generation !== currentGeneration || signal.aborted) return;
			const restore = ctx.mode === "tui" && editor === currentEditor && editor?.revision === revision && !ctx.ui.getEditorText();
			if (restore) ctx.ui.setEditorText(recovery);
			ctx.ui.notify(`${error instanceof Error ? error.message : String(error)}. Nothing sent. Remove the reference or paste the image again. ${restore ? "Draft restored." : ctx.mode === "tui" ? "Your editor was left untouched; recall the draft from input history to retry." : "Resubmit the original draft after fixing its image references."}`, "error");
			return;
		} finally {
			preparations.delete(controller);
		}
	}

	function kickoffText(topic: string): string {
		return `Start a Build session for this requested change:\n\n${topic}`;
	}

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
			if (pendingTopic || !state.active || !choices.ready || choices.submitting || state.alternatives.length === 0) {
				ctx.ui.setWidget("build-choices", undefined);
			} else {
				ctx.ui.setWidget("build-choices", (tui, theme) => {
					const items = [
						...state.alternatives.map(optionText),
						"Custom answer\nWrite your own reply",
					];
					return {
						render(width: number) {
							if (width < 1) return [];
							const height = Math.max(1, tui.terminal.rows - 12);
							const selected = Math.min(choices.selected, items.length - 1);
							const status = choices.focused ? "Choices" : "Custom editing";
							const headers = [
								theme.fg(choices.focused ? "accent" : "dim", `${status} (${selected + 1}/${items.length})`),
							].slice(0, Math.max(0, height - 1));
							const prefixWidth = Math.min(2, Math.max(0, width - 2));
							const rows = items.map((item, index) => {
								const display = width === 1 ? item.replace(/[^\x00-\x7f]/gu, (character) => `\\u{${character.codePointAt(0)!.toString(16)}}`) : item;
								const wrapped = wrapTextWithAnsi(display, width - prefixWidth);
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
							const available = height - headers.length;
							const selectedStart = rows.slice(0, selected).reduce((sum, row) => sum + row.length, 0);
							choices.pageSize = Math.max(1, available - 1);
							choices.scroll = Math.min(choices.scroll, Math.max(0, rows[selected].length - available));
							const padding = Math.floor(Math.max(0, available - rows[selected].length) / 2);
							const start = Math.max(0, Math.min(selectedStart + choices.scroll - padding, lines.length - available));
							return [...headers, ...lines.slice(start, start + available)].map((line) => truncateToWidth(line, width, ""));
						},
						invalidate() {},
					};
				}, { placement: "aboveEditor" });
			}
		}
		if (pendingTopic) {
			ctx.ui.setStatus("build", "\x1b[3;38;2;255;165;0mNew Change\x1b[0m");
			ctx.ui.setWidget("build", ["What change would you like to make?"], { placement: "belowEditor" });
			return;
		}
		const phase = currentPhase(state);
		const status = phase === "research" ? "Research" : "Build";
		ctx.ui.setStatus("build", state.active ? `\x1b[3;38;2;255;165;0m${status}\x1b[0m` : undefined);

		const displayText = state.topic.trim() ? ctx.sessionManager.getSessionName()?.trim() || state.topic : state.topic;
		const topic = displayText.length > 90 ? `${displayText.slice(0, 87)}...` : displayText;
		ctx.ui.setWidget("build", topic.trim() ? [ctx.ui.theme.fg("accent", topic)] : undefined, { placement: "belowEditor" });
	}

	function startSession(topic: string, ctx: ExtensionContext, partial: Partial<BuildState> = {}): void {
		pendingTopic = undefined;
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
		};
		state.phase = state.researchMode === "off" ? "interview" : "research";
		state.checkpoint = initialCheckpoint(topic);
		state.lastChangeSummary = "Started Build session";
		workflow.start(ctx);
		persist();
		updateUi(ctx);
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
				if ((workflow.member() || state.active || pendingTopic) && !await workflow.selectModel(ctx, "implementation")) return;
				workflow.stop();
				clearTopicEntry();
				state.pendingPlan = undefined;
				state.active = false;
				state.topic = "";
				state.phase = "interview";
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
				if (pendingTopic) pendingTopic.intent = value;
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
				if (pendingTopic) pendingTopic.outputPreference = rest;
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
				if (pendingTopic) pendingTopic.researchMode = value;
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

			clearTopicEntry();
			updateUi(ctx);
			const currentGeneration = generation;
			let topic = parsed.rest;
			if (!topic) {
				if (ctx.mode === "tui") {
					pendingTopic = partial;
					choices.focused = false;
					updateUi(ctx);
					return;
				}
				if (!ctx.hasUI) {
					showDisplay("Provide the requested change with /build <change>.", ctx);
					return;
				}
				const edited = await ctx.ui.editor("What change would you like to make?", "");
				if (generation !== currentGeneration) return;
				if (!edited?.trim()) {
					ctx.ui.notify("Cancelled Build start.", "info");
					return;
				}
				topic = edited.trim();
			}

			const images = await prepareDraft(topic, undefined, `/build ${trimmed || topic}`, ctx);
			if (!images || generation !== currentGeneration) return;
			if (!await workflow.selectModel(ctx, "interview")) return;
			startSession(topic, ctx, partial);
			pi.sendUserMessage([{ type: "text", text: kickoffText(topic) }, ...images], { deliverAs: "steer" });
		},
	};
	pi.registerCommand("build", buildCommand);
	pi.registerCommand("b", buildCommand);

	pi.registerTool({
		name: "build_finish_research",
		label: "Finish Build Research",
		description: "Record initial research findings and transition to the normal Build interview.",
		constrainedSampling: { type: "json_schema", strict: "require" },
		parameters: Type.Object({
			markdown: Type.String({ minLength: 1, description: "Full replacement checkpoint preserving requirements and decisions, with research findings, relevant paths, external sources if used, constraints, and unresolved questions. Explicitly record unavailable evidence or declined research." }),
			changeSummary: Type.String({ minLength: 1, description: "Brief visible summary of research findings." }),
			incorporatedEvidence: Type.Array(Type.String(), { maxItems: 128, description: "Exact Build evidence handles inspected and incorporated into this checkpoint, with no unresolved actionable detail omitted. Use [] when none. Only these successful research payloads may leave context." }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			if (!state.active || currentPhase(state) !== "research") throw new Error("An active initial Build research phase is required.");
			const markdown = params.markdown.trim();
			const summary = params.changeSummary.trim();
			if (!markdown || !summary) throw new Error("Research checkpoint and summary must not be empty.");
			workflow.incorporate(params.incorporatedEvidence, ctx);
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
		description: "Replace the Build shared-understanding checkpoint.",
		constrainedSampling: { type: "json_schema", strict: "require" },
		parameters: Type.Object({
			markdown: Type.String({ description: "The full replacement Markdown checkpoint." }),
			changeSummary: Type.String({ description: "Brief visible summary of what changed." }),
			incorporatedEvidence: Type.Array(Type.String(), { maxItems: 128, description: "Exact Build evidence handles inspected and incorporated, with no unresolved actionable detail omitted. Use [] when none. Only acknowledged successful research payloads may leave context." }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			if (!state.active) {
				return {
					content: [{ type: "text", text: "No active Build session. Start one with /build <topic>." }],
					details: { checkpoint: state.checkpoint, changeSummary: "No active session", updatedAt: state.updatedAt },
				};
			}
			workflow.incorporate(params.incorporatedEvidence, ctx);
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
		description: "Set answer alternatives for the next Build question.",
		parameters: Type.Object({
			question: Type.String({ description: "The question these alternatives answer." }),
			alternatives: Type.Array(
				Type.Object({
					value: Type.String({ description: "Full exact reply text, submitted unchanged. Never shorten it to fit the display." }),
					label: Type.String({ description: "Concise, concrete answer wording." }),
					description: Type.Optional(Type.String({ description: "Helpful option-specific explanation or recommendation." })),
				}),
				{ description: "2-5 useful suggested replies, with one recommendation in its label or description. Do not supply a Custom answer alternative." },
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
		renderResult(result, { expanded }, theme) {
			const alternatives = ((result.details as any)?.alternatives ?? []) as BuildAlternative[];
			const text = alternatives.length ? `✓ ${alternatives.length} answer options set` : "No alternatives set";
			const details = expanded ? alternatives.map((alternative, index) => `\n\nOption ${index + 1}\n${optionText(alternative)}`).join("") : "";
			return new Text(theme.fg(alternatives.length ? "success" : "warning", text) + details, 0, 0);
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
			const fileContent = fileContextContent(pending.fileContext);
			const implementationState = { ...cloneState(DEFAULT_STATE), topic: state.topic, intent: state.intent, researchMode: state.researchMode, outputPreference: state.outputPreference };
			const implementationWorkflow = await workflow.implementation(ctx);
			if (state.pendingPlan !== pending) return;
			const parentSession = ctx.sessionManager.getSessionFile();
			state.pendingPlan = undefined;
			persist();
			let replaced = false;
			try {
				const result = await ctx.newSession({
					parentSession,
					setup: async (manager) => {
						if (implementationWorkflow) manager.appendCustomEntry(WORKFLOW_ENTRY, implementationWorkflow);
						manager.appendCustomEntry(STATE_ENTRY_TYPE, implementationState);
						if (fileContent.length) manager.appendCustomMessageEntry("build-file-context", fileContent, false);
					},
					withSession: async (fresh) => {
						replaced = true;
						fresh.ui.notify(`Implementing plan saved to ${pending.path}`, "info");
						try {
							await fresh.sendUserMessage(`/build-restore ${JSON.stringify(kickoff)}`, { expandPromptTemplates: true });
						} catch (error) {
							fresh.ui.setEditorText(kickoff);
							fresh.ui.notify(`Could not start implementation; prompt restored in editor; planning file context remains saved in this session: ${error}`, "error");
						}
					},
				});
				if (result.cancelled && workflow.member()) {
					state.pendingPlan = pending;
					persist();
					ctx.ui.notify("Session switch cancelled. Plan saved; /build-implement retries.", "warning");
				}
			} catch (error) {
				if (!replaced && workflow.member()) {
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
		description: "Complete Build: save the final Markdown implementation plan and selected already-read file observations, then automatically start a fresh session to implement it. Call alone. Do not read additional files merely to populate handoff context. Not for cancellation.",
		parameters: Type.Object({
			plan: Type.String({ minLength: 1, description: "Full finalized self-contained implementation plan in Markdown, not a filename or brief summary." }),
			contextFiles: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 64, description: "Relevant paths already read with read in available planning context. Distinct available read results transfer exactly, newest first for budget selection; identical results at the same offset are deduplicated. Use [] for plan-only handoff. Missing, removed or unavailable content is omitted, never fetched. Do not perform extra reads merely for handoff." }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (savingPlan) throw new Error("A Build plan is already being saved.");
			if (!state.active) throw new Error("An active Build interview is required.");
			if (currentPhase(state) === "research") throw new Error("Complete initial research with build_finish_research before saving the final plan.");
			if (ctx.mode !== "tui" && ctx.mode !== "rpc") throw new Error("Automatic session handoff requires interactive Pi (TUI or RPC).");
			const markdown = params.plan.trim();
			if (!markdown) throw new Error("The final plan must not be empty.");
			signal?.throwIfAborted();
			const fileContext = collectFileContext(params.contextFiles, workflow.fileContextProjection(ctx), ctx.cwd);
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
			clearTopicEntry();
			state.pendingPlan = { path, markdown, fileContext };
			state.active = false;
			state.phase = "interview";
			state.alternatives = [];
			state.currentQuestion = undefined;
			state.lastChangeSummary = `Finished Build; saved implementation plan to ${path}`;
			persist();
			updateUi(ctx);
			// Command dispatch is opt-in. sendUserMessage is fire-and-forget;
			// the command waits for idle while this tool returns and terminates the run.
			pi.sendUserMessage("/build-implement", { deliverAs: "followUp", expandPromptTemplates: true });
			return {
				content: [{ type: "text", text: `${state.lastChangeSummary}\nSelected file observations: ${fileContext.observations.length}.${fileContext.omitted.length ? `\n${fileContext.omitted.join("\n")}` : ""}` }],
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
	});

	pi.on("before_agent_start", () => {
		syncTools();
	});

	pi.on("context_with_system", async (event, ctx) => {
		if (!state.active) return { messages: workflow.context(event.messages, ctx, "") };

		const thoroughBuildGuidance = [
			"Challenge vagueness, contradictions and assumptions collaboratively; preserve the user's intent.",
			"Resolve consequential ambiguities, not exhaustive implementation detail. Reopen settled questions only when new evidence affects them.",
			"Follow dependent branches one at a time; revisit downstream decisions when upstream assumptions change.",
		].join("\n- ");

		const researchGuidance: Record<ResearchMode, string> = {
			off: "Do not proactively inspect files or research. Ask the user instead unless they explicitly provide context.",
			ask: "Ask permission before inspecting local files/code or doing web research. Honor the approved scope and do not repeatedly ask for permission already granted. If research is declined, record the limitation and use available context only.",
			auto: "Proactively research instead of asking questions that available evidence can answer.",
		};

		const evidenceGuidance = state.researchMode === "off" ? "" : "\n- Within the permitted scope, inspect relevant local code, configuration and documentation first; use web_search to gather relevant factual context and anecdotal perspectives when useful. Keep research focused. Record unavailable or failed evidence rather than claiming verification. Do not send private code, conversation content or secrets in web queries.";
		const stageGuidance = currentPhase(state) === "research"
			? "Initial research is pending. Before normal interview questions, ask only for research permission or essential missing context that prevents research (such as the project directory). Do not produce a final plan yet. Call build_finish_research alone when the focused research pass is complete or unavailable/declined evidence has been explicitly recorded."
			: "Continue the adaptive interview; do not restart initial research. If build_finish_research just succeeded, briefly summarize its findings and continue immediately without approval. Targeted follow-up research remains subject to the research mode.";

		const prompt = `[BUILD EXTENSION ACTIVE]
Authoritative runtime state (transcript tools are historical):
- Topic: ${state.topic}
- Intent preset: ${state.intent}
- Research mode: ${state.researchMode}
- Output preference: ${describeOutputPreference(state)}
- Stage: ${currentPhase(state)}
- Prior conversation available: ${state.hasPriorConversation ? "yes" : "no"}
- Current question: ${state.currentQuestion || "(None set.)"}

Current checkpoint:
${state.checkpoint || "(No checkpoint yet.)"}

Interview policy:
- The explicit topic defines scope. Preserve confirmed decisions and constraints from conversation/summaries; assistant suggestions are not confirmed requirements.
- Build shared understanding of the user's outcome, reasoning and constraints through adaptive Socratic questioning, tailored to subject, expertise and outcome mode, not fixed interview phases.
- Ask one focused question at a time; group only inseparable questions. Before each, call build_set_alternatives with useful defaults, not exhaustive menus.
- ${ctx.mode === "tui"
	? "Ask only the question in chat, with essential question context if needed. Do not list or paraphrase alternatives; option-specific explanations belong only in the selector."
	: "Show the question and every alternative in chat: full label, optional separate description, then full exact submitted reply value, in order without field headings. Preserve wording and meaningful line breaks using literal formatting, not interpreted markup. Do not summarize or alter values. Users answer in text or write their own reply; there is no selector."}
- ${thoroughBuildGuidance}
- Keep this session focused on research and planning, with implementation handed off to a fresh session. The edit and write tools are unavailable during the interview.

Research policy:
- ${researchGuidance[state.researchMode]}${evidenceGuidance}
- ${stageGuidance}

Checkpoint policy:
- Checkpoints record understanding, not runtime configuration. Preserve user corrections; distinguish decisions, recommendations, assumptions and deferred questions.
- Call build_update_checkpoint before the next question only when understanding changes (decisions, clarifications, assumptions, risks or questions).
- Originals are retrievable via build_recall; errors stay visible. Await checkpoint success before dependent steps. On validation failure, correct and resubmit the full call.
- If the provider cannot support required strict JSON-schema constrained sampling, stop and report the provider limitation. Do not repeatedly retry, downgrade to unconstrained generation, or change the required-field contract.
- Use adaptive Markdown sections, a coverage checklist, and a decision-branch ledger; mark branches resolved, open, contradicted, or intentionally deferred. A contradiction remains unresolved until clarified or explicitly deferred.

Completion policy:
- Resolve consequential ambiguities in objective, scope, constraints, dependencies, risks, and validation; explicitly defer non-blocking questions.
- When ready, update the checkpoint and call build_finish_output_phase alone with a self-contained Markdown implementation plan. Saving automatically starts fresh-session implementation: no output menu, readiness check or approval question.
- contextFiles selects relevant already-read paths, or [] for plan only. Available results, including incorporated reads, transfer within limits; missing context is explicitly omitted, never fetched. Do not read or recall merely for transfer; implementation can acquire missing ranges.
- Include requested deliverables and /build output preferences in the plan's scope. Preserve agreed requirements, rationale, constraints, non-goals, steps, validation, decisions versus assumptions and deferred items, and context a fresh session needs without interview history.
- Do not expand scope or bypass permission, authentication, or repository setup gates; preserve these constraints in the handoff plan.
- If the user asks to stop or cancel, use /build stop; do not finish or queue implementation. If the user adds context before completion, incorporate it and continue resolving consequential questions.
[/BUILD EXTENSION ACTIVE]`;
		return {
			messages: workflow.context(event.messages, ctx, prompt),
		};
	});

	pi.on("input", async (event, ctx) => {
		if (!live) return { action: "handled" };
		if (event.source === "extension" || isControl(event.text)) return;
		const submissionIndex = event.source === "interactive" ? submissions.findIndex((item) => item.text === event.text) : -1;
		const submission = submissionIndex < 0 ? undefined : submissions.splice(submissionIndex, 1)[0];
		if (submission && submission.generation !== generation) return { action: "handled" };
		if (!pendingTopic && !state.active) return;
		if (!event.text.trim() && !event.images?.length) return { action: "handled" };
		const pending = pendingTopic;
		const currentGeneration = generation;
		const currentState = state;
		const alternatives = state.alternatives;
		const value = pending ? undefined : choices.submittedValue;
		choices.submittedValue = undefined;
		const text = value !== undefined && event.text === value.trim() ? value : event.text;
		const images = await prepareDraft(text, event.images, text, ctx, submission?.revision);
		if (!images || generation !== currentGeneration || state !== currentState || pendingTopic !== pending || (!pending && !state.active)) return { action: "handled" };
		if (pending) {
			if (!await workflow.selectModel(ctx, "interview")) return { action: "handled" };
			startSession(text, ctx, pending);
			pi.events.emit("global-input-history:transform", { images, originalText: event.text });
			return { action: "transform", text: kickoffText(text), images };
		}
		answeringAlternatives = alternatives.length ? alternatives : undefined;
		return { action: "transform", text, images };
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
		if (pendingTopic || presentedAlternatives !== state.alternatives || !state.active || ctx.signal?.aborted) return;
		presentedAlternatives = undefined;
		if (!choices.ready) {
			choices.ready = true;
			choices.focused = ctx.mode === "tui" && ctx.ui.getEditorText().length === 0;
		}
		updateUi(ctx);
	});

	function restoreState(ctx: ExtensionContext): void {
		clearTopicEntry();
		submissions = [];
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

	pi.registerCommand("build-restore", {
		description: "Restore persisted Build workflow state after a fresh-session setup",
		handler: async (args, ctx) => {
			workflow.restore(ctx);
			restoreState(ctx);
			const kickoff: unknown = args.trim() ? JSON.parse(args) : undefined;
			if (kickoff !== undefined && typeof kickoff !== "string") throw new Error("Invalid Build kickoff.");
			if (!await workflow.ensureModel(ctx)) {
				if (typeof kickoff === "string") ctx.ui.setEditorText(kickoff);
				return;
			}
			if (typeof kickoff === "string" && workflow.member()) {
				try { pi.sendUserMessage(kickoff); }
				catch (error) {
					ctx.ui.setEditorText(kickoff);
					ctx.ui.notify(`Build kickoff failed; prompt restored in editor: ${error}`, "error");
				}
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		live = true;
		restoreState(ctx);
		if (ctx.mode !== "tui") return;
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			editor = new BuildReplyEditor(
				tui, theme, keybindings, () => state, () => choices, () => updateUi(ctx),
				(error) => ctx.ui.notify(`Could not submit Build answer: ${error}`, "error"),
				() => pendingTopic !== undefined,
				(text) => {
					if ((pendingTopic || state.active) && !isControl(text)) submissions.push({ text, generation, revision: editor!.revision });
				},
				(data) => {
					if (keybindings.matches(data, "app.interrupt") && !editor!.isShowingAutocomplete()) {
						cancelPreparations();
						if (!ctx.isIdle()) submissions = [];
					} else if (keybindings.matches(data, "app.message.dequeue")) {
						submissions = [];
					}
				},
			);
			return editor;
		});
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreState(ctx);
	});

	function cancelTopicEntry(_event: unknown, ctx: ExtensionContext): void {
		clearTopicEntry();
		updateUi(ctx);
	}

	pi.on("session_before_switch", cancelTopicEntry);
	pi.on("session_before_fork", cancelTopicEntry);
	pi.on("session_before_tree", cancelTopicEntry);

	pi.on("session_shutdown", (_event, ctx) => {
		live = false;
		clearTopicEntry();
		submissions = [];
		editor = undefined;
		if (state.alternativesPresented && !choices.ready) {
			state.alternativesPresented = false;
			persist();
		}
		resetChoices();
		if (ctx.mode === "tui") {
			ctx.ui.setWidget("build-choices", undefined);
			ctx.ui.setWidget("build", undefined);
			ctx.ui.setStatus("build", undefined);
		}
	});
}
