import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { estimateTokens, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const WORKFLOW_ENTRY = "build-workflow";
const INCORPORATED_ENTRY = "build-incorporated";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const CHECKPOINT_TOOLS = new Set(["build_update_checkpoint", "build_finish_research"]);
const RESEARCH_TOOLS = new Set(["read", "web_search", "recall", "grep", "find", "ls", "build_recall"]);
const TOOLS = ["build_recall", "build_continue_checkpoint"];
const CONTEXT_PERCENT = { interview: 25, implementation: 25 } as const;
const SEED_CONTEXT_LIMIT = 0.25;
const PHASE_MODELS = { interview: "gpt-6-sol", implementation: "gpt-6-astra" } as const;
const REMAINDER = "Create a plan to finish off the remainder of this Build workflow. Treat the attached confirmed decisions and constraints as authoritative. Verify recorded progress where necessary, resolve only outstanding consequential questions, and do not repeat completed work or settled interview questions. Retrieve earlier evidence by its source handles only when needed.";

interface Workflow {
	id: string;
	source: string;
	origin: string;
	phase: "interview" | "implementation" | "completed" | "cancelled";
	parent?: string;
	fresh?: boolean;
	pending?: { status: "requested" | "ready" | "paused"; markdown?: string };
}

interface Archive {
	workflow: string;
	source: string;
	session: string;
	parent?: string;
	entries: SessionEntry[];
}

interface BuildSnapshot {
	active: boolean;
	topic: string;
	checkpoint: string;
	pendingPlan?: unknown;
}

export function conservativeProjectedTokens(messages: AgentMessage[]): number {
	return Math.ceil(messages.reduce((sum, message) => sum + estimateTokens(message) + 12, 0) * 1.25);
}

export function projectBuildContext(messages: AgentMessage[], branch: SessionEntry[], source: string, active: boolean): AgentMessage[] {
	const results = new Map(branch.flatMap((entry) => entry.type === "message" && entry.message.role === "toolResult" ? [[entry.message.toolCallId, entry] as const] : []));
	const incorporated = new Set(branch.flatMap((entry) => entry.type === "custom" && entry.customType === INCORPORATED_ENTRY ? (entry.data as { handles: string[] }).handles : []));
	return messages.map((message) => {
		if (message.role === "assistant" && active) {
			return { ...message, content: message.content.map((block) => {
				if (block.type !== "toolCall" || !CHECKPOINT_TOOLS.has(block.name)) return block;
				const result = results.get(block.id);
				if (!result || result.message.role !== "toolResult" || result.message.isError) return block;
				return { ...block, arguments: { markdown: `[Recorded checkpoint; authoritative current checkpoint is supplied separately. Original: ${source}:${result.id}]`, changeSummary: "Checkpoint recorded", incorporatedEvidence: [] } };
			}) };
		}
		if (message.role !== "toolResult") return message;
		const entry = results.get(message.toolCallId);
		if (!entry || message.isError) return message;
		const handle = `${source}:${entry.id}`;
		if (active && CHECKPOINT_TOOLS.has(message.toolName)) {
			return { ...message, content: [{ type: "text", text: `Checkpoint recorded. Original call/result: ${handle}. Current checkpoint supplied separately.` }] };
		}
		const research = RESEARCH_TOOLS.has(message.toolName) || message.toolName === "bash";
		if (!research) return message;
		if (active && incorporated.has(handle)) {
			return { ...message, content: [{ type: "text", text: `[Evidence incorporated into checkpoint. Retrieve original with build_recall: ${handle}]` }] };
		}
		return { ...message, content: [...message.content, { type: "text", text: `[Build evidence: ${handle}]` }] };
	});
}

export function registerBuildWorkflow(pi: ExtensionAPI, getBuild: () => BuildSnapshot, successorBuild: (markdown: string, implementation: boolean) => unknown) {
	let workflow: Workflow | undefined;
	let switching = false;
	let requestedThisTurn = false;
	let compactionNotice = false;
	let measuredContext: { session: string; provider: string; model: string; api: string; window: number; percent: number } | undefined;
	const directory = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "build-workflows");

	function member(): boolean {
		return workflow !== undefined && (workflow.phase === "interview" || workflow.phase === "implementation");
	}

	function modelMatches(ctx: ExtensionContext, phase: keyof typeof PHASE_MODELS): boolean {
		return (ctx.model?.provider === "openai-codex" || ctx.model?.provider === "openai") && ctx.model.id === PHASE_MODELS[phase] && pi.getThinkingLevel() === "medium";
	}

	async function selectModel(ctx: ExtensionContext, phase: keyof typeof PHASE_MODELS): Promise<boolean> {
		const id = PHASE_MODELS[phase];
		try {
			const available = ctx.modelRegistry.getAvailable();
			const model = available.find((model) => model.provider === "openai-codex" && model.id === id)
				?? available.find((model) => model.provider === "openai" && model.id === id);
			if (!model) throw new Error("Model is unavailable from both Codex and the OpenAI API; check provider authentication.");
			if (ctx.model?.provider !== model.provider || ctx.model.id !== id) {
				if (!await pi.setModel(model)) throw new Error("Model selection was rejected.");
				measuredContext = undefined;
				if (model.provider === "openai") ctx.ui.notify(`Codex ${id} is unavailable; using openai/${id} via the API instead.`, "warning");
			}
			pi.setThinkingLevel("medium");
			if (!modelMatches(ctx, phase)) throw new Error("Model or medium thinking selection did not take effect.");
			return true;
		} catch (error) {
			ctx.ui.notify(`Build requires ${id} with medium thinking via openai-codex or openai. ${error} Workflow data retained; fix model availability and retry.`, "error");
			return false;
		}
	}

	async function ensureModel(ctx: ExtensionContext): Promise<boolean> {
		return !member() || await selectModel(ctx, workflow!.phase as keyof typeof PHASE_MODELS);
	}

	function contextPercent(): number {
		if (!workflow || (workflow.phase !== "interview" && workflow.phase !== "implementation")) throw new Error("No active Build context policy.");
		return CONTEXT_PERCENT[workflow.phase];
	}

	function syncTools(): void {
		const active = pi.getActiveTools();
		const selected = active.filter((name) => !TOOLS.includes(name));
		if (workflow) selected.push("build_recall");
		if (member()) selected.push("build_continue_checkpoint");
		if (active.length !== selected.length || selected.some((name) => !active.includes(name))) pi.setActiveTools(selected);
	}

	function persist(): void {
		pi.appendEntry(WORKFLOW_ENTRY, workflow);
		syncTools();
	}

	function restore(ctx: ExtensionContext): void {
		measuredContext = undefined;
		workflow = undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === WORKFLOW_ENTRY) workflow = structuredClone(entry.data as Workflow | undefined);
		}
		requestedThisTurn = false;
		compactionNotice = false;
		switching = false;
		syncTools();
		if (workflow?.pending) ctx.ui.notify("Build continuation is pending. /build-rollover retries; /build stop cancels.", "warning");
	}

	function archivePath(id: string): string {
		if (!workflow || !UUID.test(workflow.id) || !UUID.test(id)) throw new Error("Invalid Build evidence identifier.");
		return join(directory, workflow.id, `${id}.json`);
	}

	async function archive(ctx: ExtensionContext): Promise<string> {
		if (!workflow) throw new Error("No Build workflow.");
		const id = randomUUID();
		const path = archivePath(id);
		const workflowDirectory = join(directory, workflow.id);
		const data: Archive = { workflow: workflow.id, source: workflow.source, session: ctx.sessionManager.getSessionId(), parent: workflow.parent, entries: ctx.sessionManager.getBranch() };
		await withFileMutationQueue(path, async () => {
			await mkdir(workflowDirectory, { recursive: true, mode: 0o700 });
			await writeFile(path, JSON.stringify(data), { flag: "wx", mode: 0o600, signal: ctx.signal });
		});
		return id;
	}

	async function sourceEntries(source: string, ctx: ExtensionContext): Promise<Archive> {
		if (!workflow) throw new Error("No Build evidence scope.");
		if (!source || source === workflow.source) return { workflow: workflow.id, source: workflow.source, session: ctx.sessionManager.getSessionId(), parent: workflow.parent, entries: ctx.sessionManager.getBranch() };
		if (!UUID.test(source)) throw new Error("Use a Build source identifier, not a path.");
		const visited = new Set<string>();
		let parent = workflow.parent;
		while (parent) {
			ctx.signal?.throwIfAborted();
			if (visited.has(parent)) throw new Error("Cyclic Build evidence chain.");
			visited.add(parent);
			let data: Archive;
			try { data = JSON.parse(await readFile(archivePath(parent), "utf8")); }
			catch (error) { throw new Error(`Build evidence archive ${parent} unavailable: ${error}`); }
			if (data.workflow !== workflow.id || !UUID.test(data.source) || !Array.isArray(data.entries)) throw new Error(`Invalid Build evidence archive ${parent}.`);
			if (data.source === source || parent === source) return data;
			parent = data.parent;
		}
		throw new Error("Source is not reachable from this Build branch.");
	}

	function projected(messages: AgentMessage[], ctx: ExtensionContext): AgentMessage[] {
		return workflow ? projectBuildContext(messages, ctx.sessionManager.getBranch(), workflow.source, getBuild().active) : messages;
	}

	function requestCheckpoint(ctx: ExtensionContext): void {
		if (!member() || !workflow || workflow.pending || getBuild().pendingPlan) return;
		workflow.pending = { status: "requested" };
		persist();
		requestedThisTurn = true;
		ctx.ui.notify(`Build ${workflow.phase} reached ${contextPercent()}% provider-reported context usage. Recording one continuation checkpoint before fresh Build rollover.`, "info");
	}

	function pause(ctx: ExtensionContext, message: string): void {
		if (member() && workflow) workflow.pending = { ...workflow.pending, status: "paused" };
		persist();
		ctx.ui.notify(`${message} /build-rollover retries; /build stop cancels.`, "warning");
		ctx.abort();
	}

	pi.registerTool({
		name: "build_recall",
		label: "Recall Build Evidence",
		description: "Retrieve original Build evidence only within this workflow. Use source and entry from source:entry handles. Empty source selects current source. Empty entry lists/searches one source; parent identifiers permit lazy traversal of earlier sources. Expansion includes original checkpoint tool arguments. Offset is a character offset for expansion or an entry index for search. Responses are bounded.",
		constrainedSampling: { type: "json_schema", strict: "require" },
		parameters: Type.Object({ source: Type.String(), entry: Type.String(), query: Type.String({ maxLength: 200 }), offset: Type.Integer({ minimum: 0 }), limit: Type.Integer({ minimum: 1, maximum: 12000 }) }),
		async execute(_id, params, signal, _update, ctx) {
			signal?.throwIfAborted();
			const data = await sourceEntries(params.source, ctx);
			const header = `Source ${data.source}; session ${data.session}; parent ${data.parent || "none"}\n`;
			let text: string;
			if (params.entry) {
				const entry = data.entries.find((entry) => entry.id === params.entry);
				if (!entry) throw new Error("Build source entry is missing from this branch.");
				let original: unknown = entry;
				if (entry.type === "message" && entry.message.role === "toolResult") {
					const id = entry.message.toolCallId;
					const assistant = data.entries.find((candidate) => candidate.type === "message" && candidate.message.role === "assistant" && candidate.message.content.some((block) => block.type === "toolCall" && block.id === id));
					const call = assistant?.type === "message" && assistant.message.role === "assistant" ? assistant.message.content.find((block) => block.type === "toolCall" && block.id === id) : undefined;
					original = { call: call ?? null, result: entry };
				}
				const full = JSON.stringify(original);
				text = `${header}Characters ${params.offset}-${Math.min(full.length, params.offset + params.limit)} of ${full.length}\n${full.slice(params.offset, params.offset + params.limit)}`;
			} else {
				let body = "";
				let next = params.offset;
				for (; next < data.entries.length; next++) {
					const entry = data.entries[next];
					if (entry.type !== "message") continue;
					const raw = JSON.stringify(entry.message);
					const match = raw.toLowerCase().indexOf(params.query.toLowerCase());
					if (match < 0) continue;
					const line = `${data.source}:${entry.id} ${entry.message.role} ${raw.slice(Math.max(0, match - 40), Math.max(0, match - 40) + 200)}\n`;
					if (body.length + line.length > Math.max(400, params.limit)) break;
					body += line;
				}
				text = `${header}Next entry offset: ${next < data.entries.length ? next : "end"}\n${body}`;
			}
			return { content: [{ type: "text", text }], details: undefined };
		},
	});

	pi.registerTool({
		name: "build_continue_checkpoint",
		label: "Record Build Continuation",
		description: "When rollover is requested, call alone once with a bounded authoritative continuation. Preserve the original objective/scope, all confirmed decisions, constraints/permission gates and acceptance criteria, remaining questions, completed versus unverified progress, touched files/symbols, validation, blockers, remaining tasks and evidence handles. No new research. Set complete only when no work remains (never merely because the interview plan is ready). If requirements cannot fit without loss, report that instead of dropping them.",
		constrainedSampling: { type: "json_schema", strict: "require" },
		parameters: Type.Object({ markdown: Type.String({ minLength: 1, maxLength: 32000 }), complete: Type.Boolean() }),
		async execute(_id, params, signal, _update, ctx) {
			signal?.throwIfAborted();
			if (!member() || workflow?.pending?.status !== "requested") throw new Error("No requested Build continuation.");
			const last = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
			if (last?.type !== "message" || last.message.role !== "assistant" || last.message.content.filter((block) => block.type === "toolCall").length !== 1) throw new Error("Call build_continue_checkpoint alone.");
			if (params.complete) {
				if (workflow!.phase !== "implementation" || getBuild().active) throw new Error("An active interview must use normal final-plan handoff, not mark implementation complete.");
				workflow!.phase = "completed";
				workflow!.pending = undefined;
				persist();
				return { content: [{ type: "text", text: "Build workflow complete; no rollover required." }], details: { markdown: params.markdown }, terminate: true };
			}
			workflow!.pending = { status: "ready", markdown: params.markdown };
			persist();
			pi.sendUserMessage(`/build-rollover ${workflow!.source}`, { deliverAs: "followUp", expandPromptTemplates: true });
			return { content: [{ type: "text", text: "Continuation saved; fresh Build transition queued." }], details: undefined, terminate: true };
		},
	});

	pi.registerCommand("build-rollover", {
		description: "Retry a pending Build continuation or fresh-session transition",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			if (!member() || !workflow?.pending || switching) return;
			if (args.trim() && (args.trim() !== workflow.source || workflow.pending.status !== "ready")) return;
			if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
				ctx.ui.notify("Fresh Build rollover requires TUI or RPC; continuation remains saved.", "error");
				return;
			}
			if (!await ensureModel(ctx)) return;
			if (!workflow.pending.markdown) {
				workflow.pending = { status: "requested" };
				persist();
				pi.sendUserMessage("Record the pending Build continuation with build_continue_checkpoint alone. Do not restart research.", { deliverAs: "followUp" });
				return;
			}
			const previous = structuredClone(workflow);
			const implementation = previous.phase === "implementation";
			const build = successorBuild(workflow.pending.markdown, implementation);
			const parentSession = ctx.sessionManager.getSessionFile();
			const kickoff = implementation
				? `${workflow.pending.markdown}\n\nContinue implementation from this authoritative checkpoint. Preserve permissions and constraints; verify unverified progress, retrieve evidence only as needed, and do not repeat completed work or restart the interview.`
				: REMAINDER;
			const window = ctx.model?.contextWindow;
			const seedEstimate = Math.ceil((ctx.getSystemPrompt().length + JSON.stringify(build).length + 24000) / 4 * 1.25);
			if (!window || seedEstimate >= window * SEED_CONTEXT_LIMIT) {
				ctx.ui.notify(`Build continuation cannot safely fit below ${SEED_CONTEXT_LIMIT * 100}% of this model window for continuation. No session switched or requirements discarded.`, "error");
				return;
			}
			switching = true;
			let replaced = false;
			try {
				const parent = await archive(ctx);
				if (!member() || workflow?.pending?.markdown !== previous.pending?.markdown) return;
				const next: Workflow = { id: previous.id, source: randomUUID(), origin: previous.origin, phase: previous.phase, parent, fresh: true };
				const result = await ctx.newSession({
					parentSession,
					setup: async (manager) => {
						manager.appendCustomEntry(WORKFLOW_ENTRY, next);
						manager.appendCustomEntry("build-state", build);
					},
					withSession: async (fresh) => {
						replaced = true;
						try {
							await fresh.sendUserMessage(`/build-restore ${JSON.stringify(kickoff)}`, { expandPromptTemplates: true });
						}
						catch (error) {
							fresh.ui.setEditorText(kickoff);
							fresh.ui.notify(`Fresh Build is ready; kickoff failed: ${error}`, "error");
						}
					},
				});
				if (result.cancelled) ctx.ui.notify("Build session switch cancelled. Continuation saved; /build-rollover retries.", "warning");
			} catch (error) {
				if (!replaced) ctx.ui.notify(`Build session switch failed; continuation saved. /build-rollover retries. ${error}`, "error");
			} finally {
				switching = false;
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => { restore(ctx); await ensureModel(ctx); });
	pi.on("session_tree", async (_event, ctx) => { restore(ctx); await ensureModel(ctx); });
	pi.on("input", async (event, ctx) => {
		if (event.text.startsWith("/") || !member()) return;
		if (!await ensureModel(ctx)) return { action: "handled" };
	});
	pi.on("session_compact", () => { measuredContext = undefined; });
	pi.on("session_shutdown", () => { measuredContext = undefined; });
	pi.on("model_select", () => { measuredContext = undefined; });
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		measuredContext = undefined;
		const model = ctx.model;
		if (!model || !["stop", "length", "toolUse"].includes(message.stopReason)) return;
		if (message.provider !== model.provider || message.model !== model.id || message.api !== model.api) return;
		const window = model.contextWindow;
		if (!Number.isFinite(window) || window <= 0 || !message.usage) return;
		const { input, output, cacheRead, cacheWrite } = message.usage;
		const tokens = [input, output, cacheRead, cacheWrite];
		if (!tokens.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) return;
		const percent = tokens.reduce((sum, value) => sum + value, 0) / window * 100;
		if (!Number.isFinite(percent)) return;
		measuredContext = { session: ctx.sessionManager.getSessionId(), provider: model.provider, model: model.id, api: model.api, window, percent };
	});
	pi.on("before_agent_start", () => syncTools());
	pi.on("session_before_compact", (_event, ctx) => {
		if (!member()) return;
		if (!compactionNotice) ctx.ui.notify(`Build protects conversation history: generic compaction cancelled; ${contextPercent()}% provider-reported context usage triggers ${workflow!.phase} rollover before model calls.`, "info");
		compactionNotice = true;
		return { cancel: true };
	});
	pi.on("tool_call", (event) => {
		if (!member() || !workflow?.pending) return;
		if (workflow.pending.status !== "requested" || event.toolName !== "build_continue_checkpoint") return { block: true, reason: "Build rollover is pending. Record the requested continuation alone; do not research or mutate files. /build stop cancels." };
	});
	pi.on("message_start", (event) => {
		if (event.message.role === "user" && workflow?.pending?.markdown) {
			workflow.pending = { status: "paused" };
			persist();
		}
	});
	pi.on("turn_start", () => { requestedThisTurn = false; });
	pi.on("turn_end", (event, ctx) => {
		if (!member() || getBuild().pendingPlan) return;
		if (event.outcome !== "completed" || ctx.signal?.aborted) {
			if (workflow?.pending) { workflow.pending.status = "paused"; persist(); }
			return;
		}
		if (workflow?.pending?.status === "ready") return;
		if (workflow?.pending && !requestedThisTurn) {
			pause(ctx, "Build continuation was not recorded; stopped rather than looping.");
			return;
		}
		if (!workflow?.pending) return;
		return { entries: [...event.entries, { type: "custom_message", customType: "build-continuation-request", content: `Build ${workflow!.phase} continuation is pending: call build_continue_checkpoint alone now with one bounded continuation preserving all confirmed requirements, decisions, constraints and outstanding work. Record implementation completion only if nothing remains. Do not perform more research or mutations.`, display: true }], continue: true };
	});

	return {
		restore,
		member,
		selectModel,
		ensureModel,
		start(ctx: ExtensionContext) {
			measuredContext = undefined;
			workflow = { id: randomUUID(), source: randomUUID(), origin: ctx.sessionManager.getSessionId(), phase: "interview" };
			persist();
		},
		stop() {
			measuredContext = undefined;
			if (workflow) { workflow.phase = "cancelled"; workflow.pending = undefined; persist(); }
		},
		incorporate(handles: string[], ctx: ExtensionContext) {
			if (!workflow) throw new Error("No Build workflow.");
			const branch = ctx.sessionManager.getBranch();
			for (const handle of handles) {
				const entry = branch.find((entry) => `${workflow!.source}:${entry.id}` === handle);
				if (entry?.type !== "message" || entry.message.role !== "toolResult" || entry.message.isError) throw new Error(`Evidence must be a successful result on this Build branch: ${handle}`);
			}
			if (handles.length) pi.appendEntry(INCORPORATED_ENTRY, { handles });
		},
		fileContextProjection(ctx: ExtensionContext) {
			return ctx.sessionManager.buildSessionProjection();
		},
		async implementation(ctx: ExtensionContext): Promise<Workflow | undefined> {
			if (!member() || !workflow) return;
			return { id: workflow.id, origin: workflow.origin, source: randomUUID(), phase: "implementation", parent: await archive(ctx) };
		},
		context(messages: AgentMessage[], ctx: ExtensionContext, buildInjection: string): AgentMessage[] {
			if (!member()) return messages;
			if (!modelMatches(ctx, workflow!.phase as keyof typeof PHASE_MODELS)) {
				ctx.ui.notify("Build model selection changed; request aborted. Retry your prompt to select the phase model.", "error");
				ctx.abort();
				return messages;
			}
			if (workflow!.pending && workflow!.pending.status !== "requested") {
				pause(ctx, "Build continuation is saved or paused; explicit retry is required.");
				return messages;
			}
			const reduced = projected(messages, ctx);
			let guidance = `Build phase: ${workflow!.phase}; evidence source: ${workflow!.source}; parent: ${workflow!.parent || "none"}. ${workflow!.pending ? "Rollover pending: call build_continue_checkpoint alone now; no research or mutations." : `Record a continuation only when requested at ${contextPercent()}% provider-reported context usage.`}`;
			if (getBuild().active) guidance += " Build evidence markers identify original results for build_recall. Retain research evidence until explicitly incorporated into a successful checkpoint.";
			const result: AgentMessage[] = [...reduced, { role: "system", content: "", sections: { "build.workflow": guidance, ...(buildInjection ? { "build.active": buildInjection } : {}) }, timestamp: Date.now() }];
			if (workflow!.fresh && !workflow!.pending) {
				const window = ctx.model?.contextWindow;
				if (!window || conservativeProjectedTokens(result) >= window * SEED_CONTEXT_LIMIT) {
					workflow!.pending = { status: "paused" };
					pause(ctx, !window ? "Build model context capacity is unavailable." : `Fresh Build seed already reaches ${SEED_CONTEXT_LIMIT * 100}% estimated context; stopped instead of rolling over again or discarding requirements.`);
					return result;
				}
			}
			if (workflow!.fresh) { workflow!.fresh = false; persist(); }
			if (measuredContext && (measuredContext.session !== ctx.sessionManager.getSessionId() || measuredContext.provider !== ctx.model?.provider || measuredContext.model !== ctx.model?.id || measuredContext.api !== ctx.model?.api || measuredContext.window !== ctx.model?.contextWindow)) measuredContext = undefined;
			const percent = measuredContext?.percent;
			if (typeof percent === "number" && Number.isFinite(percent) && percent >= contextPercent() && !workflow!.pending) {
				requestCheckpoint(ctx);
				const last = result.at(-1)!;
				if (last.role === "system") last.sections!["build.rollover"] = `${contextPercent()}% provider-reported context usage reached during ${workflow!.phase}. Call build_continue_checkpoint alone now; no further research or implementation.`;
			}
			return result;
		},
	};
}
