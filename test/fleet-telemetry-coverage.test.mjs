import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  collectCompanionFleetTelemetry,
  encodeCompanionFleetTelemetry,
  PROBLEM_SOURCES,
} from "../src/fleet-telemetry.js";
import { PROBLEM_STATE_FILES, sanitizeProblemDetail } from "../src/fleet-problems.js";
import { canonicalRuntimeLayout } from "../src/canonical-runtime.js";
import { recordUpdateError } from "../src/auto-update.js";
import watchdog from "../bootstrap/update-watchdog.cjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AT = Date.parse("2026-11-25T10:00:00Z");
const TOKEN = "dev_Zx81kQpLmN0aBcDeFgHiJkLmNoPqRsTu";
const LONG_SECRET = "Q2xhdWRlU2VjcmV0VmFsdWUxMjM0NTY3ODkwQUJDREVGRw";

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

// One computer with every failure record Relay keeps, each saying why.
function fakeHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-fleet-coverage-"));
  const relay = path.join(homeDir, ".relay");
  const store = path.join(homeDir, ".relay-companion");
  const platform = process.platform;
  const layout = canonicalRuntimeLayout({ homeDir, platform });
  write(layout.pointerPath, {
    schema: 1, state: "recovery-required", active: false, preparedAt: AT - 60_000, updatedAt: AT - 50_000,
    candidate: { version: "0.1.650", releaseId: "0.1.650-1-abc" }, previous: { version: "0.1.649" },
    failure: { phase: "rollback", reason: "rollback-failed", detail: `launchctl bootstrap failed for ${homeDir}/Library/LaunchAgents/work.relay.plist` },
  });
  write(path.join(layout.root, "update-requests", "0f8fad5b-d9cb-469f-a165-70867728950e.json"), {
    schema: 1, requestId: "0f8fad5b-d9cb-469f-a165-70867728950e", workerId: "w", state: "failed", version: "0.1.650",
    requestedAt: AT - 40_000, completedAt: AT - 39_000,
    result: { ok: false, phase: "activate", reason: "exact-root-health-failed", detail: `daemon refused ${TOKEN}` },
  });
  write(path.join(relay, "recovery", "release-health", "stable", "0.1.650", `failure-${"a".repeat(64)}.json`),
    { at: AT - 38_000, reason: "activate: candidate-cli-smoke-timeout: took 90s (recovery-worker-exit-1)" });
  write(path.join(relay, "recovery", "release-health", "stable", "0.1.650", `failure-${"b".repeat(64)}.json`),
    { at: AT - 90_000, reason: "runtime-not-healthy" });
  write(path.join(relay, "recovery", "status.json"), {
    schema: 1, status: "failed", ok: false, checkedAt: AT - 37_000, failures: 3, lastError: "recovery-worker-exit-1",
    lastErrorDetail: "activate: exact-root-health-failed: no heartbeat", discoveryError: "manifest-http-503",
    retryAt: AT + 60_000, restarts: 2, staleSince: AT - 600_000, launcherVersion: "0.1.649",
  });
  write(path.join(relay, "recovery", "worker-failure.json"), {
    schema: 1, at: AT - 36_000, version: "0.1.650", message: `activate: exact-root-health-failed: Authorization Bearer ${LONG_SECRET}`,
  });
  write(path.join(relay, "recovery", "repair-progress.json"), {
    schema: 1, attempts: { services: 2, "reactivate:/x": 1 }, localExhausted: true, lastError: "service-registration-query-failed", updatedAt: AT - 35_000,
  });
  write(path.join(relay, "recovery", "launcher-status.json"), {
    schema: 1, at: AT - 34_000, status: "runner-error", runtimeStatus: "restart-failed", version: "0.1.649",
  });
  write(path.join(relay, "recovery", "daemon-crash.json"), {
    schema: 1, packageRoot: path.join(homeDir, ".relay", "runtime", "releases", "r"), version: "0.1.649", pid: 4,
    at: AT - 33_000, fingerprint: "c".repeat(64), count: 3, startup: true,
  });
  write(path.join(relay, "application-migration.json"), {
    schema: 1, state: "rolled-back", at: AT - 32_000, failure: "Could not register /Users/alice/Library/LaunchAgents/x.plist for alice@example.com",
  });
  write(path.join(relay, "runtime", "installer-recovery.json"), {
    schema: 1, state: "cleaning", version: "0.1.650", at: AT - 31_000, deviceRetirement: "needs-account-review", releaseRoot: path.join(homeDir, "r"),
  });
  write(path.join(relay, "application-update.json"), {
    schema: 1, at: AT - 30_000, state: "failed", detail: "Native application offer unavailable (503) at C:\\Users\\alice\\AppData",
  });
  write(path.join(relay, "companion-install.json"), {
    version: 1, status: "failed", pid: 9, startedAt: "", finishedAt: new Date(AT - 29_000).toISOString(), reason: "exit_1", logPath: path.join(homeDir, "x.log"),
  });
  write(path.join(store, "update-errors.json"), { schema: 1, errors: [
    { at: AT - 28_000, status: "rescue-launch-failed", kind: "launch", reason: "eacces", detail: `spawn EACCES ${homeDir}/node`, count: 2 },
  ] });
  write(path.join(store, "update-loop.json"), {
    schema: 1, status: "recovery-exhausted", at: AT - 27_000, reason: "rollback-failed",
    detail: `rollback: rollback-failed: mcp_at.${LONG_SECRET} in /home/alice/.relay`, checkFailures: 0,
  });
  write(path.join(store, "update-state.json"), {
    failure: { target: "0.1.650", count: 4, firstAt: AT - 900_000, lastAt: AT - 26_000, reason: "candidate-cli-smoke-timeout" },
  });
  write(path.join(relay, "recovery", "scheduler-handover-status.json"), {
    at: AT - 25_000, ok: false, reason: "recovery-schedule-bootout-failed", cleanup: { removed: false, pending: true, reason: "handover-pending" },
  });
  write(path.join(relay, "recovery", "scheduler-cleanup.json"), { at: AT - 24_000, removed: false, pending: true, reason: "remove-failed" });
  write(path.join(relay, "application-uninstall.json"), { schema: 1, state: "removing", installationId: "i", at: AT - 23_000 });
  write(path.join(relay, "hook-retirement.json"), {
    version: 1, checkedAt: new Date(AT - 22_000).toISOString(), ok: false, retired: false,
    files: [{ ok: false, host: "claude", reason: "settings_unreadable", filePath: path.join(homeDir, ".claude", "settings.json") },
      { ok: true, host: "codex", filePath: path.join(homeDir, ".codex", "hooks.json") }],
  });
  // A launcher worker observed running well past its deadline, still alive.
  write(path.join(relay, "application-worker-observation.json"), { pid: process.pid, identity: "x", at: AT - 21_000 });
  // A Relay tool call that has been running for hours, owned by a live process.
  write(path.join(relay, "recovery", "activity", "call-0f8fad5b-d9cb-469f-a165-70867728950f.json"),
    { pid: process.pid, ownerStartedAt: Math.round(Date.now() - process.uptime() * 1000), kind: "call", label: "relay_chat_fetch", role: "broker", startedAt: AT - 20_000 });
  return { homeDir, platform, updateStatePath: path.join(store, "update-state.json") };
}

