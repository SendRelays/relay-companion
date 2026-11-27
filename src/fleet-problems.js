import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { canonicalRuntimeLayout, CANONICAL_RUNTIME_SCHEMA } from "./canonical-runtime.js";

const updateActivity = createRequire(import.meta.url)("../bootstrap/update-activity.cjs");

// Every local record of why something failed, so the fleet report can say why
// a computer is not updating or recovering without asking the person for their
// logs. One closed `source` per record; a new failure record on disk needs a
// source here (test/fleet-telemetry-coverage.test.mjs enforces this).
export const PROBLEM_SOURCES = Object.freeze([
  "runtime-pointer", // ~/.relay/runtime/current.json
  "update-request", // ~/.relay/runtime/update-requests/<id>.json
  "release-health", // ~/.relay/recovery/release-health/<channel>/<version>/failure-*.json
  "recovery-status", // ~/.relay/recovery/status.json
  "recovery-worker", // ~/.relay/recovery/worker-failure.json
  "repair-progress", // ~/.relay/recovery/repair-progress.json
  "launcher", // ~/.relay/recovery/launcher-status.json
  "daemon-crash", // ~/.relay/recovery/daemon-crash.json
  "application-migration", // ~/.relay/application-migration.json
  "installer-recovery", // ~/.relay/runtime/installer-recovery.json
  "application-update", // ~/.relay/application-update.json
  "background-install", // ~/.relay/companion-install.json
  "update-launch", // <store>/update-errors.json (auto-update.js, update-watchdog.cjs)
  "scheduler-handover", // ~/.relay/recovery/scheduler-handover-status.json (macOS)
  "scheduler-cleanup", // ~/.relay/recovery/scheduler-cleanup.json (macOS)
  "application-uninstall", // ~/.relay/application-uninstall.json
  "hook-retirement", // ~/.relay/hook-retirement.json
  "native-install", // ~/.relay/application-packages/<release>/native-install.json (Windows)
  "application-worker", // ~/.relay/application-worker-observation.json (macOS)
  "activity", // ~/.relay/recovery/activity/call-*.json, and an update waiting on them (update-loop.json)
]);
// The state files above by name, for the coverage guard.
export const PROBLEM_STATE_FILES = Object.freeze([
  "current.json", "status.json", "worker-failure.json", "repair-progress.json", "launcher-status.json",
  "daemon-crash.json", "application-migration.json", "installer-recovery.json", "application-update.json",
  "companion-install.json", "update-errors.json", "scheduler-handover-status.json", "scheduler-cleanup.json",
  "application-uninstall.json", "hook-retirement.json", "native-install.json", "application-worker-observation.json",
]);
// An interrupted native install or a launcher worker that has run this long is stuck.
const STUCK_AFTER_MS = 30 * 60_000;
// A Relay call (an AI app's tool call, a session operation, a Relay-run AI
// turn) running this long is reported; ordinary calls finish in seconds.
const LONG_CALL_MS = 30 * 60_000;
// An update waiting on Relay calls this long (auto-update.js BUSY_ATTENTION_MS).
const UPDATE_WAIT_ATTENTION_MS = 6 * 60 * 60_000;
export const MAX_PROBLEMS = 24;
// The problems list's share of the report. Entries past it are dropped, oldest first.
export const MAX_PROBLEM_BYTES = 6000;
const DETAIL_MAX = 200;
const LABEL = /^[a-z0-9_.:-]{1,60}$/;
const VERSION = /^\d+\.\d+\.\d+$/;

