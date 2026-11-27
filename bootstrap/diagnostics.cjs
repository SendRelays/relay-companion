"use strict";
// Best-effort diagnostics only. No recovery decisions, raw logs or credentials.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { atomicFile } = require("./mac-registration-transaction.cjs");
const MAX_EVENTS = 256, MAX_AGE_MS = 7 * 86400000;
const contract = require("./diagnostics-contract.json");
const pick = (list, value, fallback = "unknown") => list.includes(value) ? value : fallback;
const version = value => typeof value === "string" && value.length <= 40 && /^\d+\.\d+\.\d+$/.test(value) ? value : null;
const id = value => typeof value === "string" && /^[a-f0-9-]{32,36}$/.test(value) ? value : null;
function read(file, max = 65536) {
  try { if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > max) return null; return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
function errorCode(error) {
  const text = String(error?.code || error?.message || error || "");
  if (!text) return null;
  const named = contract.errors.find(code => text === code || text.startsWith(code + ":"));
  if (named) return named;
  const patterns = [
    [/unknown key/, "signing-key-unknown"], [/signature.*invalid|invalid.*signature/, "signature-invalid"],
    [/integrity|checksum|digest.*mismatch/, "integrity-mismatch"], [/ENOSPC/, "disk-full"],
    [/EACCES|EPERM/, "permission-denied"], [/EBUSY/, "file-busy"], [/ENOENT/, "file-missing"],
    [/ENOTFOUND|EAI_AGAIN/, "dns-failed"], [/ECONN|fetch failed/, "connection-failed"],
    [/timed?\s*out|timeout|deadline/i, "timeout"], [/transaction-in-progress|worker-exit-75|lock.*busy/, "transaction-busy"],
    [/recovery-bundle-copy-failed/, "recovery-copy-failed"], [/recovery-bundle-verification-failed/, "recovery-verification-failed"],
    [/recovery-bundle-publish-failed/, "recovery-publish-failed"], [/recovery-node-preservation-failed/, "recovery-node-failed"],
    [/runtime-not-healthy|not-responsive/, "health-check-failed"], [/configuration-unavailable/, "configuration-unavailable"],
  ];
  const matched = patterns.find(([pattern]) => pattern.test(text))?.[1];
  if (matched) return matched;
  // A reason that is itself a code (activation-busy, registration-restore-failed,
  // runtime-registration-failed) says exactly what failed, so it is kept rather
  // than flattened: 2026-11-26 a Mac's every failure read "unclassified" and its
  // cause had to be inferred from timings. Free text never qualifies; the API
  // stores an unknown code as a bounded label (packages/shared/src/tolerant.ts).
  const code = /^([a-z][a-z0-9]*(?:-[a-z0-9]+){1,7})(?::|$)/.exec(text)?.[1];
  return code && code.length <= 60 ? code : "unclassified";
}
// What kind of failure a background part hit, in the same closed vocabulary:
// never the message itself, which can hold paths or content. A server's error
// page or refusal, a local file that is corrupt, and a lock that could not be
// taken are told apart from the generic codes errorCode already knows.
function classifyFailure(error) {
  const status = Number(error?.status || error?.statusCode || 0);
  if (error?.code === "non_json_response" || status >= 500) return "server-error";
  if (status >= 400) return "server-refused";
  if (error?.name === "SyntaxError" || error instanceof SyntaxError) return "file-corrupt";
  if (/lock unavailable|lock-unavailable/i.test(String(error?.message || ""))) return "transaction-lock-unavailable";
  return errorCode(error) || "unclassified";
}
function configIdentity(homeDir) {
  const config = read(path.join(homeDir, ".relay", "config.json"));
  // A new account must never upload its predecessor's diagnostic history.
  const userId = config?.user?.id, deviceId = config?.deviceId;
  if (typeof userId !== "string" || typeof deviceId !== "string" || !userId || !deviceId) return null;
  return { config, userId, deviceId, scope: crypto.createHash("sha256").update(JSON.stringify([userId, deviceId])).digest("hex") };
}
const directory = (homeDir, scope) => path.join(homeDir, ".relay", "diagnostics", scope, "events");
function safeEvent(value) {
  if (value?.schema !== 1 || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.id || "") || !Number.isFinite(Date.parse(value.at))) return null;
  return { schema: 1, id: value.id, at: new Date(value.at).toISOString(),
    attemptId: id(value.attemptId), parentAttemptId: id(value.parentAttemptId),
    component: pick(contract.components, value.component), stage: pick(contract.stages, value.stage),
    outcome: pick(contract.outcomes, value.outcome), code: errorCode(value.code),
    signingKeyId: /^relay-runtime-release-v\d{1,6}$/.test(value.signingKeyId || "") ? value.signingKeyId : null,
    feed: pick(["stable", "stable-v3", "dev", "staging"], value.feed),
    version: version(value.version), targetVersion: version(value.targetVersion), channel: pick(contract.channels, value.channel),
    elapsedMs: Number.isFinite(value.elapsedMs) ? Math.min(86400000, Math.max(0, Math.round(value.elapsedMs))) : null };
}
function events(homeDir, scope) {
  const dir = directory(homeDir, scope);
  try {
    return fs.readdirSync(dir).filter(n => /^[a-f0-9-]{36}\.json$/.test(n)).map(name => ({ name, value: safeEvent(read(path.join(dir, name), 2048)) }))
      .filter(item => item.value?.schema === 1 && id(item.value.id) && Number.isFinite(Date.parse(item.value.at)))
      .sort((a, b) => a.value.at.localeCompare(b.value.at) || a.name.localeCompare(b.name));
  } catch { return []; }
}
function record(input, { homeDir = os.homedir(), now = Date.now, scope } = {}) {
  try {
    const identity = configIdentity(homeDir);
    if (!identity || (scope !== undefined && scope !== identity.scope)) return null;
    const at = now(), eventId = crypto.randomUUID();
    const value = { schema: 1, id: eventId, at: new Date(at).toISOString(),
      attemptId: id(input.attemptId), parentAttemptId: id(input.parentAttemptId),
      component: pick(contract.components, input.component), stage: pick(contract.stages, input.stage),
      outcome: pick(contract.outcomes, input.outcome), code: errorCode(input.code),
      signingKeyId: String(input.code?.message || input.code || "").match(/unknown key (relay-runtime-release-v\d{1,6})\b/)?.[1] || null,
      // Both the updater and (since 2026-11) the independent repair read stable-v3.
      feed: input.stage === "discovery" ? input.channel === "stable" ? "stable-v3" : pick(["dev", "staging"], input.channel) : "unknown",
      version: version(input.version), targetVersion: version(input.targetVersion),
      channel: pick(contract.channels, input.channel),
      elapsedMs: Number.isFinite(input.elapsedMs) ? Math.min(86400000, Math.max(0, Math.round(input.elapsedMs))) : null,
    };
    const dir = directory(homeDir, identity.scope);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    atomicFile(path.join(dir, eventId + ".json"), JSON.stringify(value));
    const all = events(homeDir, identity.scope);
    // Routine healthy polls must not immediately evict the failure we need to
    // diagnose. Retain failed attempts (including their preceding stages) first.
    const recent = all.filter(item => at - Date.parse(item.value.at) <= MAX_AGE_MS);
    const failedAttempts = new Set(recent.filter(e => e.value.outcome === "failed" && e.value.attemptId).map(e => e.value.attemptId));
    const important = e => e.value.outcome === "failed" || failedAttempts.has(e.value.attemptId);
    const protectedNames = new Set(recent.filter(important).slice(-192).map(e => e.name));
    const keep = new Set([...protectedNames, ...recent.filter(e => !protectedNames.has(e.name)).slice(-(MAX_EVENTS - protectedNames.size)).map(e => e.name)]);
    const removed = all.filter(item => !keep.has(item.name));
    if (removed.length) {
      const file = path.join(path.dirname(dir), "retention.json");
      atomicFile(file, JSON.stringify({ lastTrimAt: new Date(at).toISOString(), trimmedEvents: Math.min(1000000, (read(file)?.trimmedEvents || 0) + removed.length) }));
    }
    for (const item of removed) {
      try { fs.unlinkSync(path.join(dir, item.name)); } catch {}
    }
    return value;
  } catch { return null; }
}
function snapshot({ homeDir = os.homedir(), now = Date.now, env = process.env } = {}) {
  const root = path.join(homeDir, ".relay"), identity = configIdentity(homeDir);
  const current = read(path.join(root, "runtime", "current.json"));
  const recovery = read(path.join(root, "recovery", "status.json"));
  const heartbeat = read(path.join(root, "recovery", "daemon.json"));
  const progress = read(path.join(root, "recovery", "daemon-progress.json"));
  const crash = read(path.join(root, "recovery", "daemon-crash.json"));
  const update = read(path.join(homeDir, ".relay-companion", "update-state.json"));
  const processAlive = pid => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    try { process.kill(pid, 0); return true; } catch (error) { return error.code === "ESRCH" ? false : null; }
  };
  let requests = [];
  try {
    const dir = path.join(root, "runtime", "update-requests");
    requests = fs.readdirSync(dir).filter(n => /^[a-f0-9-]{36}\.json$/.test(n))
      .map(name => { try { return { name, modified: fs.statSync(path.join(dir, name)).mtimeMs }; } catch { return null; } })
      .filter(Boolean).sort((a, b) => b.modified - a.modified).slice(0, 256)
      .map(item => read(path.join(dir, item.name))).filter(Boolean).sort((a, b) => (b.requestedAt || 0) - (a.requestedAt || 0));
  } catch {}
  const request = requests[0];
  const channel = env.RELAY_UPDATE_CHANNEL || identity?.config.updateChannel || "stable";
  const retention = identity ? read(path.join(root, "diagnostics", identity.scope, "retention.json")) : null;
  const trustedKeys = (read(path.join(__dirname, "trust.json"))?.keys || []).map(k => k.keyId).filter(k => /^relay-runtime-release-v\d{1,6}$/.test(k)).slice(0, 2);
  const iso = value => Number.isFinite(value) && value > 0 && value <= 8640000000000000 ? new Date(value).toISOString() : null;
  const backup = name => {
    const value = read(path.join(root, "recovery", name));
    let available = false;
    try {
      const base = path.resolve(root, "runtime", "releases") + path.sep;
      available = typeof value?.packageRoot === "string" && path.resolve(value.packageRoot).startsWith(base)
        && fs.existsSync(path.join(value.packageRoot, "src", "recovery-entry.js"));
    } catch {}
    return { version: version(value?.version), channel: pick(contract.channels, value?.channel), available };
  };
  return { schema: 1, sampledAt: new Date(now()).toISOString(),
    trimmedEvents: Number.isSafeInteger(retention?.trimmedEvents) ? Math.min(1000000, Math.max(0, retention.trimmedEvents)) : 0,
    reporterTrustedKeys: trustedKeys,
    channel: pick(contract.channels, channel), channelSource: env.RELAY_UPDATE_CHANNEL ? "environment" : identity?.config.updateChannel ? "config" : "default",
    activeVersion: current?.active === true ? version(current.version) : null,
    candidateVersion: version(current?.candidate?.version), previousVersion: version(current?.previous?.version),
    runtimeState: pick(contract.runtimeStates, current?.state),
    recoveryVersion: version(recovery?.launcherVersion), recoveryCheckedAt: iso(recovery?.checkedAt),
    recoveryStatus: pick(contract.recoveryStatuses, recovery?.status), recoveryError: errorCode(recovery?.lastError),
    advertisedVersion: version(recovery?.advertisedVersion), selectedVersion: version(recovery?.desiredVersion),
    lastKnownGood: backup("runtime-good.json"), previousKnownGood: backup("runtime-previous-good.json"),
    daemonHeartbeatAt: iso(heartbeat?.at), daemonProgressAt: iso(progress?.at),
    daemonProcessAlive: processAlive(heartbeat?.pid),
    heartbeatMatchesActive: Boolean(current?.active && heartbeat?.version === current.version),
    progressMatchesActive: Boolean(current?.active && progress?.packageRoot === current.packageRoot && progress?.version === current.version && progress?.pid === heartbeat?.pid),
    daemonPhase: pick(["starting", "running", "offline", "signed-out"], progress?.phase),
    lastCrashAt: iso(crash?.at), lastCrashVersion: version(crash?.version),
    latestWorker: request ? { attemptId: id(request.requestId),
      stage: pick(contract.stages, request.stage), state: pick(["prepared", "admitted", "completed", "failed", "rejected"], request.state),
      startedAt: iso(request.requestedAt), stageStartedAt: iso(request.stageStartedAt), completedAt: iso(request.completedAt),
      processAlive: processAlive(request.workerPid), error: errorCode(request.result?.reason),
    } : null,
    failures: ["failure", "migrationFailure", "recoveryFailure", "autostartRepointFailure"].flatMap(slot => update?.[slot] ? [{
      kind: slot, code: errorCode(update[slot].reason), at: iso(update[slot].lastAt),
      count: Number.isFinite(update[slot].count) ? Math.min(1000000, Math.max(0, Math.floor(update[slot].count))) : 0,
    }] : []),
    discoveryError: errorCode(recovery?.discoveryError),
  };
}
module.exports = { record, snapshot, events, configIdentity, read, errorCode, classifyFailure, version, contract, MAX_EVENTS, MAX_AGE_MS };