const EXPECTED = {
  "runtime-pointer": "rollback-failed",
  "update-request": "exact-root-health-failed",
  "release-health": "candidate-cli-smoke-timeout",
  "recovery-status": "recovery-worker-exit-1",
  "recovery-worker": "exact-root-health-failed",
  "repair-progress": "service-registration-query-failed",
  launcher: "restart-failed",
  "daemon-crash": `crash-${"c".repeat(12)}`,
  "application-migration": null,
  "installer-recovery": "needs-account-review",
  "application-update": null,
  "background-install": "exit_1",
  "update-launch": "eacces",
  "scheduler-handover": "recovery-schedule-bootout-failed",
  "scheduler-cleanup": "remove-failed",
  "application-uninstall": "uninstall-interrupted",
  "hook-retirement": "hook-retirement-incomplete",
  "application-worker": "application-worker-overran",
  activity: "relay_chat_fetch",
};
// Windows only; covered by its own test below.
const TESTED_SEPARATELY = ["native-install"];

test("every recorded failure reaches the fleet report with its reason, sanitised and small", () => {
  const { homeDir, platform, updateStatePath } = fakeHome();
  const report = collectCompanionFleetTelemetry({ homeDir, platform, channel: "stable", env: {}, updateStatePath, collectHealth: () => undefined });
  assert.deepEqual([...Object.keys(EXPECTED), ...TESTED_SEPARATELY].sort(), [...PROBLEM_SOURCES].sort(), "every source has a fixture here");
  const problems = report.problems;
  for (const [source, reason] of Object.entries(EXPECTED)) {
    const entry = problems.find((problem) => problem.source === source);
    assert.ok(entry, `${source} is reported`);
    assert.equal(entry.reason, reason, `${source} carries its reason`);
    assert.deepEqual(Object.keys(entry).sort(), ["at", "count", "detail", "phase", "reason", "source", "state"]);
  }
  const by = (source) => problems.find((problem) => problem.source === source);
  assert.equal(by("runtime-pointer").phase, "rollback");
  assert.equal(by("runtime-pointer").state, "recovery-required");
  assert.match(by("runtime-pointer").detail, /~\/Library\/LaunchAgents/);
  assert.equal(by("update-request").count, 1);
  assert.equal(by("release-health").count, 2, "every failure file of the version is counted");
  assert.equal(by("release-health").phase, "activate");
  assert.equal(by("recovery-status").count, 3);
  assert.ok(problems.some((problem) => problem.source === "recovery-status" && problem.phase === "discovery" && problem.reason === "manifest-http-503"));
  assert.equal(by("recovery-worker").phase, "activate");
  assert.equal(by("repair-progress").state, "exhausted");
  assert.equal(by("daemon-crash").state, "startup-crash");
  assert.equal(by("daemon-crash").count, 3);
  assert.equal(by("application-migration").state, "rolled-back");
  assert.match(by("application-migration").detail, /^Could not register ~\/Library/);
  assert.equal(by("application-update").state, "failed");
  assert.equal(by("update-launch").state, "rescue-launch-failed");
  assert.equal(by("update-launch").count, 2);
  assert.deepEqual(problems.map((problem) => problem.at), [...problems.map((problem) => problem.at)].sort().reverse(), "newest first");

  assert.equal(report.failures[0].reason, "candidate-cli-smoke-timeout");
  assert.equal(report.updateLoop.reason, "rollback-failed");
  assert.match(report.updateLoop.detail, /^rollback: rollback-failed: \[redacted\] in ~\/\.relay$/);

  const text = JSON.stringify(report);
  assert.equal(text.includes(homeDir), false, "no local path leaves the machine");
  for (const secret of [TOKEN, LONG_SECRET, "alice", "c".repeat(13)]) assert.equal(text.includes(secret), false, `${secret} is not reported`);
  assert.ok(Buffer.byteLength(JSON.stringify(problems)) < 6000, "problems stay well inside the report budget");
  assert.ok(encodeCompanionFleetTelemetry(report).length <= 4096);
});

