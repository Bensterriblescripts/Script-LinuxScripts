import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readWeekly } from "./status.ts";

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

  function refresh() {
    if (!ctx) return;
    pending = true;
    if (task) return;
    const token = generation;
    const context = ctx;
    const current = async () => {
      while (pending && token === generation) {
        pending = false;
        clearExpiry();
        context.ui.setStatus("codex-weekly", "Weekly …");
        const request = new AbortController();
        controller = request;
        try {
          const snapshot = await readWeekly(request.signal);
          if (token !== generation) return;
          const remaining = snapshot.resetsAt * 1000 - Date.now();
          context.ui.setStatus("codex-weekly", remaining > 0 ? snapshot.text : "Weekly unavailable");
          if (remaining > 0) {
            expiry = setTimeout(() => {
              expiry = undefined;
              if (token === generation) context.ui.setStatus("codex-weekly", "Weekly unavailable");
            }, remaining);
            expiry.unref();
          }
        } catch {
          if (token === generation) context.ui.setStatus("codex-weekly", "Weekly unavailable");
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
    if (!ctx || !runPending || !settled || running || prompting || compacting) return;
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

  pi.on("session_start", (_event, context) => {
    dispose();
    if (context.mode !== "tui") return;
    ctx = context;
    running = !context.isIdle();
    runPending = running;
    prompting = compacting = compactionFailed = settled = false;
    context.ui.setStatus("codex-weekly", "Weekly …");
    refresh();
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
