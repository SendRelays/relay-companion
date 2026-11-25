import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const diagnostics = require("../bootstrap/diagnostics.cjs");

// HOW THIS PROCESS IS GETTING ON WITH RELAY'S SERVER (2026-11-25).
//
// On 2026-11-24 Sven's Mac reported its background service "not responding"
// with every network job stalled, and nothing on the server could say whether
// his connection was down or Relay itself was stuck: the answer was only in
// his local log. This keeps, per process, what that question needs and nothing
// more: request outcomes and timings for the last 15 minutes, the last failure
// as a closed code, which kinds of request are still waiting (route shapes,
// never ids, URLs or bodies), and, in the daemon only, an outage history that
// is recorded as diagnostics events so it uploads once the connection returns.

const WINDOW_MS = 15 * 60_000;
const MAX_SAMPLES = 600;
const SLOW_MS = 5_000;
// Failing for this long, with no success in between, is an outage.
const OUTAGE_MS = 60_000;

const samples = []; // { at, ms, outcome: "ok" | "server-error" | "failed" }
const inFlight = new Map();
let nextRequestId = 1;
let lastSuccessAt = 0;
let lastFailureAt = 0;
let failingSince = 0;
let lastFailureCode = null;
let outage = null; // { since, code, recorded }
let outageRecorder = null;

/** Which daemon part a request belongs to (daemon-components.js runs each part inside it). */
export const requestScope = new AsyncLocalStorage();

/** "GET /v1/relays/:id/task": the route's shape, never an id or a query. */
export function requestLabel(method, path) {
  const segments = String(path || "").split("?")[0].split("/").filter(Boolean)
    .slice(0, 5)
    .map((segment) => (/^(v\d|[a-z][a-z-]{0,30})$/.test(segment) ? segment : ":id"));
  return `${String(method || "GET").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 7)} /${segments.join("/")}`.slice(0, 68);
}

function failureChain(error) {
  const codes = [];
  let name = "";
  for (let current = error, depth = 0; current && depth < 8; depth += 1, current = current.cause) {
    if (typeof current.code === "string") codes.push(current.code);
    if (!name && typeof current.name === "string") name = current.name;
  }
  return { codes, name, message: String(error?.message || "") };
}

/** A request that got no answer, as one closed code. */
export function connectionFailureCode(error) {
  const { codes, name, message } = failureChain(error);
  const has = (pattern) => codes.some((code) => pattern.test(code));
  if (has(/^(ENOTFOUND|EAI_AGAIN|EAI_NONAME)$/)) return "dns-failed";
  if (has(/^ECONNREFUSED$/)) return "connection-refused";
  if (has(/^(ECONNRESET|EPIPE|UND_ERR_SOCKET|UND_ERR_CLOSED)$/)) return "connection-reset";
  if (has(/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/)) return "tls-failed";
  if (name === "TimeoutError" || has(/^(ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)$/) || /timed? ?out/i.test(message)) return "timeout";
  if (has(/^(ENETUNREACH|EHOSTUNREACH|ENETDOWN)$/)) return "connection-failed";
  return "connection-failed";
}

function prune(now) {
  while (samples.length && (now - samples[0].at > WINDOW_MS || samples.length > MAX_SAMPLES)) samples.shift();
}

export function requestStarted(method, path, now = Date.now()) {
  const id = nextRequestId++;
  inFlight.set(id, { label: requestLabel(method, path), startedAt: now, component: requestScope.getStore()?.component || null });
  return id;
}

/** The server answered (any status). */
export function requestAnswered(id, status, now = Date.now()) {
  const entry = inFlight.get(id);
  inFlight.delete(id);
  const ms = entry ? Math.max(0, now - entry.startedAt) : 0;
  samples.push({ at: now, ms, outcome: Number(status) >= 500 ? "server-error" : "ok" });
  prune(now);
  lastSuccessAt = now;
  failingSince = 0;
  if (outage?.recorded && outageRecorder) {
    try { outageRecorder({ component: "daemon", stage: "connection", outcome: "succeeded", code: null, elapsedMs: now - outage.since }); } catch {}
  }
  outage = null;
}

/** No answer: the connection failed, timed out or was refused. Cancellations are not reported here. */
export function requestFailed(id, error, now = Date.now()) {
  inFlight.delete(id);
  const code = connectionFailureCode(error);
  samples.push({ at: now, ms: 0, outcome: "failed" });
  prune(now);
  lastFailureAt = now;
  lastFailureCode = code;
  if (!failingSince) failingSince = now;
  if (!outage) outage = { since: failingSince, code, recorded: false };
  if (outageRecorder && !outage.recorded && now - outage.since >= OUTAGE_MS) {
    outage.recorded = true;
    try { outageRecorder({ component: "daemon", stage: "connection", outcome: "failed", code: outage.code, elapsedMs: now - outage.since }); } catch {}
  }
}

/** A request given up on by its caller (cancelled), neither answered nor failed. */
export function requestAbandoned(id) {
  inFlight.delete(id);
}

const iso = (millis) => (millis > 0 ? new Date(millis).toISOString() : null);

/** The oldest request a daemon part is still waiting on, or null. */
export function oldestRequestFor(component, now = Date.now()) {
  let oldest = null;
  for (const entry of inFlight.values()) {
    if (entry.component !== component) continue;
    if (!oldest || entry.startedAt < oldest.startedAt) oldest = entry;
  }
  return oldest ? { label: oldest.label, waitingMs: Math.max(0, now - oldest.startedAt) } : null;
}

/** This process's connection summary: what the health report carries. */
export function connectionHealth(now = Date.now()) {
  prune(now);
  const answered = samples.filter((sample) => sample.outcome !== "failed").map((sample) => sample.ms).sort((a, b) => a - b);
  const percentile = (p) => (answered.length ? answered[Math.min(answered.length - 1, Math.floor(p * answered.length))] : null);
  const waiting = [...inFlight.values()]
    .filter((entry) => now - entry.startedAt >= 10_000)
    .sort((a, b) => a.startedAt - b.startedAt)
    .slice(0, 3)
    .map((entry) => ({ label: entry.label, component: entry.component, waitingMs: now - entry.startedAt }));
  return {
    lastSuccessAt: iso(lastSuccessAt),
    failingSince: iso(failingSince),
    lastFailureAt: iso(lastFailureAt),
    lastFailureCode,
    window: {
      minutes: WINDOW_MS / 60_000,
      ok: samples.filter((sample) => sample.outcome === "ok").length,
      serverError: samples.filter((sample) => sample.outcome === "server-error").length,
      failed: samples.filter((sample) => sample.outcome === "failed").length,
      slow: samples.filter((sample) => sample.outcome !== "failed" && sample.ms >= SLOW_MS).length,
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
    },
    waiting,
  };
}

/** The daemon records outages as diagnostics events, so they upload after the connection returns. */
export function enableOutageDiagnostics({ record = (event) => diagnostics.record(event) } = {}) {
  outageRecorder = record;
}

/** Test seam: forget everything. */
export function resetConnectionHealth() {
  samples.length = 0;
  inFlight.clear();
  lastSuccessAt = 0;
  lastFailureAt = 0;
  failingSince = 0;
  lastFailureCode = null;
  outage = null;
  outageRecorder = null;
}