test("the header sheds problems before any installation detail", () => {
  const { homeDir, platform, updateStatePath } = fakeHome();
  const installation = { installationId: null, padding: "p".repeat(1800) };
  const report = collectCompanionFleetTelemetry({ homeDir, platform, channel: "stable", env: {}, updateStatePath, collectHealth: () => installation });
  assert.ok(Buffer.from(JSON.stringify(report)).toString("base64url").length > 4096, "the fixture overflows the header");
  let truncated = 0;
  const header = JSON.parse(Buffer.from(encodeCompanionFleetTelemetry(report, { onTruncated: () => { truncated += 1; } }), "base64url"));
  assert.equal(header.problems, undefined);
  assert.equal(header.updateLoop.detail, undefined);
  assert.equal(header.updateLoop.status, "recovery-exhausted");
  assert.deepEqual(header.installation, installation, "the installation block is kept whole");
  assert.equal(truncated, 0);
});

test("the update watchdog and the update loop share one error ring, and the report reads both", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-fleet-ring-"));
  const store = path.join(homeDir, ".relay-companion");
  const updateStatePath = path.join(store, "update-state.json");
  recordUpdateError(path.join(store, "update-errors.json"), { status: "migration-launch-failed", kind: "launch", reason: "enoent", detail: "spawn ENOENT" }, { now: () => AT - 5000 });
  for (const at of [AT - 2000, AT - 1000]) {
    watchdog.recordWatchdogError(path.join(homeDir, "rel", "relay-update-worker.cjs"), "recovery-worker-deadline-exceeded", { env: {}, homeDir, now: () => at });
  }
  const report = collectCompanionFleetTelemetry({ homeDir, platform: process.platform, env: {}, updateStatePath, collectHealth: () => undefined });
  assert.deepEqual(report.problems.map(({ source, state, phase, reason, count }) => ({ source, state, phase, reason, count })), [
    { source: "update-launch", state: "watchdog", phase: "relay-update-worker", reason: "recovery-worker-deadline-exceeded", count: 2 },
    { source: "update-launch", state: "migration-launch-failed", phase: "launch", reason: "enoent", count: 1 },
  ]);
});

