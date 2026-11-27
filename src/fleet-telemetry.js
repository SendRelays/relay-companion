import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { updateChannel, configPath } from "./config.js";
import { createFleetTelemetryCache } from "./fleet-telemetry-background.js";
import { storeDir } from "./host-paths.js";
import { readCanonicalRuntimeState } from "./canonical-runtime.js";
import { collectFleetProblems, inactivePointer, readRuntimePointer, sanitizeProblemDetail, PROBLEM_SOURCES } from "./fleet-problems.js";

export { PROBLEM_SOURCES };

const require = createRequire(import.meta.url);
const relaySkill = require("../bootstrap/relay-skill.cjs");
const { collectInstallationHealth } = require("../bootstrap/installation-health.cjs");

export const COMPANION_TELEMETRY_SCHEMA = 1;
export const COMPANION_TELEMETRY_HEADER = "x-relay-companion-telemetry";
// The whole report travels in a request body (POST /v1/devices/telemetry),
// below the API's 65536-byte limit with room for the JSON envelope.
export const MAX_FULL_REPORT_BYTES = 60_000;
const FAILURE_SLOTS = [
  ["failure", "update"],
  ["migrationFailure", "migration"],
  ["recoveryFailure", "recovery"],
  ["autostartRepointFailure", "autostart_repoint"],
];

function isoFromMillis(value) {
  const millis = Number(value);
  if (!Number.isFinite(millis) || millis <= 0) return null;
  try { return new Date(millis).toISOString(); } catch { return null; }
}

function cleanVersion(value) {
  const version = String(value || "").trim().slice(0, 40);
  return version || null;
}

