import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { updateChannel } from "./config.js";
import { recoveryPolicy } from "../bootstrap/recovery-policy.cjs";
import { compatibleNodeRuntime, persistentNodePath, stableNodePath } from "./install.js";
import { ACTIVE_UPDATE_WORKER_ENV } from "./update-agent-cleanup.js";
import { ensureMcpBrokerProvisioned } from "./mcp-broker-state.js";
import nodeContract from "../bootstrap/node-contract.cjs";
import {
  canonicalRuntimeLayout,
  readCanonicalRuntime,
  recoverCanonicalRuntime,
  repairCanonicalRuntime,
  verifyCanonicalCandidate,
  verifyCanonicalTreeComplete,
} from "./canonical-runtime.js";

const WINDOWS_DAEMON_TASK = "Relay Companion Daemon";
const WINDOWS_PILL_TASK = "Relay Companion Pill";
export const UPDATE_WORKER_LABEL_PREFIX = "work.relay.companion.update.";
export const UPDATE_WORKER_LABEL = "work.relay.companion.update";
export const UPDATE_REQUEST_SCHEMA = 1;
const require = createRequire(import.meta.url);
const diagnostics = require("../bootstrap/diagnostics.cjs");
const { stageVerifiedRuntime, releasePlatform } = require("../bootstrap/relay-setup.cjs");
const { systemdRunEnvironmentArgs } = require("../bootstrap/linux-systemd.cjs");
const { associatedBundleIdentifiersPlist } = require("../bootstrap/mac-background-identity.cjs");
const {
  activateLinuxRuntimeServices,
  activateMacRuntimeServices,
  exactRuntimeHealth,
  runtimeProcessCommands: processCommands,
} = require("../bootstrap/runtime-health.cjs");

export { exactRuntimeHealth };

// ---- Delegated activation ----
// The update worker is the RUNNING release's code. From this release on, when
// the release being installed ships src/activation-entry.js, the worker runs
// that release's own activation code for the switch, so a fix to activation
// takes effect on the very update that ships it. The worker keeps the lock,
// has already verified the tree, and restores itself with its own code if the
// new code crashes, overruns or fails. Releases before this one never
// delegate: they keep activating with their own code, as they always did.
export const ACTIVATION_ENTRY = path.join("src", "activation-entry.js");
export const ACTIVATION_RESULT_PREFIX = "RELAY_ACTIVATION_RESULT ";
// Activation's own bounds: registrations (30 s), service restart (90 s),
// readiness proof (90 s), the Mac transaction around them. Generous, so a
// slow but healthy activation is never killed half way.
export const DELEGATED_ACTIVATION_TIMEOUT_MS = 8 * 60_000;
const DELEGATED_OUTPUT_LIMIT = 256 * 1024;

/** Whether `candidate` can activate itself. RELAY_DELEGATED_ACTIVATION=0 turns it off. */
export function canDelegateActivation(candidate, { env = process.env, existsSync = fs.existsSync } = {}) {
  if (String(env?.RELAY_DELEGATED_ACTIVATION ?? "").trim() === "0") return false;
  if (!candidate?.packageRoot || !candidate?.node || !candidate?.bin) return false;
  try { return existsSync(path.join(candidate.packageRoot, ACTIVATION_ENTRY)); } catch { return false; }
}

/**
 * Run `owner`'s activation entry: mode "activate" switches to `target`
 * (owner itself), "restore" puts `target` (the release owner was replacing)
 * back. `completed: true` means owner's code ran to the end and gave a
 * verdict; a crash, overrun or unreadable answer is `completed: false`.
 */
