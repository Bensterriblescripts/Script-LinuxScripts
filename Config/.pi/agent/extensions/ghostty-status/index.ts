import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Display-only: no tools, prompt hooks, transcript writes, or model calls.
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const clean = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 160);

export default function (pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let frame = 0;
  let running = false;
  let prompting = false;
  let compacting = false;
  let compactionFailed = false;
  let stopped = true;

  function enabled(context: ExtensionContext) {
    return context.mode === "tui" && process.env.TERM_PROGRAM === "ghostty";
  }

  function base() {
    const name = pi.getSessionName();
    return `π - ${name ? `${clean(name)} - ` : ""}${clean(basename(ctx!.cwd))}`;
  }

  function restingStatus(): string {
    const entries = ctx!.sessionManager.getBranch();
    let grill: any;
    let assistant: any;
    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === "grill-me-state") grill = entry.data;
      if (entry.type === "message" && entry.message.role === "assistant") assistant = entry.message;
    }
    if (compactionFailed || assistant?.stopReason === "error") return "! Error";
    if (assistant?.stopReason === "aborted") return "! Stopped";
    if (grill?.active && !grill.outputPhase && grill.phase !== "output") return "? Needs input";
    return assistant ? "✓ Finished" : "○ Ready";
  }

  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = undefined;
  }

  function render() {
    if (!ctx || stopped) return;
    const busy = !prompting && (running || compacting);
    const status = prompting ? "? Needs input" : busy ? `${FRAMES[frame++ % FRAMES.length]} Working` : restingStatus();
    ctx.ui.setTitle(`${status} | ${base()}`);
    // Pi also writes its default title after startup/rename. Refresh slowly while
    // idle to restore our indicator and notice local /grill state changes.
    clearTimer();
    timer = setTimeout(render, busy ? 120 : 1000);
    timer.unref();
  }

  pi.on("session_start", (_event, context) => {
    clearTimer();
    ctx = context;
    stopped = !enabled(context);
    running = !context.isIdle();
    prompting = compacting = compactionFailed = false;
    frame = 0;
    render();
  });
  pi.on("agent_start", () => {
    running = true;
    compactionFailed = false;
    render();
  });
  // agent_end is deliberately ignored: retries, compaction and queued follow-ups
  // can still continue automatically. Only settled means intervention is possible.
  pi.on("agent_settled", (_event, context) => {
    running = !context.isIdle();
    render();
  });
  pi.on("ui_prompt_start", () => { prompting = true; render(); });
  pi.on("ui_prompt_end", () => { prompting = false; render(); });
  pi.on("session_before_compact", () => { compacting = true; compactionFailed = false; render(); });
  pi.on("session_compact", () => { compacting = false; compactionFailed = false; render(); });
  pi.on("session_compact_failed", (event) => {
    compacting = false;
    compactionFailed = !event.aborted && !event.willRetry;
    render();
  });
  pi.on("session_info_changed", () => render());
  pi.on("session_tree", () => render());
  pi.on("session_shutdown", () => {
    clearTimer();
    if (ctx && !stopped) ctx.ui.setTitle(base());
    stopped = true;
    ctx = undefined;
  });
}