function readObject(file, readFileSync) {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function failureTelemetry(updateState) {
  const failures = [];
  for (const [slot, kind] of FAILURE_SLOTS) {
    const value = updateState?.[slot];
    const count = Number(value?.count);
    if (!value || !Number.isFinite(count) || count <= 0) continue;
    // A superseded recovery keeps its episode key (the stuck candidate) and says
    // which release it is actually trying, so the fleet sees "0.1.510 via 0.1.624"
    // rather than four weeks of an apparently identical retry.
    const launched = typeof value.launched === "string" ? value.launched.trim() : "";
    const target = String(value.target || "").trim();
    const exhaustedAt = isoFromMillis(value.exhaustedAt);
    const reason = LOOP_LABEL.test(String(value.reason || "")) ? String(value.reason) : null;
    failures.push({
      kind,
      target: (launched && !target.endsWith(`:${launched}`) ? `${target} via ${launched}` : target).slice(0, 80),
      count: Math.min(1_000_000, Math.floor(count)),
      firstAt: isoFromMillis(value.firstAt),
      lastAt: isoFromMillis(value.lastAt),
      // Only a parked recovery reports this, so an API that predates the field
      // rejects nothing but the reports of machines that have already given up.
      ...(exhaustedAt ? { exhaustedAt } : {}),
      // Why the last attempt failed (update-state.json), when it was recorded.
      ...(reason ? { reason } : {}),
    });
  }
  return failures;
}

const LOOP_VERSION = /^\d+\.\d+\.\d+$/;
const LOOP_LABEL = /^[a-z0-9_.:-]{1,60}$/;

// Why this computer is or is not updating, as its own update loop last
// decided (auto-update.js, update-loop.json). Labels, versions, counts and
// times only. Absent when the loop has not recorded a decision yet.
function updateLoopTelemetry(file, readFileSync, homeDir) {
  const loop = readObject(file, readFileSync);
  if (!loop || !LOOP_LABEL.test(String(loop.status || ""))) return undefined;
  const version = (value) => (LOOP_VERSION.test(String(value || "")) ? String(value) : null);
  const label = (value) => (LOOP_LABEL.test(String(value || "")) ? String(value) : null);
  const count = Number(loop.checkFailures);
  const detail = sanitizeProblemDetail(loop.detail, { homeDir });
  return {
    status: String(loop.status),
    at: isoFromMillis(loop.at),
    latest: version(loop.latest),
    pending: version(loop.pending),
    retryAt: isoFromMillis(loop.retryAt),
    reason: label(loop.reason),
    lastCheckAt: isoFromMillis(loop.lastCheckAt),
    checkFailures: Number.isFinite(count) && count > 0 ? Math.min(1_000_000, Math.floor(count)) : 0,
    checkError: label(loop.checkError),
    ...(isoFromMillis(loop.busySince) ? { busySince: isoFromMillis(loop.busySince) } : {}),
    // The error text behind a launch failure or a stuck recovery, sanitised.
    ...(detail ? { detail } : {}),
  };
}

function autoUpdateEnabled(env) {
  const raw = String(env?.RELAY_AUTO_UPDATE ?? "").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

function optionalIso(value) {
  if (typeof value !== "string" || !value) return null;
  return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

/** Inspect only Relay-owned metadata and hashes; never include local paths. */
function managedSkillTelemetry({ homeDir, env }) {
  return relaySkill.defaultTargets({ homeDir, env }).map((target) => {
    const state = relaySkill.readState(target.directory);
    const exists = fs.existsSync(target.directory);
    const changed = exists ? relaySkill.localChanges(target.directory, state) : [];
    return {
      name: "relay",
      host: target.host,
      target: target.target || "primary",
      ...(state && /^ski_[A-Za-z0-9_-]{20,80}$/.test(String(state.installationId || "")) ? { installationId: state.installationId } : {}),
      version: state && /^\d+\.\d+\.\d+$/.test(String(state.version || "")) ? state.version : null,
      consentVersion: Number.isSafeInteger(state?.consentVersion) && state.consentVersion > 0 ? state.consentVersion : null,
      status: !exists ? "absent" : !state ? "unmanaged" : changed.length ? "modified" : "managed",
      installedAt: optionalIso(state?.installedAt),
    };
  });
}

// Free space on the disk holding Relay, so a computer running out shows before
// an update fails to download. 5 GB matches the updater's low-disk mode
// (canonical-updater.js LOW_DISK_FREE_BYTES).
const LOW_DISK_BYTES = 5 * 1024 ** 3;
function diskTelemetry(homeDir, statfs) {
  try {
    const stats = statfs(homeDir);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize), totalBytes = Number(stats.blocks) * Number(stats.bsize);
    if (!Number.isFinite(freeBytes) || !Number.isFinite(totalBytes) || totalBytes <= 0) return undefined;
    return { freeBytes: Math.floor(freeBytes), totalBytes: Math.floor(totalBytes), low: freeBytes < LOW_DISK_BYTES };
  } catch { return undefined; }
}

/** Collect only the state needed to identify and support a stranded updater. */
export function collectCompanionFleetTelemetry({
  homeDir = os.homedir(),
  platform = process.platform,
  env = process.env,
  channel = updateChannel(),
  updateStatePath = path.join(storeDir(), "update-state.json"),
  updateLoopPath = path.join(path.dirname(updateStatePath), "update-loop.json"),
  readFileSync = fs.readFileSync,
  readdirSync = fs.readdirSync,
  statSync = fs.statSync,
  collectHealth = collectInstallationHealth,
  statfs = fs.statfsSync,
} = {}) {
  const canonical = readCanonicalRuntimeState({ homeDir, platform, readFileSync });
  const updateState = readObject(updateStatePath, readFileSync);
  const updateLoop = updateLoopTelemetry(updateLoopPath, readFileSync, homeDir);
  // A canonical pointer that a rollback or recovery left with nothing active
  // (canonical-runtime.js) is not a legacy install: say so, and why.
  const pointer = readRuntimePointer({ homeDir, platform, readFileSync });
  const inactive = !canonical && inactivePointer(pointer);
  const runtimeState = canonical?.state === "activating" || canonical?.state === "recovery-required"
    ? canonical.state
    : canonical?.active === true
      ? "active"
      : inactive ? "inactive" : "legacy";
  let problems = [];
  try {
    problems = collectFleetProblems({ homeDir, platform, env, updateStatePath, pointer, readFileSync, readdirSync, statSync });
  } catch {}
  const stateMillis = canonical?.committedAt || canonical?.updatedAt || canonical?.preparedAt || null;
  return {
    schema: COMPANION_TELEMETRY_SCHEMA,
    channel: ["dev", "staging"].includes(channel) ? channel : "stable",
    autoUpdate: autoUpdateEnabled(env),
    runtimeKind: canonical || inactive ? "canonical" : "legacy",
    runtimeState,
    activeVersion: cleanVersion(canonical?.active === true ? canonical.version : canonical?.previous?.version),
    candidateVersion: cleanVersion(canonical?.candidate?.version),
    previousVersion: cleanVersion(canonical?.previous?.version),
    stateChangedAt: isoFromMillis(stateMillis),
    failures: failureTelemetry(updateState),
    ...(updateLoop ? { updateLoop } : {}),
    // Every locally recorded failure reason, newest first (fleet-problems.js).
    ...(problems.length ? { problems } : {}),
    skills: managedSkillTelemetry({ homeDir, env }),
    installation: collectHealth({ homeDir, platform }),
    ...(diskTelemetry(homeDir, statfs) ? { disk: diskTelemetry(homeDir, statfs) } : {}),
  };
}

export function encodeCompanionFleetTelemetry(value, { onTruncated = () => {} } = {}) {
  const encode = (report) => Buffer.from(JSON.stringify(report), "utf8").toString("base64url");
  let header = encode(value);
  if (header.length <= 4096) return header;
  // Over the API's 4096-byte header boundary, shed the problems list and the
  // update loop's error text first (the whole report carries both), then the
  // connection detail (connection-health.js) before the installation report,
  // and the report before the whole header.
  if (value?.problems || value?.updateLoop?.detail) {
    const { detail, ...loop } = value.updateLoop || {};
    value = { ...value, problems: undefined, ...(value.updateLoop ? { updateLoop: loop } : {}) };
    header = encode(value);
    if (header.length <= 4096) return header;
  }
  const installation = value?.installation;
  const shed = installation ? [
    { ...installation,
      connection: installation.connection ? { ...installation.connection, waiting: [] } : undefined,
      health: installation.health?.errors
        ? { ...installation.health, errors: installation.health.errors.map(({ waitingOn, ...item }) => item) }
        : installation.health },
    { ...installation, connection: undefined, loop: undefined,
      health: installation.health?.errors
        ? { ...installation.health, errors: installation.health.errors.map(({ waitingOn, ...item }) => item) }
        : installation.health },
  ] : [];
  for (const smaller of shed) {
    header = encode({ ...value, installation: smaller });
    if (header.length <= 4096) return header;
  }
  try { onTruncated(); } catch {}
  header = encode({ ...value, installation: undefined });
  return header.length <= 4096 ? header : "";
}

function fileGeneration(file) {
  try {
    const stat = fs.statSync(file);
    return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function fleetTelemetryContext(scope = "") {
  const homeDir = os.homedir();
  const configFile = configPath();
  const updateStatePath = path.join(storeDir(), "update-state.json");
  // Cheap generation checks prevent a late scan crossing a config/account or
  // canonical-runtime change. No credentials, process scans or file hashing.
  const key = JSON.stringify([scope, homeDir, configFile, updateStatePath,
    process.env.RELAY_UPDATE_CHANNEL, process.env.RELAY_AUTO_UPDATE,
    process.env.CODEX_HOME, process.env.CLAUDE_HOME,
    fileGeneration(configFile), fileGeneration(path.join(homeDir, ".relay", "runtime", "current.json"))]);
  return { key, homeDir, configFile, updateStatePath };
}

const telemetryCache = createFleetTelemetryCache({ context: fleetTelemetryContext });

export function companionFleetTelemetryHeader({ scope = "" } = {}) {
  return telemetryCache.header(scope);
}

/** The whole report as JSON plus its sample time, or null while none is fresh. */
export function companionFleetTelemetryReport({ scope = "", freshMs } = {}) {
  return telemetryCache.full(scope, { freshMs });
}

export function resetCompanionFleetTelemetryCache() {
  telemetryCache.reset();
}