export function runDelegatedActivation(mode, target, {
  owner,
  homeDir = os.homedir(),
  platform = process.platform,
  options = {},
  spawnImpl = spawn,
  timeoutMs = DELEGATED_ACTIVATION_TIMEOUT_MS,
  env = process.env,
  log = () => {},
} = {}) {
  const payload = Buffer.from(JSON.stringify({ schema: 1, mode, target, homeDir, platform, options }), "utf8").toString("base64url");
  const entry = path.join(owner.packageRoot, ACTIVATION_ENTRY);
  return new Promise((resolve) => {
    let child;
    let output = "";
    let errors = "";
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ...result, delegated: true, delegatedTo: owner.version });
    };
    try {
      // The new release's code acts inside this worker's transaction. Hand it
      // the lock's owner token, as every repair child gets: without it the
      // registration step it runs sees another owner and refuses ("Another
      // verified Relay install or update is already in progress").
      const owned = require("../bootstrap/lifecycle-ownership.cjs").ownerEnvironment({ homeDir, env });
      child = spawnImpl(owner.node, [entry, payload], {
        env: { ...owned, [ACTIVE_UPDATE_WORKER_ENV]: "1", RELAY_ACTIVATION_WORKER: "1", ELECTRON_RUN_AS_NODE: undefined },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      finish({ ok: false, completed: false, reason: "delegated-activation-spawn-failed", detail: String(error?.message || error) });
      return;
    }
    timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish({ ok: false, completed: false, reason: "delegated-activation-timeout", detail: `no verdict after ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk) => { if (output.length < DELEGATED_OUTPUT_LIMIT) output += String(chunk); });
    child.stderr?.on("data", (chunk) => { if (errors.length < 8_192) errors += String(chunk); });
    child.on("error", (error) => finish({ ok: false, completed: false, reason: "delegated-activation-spawn-failed", detail: String(error?.message || error) }));
    child.on("close", (code, signal) => {
      const line = output.split(/\r?\n/).reverse().find((value) => value.startsWith(ACTIVATION_RESULT_PREFIX));
      let verdict = null;
      try { verdict = line ? JSON.parse(line.slice(ACTIVATION_RESULT_PREFIX.length)) : null; } catch { verdict = null; }
      if (verdict && typeof verdict === "object" && typeof verdict.ok === "boolean") {
        if (!verdict.ok) log(`delegated ${mode} by ${owner.version} failed: ${verdict.reason || "unknown"}`);
        finish({ ...verdict, completed: true });
      } else {
        const tail = errors.trim().split(/\r?\n/).slice(-3).join(" | ").slice(0, 1_000);
        finish({ ok: false, completed: false, reason: "delegated-activation-no-verdict", detail: `exit=${code} signal=${signal || ""} ${tail}`.trim() });
      }
    });
  });
}

/**
 * After a rollback whose proof failed: is the restored release's daemon in
 * fact the one serving? Exactly one daemon from its tree and no other, its
 * heartbeat fresh and naming its version, and its probe answering, on two
 * samples `gapMs` apart. A stray broker or a missing pill does not count
 * against it: the daemon's own guards heal those (canonical-runtime.js,
 * servingDespiteFailedRollback). An observer that cannot list processes
 * proves nothing.
 */
export async function confirmRuntimeServing(target, {
  homeDir = os.homedir(),
  platform = process.platform,
  run = defaultRun,
  health = exactRuntimeHealth,
  probe = (role, value, options) => require("../bootstrap/recovery-probe.cjs").requestProbe(role, value, options),
  readHeartbeat = () => JSON.parse(fs.readFileSync(path.join(homeDir, ".relay", "recovery", "daemon.json"), "utf8")),
  hasProbe = (value) => fs.existsSync(path.join(value.packageRoot, "bootstrap", "recovery-probe.cjs")),
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  samples = 2,
  gapMs = 10_000,
  heartbeatFreshMs = 60_000,
} = {}) {
  if (!target?.bin || !target?.packageRoot || !target?.version) return { ok: false, reason: "serving-target-invalid" };
  let observed = null;
  for (let sample = 0; sample < samples; sample += 1) {
    if (sample > 0) await sleep(gapMs);
    observed = health(target, { platform, run });
    if (!observed?.known || observed.daemon !== true || observed.oldDaemon === true) {
      return { ok: false, reason: "daemon-not-serving", detail: JSON.stringify({ known: observed?.known, daemon: observed?.daemon, oldDaemon: observed?.oldDaemon }) };
    }
    let beat = null;
    try { beat = readHeartbeat(); } catch {}
    const age = now() - Number(beat?.at);
    if (beat?.version !== target.version || !Number.isFinite(age) || age < 0 || age >= heartbeatFreshMs) {
      return { ok: false, reason: "daemon-heartbeat-stale" };
    }
    // Releases older than the probe protocol cannot answer it; the process
    // and the heartbeat are then the strongest evidence there is.
    if (hasProbe(target)) {
      const answer = await probe("daemon", target, { homeDir, timeoutMs: 3000 });
      if (answer?.ok !== true) return { ok: false, reason: answer?.reason || "daemon-probe-failed" };
    }
  }
  return { ok: true, pill: observed.pill === true, oldBroker: observed.oldBroker === true, oldPill: observed.oldPill === true };
}

export async function installSignedRuntimeCandidate({ stagingRoot, version, platform = process.platform, log } = {}) {
  try {
    const expectedPlatform = releasePlatform(platform, process.arch);
    await stageVerifiedRuntime({ version, platformKey: expectedPlatform, destination: stagingRoot, ...(log ? { log } : {}) });
    return { ok: true, source: "signed-runtime-artifact" };
  } catch (error) {
    return { ok: false, detail: error?.message || String(error) };
  }
}

function commandOk(result) {
  return Boolean(result && !result.error && result.status === 0);
}

function defaultRun(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", timeout: 30_000, windowsHide: true, ...options });
}

export function legacyRuntimeTarget(packageRoot, version, {
  node = process.execPath,
  platform = process.platform,
} = {}) {
  const verified = verifyCanonicalCandidate(packageRoot, version, { platform });
  if (!verified.ok) return null;
  // The running tree is only a rollback target while it can still be imported.
  // A tree that lost packages to a partial delete is worse than no target: the
  // transaction then leaves repair to the verified recovery engine.
  if (!verifyCanonicalTreeComplete(packageRoot, { platform }).ok) return null;
  return {
    kind: "legacy",
    version,
    packageRoot,
    bin: verified.bin,
    electronPath: verified.electronPath,
    node,
  };
}

export function runtimeNpmCommand(node = process.execPath, {
  platform = process.platform,
  existsSync = fs.existsSync,
} = {}) {
  const api = platform === "win32" ? path.win32 : path.posix;
  const directory = api.dirname(String(node || ""));
  const names = platform === "win32" ? ["npm.cmd", "npm"] : ["npm"];
  for (const name of names) {
    const candidate = api.join(directory, name);
    try { if (existsSync(candidate)) return candidate; } catch {}
  }
  return null;
}

export const CANDIDATE_SMOKE_TIMEOUT_MS = 120_000;

export function smokeCanonicalCandidate(candidate, { run = defaultRun, log = () => {}, now = Date.now } = {}) {
  // First-touch scanning can make a freshly extracted Windows tree much slower
  // than a warm CLI. Retry only a timeout, against this same verified tree.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const startedAt = now();
    const result = run(candidate.node, [candidate.bin, "--help"], {
      timeout: CANDIDATE_SMOKE_TIMEOUT_MS,
      env: { ...process.env, RELAY_SKIP_DESKTOP_POSTINSTALL: "1" },
    });
    const timedOut = result?.error?.code === "ETIMEDOUT";
    const elapsedMs = Math.max(0, now() - startedAt);
    log(`candidate startup check ${attempt}/2: ${commandOk(result) ? "passed" : timedOut ? "timed out" : "failed"}; elapsed=${elapsedMs}ms; exit=${result?.status ?? "none"}; signal=${result?.signal || "none"}`);
    if (commandOk(result)) return { ok: true };
    if (timedOut && attempt === 1) continue;
    return {
      ok: false,
      reason: timedOut ? "candidate-cli-smoke-timeout" : "candidate-cli-smoke-failed",
      detail: result?.error?.message || result?.stderr || result?.stdout || "",
    };
  }
}

/**
 * The release copies cleanup must keep besides the active one: every release a
 * running process uses, and the watchdog's last responsive installations
 * (runtime-good.json, runtime-previous-good.json), which are its offline
 * recovery sources. `recoveryBackups` counts the backups actually recorded.
 */
// Below this much free space on the disk that holds ~/.relay, Relay keeps one
// recovery backup instead of two: each release copy is close to 900 MB, and on
// 2026-11-27 a Mac with 4.7 GB free held five of them. The newest proven
// release (runtime-good.json) is always kept.
export const LOW_DISK_FREE_BYTES = 5 * 1024 ** 3;

/** Free and total bytes of the disk holding `directory`, or null when unknown. */
export function diskSpace(directory, { statfs = fs.statfsSync } = {}) {
  try {
    const stats = statfs(directory);
    const free = Number(stats.bavail) * Number(stats.bsize), total = Number(stats.blocks) * Number(stats.bsize);
    return Number.isFinite(free) && Number.isFinite(total) && total > 0 ? { freeBytes: free, totalBytes: total } : null;
  } catch { return null; }
}

export function keptReleaseRoots({
  homeDir = os.homedir(),
  platform = process.platform,
  getProtectedPackageRoots = processReferencedCanonicalRoots,
  fsImpl = fs,
  space = () => diskSpace(homeDir),
} = {}) {
  const protectedPackageRoots = [...getProtectedPackageRoots({ homeDir, platform })];
  let recoveryBackups = 0;
  let free = null;
  try { free = space()?.freeBytes ?? null; } catch {}
  const lowDisk = Number.isFinite(free) && free < LOW_DISK_FREE_BYTES;
  for (const name of lowDisk ? ["runtime-good.json"] : ["runtime-good.json", "runtime-previous-good.json"]) {
    try {
      const good = JSON.parse(fsImpl.readFileSync(path.join(homeDir, ".relay", "recovery", name), "utf8"));
      if (typeof good?.packageRoot === "string") {
        protectedPackageRoots.push(good.packageRoot);
        recoveryBackups += 1;
      }
    } catch {}
  }
  return { protectedPackageRoots, recoveryBackups, lowDisk };
}

// Update request records (update-requests/<id>.json) were never removed: a Mac
// had 4,127 of them on 2026-11-27. Keep the newest KEEP_UPDATE_REQUESTS and any
// written in the last hour; remove the rest once finished, or once a day old
// whatever their state (an unfinished request a day old is abandoned).
export const KEEP_UPDATE_REQUESTS = 50;
export function pruneUpdateRequests({ homeDir = os.homedir(), platform = process.platform, fsImpl = fs, now = Date.now } = {}) {
  const directory = requestDirectory(homeDir, platform);
  let names;
  try { names = fsImpl.readdirSync(directory).filter((name) => /^[A-Za-z0-9-]{1,80}\.json$/.test(name)); } catch { return { removed: 0 }; }
  const records = names.map((name) => {
    const file = path.join(directory, name);
    let modified = 0;
    try { modified = fsImpl.statSync(file).mtimeMs; } catch {}
    return { file, modified };
  }).sort((a, b) => b.modified - a.modified);
  let removed = 0;
  for (const record of records.slice(KEEP_UPDATE_REQUESTS)) {
    const age = now() - record.modified;
    if (!(age >= 60 * 60_000)) continue;
    let state = null;
    try { state = JSON.parse(fsImpl.readFileSync(record.file, "utf8"))?.state || null; } catch {}
    if (!["completed", "failed", "rejected"].includes(state) && age < 24 * 60 * 60_000) continue;
    try { fsImpl.rmSync(record.file, { force: true }); removed += 1; } catch {}
  }
  return { removed, kept: records.length - removed };
}

export function processReferencedCanonicalRoots({
  homeDir = os.homedir(),
  platform = process.platform,
  run = defaultRun,
  fsImpl = fs,
} = {}) {
  const api = platform === "win32" ? path.win32 : path.posix;
  const { releasesDir } = canonicalRuntimeLayout({ homeDir, platform });
  let names = [];
  try {
    names = fsImpl.readdirSync(releasesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink?.())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const commands = processCommands(platform, run);
  const normalize = (value) => (platform === "win32" ? String(value).toLowerCase() : String(value)).replaceAll("\\", "/");
  return names
    .map((name) => api.join(releasesDir, name, "node_modules", "relay-companion"))
    .filter((packageRoot) => commands.some((command) => normalize(command).includes(normalize(packageRoot))));
}

// How long activation waits, behind the barrier that holds new Relay calls
// back, for calls already running to finish. The updater checks for running
// calls before it starts (runCanonicalUpdateTransaction), so this only covers a
// call that began in between; holding new calls back longer would itself
// interrupt people.
export const ACTIVATION_DRAIN_ATTEMPTS = 180; // 90 s at 500 ms

export async function activateCanonicalRuntime(target, options = {}) {
  let release;
  let drained = false;
  try {
    const drain = options.drain || require("../bootstrap/update-activity.cjs").drainCalls;
    release = await drain({ homeDir: options.homeDir, sleep: options.sleep, attempts: options.drainAttempts ?? ACTIVATION_DRAIN_ATTEMPTS });
    drained = true;
    const activateReady = async () => {
      const activated = await activateDrainedRuntime(target, options);
      if (!activated.ok) return activated;
      const ready = options.verifyReady || require("../bootstrap/recovery-readiness.cjs").waitForRecoveryReady;
      const requiresProgress = fs.existsSync(path.join(target.packageRoot, "bootstrap", "daemon-progress.cjs"));
      const observed = await ready({ homeDir: options.homeDir, platform: options.platform, target,
        // The transaction deliberately keeps the pointer in "activating"
        // until this proof finishes. Probe the lock-owned target, not an
        // already-committed pointer, including when proving rollback.
        readCurrent: () => ({ ...target, active: true }),
        requireProgress: requiresProgress, timeoutMs: 90_000 });
      return observed.ok ? { ...activated, readiness: observed } : { ok: false, reason: "activation-not-ready", detail: observed.detail || observed.reason };
    };
    if ((options.platform || process.platform) === "darwin") {
      const transaction = options.macTransaction || require("../bootstrap/mac-activation-transaction.cjs").macActivationTransaction;
      return await transaction(target, activateReady, options);
    }
    return await activateReady();
  } catch (error) {
    // Nothing has been changed before the drain finishes: Relay work still
    // running is a reason to wait, never a failed activation to roll back.
    // 2026-11-26: a Mac turned "busy" into "recovery required" this way, and
    // every repair after it waited on the same call and gave up the same way.
    if (!drained) {
      return { ok: false, unchanged: true, reason: error?.code === "relay-calls-active" ? "activation-busy" : "activation-drain-failed",
        detail: error?.message || String(error), ...(Array.isArray(error?.blocking) ? { blocking: error.blocking } : {}) };
    }
    return { ok: false, reason: "activation-threw", detail: error?.message || String(error) };
  } finally { release?.(); }
}

/** Rewrite the shared MCP broker descriptor to name `target`'s broker. Never throws. */
export function provisionBrokerForTarget(target, {
  homeDir = os.homedir(),
  platform = process.platform,
  env = process.env,
  provision = ensureMcpBrokerProvisioned,
} = {}) {
  // The same config root the daemon's own registration repair uses
  // (mcp-launcher.js ensureStableMcpLauncher), so both write one descriptor.
  const brokerEnv = { ...env, ...(env.RELAY_CONFIG || env.RELAY_CONFIG_DIR ? {} : { RELAY_CONFIG_DIR: path.join(homeDir, ".relay") }) };
  delete brokerEnv[ACTIVE_UPDATE_WORKER_ENV];
  try {
    provision({ env: brokerEnv, packageRoot: target.packageRoot, brokerNode: target.node, platform, homeDir });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: "broker-descriptor-provision-failed", detail: error?.message || String(error) };
  }
}

async function activateDrainedRuntime(target, {
  homeDir = os.homedir(),
  platform = process.platform,
  run = defaultRun,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  // Exact-root health polls, 500ms apart. 30s: an Electron pill can legitimately
  // take >15s to be killed and >5s to come back up on a loaded machine.
  attempts = 60,
  domainPollMs = 250,
  bootstrapDelayMs = 500,
  activationDeadlineMs = 90_000,
  now = Date.now,
  repairExecutable = target,
  provisionBroker = provisionBrokerForTarget,
} = {}) {
  if (!target?.bin || !target?.node || !target?.packageRoot) return { ok: false, reason: "activation-target-invalid" };
  if (!repairExecutable?.bin || !repairExecutable?.node) return { ok: false, reason: "repair-runtime-missing" };
  const targetOverride = repairExecutable.bin === target.bin
    ? []
    : ["--target-bin", target.bin, "--target-node", target.node];
  const repair = run(repairExecutable.node, [
    repairExecutable.bin,
    "repair-runtime",
    "--no-restart",
    ...targetOverride,
  ], {
    env: require("../bootstrap/lifecycle-ownership.cjs").ownerEnvironment({ homeDir,
      env: { ...process.env, RELAY_SKIP_DESKTOP_POSTINSTALL: "1", [ACTIVE_UPDATE_WORKER_ENV]: "1" } }),
  });
  if (!commandOk(repair)) {
    return { ok: false, reason: "runtime-registration-failed", detail: repair?.error?.message || repair?.stderr || repair?.stdout || "" };
  }

  // Point the MCP broker descriptor at the target BEFORE the old broker is
  // stopped. Each release's broker has its own endpoint, and every AI session's
  // bridge redials whatever the descriptor names the moment its broker goes away
  // (native-bridge/session.go). Until now only the new daemon rewrote it, a few
  // seconds after starting, so in that window reconnecting bridges dialled the
  // old endpoint, found nothing and started the OLD release's broker again. On a
  // Mac that old broker fails activation's exact-root proof, activation stops it,
  // bridges bring it back, and the 90 s deadline runs out: Sven, 2026-11-24
  // (oldBroker:true, rolled back), and 2026-10-10 and 2026-11-12 before that.
  // A rollback activates the previous release through this same path, so the
  // descriptor follows it back. A failure here is not fatal: the new daemon
  // still rewrites the descriptor when it starts, as before.
  provisionBroker(target, { homeDir, platform });

  if (platform === "darwin") {
    return activateMacRuntimeServices(target, {
      homeDir,
      platform,
      run,
      sleep,
      domainPollMs,
      bootstrapDelayMs,
      activationDeadlineMs,
      now,
    });
  } else if (platform === "linux") {
    return activateLinuxRuntimeServices(target, {
      homeDir,
      platform,
      run,
      sleep,
      attempts,
    });
  } else if (platform === "win32") {
    for (const task of [WINDOWS_PILL_TASK, WINDOWS_DAEMON_TASK]) run("schtasks.exe", ["/End", "/TN", task]);
    // The tasks launch through a short-lived wscript/WshShell.Run wrapper. `/End`
    // can therefore succeed while the actual node/Electron child survives. Stop
    // every Relay service process by command-line identity before starting the new
    // exact-root actions; the updater worker itself does not match either pattern.
    const stopRelayChildren = [
      "$relaySid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;",
      "$p=Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {",
      "  $_.CommandLine -and ($_.CommandLine -match '[\\\\/]node_modules[\\\\/]relay-companion[\\\\/]') -and (($_.CommandLine -match '[\\\\/]relay\\.js.*\\bdaemon\\b') -or ($_.CommandLine -match '[\\\\/]overlay[\\\\/]main\\.cjs') -or ($_.CommandLine -match '[\\\\/]mcp-broker-entry\\.js'))",
      "}; foreach($x in $p){ try { $relayOwner=Invoke-CimMethod -InputObject $x -MethodName GetOwnerSid -ErrorAction Stop; if($relayOwner.Sid -eq $relaySid){ Invoke-CimMethod -InputObject $x -MethodName Terminate -ErrorAction Stop | Out-Null } } catch {} }",
    ].join(" ");
    const stopped = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", stopRelayChildren]);
    if (!commandOk(stopped)) return { ok: false, reason: "old-service-stop-failed", detail: stopped?.stderr || stopped?.stdout || "" };
    for (const task of [WINDOWS_PILL_TASK, WINDOWS_DAEMON_TASK]) {
      const started = run("schtasks.exe", ["/Run", "/TN", task]);
      if (!commandOk(started)) return { ok: false, reason: "service-start-failed", detail: `${task}: ${started?.stderr || started?.stdout || ""}` };
    }
  } else {
    return { ok: false, reason: "activation-platform-unsupported" };
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const health = exactRuntimeHealth(target, { platform, run });
    if (health.ok) return { ok: true, health };
    if (attempt + 1 < attempts) await sleep(500);
  }
  return { ok: false, reason: "exact-root-health-failed", detail: target.packageRoot };
}

export async function runCanonicalUpdateTransaction({
  version,
  runningPackageRoot,
  runningVersion,
  node = process.execPath,
  homeDir = os.homedir(),
  platform = process.platform,
  log = () => {},
  activate = activateCanonicalRuntime,
  confirmServing = confirmRuntimeServing,
  canDelegate = canDelegateActivation,
  delegateActivation = runDelegatedActivation,
  runningCalls = () => require("../bootstrap/update-activity.cjs").describeCalls({ homeDir }).filter((call) => call.alive),
  repair = repairCanonicalRuntime,
  installCandidate = installSignedRuntimeCandidate,
  smoke = smokeCanonicalCandidate,
  npmCommand = runtimeNpmCommand(node, { platform }),
  getProtectedPackageRoots = processReferencedCanonicalRoots,
  resolveServiceNode = stableNodePath,
  onLockAcquired = () => {},
  requestId = null,
  workerId = null,
  repairExecutableOverride = null,
  supersedeBrokenRecovery = false,
  onProgress = () => {},
  now = Date.now,
  releasePolicy = recoveryPolicy({ root: path.join(homeDir, ".relay", "recovery"), now }),
} = {}) {
  const releaseChannel = updateChannel();
  const releaseFailureId = requestId || workerId || randomUUID();
  const diagnosticScope = diagnostics.configIdentity(homeDir)?.scope || null;
  const diagnostic = (stage, outcome, code = null, elapsedMs = null) => diagnostics.record({
    component: "updater", attemptId: releaseFailureId, parentAttemptId: process.env.RELAY_RECOVERY_RUN_ID,
    channel: releaseChannel, targetVersion: version, stage, outcome, code, elapsedMs,
  }, { homeDir, now, scope: diagnosticScope });
  const transactionStartedAt = now();
  // A transaction the machine slept through is recorded but does not count (recovery-policy.cjs).
  const noteReleaseFailure = reason => {
    try { releasePolicy.failure(releaseChannel, version, { id: releaseFailureId, reason, since: transactionStartedAt }); }
    catch (error) { log(`release failure history could not be saved: ${error.message}`); }
  };
  const stage = async (name, operation) => {
    const startedAt = now();
    diagnostic(name, "started");
    onProgress({ stage: name, stageStartedAt: startedAt });
    log(`stage ${name} started`);
    try {
      const result = await operation();
      diagnostic(name, result?.ok === false ? "failed" : "succeeded", result?.reason || (result?.ok === false ? result?.detail : null), now() - startedAt);
      // Relay work still running says nothing about the release: no cooldown.
      if (result?.ok === false && result.reason !== "activation-busy" && ["activation", "startup-verification"].includes(name)) {
        noteReleaseFailure(result.reason);
      }
      log(`stage ${name} ${result?.ok === false ? "failed" : "finished"}; elapsed=${Math.max(0, now() - startedAt)}ms`);
      return result;
    } catch (error) {
      diagnostic(name, "failed", error, now() - startedAt);
      if (["activation", "startup-verification"].includes(name)) {
        noteReleaseFailure(error.message);
      }
      log(`stage ${name} threw; elapsed=${Math.max(0, now() - startedAt)}ms; ${error?.message || error}`);
      throw error;
    }
  };
  const selectedServiceNode = resolveServiceNode(node);
  if (!selectedServiceNode) return { ok: false, phase: "input", reason: "service-node-missing", detail: node };
  if (isElectronExecutable(selectedServiceNode)) return { ok: false, phase: "input", reason: "service-node-electron", detail: selectedServiceNode };
  let serviceNode;
  try {
    serviceNode = persistentNodePath(selectedServiceNode, { platform, homeDir });
  } catch (error) {
    return {
      ok: false,
      phase: "input",
      reason: "service-node-preservation-failed",
      detail: error?.message || String(error),
    };
  }
  const persistentTargetNode = (candidate) => {
    const selected = resolveServiceNode(candidate);
    if (!selected) return serviceNode;
    try {
      return persistentNodePath(selected, { platform, homeDir });
    } catch {
      return serviceNode;
    }
  };
  // Electron must never be baked into plists/pointers as the runtime's node, and it
  // cannot resolve npm either. spawnCanonicalUpdate substitutes a real node before
  // the worker exists; this guard is the backstop for every other caller.
  if (isElectronExecutable(serviceNode)) {
    return { ok: false, phase: "input", reason: "service-node-electron", detail: serviceNode };
  }
  const { protectedPackageRoots } = keptReleaseRoots({ homeDir, platform, getProtectedPackageRoots });
  const lockIdentity = { ...(requestId ? { requestId } : {}), ...(workerId ? { workerId } : {}) };
  let admitted = false;
  const admit = async (owner) => {
    if (admitted) return;
    await onLockAcquired(owner);
    admitted = true;
  };
  const recovered = await stage("recovery", () => recoverCanonicalRuntime({
    homeDir,
    platform,
    protectedPackageRoots,
    rollbackActivate: async (target, context) => target
      ? activate({
          ...target,
          node: persistentTargetNode(target?.node || serviceNode),
        }, { homeDir, platform, restoreRegistrations: true, repairExecutable: repairExecutableOverride || context?.recovery?.candidate })
      : { ok: true },
    onLockAcquired: admit,
    lockIdentity,
    confirmServing: (target) => confirmServing(target, { homeDir, platform }),
  }));
  if (!recovered.ok && !(supersedeBrokenRecovery && recovered.phase === "recovery")) return recovered;
  if (recovered.recovered) return recovered;
  // npm is resolved beside the worker's own runtime; when that yields nothing (the
  // worker was handed a bare binary with no sibling npm), fall back to the durable
  // service node's npm rather than failing the whole transaction.
  const npmExecutable = npmCommand || runtimeNpmCommand(serviceNode, { platform });
  const previous = readCanonicalRuntime({ homeDir, platform });
  const legacy = previous || supersedeBrokenRecovery ? null : legacyRuntimeTarget(runningPackageRoot, runningVersion, { node: serviceNode, platform });
  if (!previous && !legacy && !supersedeBrokenRecovery) return { ok: false, phase: "input", reason: "legacy-runtime-invalid" };
  // An ordinary update waits while Relay work is running, before it downloads
  // or changes anything; the daemon tries again shortly (auto-update.js). A
  // repair of a broken installation does not wait here: its activation drain
  // still lets running calls finish.
  if (!supersedeBrokenRecovery) {
    let running = [];
    try { running = runningCalls(); } catch {}
    if (running.length) {
      const { summarizeCalls } = require("../bootstrap/update-activity.cjs");
      const detail = summarizeCalls(running);
      log(`waiting: Relay work is running (${detail})`);
      diagnostic("activation", "deferred", "activation-busy");
      return { ok: false, phase: "busy", reason: "activation-busy", unchanged: true, detail, blocking: running };
    }
  }
  return repair({
    archiveRecoveryJournal: supersedeBrokenRecovery,
    version,
    homeDir,
    platform,
    node: serviceNode,
    npmCommand: npmExecutable,
    // The download's own progress lines (resumed from, every 10%) go to the
    // same update.log as the stage lines, so a slow or flaky download is
    // readable afterwards instead of a silent gap before a timeout.
    installCandidate: (options) => stage("download-and-extract", () => installCandidate({ ...options, log })),
    protectedPackageRoots,
    normalizePreviousTarget: (target) => ({
      ...target,
      node: persistentTargetNode(target?.node || serviceNode),
    }),
    onLockAcquired: admit,
    lockIdentity,
    rollbackTarget: legacy,
    preCommitVerify: (candidate) => stage("startup-verification", () => smoke(candidate, { log })),
    postCommitActivate: async (candidate) => {
      log(`activating ${candidate.version} from ${candidate.packageRoot}`);
      const options = { allowRebuildRegistrations: supersedeBrokenRecovery };
      if (canDelegate(candidate)) {
        log(`activation delegated to ${candidate.version}'s own code`);
        return stage("activation", () => delegateActivation("activate", candidate, { owner: candidate, homeDir, platform, options, log }));
      }
      return stage("activation", () => activate(candidate, { homeDir, platform, ...options }));
    },
    confirmServing: (target) => confirmServing(target, { homeDir, platform }),
    rollbackActivate: async (target, context) => {
      if (!target) return { ok: true };
      if (context?.activation?.unchanged === true) return { ok: true };
      log(`restoring runtime targets to ${target.packageRoot}`);
      const options = { restoreRegistrations: true, repairExecutable: context?.failed };
      return stage("rollback", async () => {
        // The new release's code ran to the end and gave a verdict: it is the
        // newer code, so it restores first. A crash or overrun of that code is
        // never trusted with the rollback, and this release's own code always
        // has the last word.
        const failed = context?.failed;
        if (failed && context?.activation?.delegated === true && context.activation.completed === true && canDelegate(failed)) {
          const restored = await delegateActivation("restore", target, { owner: failed, homeDir, platform, options, log });
          if (restored.ok) return restored;
          log(`delegated restore by ${failed.version} failed (${restored.reason || "unknown"}); restoring with ${runningVersion || "this release"}'s own code`);
        }
        return activate(target, { homeDir, platform, ...options });
      });
    },
  });
}