/** A short label, or null: never free text. */
export function problemLabel(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toLowerCase().replace(/\s+/g, "-");
  return LABEL.test(text) ? text : null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Free text that may leave the machine: no home directory or user name, no
 * credential, no address; whitespace collapsed; at most 200 characters.
 */
export function sanitizeProblemDetail(value, { homeDir = "" } = {}) {
  if (value === null || value === undefined) return null;
  let text = typeof value === "string" ? value : String(value?.message || value);
  const homes = new Set();
  for (const candidate of [homeDir, (() => { try { return fs.realpathSync(homeDir); } catch { return ""; } })()]) {
    if (!candidate || candidate.length < 2) continue;
    homes.add(candidate);
    homes.add(candidate.replace(/\\/g, "/"));
    homes.add(candidate.replace(/\//g, "\\"));
  }
  for (const home of [...homes].sort((a, b) => b.length - a.length)) {
    text = text.replace(new RegExp(escapeRegExp(home), "gi"), "~");
  }
  text = text
    .replace(/(?:[A-Za-z]:)?[\\/]+(?:Users|home)[\\/]+[^\\/\s"'`:;,()]+/gi, "~")
    .replace(/\bBearer\s+\S+/gi, "[redacted]")
    .replace(/\b(?:dev|ski|rly|ghp|gho|ghs|npm|sk)_[A-Za-z0-9_-]{6,}/g, "[redacted]")
    .replace(/\bmcp_at\.\S+/g, "[redacted]")
    .replace(/[^\s@"'<>()]+@[^\s@"'<>()]+\.[A-Za-z]{2,}/g, "[redacted]")
    .replace(/[A-Za-z0-9+/=_-]{33,}/g, (run) => (
      /^[a-f0-9]+$/i.test(run) || (/[0-9]/.test(run) && /[A-Z]/.test(run) && /[a-z]/.test(run)) ? "[redacted]" : run
    ))
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, DETAIL_MAX) : null;
}

function iso(value) {
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? new Date(parsed).toISOString() : null;
  }
  const millis = Number(value);
  if (!Number.isFinite(millis) || millis <= 0) return null;
  try { return new Date(millis).toISOString(); } catch { return null; }
}

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(1_000_000, Math.floor(number)) : null;
}

// "phase: reason: detail", as recovery-entry.js and the update worker phrase a cause.
function splitCause(text) {
  const match = /^\s*([a-z0-9_.-]{1,60}):\s*([a-z0-9_.-]{1,60})(?::\s*([\s\S]*))?$/i.exec(String(text || ""));
  return match ? { phase: match[1].toLowerCase(), reason: match[2].toLowerCase(), rest: match[3] || "" } : null;
}

function readObject(file, readFileSync) {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function listNames(directory, readdirSync) {
  try { return readdirSync(directory).map(String); } catch { return []; }
}

/** Read the canonical pointer as written, whatever its state. */
export function readRuntimePointer({ homeDir, platform, readFileSync = fs.readFileSync }) {
  const value = readObject(canonicalRuntimeLayout({ homeDir, platform }).pointerPath, readFileSync);
  return value?.schema === CANONICAL_RUNTIME_SCHEMA ? value : null;
}

/** A rolled-back or recovered pointer: canonical, nothing active, no journal. */
export function inactivePointer(pointer) {
  return Boolean(pointer && pointer.active === false && !pointer.candidate
    && (pointer.state === "inactive" || pointer.state === undefined || pointer.state === null));
}

function pointerProblems(pointer) {
  if (!pointer) return [];
  // A rollback the runtime kept because the restored release was proven to be
  // serving (canonical-runtime.js, servingDespiteFailedRollback).
  const incomplete = pointer.rollbackIncomplete && typeof pointer.rollbackIncomplete === "object" ? pointer.rollbackIncomplete : null;
  const kept = incomplete ? [{ state: "rollback-incomplete", phase: incomplete.phase, reason: incomplete.reason,
    detail: [incomplete.failedVersion ? `from ${incomplete.failedVersion}` : "", incomplete.pill === false ? "pill not running" : "",
      incomplete.strayBroker ? "stray broker" : "", incomplete.detail || ""].filter(Boolean).join("; "),
    at: incomplete.at }] : [];
  if (["activating", "recovery-required"].includes(pointer.state)) {
    const failure = pointer.failure && typeof pointer.failure === "object" ? pointer.failure : null;
    if (!failure && pointer.state === "activating") return [];
    return [{ state: pointer.state, phase: failure?.phase, reason: failure?.reason, detail: failure?.detail,
      at: pointer.updatedAt || pointer.preparedAt }];
  }
  if (inactivePointer(pointer)) {
    return [...kept, { state: "inactive", reason: "rolled-back",
      detail: pointer.rolledBackFrom ? `rolled back from ${pointer.rolledBackFrom}` : "no active runtime",
      at: pointer.recoveredAt || pointer.committedAt || pointer.updatedAt }];
  }
  return kept;
}

function updateRequestProblems({ homeDir, platform, readFileSync, readdirSync, statSync }) {
  const api = platform === "win32" ? path.win32 : path.posix;
  const directory = api.join(canonicalRuntimeLayout({ homeDir, platform }).root, "update-requests");
  const files = listNames(directory, readdirSync).filter((name) => /^[A-Za-z0-9-]{1,80}\.json$/.test(name))
    .map((name) => {
      const file = api.join(directory, name);
      let mtime = 0;
      try { mtime = Number(statSync(file).mtimeMs) || 0; } catch {}
      return { file, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 20);
  const requests = files.map(({ file }) => readObject(file, readFileSync)).filter((value) => value?.requestId)
    .sort((a, b) => (Number(b.completedAt || b.requestedAt) || 0) - (Number(a.completedAt || a.requestedAt) || 0));
  let streak = 0;
  while (streak < requests.length && ["failed", "rejected"].includes(requests[streak].state)) streak += 1;
  return requests.slice(0, 2).filter((request) => ["failed", "rejected"].includes(request.state)).map((request, index) => {
    const result = request.result && typeof request.result === "object" ? request.result : {};
    const version = VERSION.test(String(request.version || "")) ? request.version : null;
    const text = result.detail || request.detail || "";
    return { state: request.state, phase: result.phase || request.stage, reason: result.reason || request.reason,
      detail: [version, text].filter(Boolean).join(": ") || null, at: request.completedAt || request.requestedAt,
      count: index === 0 ? streak : null };
  });
}

function releaseHealthProblems({ root, readFileSync, readdirSync }) {
  const directory = path.join(root, "recovery", "release-health");
  const found = [];
  let reads = 0;
  for (const channel of listNames(directory, readdirSync).filter((name) => ["stable", "dev", "staging"].includes(name))) {
    for (const version of listNames(path.join(directory, channel), readdirSync).filter((name) => VERSION.test(name))) {
      const releaseDir = path.join(directory, channel, version);
      const names = listNames(releaseDir, readdirSync).filter((name) => /^failure-[a-f0-9]{64}\.json$/.test(name));
      if (!names.length) continue;
      let newest = null;
      for (const name of names.slice(0, 100)) {
        if (reads++ > 400) break;
        const event = readObject(path.join(releaseDir, name), readFileSync);
        if (Number.isFinite(event?.at) && (!newest || event.at > newest.at)) newest = event;
      }
      if (!newest) continue;
      const proven = readObject(path.join(releaseDir, "proven.json"), readFileSync);
      if (Number(proven?.at) > newest.at) continue;
      found.push({ channel, version, newest, count: names.length });
    }
  }
  return found.sort((a, b) => b.newest.at - a.newest.at).slice(0, 2).map(({ channel, version, newest, count: total }) => {
    const cause = splitCause(newest.reason);
    return { state: newest.slept === true ? "slept" : "failed", phase: cause?.phase || channel,
      reason: cause?.reason || newest.reason, detail: `${channel} ${version}: ${newest.reason || "failed"}`,
      at: newest.at, count: total };
  });
}

// The retry time, restarts and stale-since are in installation.recovery
// (installation-health.cjs); this carries the errors and who paused recovery.
function recoveryStatusProblems(status) {
  if (!status) return [];
  const problems = [];
  if (status.status === "intentionally-stopped") {
    problems.push({ state: status.status, reason: status.pausedBy || "unknown", detail: null, at: status.pausedAt || status.checkedAt });
  } else if (status.lastError || status.ok === false) {
    const cause = splitCause(status.lastError);
    problems.push({ state: status.status, phase: cause?.phase, reason: cause?.reason || status.lastError,
      detail: status.lastError, at: status.checkedAt, count: status.failures });
  }
  if (status.discoveryError) {
    problems.push({ state: status.status, phase: "discovery", reason: status.discoveryError, detail: status.discoveryError, at: status.checkedAt });
  }
  return problems;
}

function workerProblems(failure) {
  if (!failure?.message) return [];
  const cause = splitCause(failure.message);
  const version = VERSION.test(String(failure.version || "")) ? failure.version : null;
  return [{ state: "failed", phase: cause?.phase, reason: cause?.reason || failure.message,
    detail: [version, cause ? cause.rest || null : failure.message].filter(Boolean).join(": ") || null, at: failure.at }];
}

function repairProblems(progress) {
  if (!progress || (!progress.lastError && progress.localExhausted !== true)) return [];
  const attempts = progress.attempts && typeof progress.attempts === "object"
    ? Object.values(progress.attempts).reduce((sum, value) => sum + (Number(value) || 0), 0) : null;
  const cause = splitCause(progress.lastError);
  return [{ state: progress.localExhausted === true ? "exhausted" : "retrying", phase: cause?.phase,
    reason: cause?.reason || progress.lastError, detail: progress.lastError, at: progress.updatedAt, count: attempts }];
}

function launcherProblems(launcher) {
  if (!launcher || !["failed", "runner-error", "fallback"].includes(launcher.status)) return [];
  const bundle = launcher.failedBundle ? String(launcher.failedBundle).split(/[\\/]/).filter(Boolean).pop() : null;
  return [{ state: launcher.status, reason: launcher.runtimeStatus,
    detail: [launcher.version && `bundle ${launcher.version}`, bundle && `quarantined ${bundle}`].filter(Boolean).join("; ") || null,
    at: launcher.at }];
}

function crashProblems(crash) {
  if (!crash || !Number.isFinite(crash.at)) return [];
  const fingerprint = /^[a-f0-9]{12,}$/.test(String(crash.fingerprint || "")) ? crash.fingerprint.slice(0, 12) : null;
  return [{ state: crash.startup === true ? "startup-crash" : "crash", reason: fingerprint ? `crash-${fingerprint}` : null,
    detail: VERSION.test(String(crash.version || "")) ? `version ${crash.version}` : null, at: crash.at, count: crash.count }];
}

function migrationProblems(journal) {
  if (!journal || !journal.state || journal.state === "complete") return [];
  const cause = splitCause(journal.failure);
  return [{ state: journal.state, phase: cause?.phase, reason: cause?.reason || journal.failure, detail: journal.failure || null,
    at: journal.completedAt || journal.at }];
}

function installerRecoveryProblems(journal) {
  if (!journal || (journal.state === "complete" && journal.deviceRetirement !== "needs-account-review")) return [];
  return [{ state: journal.state || "unknown", reason: journal.deviceRetirement,
    detail: VERSION.test(String(journal.version || "")) ? `version ${journal.version}` : null, at: journal.completedAt || journal.at }];
}

const QUIET_APPLICATION_STATES = new Set(["current", "no-offer", "complete", "installing", "disabled", "backoff"]);
function applicationUpdateProblems(status) {
  if (!status || (QUIET_APPLICATION_STATES.has(status.state) && !status.reason && !status.detail)) return [];
  const version = VERSION.test(String(status.version || "")) ? status.version : null;
  return [{ state: status.state, reason: status.reason, detail: [version, status.detail].filter(Boolean).join(": ") || null, at: status.at }];
}

function backgroundInstallProblems(install) {
  if (!install || install.status !== "failed") return [];
  return [{ state: "failed", reason: install.reason, detail: install.reason, at: install.finishedAt || install.startedAt }];
}

// The recovery schedule's handover to a new release (recovery-schedule-handover.cjs):
// a failed handover, or a cleanup of the old job that is still pending.
function schedulerHandoverProblems(status) {
  if (!status || typeof status !== "object") return [];
  const problems = [];
  if (status.ok === false) problems.push({ state: "failed", reason: status.reason, at: status.at });
  const cleanup = status.cleanup && typeof status.cleanup === "object" ? status.cleanup : null;
  if (cleanup?.pending === true && !["handover-pending", "removal-pending"].includes(cleanup.reason)) {
    problems.push({ state: "cleanup-pending", phase: "cleanup", reason: cleanup.reason, at: status.at });
  }
  return problems;
}

// Removing the previous recovery job after an install (recovery-install.cjs).
function schedulerCleanupProblems(status) {
  if (!status || status.pending !== true || status.reason === "running") return [];
  return [{ state: "pending", reason: status.reason, at: status.at }];
}

// An uninstall that started and never finished (application-uninstall.cjs).
function applicationUninstallProblems(journal) {
  if (!journal || journal.state !== "removing") return [];
  return [{ state: "removing", reason: "uninstall-interrupted", at: journal.at }];
}

// Retiring Relay's old agent hooks (install.js retireAgentHooks): which files
// could not be cleaned, by host and reason; paths are sanitised on the way out.
function hookRetirementProblems(report) {
  if (!report || report.ok !== false) return [];
  const failed = (Array.isArray(report.files) ? report.files : []).filter((file) => file && file.ok === false);
  return [{ state: "incomplete", reason: "hook-retirement-incomplete", count: failed.length,
    detail: failed.slice(0, 3).map((file) => [file.host, file.reason].filter(Boolean).join(": ")).join("; ") || null,
    at: report.checkedAt }];
}

// Windows records a native install as started, then complete; one left
// started is an install that was interrupted. Elsewhere the file only marks
// what to resume and is never completed, so it says nothing.
function nativeInstallProblems({ root, platform, readFileSync, readdirSync, statSync, now }) {
  if (platform !== "win32") return [];
  const directory = path.join(root, "application-packages");
  const problems = [];
  for (const name of listNames(directory, readdirSync)) {
    const file = path.join(directory, name, "native-install.json");
    const attempt = readObject(file, readFileSync);
    if (attempt?.state !== "started") continue;
    let at = 0;
    try { at = Number(statSync(file).mtimeMs) || 0; } catch {}
    if (at > 0 && now - at < STUCK_AFTER_MS) continue;
    const version = /^(\d+\.\d+\.\d+)-/.exec(name)?.[1] || null;
    problems.push({ state: "interrupted", reason: "native-install-interrupted", detail: version ? `release ${version}` : null, at: at || null });
  }
  return problems.slice(0, 2);
}

// The launcher's update worker the daemon found still running on a Mac
// (application-maintenance.js): stuck once it has run past its deadline.
function applicationWorkerProblems(observation, { now, alive }) {
  if (!observation || !Number.isSafeInteger(observation.pid) || !Number.isFinite(observation.at)) return [];
  if (now - observation.at < STUCK_AFTER_MS || !alive(observation.pid)) return [];
  return [{ state: "stuck", reason: "application-worker-overran", detail: `running ${Math.round((now - observation.at) / 60_000)} min`, at: observation.at }];
}

// Relay calls in progress (bootstrap/update-activity.cjs): each one an update
// would wait for. Long ones are reported with what they are and who owns them,
// so an update that waits shows what it waits on; markers whose owner has
// exited block nothing and are only counted.
function activityProblems({ root, readFileSync, readdirSync, now, alive, startedAtOf, loop }) {
  const directory = path.join(root, "recovery", "activity");
  const problems = [];
  let orphaned = 0, reused = 0;
  for (const name of listNames(directory, readdirSync).filter((value) => /^call-[a-f0-9-]+\.json$/.test(value))) {
    const call = readObject(path.join(directory, name), readFileSync);
    if (!call) continue;
    const present = Number.isSafeInteger(call.pid) && call.pid > 0 && alive(call.pid);
    if (!present) { orphaned += 1; continue; }
    // The number belongs to a process started after the marker (a restart
    // handed it on): the call is over, and the next update removes the marker.
    if (!updateActivity.ownerRunning(call, { alive, ...(startedAtOf ? { startedAtOf } : {}) })) { reused += 1; continue; }
    const started = Number(call.startedAt);
    const age = Number.isFinite(started) && started > 0 ? now - started : null;
    if (age === null || age >= LONG_CALL_MS) {
      problems.push({ state: "running", phase: call.kind, reason: call.label || call.kind || "call",
        detail: `${call.role || "unknown"} process, running ${age === null ? "an unknown time" : `${Math.floor(age / 60_000)} min`}`,
        at: Number.isFinite(started) && started > 0 ? started : null });
    }
  }
  if (orphaned) problems.push({ state: "orphaned", reason: "call-owner-exited", count: orphaned });
  if (reused) problems.push({ state: "orphaned", reason: "call-owner-number-reused", count: reused });
  const since = Number(loop?.busySince);
  if (loop?.status === "deferred-calls" && Number.isFinite(since) && now - since >= UPDATE_WAIT_ATTENTION_MS) {
    problems.push({ state: "update-waiting", reason: "relay-calls-active",
      detail: [loop.latest ? `waiting to install ${loop.latest}` : "", loop.detail || ""].filter(Boolean).join(": "), at: since });
  }
  return problems.slice(0, 4);
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

function updateLaunchProblems(ring) {
  const entries = Array.isArray(ring?.errors) ? ring.errors : [];
  return entries.filter((entry) => entry && typeof entry === "object")
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0)).slice(0, 3)
    .map((entry) => ({ state: entry.status, phase: entry.kind, reason: entry.reason, detail: entry.detail, at: entry.at, count: entry.count }));
}

function normalize(source, raw, homeDir) {
  const reason = problemLabel(raw.reason);
  const detail = sanitizeProblemDetail(raw.detail, { homeDir });
  return {
    source,
    state: problemLabel(raw.state),
    phase: problemLabel(raw.phase),
    reason,
    // A detail that only repeats the reason says nothing more.
    detail: detail && detail.toLowerCase() === reason ? null : detail,
    at: iso(raw.at),
    count: raw.count === undefined || raw.count === null ? null : count(raw.count),
  };
}

/** Every recorded failure, newest first, bounded in count and bytes. Never throws. */
export function collectFleetProblems({
  homeDir,
  platform = process.platform,
  env = process.env,
  updateStatePath,
  pointer,
  readFileSync = fs.readFileSync,
  readdirSync = fs.readdirSync,
  statSync = fs.statSync,
  now = Date.now(),
  alive = processAlive,
  startedAtOf,
} = {}) {
  const root = path.join(homeDir, ".relay");
  const read = (...parts) => readObject(path.join(...parts), readFileSync);
  const backgroundInstallFile = env?.RELAY_BACKGROUND_INSTALL_STATUS
    || path.join(env?.RELAY_CONFIG_DIR || root, "companion-install.json");
  const collectors = [
    ["runtime-pointer", () => pointerProblems(pointer === undefined ? readRuntimePointer({ homeDir, platform, readFileSync }) : pointer)],
    ["update-request", () => updateRequestProblems({ homeDir, platform, readFileSync, readdirSync, statSync })],
    ["release-health", () => releaseHealthProblems({ root, readFileSync, readdirSync })],
    ["recovery-status", () => recoveryStatusProblems(read(root, "recovery", "status.json"))],
    ["recovery-worker", () => workerProblems(read(root, "recovery", "worker-failure.json"))],
    ["repair-progress", () => repairProblems(read(root, "recovery", "repair-progress.json"))],
    ["launcher", () => launcherProblems(read(root, "recovery", "launcher-status.json"))],
    ["daemon-crash", () => crashProblems(read(root, "recovery", "daemon-crash.json"))],
    ["application-migration", () => migrationProblems(read(root, "application-migration.json"))],
    ["installer-recovery", () => installerRecoveryProblems(read(root, "runtime", "installer-recovery.json"))],
    ["application-update", () => applicationUpdateProblems(read(root, "application-update.json"))],
    ["background-install", () => backgroundInstallProblems(readObject(backgroundInstallFile, readFileSync))],
    ["scheduler-handover", () => schedulerHandoverProblems(read(root, "recovery", "scheduler-handover-status.json"))],
    ["scheduler-cleanup", () => schedulerCleanupProblems(read(root, "recovery", "scheduler-cleanup.json"))],
    ["application-uninstall", () => applicationUninstallProblems(read(root, "application-uninstall.json"))],
    ["hook-retirement", () => hookRetirementProblems(read(root, "hook-retirement.json"))],
    ["native-install", () => nativeInstallProblems({ root, platform, readFileSync, readdirSync, statSync, now })],
    ["application-worker", () => applicationWorkerProblems(read(root, "application-worker-observation.json"), { now, alive })],
    ["activity", () => activityProblems({ root, readFileSync, readdirSync, now, alive, startedAtOf,
      loop: updateStatePath ? readObject(path.join(path.dirname(updateStatePath), "update-loop.json"), readFileSync) : null })],
    ["update-launch", () => updateLaunchProblems(updateStatePath ? readObject(path.join(path.dirname(updateStatePath), "update-errors.json"), readFileSync) : null)],
  ];
  const problems = [];
  for (const [source, collect] of collectors) {
    try {
      for (const raw of collect()) problems.push(normalize(source, raw, homeDir));
    } catch {}
  }
  // Newest first; undated last, in source order.
  const ordered = problems.map((problem, index) => ({ problem, index }))
    .sort((a, b) => (Date.parse(b.problem.at || "") || 0) - (Date.parse(a.problem.at || "") || 0) || a.index - b.index)
    .map(({ problem }) => problem);
  const kept = [];
  let bytes = 2;
  for (const problem of ordered) {
    const size = Buffer.byteLength(JSON.stringify(problem), "utf8") + 1;
    if (kept.length >= MAX_PROBLEMS || bytes + size > MAX_PROBLEM_BYTES) break;
    kept.push(problem);
    bytes += size;
  }
  return kept;
}