test("a rolled-back pointer with nothing active reports as inactive, not legacy", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-fleet-inactive-"));
  const platform = process.platform;
  const layout = canonicalRuntimeLayout({ homeDir, platform });
  write(layout.pointerPath, { schema: 1, active: false, state: "inactive", rolledBackFrom: "0.1.650-1788800000000-abc", recoveredAt: AT });
  const report = collectCompanionFleetTelemetry({ homeDir, platform, channel: "stable", env: {}, updateStatePath: path.join(homeDir, "s", "update-state.json"), collectHealth: () => undefined });
  assert.equal(report.runtimeState, "inactive");
  assert.equal(report.runtimeKind, "canonical");
  assert.deepEqual(report.problems, [{ source: "runtime-pointer", state: "inactive", phase: null, reason: "rolled-back",
    detail: "rolled back from 0.1.650-1788800000000-abc", at: new Date(AT).toISOString(), count: null }]);
  // An activation rollback writes the same pointer without a state.
  write(layout.pointerPath, { schema: 1, active: false, rolledBackFrom: "0.1.651-1-def", committedAt: AT });
  assert.equal(collectCompanionFleetTelemetry({ homeDir, platform, env: {}, updateStatePath: path.join(homeDir, "s", "update-state.json"), collectHealth: () => undefined }).runtimeState, "inactive");
});

test("details lose home directories, user names and credentials", () => {
  const home = "/Users/sven";
  assert.equal(sanitizeProblemDetail("open /Users/sven/.relay/x failed", { homeDir: home }), "open ~/.relay/x failed");
  assert.equal(sanitizeProblemDetail("C:\\Users\\Dino\\AppData\\Relay\tlocked\n"), "~\\AppData\\Relay locked");
  assert.equal(sanitizeProblemDetail("/home/ada/.relay gone"), "~/.relay gone");
  assert.equal(sanitizeProblemDetail(`Bearer ${LONG_SECRET} rejected`), "[redacted] rejected");
  assert.equal(sanitizeProblemDetail(`token ${TOKEN}`), "token [redacted]");
  assert.equal(sanitizeProblemDetail(`sha ${"f0".repeat(20)}`), "sha [redacted]");
  assert.equal(sanitizeProblemDetail("service-registration-query-failed-after-two-attempts-on-launchd"),
    "service-registration-query-failed-after-two-attempts-on-launchd", "long labels are not mistaken for secrets");
  assert.equal(sanitizeProblemDetail("x".repeat(500)).length, 200);
  assert.equal(sanitizeProblemDetail(null), null);
});