function workerPath() {
  return fileURLToPath(new URL("./relay-update-worker.cjs", import.meta.url));
}

function encodePayload(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

// The pill launches `relay update` with ELECTRON_RUN_AS_NODE=1, which changes
// behaviour but not process.execPath — so "the current runtime" reaching this
// module can be the Electron binary itself. `launchctl submit` carries no
// environment (the whole premise of the PATH bug above), so a submitted Electron
// runs the worker as a GUI app: GPU and network helpers, no npm resolvable beside
// it, and no exit when the work ends. That immortal worker is what Sven clicked
// "Update" into (pid 15090) — it did nothing, and it never went away.
export function isElectronExecutable(executable = process.execPath) {
  return nodeContract.isElectronExecutable(executable);
}

export function resolveUpdateWorkerNode(node = process.execPath, {
  platform = process.platform,
  homeDir = os.homedir(),
  existsSync = fs.existsSync,
  run = defaultRun,
} = {}) {
  if (node && !isElectronExecutable(node)) return node;
  const candidates = [];
  try {
    const current = readCanonicalRuntime({ homeDir, platform });
    if (current?.node) candidates.push(current.node);
  } catch {}
  if (platform !== "win32") candidates.push("/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node");
  const which = run(platform === "win32" ? "where.exe" : "/usr/bin/which", ["node"]);
  if (commandOk(which)) {
    const first = String(which.stdout || "").split(/\r?\n/)[0].trim();
    if (first) candidates.push(first);
  }
  for (const candidate of candidates) {
    try {
      if (
        candidate &&
        !isElectronExecutable(candidate) &&
        existsSync(candidate) &&
        compatibleNodeRuntime(candidate, { runCommand: run })
      ) return candidate;
    } catch {}
  }
  return null;
}

// `launchctl list` rows are "PID\tStatus\tLabel". Current builds own one fixed
// label; suffixed labels identify legacy workers that must be removed wholesale.
export function listUpdateWorkerJobs({ run = defaultRun } = {}) {
  const result = run("/bin/launchctl", ["list"]);
  if (!commandOk(result)) return [];
  const jobs = [];
  for (const line of String(result.stdout || "").split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [pid, , label] = parts;
    if (!label || (label !== UPDATE_WORKER_LABEL && !label.startsWith(UPDATE_WORKER_LABEL_PREFIX))) continue;
    const spawnedAt = Number(label.split(".").pop()) || 0;
    jobs.push({
      label,
      kind: label === UPDATE_WORKER_LABEL ? "fixed" : "legacy",
      pid: pid === "-" ? null : Number(pid) || null,
      spawnedAt: label === UPDATE_WORKER_LABEL ? 0 : spawnedAt,
    });
  }
  return jobs;
}

// Every suffixed label belongs to a pre-fixed-label build. A young PID is not
// evidence that it is safe: the live process may itself be the stale storm
// generator replaying a dead version. The first current client to run removes all
// legacy jobs. The fixed label is deliberately retained while inactive; removing
// it from a delayed old worker creates an ABA race with the next update.
export function reconcileUpdateWorkerJobs({ run = defaultRun } = {}) {
  const jobs = listUpdateWorkerJobs({ run });
  const legacy = jobs.filter((job) => job.kind === "legacy");
  for (const job of legacy) run("/bin/launchctl", ["remove", job.label]);
  const fixed = jobs.find((job) => job.kind === "fixed") || null;
  return { removedLegacy: legacy.length, fixed };
}

function requestDirectory(homeDir, platform) {
  const api = platform === "win32" ? path.win32 : path.posix;
  return api.join(canonicalRuntimeLayout({ homeDir, platform }).root, "update-requests");
}

// Windows antivirus and indexing hold a handle on a freshly written file for a
// moment, and rename fails with EPERM/EBUSY for exactly that moment. Two update
// workers on Dino's machine (2026-09-13) died on this rename of their own request
// file. Retry briefly; the hold clears by itself.
const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
export function renameWithRetry(fsImpl, from, to, {
  totalMs = 3000,
  sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
} = {}) {
  const started = Date.now();
  let wait = 50;
  for (;;) {
    try { fsImpl.renameSync(from, to); return; }
    catch (error) {
      if (!RENAME_RETRY_CODES.has(error?.code) || Date.now() - started + wait > totalMs) throw error;
      sleep(wait);
      wait = Math.min(500, wait * 2);
    }
  }
}

function atomicWriteText(destination, value, { fsImpl = fs, platform = process.platform } = {}) {
  const api = platform === "win32" ? path.win32 : path.posix;
  fsImpl.mkdirSync(api.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  fsImpl.writeFileSync(temporary, value, { mode: 0o600 });
  try { renameWithRetry(fsImpl, temporary, destination); }
  catch (error) { try { fsImpl.unlinkSync(temporary); } catch {} throw error; }
}

function atomicWriteRequest(requestPath, value, options = {}) {
  atomicWriteText(requestPath, `${JSON.stringify(value)}\n`, options);
}

function plistEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// Run-once: `launchctl submit` would instead keep the job alive and replay its
// original arguments forever, long after the release tree they name is pruned.
export function updateWorkerPlist(programArguments, logPath, label = UPDATE_WORKER_LABEL) {
  const argumentsXml = programArguments.map((argument) => `    <string>${plistEscape(argument)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${plistEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>ProcessType</key><string>Background</string>
${associatedBundleIdentifiersPlist("  ")}
  <key>StandardOutPath</key><string>${plistEscape(logPath)}</string>
  <key>StandardErrorPath</key><string>${plistEscape(logPath)}</string>
</dict>
</plist>
`;
}

function claimUpdateRequestDecision(requestPath, value, { fsImpl = fs } = {}) {
  const decisionPath = `${requestPath}.decision`;
  let descriptor = null;
  try {
    descriptor = fsImpl.openSync(decisionPath, "wx", 0o600);
    fsImpl.writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
    fsImpl.closeSync(descriptor);
    descriptor = null;
    return { won: true, value };
  } catch (error) {
    if (descriptor !== null) {
      try { fsImpl.closeSync(descriptor); } catch {}
    }
    if (error?.code !== "EEXIST") throw error;
    // `open("wx")` is the linearization point. The winner may still be writing
    // the tiny record, so tolerate that bounded publication window.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const existing = JSON.parse(fsImpl.readFileSync(decisionPath, "utf8"));
        if (existing?.requestId && existing?.workerId && existing?.state) {
          return { won: false, value: existing };
        }
      } catch {}
      blockingSleep(5);
    }
    return { won: false, value: null };
  }
}

export function readUpdateRequest(requestPath, { fsImpl = fs } = {}) {
  try {
    const value = JSON.parse(fsImpl.readFileSync(requestPath, "utf8"));
    return value?.schema === UPDATE_REQUEST_SCHEMA && value?.requestId ? value : null;
  } catch {
    return null;
  }
}

// Request identity prevents a stale observer from consuming another worker's
// result. A PID probe can prove exit, but permission errors cannot prove death.
export function inspectUpdateRequest(launch, { read = readUpdateRequest, alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code !== "ESRCH"; }
} } = {}) {
  if (!launch?.requestPath) return null;
  const request = read(launch.requestPath);
  if (!request || request.requestId !== launch.requestId || request.workerId !== launch.workerId) return null;
  if (["completed", "failed", "rejected"].includes(request.state)) return request;
  if (Number.isSafeInteger(request.workerPid) && request.workerPid > 0 && !alive(request.workerPid)) {
    return { ...request, state: "failed", result: { ok: false, phase: request.stage || "worker", reason: "worker-exited", detail: "Update worker exited without recording an outcome." } };
  }
  return request;
}

