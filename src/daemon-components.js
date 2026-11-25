import { createRequire } from "node:module";
import { oldestRequestFor, requestScope } from "./connection-health.js";

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
//
// A run the machine slept through is not judged on the sleep: its stall clock
// starts again at the wake (wokeAt, recovery-health.js), and a failure it met
// is logged but not recorded as a diagnostic, since the sleep cut it off.
export function createDaemonComponents({
  health, log = () => {}, now = Date.now, stalledMs = 60_000, wokeAt = () => 0,
  record = (event) => diagnostics.record(event), classify = diagnostics.classifyFailure,
} = {}) {
  const woke = () => { try { return Number(wokeAt()) || 0; } catch { return 0; } };
  const runningFor = (entry) => now() - Math.max(entry.startedAt, woke());
  const active = new Map();
  const recordedAt = new Map();
  function note(name, stage, code, elapsedMs, waitingOn = null) {
    const at = now();
    // waitingOn: the kind of server request the part was still waiting on
    // ("GET /v1/inbox"), so a stall says "waiting on the server" or not.
    try { health?.componentError?.(name, { stage, code, at, ...(waitingOn ? { waitingOn } : {}) }); } catch {}
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
    note(name, stage, "component-stalled", runningFor(pending), oldestRequestFor(name)?.label || null);
  }
  return {
    inspect() {
      for (const [name, pending] of active) if (runningFor(pending) >= stalledMs) stalled(name, pending);
    },
    disable(name) { if (!active.has(name)) health?.component(name, "disabled"); },
    run(name, operation) {
      const pending = active.get(name);
      if (pending) {
        if (runningFor(pending) >= stalledMs) stalled(name, pending);
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
      // Requests made inside the part are tagged with its name (connection-health.js).
      entry.promise = Promise.resolve().then(() => requestScope.run({ component: name }, () => operation(track))).then(
        () => health?.component(name, "ok"),
        error => {
          health?.component(name, "failed");
          log(`${name} failed: ${error?.message || error}`);
          if (woke() <= entry.startedAt) note(name, error?.diagnosticStage || name, classify(error), now() - entry.startedAt);
        },
      ).finally(() => active.delete(name));
      return entry.promise;
    },
  };
}
