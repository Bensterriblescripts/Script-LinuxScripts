import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export interface WeeklySnapshot {
  text: string;
  resetsAt: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function remainingText(used: number): string {
  const [mantissa, exponent = "0"] = used.toString().split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  const scale = Math.max(0, fraction.length - Number(exponent));
  const denominator = 10n ** BigInt(scale);
  const numerator = BigInt(whole + fraction) * 10n ** BigInt(Math.max(0, Number(exponent) - fraction.length));
  const remaining = 100n * denominator - numerator;
  const units = remaining * 1000000n / denominator;
  if (remaining > 0n && units === 0n) return "<0.000001";
  const digits = (units % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${units / 1000000n}${digits ? `.${digits}` : ""}`;
}

export function parseWeekly(result: unknown, now = Date.now()): WeeklySnapshot {
  if (!record(result) || !record(result.rateLimitsByLimitId) || !record(result.rateLimitsByLimitId.codex)) {
    throw new Error("Weekly limits unavailable");
  }
  const bucket = result.rateLimitsByLimitId.codex;
  const windows = [bucket.primary, bucket.secondary].filter(
    (window): window is Record<string, unknown> => record(window) && window.windowDurationMins === 10080,
  );
  if (windows.length !== 1) throw new Error("Weekly window unavailable");
  const { usedPercent, resetsAt } = windows[0];
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100 ||
      typeof resetsAt !== "number" || !Number.isSafeInteger(resetsAt) || !Number.isSafeInteger(resetsAt * 1000) ||
      resetsAt * 1000 <= now || resetsAt * 1000 - now > 2147483647) {
    throw new Error("Invalid weekly window");
  }
  return { text: `Weekly ${remainingText(usedPercent)}% left`, resetsAt };
}

export function readWeekly(signal: AbortSignal): Promise<WeeklySnapshot> {
  if (signal.aborted) return Promise.reject(new Error("Cancelled"));
  return new Promise((resolve, reject) => {
    const child = spawn(join(homedir(), ".local/bin/codex"), ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    let buffer = "";
    let outputBytes = 0;
    let stderrBytes = 0;
    let phase = 1;
    let finishing = false;
    let closed = false;
    let settled = false;
    let snapshot: WeeklySnapshot | undefined;
    let failure: Error | undefined;
    let terminateTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => finish(new Error("Status read timed out")), 12000);

    function settle() {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(terminateTimer);
      clearTimeout(killTimer);
      signal.removeEventListener("abort", abort);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      buffer = "";
      if (failure || !snapshot) reject(failure ?? new Error("Status unavailable"));
      else resolve(snapshot);
    }

    function finish(error?: Error, value?: WeeklySnapshot) {
      if (finishing) return;
      finishing = true;
      failure = error;
      snapshot = value;
      clearTimeout(timeout);
      if (closed) return settle();
      child.stdin.end();
      child.kill("SIGTERM");
      terminateTimer = setTimeout(() => {
        child.kill("SIGKILL");
        killTimer = setTimeout(() => {
          child.unref();
          settle();
        }, 500);
      }, 250);
    }

    function abort() {
      if (finishing) {
        failure = new Error("Cancelled");
        return;
      }
      finish(new Error("Cancelled"));
    }

    function send(message: object) {
      if (finishing) return;
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch {
        finish(new Error("Status stream failed"));
      }
    }

    signal.addEventListener("abort", abort, { once: true });
    child.on("error", () => finish(new Error("Status process failed")));
    child.on("close", () => {
      closed = true;
      if (!finishing) finish(new Error("Status process disconnected"));
      else settle();
    });
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream.on("error", () => finish(new Error("Status stream failed")));
    }
    child.stderr.on("data", (chunk: Buffer) => {
      if (finishing) return;
      stderrBytes += chunk.length;
      if (stderrBytes > 65536) finish(new Error("Status stderr limit exceeded"));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (finishing) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > 1048576) return finish(new Error("Status output limit exceeded"));
      buffer += chunk;
      let newline: number;
      while (!finishing && (newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          return finish(new Error("Malformed status response"));
        }
        if (!record(message)) return finish(new Error("Invalid status response"));
        if (message.id !== phase) continue;
        if ("error" in message || !record(message.result)) return finish(new Error("Status protocol error"));
        if (phase === 1) {
          phase = 2;
          send({ method: "initialized" });
          send({ id: 2, method: "account/rateLimits/read" });
        } else {
          try {
            finish(undefined, parseWeekly(message.result));
          } catch {
            finish(new Error("Weekly limits unavailable"));
          }
        }
      }
    });
    if (signal.aborted) abort();
    else send({ id: 1, method: "initialize", params: { clientInfo: { name: "pi_codex_weekly", version: "1.0.0" } } });
  });
}