function blockingSleep(ms) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, Math.max(1, ms));
}

export function waitForUpdateRequestAdmission(requestPath, {
  fsImpl = fs,
  now = Date.now,
  sleep = blockingSleep,
  // The worker loads the same cold module graph as the candidate CLI. The old
  // five-second ceiling could kill it before it even entered the transaction.
  timeoutMs = 120_000,
  pollMs = 50,
} = {}) {
  const deadline = now() + timeoutMs;
  do {
    const value = readUpdateRequest(requestPath, { fsImpl });
    if (value && ["admitted", "completed", "failed", "rejected"].includes(value.state)) return value;
    sleep(pollMs);
  } while (now() < deadline);
  return readUpdateRequest(requestPath, { fsImpl });
}

export async function waitForUpdateRequestTerminal(requestPath, {
  fsImpl = fs,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = 20 * 60_000,
  pollMs = 250,
} = {}) {
  const deadline = now() + timeoutMs;
  do {
    const value = readUpdateRequest(requestPath, { fsImpl });
    if (value && ["completed", "failed", "rejected"].includes(value.state)) return value;
    await sleep(pollMs);
  } while (now() < deadline);
  return readUpdateRequest(requestPath, { fsImpl });
}

/**
 * Start a Windows process that outlives the daemon, with no console window.
 *
 * The daemon runs under a Task Scheduler job, so a plain child would die with
 * `schtasks /End`. WMI's Win32_Process.Create parents the new process to the WMI
 * service instead. The WMI service has no console, so CreateProcess allocates a
 * fresh one for node.exe — and shows it, which every Windows user saw as a black
 * window during each update. A Win32_ProcessStartup with ShowWindow=0 (SW_HIDE)
 * keeps that console hidden; every descendant that inherits stdio inherits the
 * hidden console too, so the watchdog, worker, and relay-setup all stay
 * invisible. CREATE_NO_WINDOW is not accepted through WMI (verified: ReturnValue
 * 21, invalid parameter), and a detached node child is no alternative: it has no
 * console at all, so its first stdio-inheriting grandchild pops a visible one.
 */
