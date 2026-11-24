import { execFile } from "node:child_process";
import { Worker } from "node:worker_threads";
import runtimeHealth from "../bootstrap/runtime-health.cjs";
import diagnostics from "../bootstrap/diagnostics.cjs";
import sleepClock from "../bootstrap/sleep-clock.cjs";

// Why a collection failed, in the closed diagnostics vocabulary: which step
// (process-query, report) and what happened, so the fleet can tell a slow
// process listing from a crashed report thread or a sleeping computer.
function tagged(error, stage, code) {
  const value = error instanceof Error ? error : new Error(String(error));
  if (!value.diagnosticStage) Object.assign(value, { diagnosticStage: stage, diagnosticCode: code });
  return value;
}

// The parent owns the subprocess so a worker crash/termination cannot orphan
// PowerShell. Neither process enumeration nor metadata hashing runs synchronously
// on the request thread. The live recovery collectors keep their existing API.
export async function collectFleetTelemetryInBackground(context, signal, {
  query = runtimeHealth.runtimeProcessQuery(process.platform),
  workerUrl = new URL("./fleet-telemetry-worker.js", import.meta.url),
} = {}) {
  signal.throwIfAborted();
  let queryTimedOut = false;
  const stdout = await new Promise((resolve, reject) => {
    const child = execFile(query.command, query.args, {
      encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    }, (error, output) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", cancel);
      process.removeListener("exit", cancel);
      if (signal.aborted) reject(signal.reason);
      else if (error) reject(tagged(error, "process-query", queryTimedOut ? "timeout" : "service-process-query-failed"));
      else resolve(output);
    });
    const cancel = () => child.kill();
    // execFile's built-in timeout keeps short-lived CLI callers alive. Own an
    // unreferenced deadline instead, and kill the child on ordinary parent exit.
    const timeout = setTimeout(() => { queryTimedOut = true; cancel(); }, 15_000);
    timeout.unref();
    signal.addEventListener("abort", cancel, { once: true });
    process.once("exit", cancel);
    child.stdin?.end();
    child.unref();
    child.stdout?.unref?.();
    child.stderr?.unref?.();
  });
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, {
      workerData: { ...context, processOutput: stdout },
      execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
    let report;
    let failure;
    const cancel = () => { void worker.terminate().catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    worker.on("message", message => { report = message; });
    worker.on("error", error => { failure = error; });
    // Hold the in-flight slot until exit, including termination after timeout.
    worker.once("exit", code => {
      signal.removeEventListener("abort", cancel);
      if (signal.aborted) reject(signal.reason);
      else if (failure) reject(tagged(failure, "report", failure.code === "ERR_WORKER_OUT_OF_MEMORY" ? "worker-out-of-memory" : "worker-crashed"));
      else if (code !== 0) reject(tagged(new Error("telemetry-worker-failed"), "report", "worker-exited"));
      else if (typeof report !== "string" || !report) reject(tagged(new Error("telemetry-worker-failed"), "report", "collection-failed"));
      else resolve(report);
    });
    worker.unref();
  });
}

/** Request-time access never waits for collection. Time is sample age, not receipt age. */
export function createFleetTelemetryCache({
  collect = collectFleetTelemetryInBackground,
  context,
  now = Date.now,
  maxAgeMs = 30_000,
  timeoutMs = 25_000,
  retryMs = 30_000,
  slept = () => sleepClock.sleptMs(),
} = {}) {
  let cached = null;
  let pending = null;
  let retryAt = 0;
  let generation = 0;
  let currentKey;
  function reset() {
    generation++;
    cached = null;
    retryAt = 0;
    currentKey = undefined;
    // A new account, server or runtime: the collection in flight is stale.
    // That is a cancellation, not a failure of this computer.
    pending?.controller.abort(tagged(new Error("collection-cancelled"), "health", "collection-cancelled"));
  }
  return {
    reset,
    header(scope = "") {
      try {
        const snapshot = context(scope);
        const timestamp = now();
        if (snapshot.key !== currentKey) {
          reset();
          currentKey = snapshot.key;
        }
        if (cached && timestamp >= cached.at && timestamp - cached.at < maxAgeMs) return cached.header;
        cached = null;
        if (pending || (timestamp < retryAt && retryAt - timestamp <= retryMs)) return "";
        const controller = new AbortController();
        const run = { controller, generation, at: timestamp, slept: slept() };
        pending = run;
        const timer = setTimeout(() => controller.abort(tagged(new Error("deadline"), "health", "timeout")), timeoutMs);
        timer.unref?.();
        // collect's production implementation starts async execFile immediately.
        // The rejection handler also covers synchronous setup failures.
        void Promise.resolve().then(() => collect(snapshot, controller.signal)).then(header => {
          if (controller.signal.aborted || run.generation !== generation) return;
          const age = now() - run.at;
          if (age >= 0 && age < maxAgeMs && context(scope).key === snapshot.key
              && typeof header === "string" && header.length > 0 && header.length <= 4096) cached = { header, at: run.at };
        }).catch((error) => {
          // A computer that slept mid-check did not fail; say so instead.
          const sleptThrough = sleepClock.sleptBetween(run.slept, slept());
          const cancelled = error?.diagnosticCode === "collection-cancelled";
          if (snapshot.homeDir) diagnostics.record({
            component: "collector",
            stage: error?.diagnosticStage || "health",
            outcome: cancelled ? "skipped" : sleptThrough ? "deferred" : "failed",
            code: sleptThrough && !cancelled ? "interrupted-by-sleep" : error?.diagnosticCode || "collection-failed",
            elapsedMs: now() - run.at,
          }, { homeDir: snapshot.homeDir });
          // Diagnostic failures cannot fail the API request or escape as an
          // unhandled rejection. Retry at most once per cooldown.
        }).finally(() => {
          clearTimeout(timer);
          if (pending === run) pending = null;
          if (run.generation === generation && !cached) retryAt = now() + retryMs;
        });
      } catch {
        reset();
      }
      return "";
    },
  };
}