// GUARD: every JSON state file the Companion names is either reported in the
// fleet report (fleet-problems.js PROBLEM_STATE_FILES) or listed below with
// why it is not. If this fails, you added a state file: if it can record a
// failure, a reason or an error, report it (add a source to PROBLEM_SOURCES
// and a fixture above); otherwise add it to the right list here.
const ALREADY_REPORTED_ELSEWHERE = [
  "update-state.json", // failures[]
  "update-loop.json", // updateLoop
  "daemon.json", "daemon-progress.json", "pill-status.json", "maintenance.json", "policy.json", "installation-id.json", // installation
  ".relay-managed.json", // skills
  "proven.json", "cooldown.json", // release-health (read beside the failure files)
  "application-owner.json", // x-relay-application-telemetry
  "action.json", // copied into application-update.json (application-update.cjs), reported there
];
// Records that can hold a failure but are not reported yet. Keep this empty:
// add a source to fleet-problems.js instead.
const NOT_YET_REPORTED = [];
// Configuration, identities, ownership, leases, caches and content: no failure reason.
const NOT_FAILURE_RECORDS = [
  ".claude.json", ".codex-global-state.json", ".meta.json", ".request.json", "agent-authorization.json",
  "agent-companion-pairing.json", "agent-protocol.json", "agent-rules.json", "anonymous-sessions.json",
  "application-handoff-complete.json", "authorization.json", "bridge.json", "broker-v1.json", "busy.json",
  "candidate.json", "claude_desktop_config.json", "config.json", "controlled-sessions.json", "credentials.v2.json",
  "desktop-onboarding.json", "drain.json", "emergency-download.json", "first-relay-ideas.json", "first-relay-waiter.json",
  "history-cache.json", "hooks.json", "inbox-attachment-work.json", "inbox-ledger.json", "inbox.json",
  "installation-authorization.json", "intent.json", "known-good.json", "launcher-host.json", "launcher-node.json",
  "mac-registrations.json", "manifest.json", "no-local-daemon.json", "onboarding-bridge.json", "owl-electron-app.json",
  "owner.json", "package.json", "pending-open.json", "pill.json", "previous-good.json", "previous.json", "probation.json",
  "provider-connections.json", "reclaim.json", "registration.json", "relay-desktop-wake.json", "repo-index.json",
  "request.json", "restored.json", "retention.json", "runtime-good.json", "runtime-links.json", "runtime-manifest.json",
  "runtime-previous-good.json", "scheduler.json", "session-directory.json", "settings.json", "settings.local.json",
  "setup-intent.json", "state.json", "task-completion-wake.json", "task-ledger.json", "topics.json", "trust.json", "upload.json",
];

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(file);
    return /\.(?:c|m)?js$/.test(entry.name) ? [file] : [];
  });
}