export function launchHiddenWindowsProcess(commandParts, { run = defaultRun, env = process.env } = {}) {
  const quote = (value) => `"${String(value).replaceAll('"', '\\"')}"`;
  const commandLine = commandParts.map(quote).join(" ");
  const ps = [
    "$s=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}",
    `$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${commandLine.replaceAll("'", "''")}';ProcessStartupInformation=$s} -ErrorAction Stop`,
    "if($r.ReturnValue-ne 0){exit 1}",
    "Write-Output $r.ProcessId",
  ].join(";");
  const encoded = Buffer.from(ps, "utf16le").toString("base64");
  const systemRoot = env.SystemRoot || env.windir || "C:\\Windows";
  const submitted = run(path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded,
  ]);
  if (!commandOk(submitted)) {
    return { ok: false, pid: null, detail: submitted?.stderr || submitted?.stdout || submitted?.error?.message || "" };
  }
  return { ok: true, pid: Number(String(submitted.stdout || "").trim()) || null, detail: "" };
}

export function spawnCanonicalUpdate({
  version,
  runningPackageRoot,
  runningVersion,
  node = process.execPath,
  homeDir = os.homedir(),
  platform = process.platform,
  env = process.env,
  run = defaultRun,
  existsSync = fs.existsSync,
  fsImpl = fs,
  requestId = randomUUID(),
  workerId = randomUUID(),
  waitForAdmission = waitForUpdateRequestAdmission,
  // The daemon sets this when a candidate has failed recovery repeatedly and a
  // newer release should take over. The worker's transaction then continues
  // past a recovery that fails again instead of stopping at it.
  supersedeBrokenRecovery = false,
} = {}) {
  const workerNode = resolveUpdateWorkerNode(node, { platform, homeDir, existsSync, run });
  if (!workerNode) {
    throw new Error("canonical update worker needs a real Node runtime: refusing to launch it under Electron, and no public node was found");
  }
  const api = platform === "win32" ? path.win32 : path.posix;
  const requestPath = api.join(requestDirectory(homeDir, platform), `${requestId}.json`);
  const prepared = {
    schema: UPDATE_REQUEST_SCHEMA,
    requestId,
    workerId,
    state: "prepared",
    requestedAt: Date.now(),
    version,
    runningVersion,
  };
  atomicWriteRequest(requestPath, prepared, { fsImpl, platform });
  const payload = encodePayload({
    version, runningPackageRoot, runningVersion, node: workerNode, homeDir, platform,
    requestId, workerId, requestPath,
    ...(supersedeBrokenRecovery ? { supersedeBrokenRecovery: true } : {}),
  });
  let launchedPid = null;
  let linuxWorkerUnit = null;
  if (platform === "darwin") {
    const reconciled = reconcileUpdateWorkerJobs({ run });
    if (reconciled.fixed?.pid) {
      atomicWriteRequest(requestPath, { ...prepared, state: "rejected", reason: "worker-busy", completedAt: Date.now() }, { fsImpl, platform });
      return { status: "busy", requestId, workerId, requestPath };
    }
    const domain = `gui/${typeof process.getuid === "function" ? process.getuid() : 0}`;
    if (reconciled.fixed) run("/bin/launchctl", ["bootout", `${domain}/${UPDATE_WORKER_LABEL}`]);
    const layout = canonicalRuntimeLayout({ homeDir, platform });
    const workerPlistPath = api.join(layout.root, "update-worker.plist");
    const logPath = api.join(homeDir, ".relay", "update.log");
    atomicWriteText(
      workerPlistPath,
      updateWorkerPlist([workerNode, api.join(runningPackageRoot, "bootstrap", "update-watchdog.cjs"), workerPath(), "--worker", payload], logPath),
      { fsImpl, platform },
    );
    const submitted = run("/bin/launchctl", ["bootstrap", domain, workerPlistPath]);
    if (!commandOk(submitted)) {
      atomicWriteRequest(requestPath, { ...prepared, state: "rejected", reason: "launch-failed", detail: submitted?.stderr || submitted?.stdout || "", completedAt: Date.now() }, { fsImpl, platform });
      return { status: "launch-failed", requestId, workerId, requestPath };
    }
  } else if (platform === "win32") {
    const launched = launchHiddenWindowsProcess(
      [workerNode, api.join(runningPackageRoot, "bootstrap", "update-watchdog.cjs"), workerPath(), "--worker", payload],
      { run },
    );
    if (!launched.ok) {
      atomicWriteRequest(requestPath, { ...prepared, state: "rejected", reason: "launch-failed", detail: launched.detail, completedAt: Date.now() }, { fsImpl, platform });
      return { status: "launch-failed", requestId, workerId, requestPath };
    }
    launchedPid = launched.pid;
  } else if (platform === "linux") {
    linuxWorkerUnit = `${UPDATE_WORKER_LABEL_PREFIX}${requestId}`;
    const logPath = api.join(homeDir, ".relay", "update.log");
    const submitted = run("systemd-run", [
      "--user",
      "--quiet",
      "--collect",
      `--unit=${linuxWorkerUnit}`,
      ...systemdRunEnvironmentArgs(env),
      "--property=Type=exec",
      "--property=RuntimeMaxSec=1800",
      "--property=KillMode=control-group",
      `--property=StandardOutput=append:${logPath}`,
      `--property=StandardError=append:${logPath}`,
      workerNode,
      api.join(runningPackageRoot, "bootstrap", "update-watchdog.cjs"),
      workerPath(),
      "--worker",
      payload,
    ]);
    if (!commandOk(submitted)) {
      atomicWriteRequest(requestPath, { ...prepared, state: "rejected", reason: "launch-failed", detail: submitted?.stderr || submitted?.stdout || "", completedAt: Date.now() }, { fsImpl, platform });
      return { status: "launch-failed", requestId, workerId, requestPath };
    }
  } else {
    throw new Error(`canonical updater unsupported on ${platform}`);
  }
  const admitted = waitForAdmission(requestPath, { fsImpl });
  if (admitted?.state === "failed" && admitted.workerId === workerId && admitted.admittedAt) {
    return { status: "failed", requestId, workerId, requestPath, admittedAt: admitted.admittedAt, terminal: admitted };
  }
  if (!admitted || !["admitted", "completed"].includes(admitted.state) || admitted.workerId !== workerId) {
    const transactionAlreadyInProgress = admitted?.state === "failed" &&
      admitted?.result?.phase === "lock" &&
      admitted?.result?.reason === "transaction-in-progress";
    const rejected = {
      ...(admitted || prepared),
      schema: UPDATE_REQUEST_SCHEMA,
      requestId,
      workerId,
      state: "rejected",
      reason: transactionAlreadyInProgress ? "worker-busy" : admitted?.reason || "admission-timeout",
      completedAt: Date.now(),
    };
    const decision = claimUpdateRequestDecision(requestPath, rejected, { fsImpl });
    if (decision.value?.state === "admitted" && decision.value.workerId === workerId) {
      return { status: "admitted", requestId, workerId, requestPath, admittedAt: decision.value.admittedAt };
    }
    if (decision.won) atomicWriteRequest(requestPath, rejected, { fsImpl, platform });
    if (platform === "win32" && launchedPid && decision.won) {
      run("taskkill.exe", ["/PID", String(launchedPid), "/T", "/F"]);
    }
    if (platform === "linux" && linuxWorkerUnit && decision.won) {
      run("systemctl", ["--user", "stop", linuxWorkerUnit]);
    }
    // Never remove the fixed launchd label here. Another caller may have observed
    // its old inactive state, replaced it, and submitted a newer worker while this
    // caller waited. Removing by label would kill that newer owner (an ABA race).
    return { status: decision.value?.reason === "worker-busy" ? "busy" : "not-admitted", requestId, workerId, requestPath };
  }
  return { status: "admitted", requestId, workerId, requestPath, admittedAt: admitted.admittedAt };
}

