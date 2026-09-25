import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatSnapshot, readSnapshot, type Snapshot } from "./status.ts";

const stateKey = Symbol.for("pi.codex-weekly.snapshot");
const globals = globalThis as typeof globalThis & { [stateKey]?: { launched: boolean; snapshot: Snapshot } };
const state = globals[stateKey] ??= { launched: false, snapshot: {} };

export default function (pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined;
  let generation = 0;
  let task: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let pending = false;
  let running = false;
  let prompting = false;
  let compacting = false;
  let compactionFailed = false;
  let runPending = false;
  let settled = false;

  function clearExpiry() {
    clearTimeout(expiry);
    expiry = undefined;
  }

  function dispose() {
    generation++;
    ctx = undefined;
    pending = false;
    clearExpiry();
    controller?.abort();
    return task;
  }

  function render() {
    clearExpiry();
    if (!ctx) return;
    const now = Date.now();
    ctx.ui.setStatus("codex-weekly", formatSnapshot(state.snapshot, now));
    const deadlines = [state.snapshot.weekly, state.snapshot.short]
      .flatMap((window) => window && window.resetsAt * 1000 > now ? [window.resetsAt * 1000] : []);
    if (deadlines.length) {
      expiry = setTimeout(render, Math.min(...deadlines) - now);
      expiry.unref();
    }
  }

  function refresh() {
    if (!ctx) return;
    pending = true;
    if (task) return;
    const token = generation;

    const current = async () => {
      while (pending && token === generation) {
        pending = false;
        render();
        const request = new AbortController();
        controller = request;
        try {
          const snapshot = await readSnapshot(request.signal);
          if (token !== generation) return;
          state.snapshot = snapshot;
          render();
        } catch {
          if (token === generation) {
            state.snapshot = {};
            render();
          }
        } finally {
          if (controller === request) controller = undefined;
        }
      }
    };
    task = current().finally(() => {
      task = undefined;
      if (pending && ctx) refresh();
    });
  }

  function finished() {
    if (!ctx || !runPending || !settled || running || prompting || compacting || !ctx.isIdle()) return;
    const entries = ctx.sessionManager.getBranch();
    let build: { active?: boolean; outputPhase?: boolean; phase?: string } | undefined;
    let assistant: { stopReason?: string } | undefined;
    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === "build-state") build = entry.data as typeof build;
      if (entry.type === "message" && entry.message.role === "assistant") assistant = entry.message;
    }
    runPending = false;
    if (compactionFailed || assistant?.stopReason === "error" || assistant?.stopReason === "aborted") return;
    if (build?.active && !build.outputPhase && build.phase !== "output") return;
    if (assistant) refresh();
  }

  pi.on("session_start", (event, context) => {
    dispose();
    if (context.mode !== "tui") return;
    ctx = context;
    running = !context.isIdle();
    runPending = false;
    prompting = compacting = compactionFailed = settled = false;
    render();
    if (event.reason === "startup" && !state.launched) {
      state.launched = true;
      refresh();
    }
  });
  pi.on("agent_start", (_event, context) => {
    if (!ctx || context.mode !== "tui") return;
    ctx = context;
    running = runPending = true;
    settled = compactionFailed = false;
  });
  pi.on("agent_settled", (_event, context) => {
    if (!ctx || context.mode !== "tui") return;
    ctx = context;
    running = !context.isIdle();
    settled = true;
    finished();
  });
  pi.on("ui_prompt_start", () => { if (ctx) prompting = true; });
  pi.on("ui_prompt_end", () => { if (ctx) { prompting = false; finished(); } });
  pi.on("session_before_compact", () => {
    if (!ctx) return;
    compacting = true;
    compactionFailed = false;
  });
  pi.on("session_compact", () => {
    if (!ctx) return;
    compacting = compactionFailed = false;
    finished();
  });
  pi.on("session_compact_failed", (event) => {
    if (!ctx) return;
    compacting = false;
    compactionFailed = !event.aborted && !event.willRetry;
    finished();
  });
  pi.on("session_shutdown", async () => { await dispose(); });
}
