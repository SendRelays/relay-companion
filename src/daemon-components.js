import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const diagnostics = require("../bootstrap/diagnostics.cjs");

// The same failure is recorded at most this often per part and code, so a part
// that fails on every daemon tick cannot flood the bounded diagnostics store.
const RECORD_EVERY_MS = 15 * 60_000;

// Optional components run independently. A hung component remains in flight:
// never launch overlapping work or replay its external effects on a timeout.
//
// When one fails or stalls, the reason is kept where the fleet can see it, in
// the closed diagnostics vocabulary (never the message): the daemon's health
// file carries each part's last error, and a throttled diagnostics event says
// which part, which of its jobs, and what kind of failure. An operation may
// name its jobs with track(stage, promise), so a stall says which one hangs.
export function createDaemonComponents({
  health, log = () => {}, now = Date.now, stalledMs = 60_000,
  record = (event) => diagnostics.record(event), classify = diagnostics.classifyFailure,
} = {}) {
  const active = new Map();
  const recordedAt = new Map();
  function note(name, stage, code, elapsedMs) {
    const at = now();
    try { health?.componentError?.(name, { stage, code, at }); } catch {}
    const key = `${name}:${stage}:${code}`;
    if (at - (recordedAt.get(key) ?? -Infinity) < RECORD_EVERY_MS) return;
    recordedAt.set(key, at);
    try { record({ component: "daemon", stage, outcome: "failed", code, elapsedMs }); } catch {}
  }
  function stalled(name, pending) {
    health?.component(name, "stalled");
    if (pending.stallNoted) return;
    pending.stallNoted = true;
    const stage = [...pending.jobs][0] || name;
    note(name, stage, "component-stalled", now() - pending.startedAt);
  }
  return {
    inspect() {
      for (const [name, pending] of active) if (now() - pending.startedAt >= stalledMs) stalled(name, pending);
    },
    disable(name) { if (!active.has(name)) health?.component(name, "disabled"); },
    run(name, operation) {
      const pending = active.get(name);
      if (pending) {
        if (now() - pending.startedAt >= stalledMs) stalled(name, pending);
        return pending.promise;
      }
      const entry = { startedAt: now(), jobs: new Set(), stallNoted: false };
      const track = (stage, promise) => {
        entry.jobs.add(stage);
        return Promise.resolve(promise).then(
          (value) => { entry.jobs.delete(stage); return value; },
          (error) => {
            entry.jobs.delete(stage);
            if (error && typeof error === "object" && !error.diagnosticStage) error.diagnosticStage = stage;
            throw error;
          },
        );
      };
      active.set(name, entry);
      entry.promise = Promise.resolve().then(() => operation(track)).then(
        () => health?.component(name, "ok"),
        error => {
          health?.component(name, "failed");
          log(`${name} failed: ${error?.message || error}`);
          note(name, error?.diagnosticStage || name, classify(error), now() - entry.startedAt);
        },
      ).finally(() => active.delete(name));
      return entry.promise;
    },
  };
}