export async function workerMain(payload) {
  let options = null;
  try {
    options = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch (error) {
    console.error(`[relay-update] worker payload invalid: ${error?.message || error}`);
    return null;
  }
  const requestApi = options.platform === "win32" ? path.win32 : path.posix;
  const expectedRequestPath = requestApi.join(requestDirectory(options.homeDir, options.platform), `${options.requestId}.json`);
  if (
    !options.requestId ||
    !options.workerId ||
    requestApi.resolve(String(options.requestPath || "")) !== requestApi.resolve(expectedRequestPath)
  ) {
    console.error("[relay-update] worker request identity/path invalid");
    return null;
  }
  const logPath = path.join(options.homeDir, ".relay", "update.log");
  const log = (message) => {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, `[relay-update] ${new Date().toISOString()} ${message}\n`);
    } catch {}
  };
  const diagnosticScope = diagnostics.configIdentity(options.homeDir)?.scope || null;
  const writeState = (state, extra = {}) => {
    if (!options.requestPath || !options.requestId || !options.workerId) return;
    const current = readUpdateRequest(options.requestPath) || {
      schema: UPDATE_REQUEST_SCHEMA,
      requestId: options.requestId,
      workerId: options.workerId,
      requestedAt: Date.now(),
    };
    if (current.requestId !== options.requestId || current.workerId !== options.workerId) {
      throw new Error("update request identity changed before worker admission");
    }
    if (current.state === "rejected" && state !== "rejected") return current;
    atomicWriteRequest(options.requestPath, { ...current, ...extra, state });
    if (["completed", "failed", "admitted"].includes(state)) diagnostics.record({
      component: "updater", attemptId: options.requestId, parentAttemptId: process.env.RELAY_RECOVERY_RUN_ID,
      stage: "worker", outcome: state === "completed" ? "succeeded" : state === "failed" ? "failed" : "started",
      code: extra.result?.reason, targetVersion: options.version,
    }, { homeDir: options.homeDir, scope: diagnosticScope });
    return { ...current, ...extra, state };
  };
  try {
    const result = await runCanonicalUpdateTransaction({
      ...options,
      log,
      onProgress: (progress) => {
        const current = readUpdateRequest(options.requestPath);
        writeState(current?.state || "prepared", { ...progress, workerPid: process.pid });
      },
      onLockAcquired: (owner) => {
        const admittedAt = Date.now();
        const admission = {
          schema: UPDATE_REQUEST_SCHEMA,
          requestId: options.requestId,
          workerId: options.workerId,
          state: "admitted",
          admittedAt,
          lockOwner: owner,
        };
        const decision = claimUpdateRequestDecision(options.requestPath, admission);
        if (!decision.won && (
          decision.value?.state !== "admitted" ||
          decision.value?.requestId !== options.requestId ||
          decision.value?.workerId !== options.workerId
        )) {
          throw new Error("update request was cancelled before worker admission");
        }
        writeState("admitted", { admittedAt, lockOwner: owner });
      },
    });
    const detail = String(result?.detail || "").trim().replace(/\s+/g, " ").slice(0, 2000);
    log(result.ok
      ? result.recovered ? "canonical activation journal recovered" : `canonical update committed: ${result.candidate.version}`
      : `canonical update failed at ${result.phase}: ${result.reason}${detail ? ` (${detail})` : ""}`);
    writeState(result.ok ? "completed" : "failed", {
      completedAt: Date.now(),
      result: { ok: Boolean(result.ok), phase: result.phase || null, reason: result.reason || null, detail },
    });
  } catch (error) {
    log(`canonical update worker crashed: ${error?.stack || error?.message || String(error)}`);
    try {
      writeState("failed", {
        completedAt: Date.now(),
        result: { ok: false, phase: "worker", reason: "worker-crashed", detail: error?.message || String(error) },
      });
    } catch {}
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "--worker" && process.argv[3]) {
  const options = await workerMain(process.argv[3]);
  // ALWAYS exit 0. launchd restarts a submitted job that exits non-zero — forever,
  // with its original payload — so a failing worker used to be resurrected every
  // few seconds for hours, replaying a stale target version. Failure is reported
  // through update.log and the durable failure records, never the exit code
  // (nothing ever read it anyway).
  process.exitCode = 0;
}