test("every Companion state file is reported or deliberately left out", () => {
  const known = new Set([...PROBLEM_STATE_FILES, ...ALREADY_REPORTED_ELSEWHERE, ...NOT_YET_REPORTED, ...NOT_FAILURE_RECORDS]);
  const named = new Set();
  for (const file of [...sourceFiles(path.join(packageRoot, "src")), ...sourceFiles(path.join(packageRoot, "bootstrap"))]) {
    for (const match of fs.readFileSync(file, "utf8").matchAll(/["'`]([A-Za-z0-9._-]+\.json)["'`]/g)) named.add(match[1]);
  }
  const unknown = [...named].filter((name) => !known.has(name)).sort();
  assert.deepEqual(unknown, [], "a new state file: report it in fleet-problems.js or list it in this test with why not");
  for (const name of PROBLEM_STATE_FILES) assert.ok(named.has(name), `${name} is still written somewhere`);
});

test("a rollback kept because the restored release was serving is reported, with the runtime still active", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-kept-rollback-"));
  try {
    const layout = canonicalRuntimeLayout({ homeDir, platform: "darwin", releaseId: "0.1.634-a" });
    fs.mkdirSync(path.dirname(layout.pointerPath), { recursive: true });
    fs.writeFileSync(layout.pointerPath, JSON.stringify({
      schema: 1, active: true, version: "0.1.634", releaseId: layout.releaseId, releaseRoot: layout.releaseRoot,
      packageRoot: layout.packageRoot, bin: layout.bin, committedAt: 1,
      rollbackIncomplete: { phase: "rollback", reason: "activation-not-ready", detail: `stray broker under ${homeDir}/.relay`, failedVersion: "0.1.648", pill: true, strayBroker: true, at: 2_000 },
    }));
    const report = collectCompanionFleetTelemetry({ homeDir, platform: "darwin", channel: "stable", env: {},
      updateStatePath: path.join(homeDir, ".relay-companion", "update-state.json"), collectHealth: () => undefined });
    assert.equal(report.runtimeState, "active");
    const kept = report.problems.find((problem) => problem.state === "rollback-incomplete");
    assert.equal(kept.source, "runtime-pointer");
    assert.equal(kept.reason, "activation-not-ready");
    assert.match(kept.detail, /^from 0\.1\.648; stray broker; stray broker under ~\/\.relay$/);
    assert.equal(JSON.stringify(report).includes(homeDir), false);
  } finally { fs.rmSync(homeDir, { recursive: true, force: true }); }
});

test("the six records added last are quiet when nothing is wrong", async () => {
  const { collectFleetProblems } = await import("../src/fleet-problems.js");
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-fleet-quiet-"));
  try {
    const relay = path.join(homeDir, ".relay");
    write(path.join(relay, "recovery", "scheduler-handover-status.json"), { at: AT, ok: true, reason: "already-current", cleanup: { pending: true, reason: "removal-pending" } });
    write(path.join(relay, "recovery", "scheduler-cleanup.json"), { at: AT, removed: false, pending: true, reason: "running" });
    write(path.join(relay, "application-uninstall.json"), { schema: 1, state: "complete", at: AT });
    write(path.join(relay, "hook-retirement.json"), { version: 1, ok: true, files: [] });
    write(path.join(relay, "application-worker-observation.json"), { pid: 2 ** 30, identity: "x", at: AT });
    write(path.join(relay, "application-packages", "0.1.650-abc-darwin-arm64", "native-install.json"), { state: "started" });
    const problems = collectFleetProblems({ homeDir, platform: "darwin", env: {}, now: AT + 3_600_000, alive: () => false });
    assert.deepEqual(problems, []);
    // A worker that is still running but has not yet passed its deadline.
    write(path.join(relay, "application-worker-observation.json"), { pid: process.pid, identity: "x", at: AT });
    assert.deepEqual(collectFleetProblems({ homeDir, platform: "darwin", env: {}, now: AT + 60_000, alive: () => true }), []);
  } finally { fs.rmSync(homeDir, { recursive: true, force: true }); }
});

test("an interrupted Windows native install is reported once it is old; a fresh one is still running", async () => {
  const { collectFleetProblems } = await import("../src/fleet-problems.js");
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-fleet-native-"));
  try {
    const file = path.join(homeDir, ".relay", "application-packages", "0.1.650-abc-win32-x64", "native-install.json");
    write(file, { state: "started", root: "C:\\Users\\alice\\AppData\\Local\\Programs\\Relay" });
    const mtime = fs.statSync(file).mtimeMs;
    assert.deepEqual(collectFleetProblems({ homeDir, platform: "win32", env: {}, now: mtime + 60_000 }), []);
    const [problem] = collectFleetProblems({ homeDir, platform: "win32", env: {}, now: mtime + 3_600_000 });
    assert.deepEqual({ source: problem.source, state: problem.state, reason: problem.reason, detail: problem.detail },
      { source: "native-install", state: "interrupted", reason: "native-install-interrupted", detail: "release 0.1.650" });
    write(file, { state: "complete" });
    assert.deepEqual(collectFleetProblems({ homeDir, platform: "win32", env: {}, now: mtime + 3_600_000 }), []);
  } finally { fs.rmSync(homeDir, { recursive: true, force: true }); }
});
