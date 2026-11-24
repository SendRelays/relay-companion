import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Every few hours the daemon removes release copies nothing needs any more
// (canonical-runtime.js tidyCanonicalReleases), so a copy left behind by a
// failed update or a backup the recovery runner has moved past does not stay
// on disk until the next update. The work runs in a child process; this side
// only schedules it and logs what it removed.
const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "release-tidy-entry.js");
export const RELEASE_TIDY_FIRST_DELAY_MS = 10 * 60_000;
export const RELEASE_TIDY_EVERY_MS = 6 * 60 * 60_000;
const RELEASE_TIDY_TIMEOUT_MS = 2 * 60_000;

export function runReleaseTidyOnce({ log = () => {}, spawnImpl = spawn, execPath = process.execPath, entry = ENTRY, timeoutMs = RELEASE_TIDY_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let output = "";
    let child;
    try {
      child = spawnImpl(execPath, [entry], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch (error) {
      log(`release tidy could not start: ${error?.message || error}`);
      resolve(null);
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk) => { if (output.length < 65_536) output += chunk; });
    child.once("error", () => {});
    child.once("close", () => {
      clearTimeout(timer);
      let result = null;
      try { result = JSON.parse(output.trim().split(/\r?\n/).pop() || "null"); } catch {}
      if (result?.removed?.length) log(`release tidy removed ${result.removed.length} unused release cop${result.removed.length === 1 ? "y" : "ies"}: ${result.removed.join(", ")}`);
      else if (result?.ok === false) log(`release tidy failed: ${result.skipped || "unknown"}${result.detail ? ` (${result.detail})` : ""}`);
      resolve(result);
    });
  });
}

/** Schedules the tidy: once a few minutes after the daemon starts, then every few hours. Returns stop(). */
export function startReleaseTidy({ log = () => {}, firstDelayMs = RELEASE_TIDY_FIRST_DELAY_MS, everyMs = RELEASE_TIDY_EVERY_MS, run = runReleaseTidyOnce } = {}) {
  let interval = null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await run({ log }); } catch {} finally { running = false; }
  };
  const first = setTimeout(() => {
    void tick();
    interval = setInterval(() => { void tick(); }, everyMs);
    interval.unref?.();
  }, firstDelayMs);
  first.unref?.();
  return () => { clearTimeout(first); if (interval) clearInterval(interval); };
}
