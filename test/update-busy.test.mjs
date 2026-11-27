// 2026-11-26: a Mac's update to 0.1.648 found a Relay call still running,
// gave up after 30 s, called that a failed activation, failed the rollback the
// same way, and was left "recovery required"; every repair after it waited on
// the same call and gave up again. Its diagnostics said only "unclassified".
// These tests hold the rules that replace that: running Relay work is waited
// for, visibly, and never turned into a failure, and every report says what
// was being waited on.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { activateCanonicalRuntime, runCanonicalUpdateTransaction } from "../src/canonical-updater.js";
import { createAutoUpdater, readUpdateFailure } from "../src/auto-update.js";
import { collectFleetProblems } from "../src/fleet-problems.js";

const require = createRequire(import.meta.url);
const activity = require("../bootstrap/update-activity.cjs");
const diagnostics = require("../bootstrap/diagnostics.cjs");

function home(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-busy-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  return homeDir;
}
function marker(homeDir, fields) {
  const directory = path.join(homeDir, ".relay", "recovery", "activity");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `call-${crypto.randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify(fields));
  return file;
}

test("a call marker says what it is and who owns it, and a drain that gives up names it", async (t) => {
  const homeDir = home(t);
  const release = activity.beginCall({ homeDir, label: "relay_chat_fetch" });
  const [call] = activity.describeCalls({ homeDir });
  assert.deepEqual({ kind: call.kind, label: call.label, pid: call.pid, alive: call.alive }, { kind: "call", label: "relay_chat_fetch", pid: process.pid, alive: true });
  assert.equal(typeof call.role, "string");
  await assert.rejects(activity.drainCalls({ homeDir, attempts: 2, sleep: async () => {} }), (error) => {
    assert.equal(error.code, "relay-calls-active");
    assert.match(error.message, /call:relay_chat_fetch by .* pid \d+ for /);
    assert.equal(error.blocking.length, 1);
    return true;
  });
  release();
  assert.deepEqual(activity.describeCalls({ homeDir }), []);
  // A label that is not a plain name is never written: no content in markers.
  const other = activity.beginCall({ homeDir, label: "send to bob@example.com" });
  assert.equal(activity.describeCalls({ homeDir })[0].label, null);
  other();
});

test("running Relay work makes activation wait with nothing changed; any later failure is still a failure", async () => {
  const busy = Object.assign(new Error("Relay calls still active: call:relay_x by broker pid 9 for 2h1m"), { code: "relay-calls-active", blocking: [{ kind: "call" }] });
  const waited = await activateCanonicalRuntime({ packageRoot: "/x" }, { drain: async () => { throw busy; }, platform: "linux" });
  assert.deepEqual({ ok: waited.ok, unchanged: waited.unchanged, reason: waited.reason }, { ok: false, unchanged: true, reason: "activation-busy" });
  assert.match(waited.detail, /relay_x by broker/);

  // A drain that fails for another reason changed nothing either, but is not "busy".
  const broken = await activateCanonicalRuntime({ packageRoot: "/x" }, { drain: async () => { throw new Error("EACCES"); }, platform: "linux" });
  assert.deepEqual({ unchanged: broken.unchanged, reason: broken.reason }, { unchanged: true, reason: "activation-drain-failed" });

  // Past the drain, a failure is a failure: never marked unchanged, never "busy".
  const failed = await activateCanonicalRuntime({ packageRoot: "/x" }, { drain: async () => () => {}, platform: "linux" });
  assert.equal(failed.ok, false);
  assert.notEqual(failed.reason, "activation-busy");
  assert.notEqual(failed.unchanged, true);
});

test("an update waits before downloading while Relay work runs; a repair of a broken install does not", async (t) => {
  const homeDir = home(t);
  const packageRoot = path.join(homeDir, "lib", "node_modules", "relay-companion");
  for (const [relative, contents] of [["package.json", JSON.stringify({ version: "0.1.650" })], ["bin/relay.js", "//"], ["src/task-daemon.js", "//"],
    ["overlay/main.cjs", "//"], ["node_modules/electron/dist/electron", ""]]) {
    fs.mkdirSync(path.dirname(path.join(packageRoot, relative)), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, relative), contents, { mode: 0o700 });
  }
  const running = [{ kind: "work", label: "session-operation:start", role: "daemon", pid: 7, alive: true, ageMs: 7_800_000 }];
  let repaired = 0;
  const base = { version: "0.1.700", runningVersion: "0.1.650", runningPackageRoot: packageRoot, platform: "linux", homeDir, node: process.execPath,
    npmCommand: "npm", resolveServiceNode: () => process.execPath, getProtectedPackageRoots: () => [], runningCalls: () => running,
    repair: async () => { repaired += 1; return { ok: true }; } };
  const waited = await runCanonicalUpdateTransaction(base);
  assert.deepEqual({ ok: waited.ok, phase: waited.phase, reason: waited.reason, unchanged: waited.unchanged }, { ok: false, phase: "busy", reason: "activation-busy", unchanged: true });
  assert.match(waited.detail, /work:session-operation:start by daemon pid 7 for 2h10m/);
  assert.equal(repaired, 0, "nothing was downloaded or changed");
  await runCanonicalUpdateTransaction({ ...base, supersedeBrokenRecovery: true });
  assert.equal(repaired, 1, "repairing a broken installation is not held back");
});

test("the daemon waits on running calls without counting a failure, says what it waits on, and resumes when they end", async (t) => {
  const root = home(t);
  const packageRoot = path.join(os.homedir(), ".relay", "runtime", "releases", "test", "node_modules", "relay-companion");
  let clock = 1_000_000, calls = [{ kind: "call", label: "relay_session_updates", role: "broker", pid: 9, alive: true, ageMs: 3_600_000 }];
  let launches = 0, outcome = null;
  const updater = createAutoUpdater({
    platform: "darwin", packageRoot, now: () => clock,
    getCurrentVersion: () => "1.0.0", getCurrentChannel: () => "stable",
    getCanonicalRuntime: () => ({ packageRoot, version: "1.0.0" }), getCanonicalRuntimeState: () => null,
    getLatestVersion: async () => "1.0.1", updateStatePath: path.join(root, "update-state.json"),
    runningCalls: () => calls, checkIntervalMs: 60_000, restartCooldownMs: 0,
    spawnUpdate: () => { launches += 1; return { status: "admitted", requestId: `r${launches}`, requestPath: "fake" }; },
    inspectRequest: () => outcome || { state: "admitted", workerPid: 1 },
  });
  const loop = () => JSON.parse(fs.readFileSync(path.join(root, "update-loop.json"), "utf8"));
  const waiting = await updater.tick();
  assert.equal(waiting.status, "deferred-calls");
  assert.equal(launches, 0);
  assert.equal(loop().status, "deferred-calls");
  assert.match(loop().detail, /call:relay_session_updates by broker pid 9 for 1h0m/);
  assert.equal(loop().busySince, 1_000_000);
  clock += 60_000;
  await updater.tick();
  assert.equal(loop().busySince, 1_000_000, "the wait keeps its start, so a long one shows as long");

  // The calls end: the update starts. Its worker then finds a call that began
  // in between and changes nothing: that is a wait, not a failed attempt.
  calls = [];
  clock += 60_000;
  assert.equal((await updater.tick()).status, "updating");
  outcome = { state: "failed", completedAt: clock, result: { ok: false, phase: "busy", reason: "activation-busy", detail: "work:acp-run:claude by daemon pid 4 for 5s" } };
  clock += 5_000;
  const held = await updater.tick();
  assert.equal(readUpdateFailure(path.join(root, "update-state.json")), null, "no failure is recorded against the release");
  assert.equal(held.status, "deferred-calls", "it waits a little before trying again");
  assert.match(held.detail, /acp-run:claude by daemon/, "and says what the worker found running");
  assert.equal(launches, 1);
  outcome = null;
  clock += 3 * 60_000;
  assert.equal((await updater.tick()).status, "updating", "it tries again shortly, with no backoff");
});

test("the fleet report shows long Relay calls, ignores short ones, counts orphans and flags an update waiting for hours", async (t) => {
  const homeDir = home(t);
  const store = path.join(homeDir, ".relay-companion");
  const now = Date.parse("2026-11-26T12:00:00Z");
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: "ignore" });
  t.after(() => sleeper.kill());
  marker(homeDir, { pid: sleeper.pid, kind: "call", label: "relay_chat_fetch", role: "broker", startedAt: now - 2 * 3_600_000 - 13 * 60_000 });
  marker(homeDir, { pid: sleeper.pid, kind: "call", label: "relay_send", role: "broker", startedAt: now - 5_000 });
  marker(homeDir, { pid: 2 ** 30, kind: "work", role: "daemon", startedAt: now - 9_000_000 });
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, "update-loop.json"), JSON.stringify({ schema: 1, status: "deferred-calls", latest: "0.1.700",
    detail: "call:relay_chat_fetch by broker pid 1 for 8h", busySince: now - 7 * 3_600_000 }));
  const problems = collectFleetProblems({ homeDir, platform: process.platform, env: {}, updateStatePath: path.join(store, "update-state.json"), now,
    alive: (pid) => pid === sleeper.pid, startedAtOf: () => null });
  const activityProblems = problems.filter((problem) => problem.source === "activity");
  const running = activityProblems.filter((problem) => problem.state === "running");
  assert.equal(running.length, 1, "a call of a few seconds is ordinary");
  assert.deepEqual({ phase: running[0].phase, reason: running[0].reason }, { phase: "call", reason: "relay_chat_fetch" });
  assert.match(running[0].detail, /broker process, running 133 min/);
  assert.equal(activityProblems.find((problem) => problem.state === "orphaned").count, 1);
  const waiting = activityProblems.find((problem) => problem.state === "update-waiting");
  assert.equal(waiting.reason, "relay-calls-active");
  assert.match(waiting.detail, /waiting to install 0\.1\.700: call:relay_chat_fetch/);
});

test("diagnostics keep a failure's own code instead of flattening it to unclassified", () => {
  for (const code of ["activation-busy", "registration-restore-failed", "runtime-registration-failed", "activation-drain-failed"]) {
    assert.equal(diagnostics.errorCode(code), code);
    assert.equal(diagnostics.errorCode(`${code}: some detail /Users/dylan/x`), code);
  }
  assert.equal(diagnostics.errorCode("Relay calls still active; activation deferred"), "unclassified", "free text never becomes a code");
  assert.equal(diagnostics.errorCode("connect ECONNREFUSED 127.0.0.1"), "connection-failed");
});

// 2026-11-27, Dylan's Mac: a call marker written on 20 Nov named PID 872. After
// a restart, 872 belonged to Apple's AudioConverterHardenedService, so every
// update and repair waited on a call that had ended a week before.
test("a marker whose process number now belongs to a later process is over, and is cleared", async (t) => {
  const homeDir = home(t);
  const written = Date.parse("2026-11-20T10:08:42Z");
  const restartedAt = Date.parse("2026-11-27T08:18:43Z");
  const stale = marker(homeDir, { pid: 872, kind: "call", startedAt: written }); // as 0.1.634 wrote it
  const options = { alive: (pid) => pid === 872, startedAtOf: (pid) => (pid === 872 ? restartedAt : null) };
  assert.equal(activity.ownerRunning(JSON.parse(fs.readFileSync(stale, "utf8")), options), false);
  assert.equal(activity.activeCalls({ homeDir, ...options }), 0, "nothing an update must wait for");
  const [described] = activity.describeCalls({ homeDir, ...options });
  assert.deepEqual({ alive: described.alive, reused: described.reused }, { alive: false, reused: true });
  const release = await activity.drainCalls({ homeDir, attempts: 1, sleep: async () => {}, ...options });
  release();
  assert.equal(fs.existsSync(stale), false, "the drain removes it instead of giving up after 30 seconds");
});

test("a genuine call is never cleared: same process, older process, or a start time that cannot be told", async (t) => {
  const homeDir = home(t);
  const written = Date.parse("2026-11-27T12:00:00Z");
  const cases = [
    { name: "owner started before the marker", start: written - 3_600_000, record: { startedAt: written } },
    { name: "start shown to the whole second", start: written + 900, record: { startedAt: written } },
    { name: "start time unknown", start: null, record: { startedAt: written } },
    { name: "recorded owner start matches", start: written - 5_000, record: { startedAt: written, ownerStartedAt: written - 5_000 } },
  ];
  for (const { name, start, record } of cases) {
    const file = marker(homeDir, { pid: 4242, kind: "call", ...record });
    const options = { alive: () => true, startedAtOf: () => start };
    assert.equal(activity.ownerRunning(JSON.parse(fs.readFileSync(file, "utf8")), options), true, name);
    await assert.rejects(activity.drainCalls({ homeDir, attempts: 1, sleep: async () => {}, ...options }), /relay_?|call/, name);
    assert.equal(fs.existsSync(file), true, `${name}: kept`);
    fs.rmSync(file);
  }
  // A marker recording its owner's start, whose number a later process has.
  const file = marker(homeDir, { pid: 4242, kind: "call", startedAt: written, ownerStartedAt: written - 60_000 });
  assert.equal(activity.ownerRunning(JSON.parse(fs.readFileSync(file, "utf8")), { alive: () => true, startedAtOf: () => written - 30_000 }), false,
    "a process that started after the recorded owner is a different process, even before the call began");
});

test("a new marker records its owner's start, and this process reads as running", async (t) => {
  const homeDir = home(t);
  const release = activity.beginCall({ homeDir, label: "relay_send" });
  const [file] = fs.readdirSync(path.join(homeDir, ".relay", "recovery", "activity")).filter((name) => name.startsWith("call-"));
  const report = JSON.parse(fs.readFileSync(path.join(homeDir, ".relay", "recovery", "activity", file), "utf8"));
  assert.ok(Math.abs(report.ownerStartedAt - (Date.now() - process.uptime() * 1000)) < 2_000);
  assert.equal(activity.ownerRunning(report), true);
  if (process.platform !== "win32") {
    const started = activity.processStartedAt(process.ppid);
    assert.ok(Number.isFinite(started) && started <= Date.now(), "ps reports another process's start");
  }
  release();
});

test("the fleet report counts a marker with a reused process number as over, not running", async (t) => {
  const homeDir = home(t);
  const now = Date.parse("2026-11-27T13:25:00Z");
  marker(homeDir, { pid: 872, kind: "call", startedAt: Date.parse("2026-11-20T10:08:42Z") });
  const problems = collectFleetProblems({ homeDir, platform: "darwin", env: {}, now, alive: () => true, startedAtOf: () => Date.parse("2026-11-27T08:18:43Z") });
  const activityProblems = problems.filter((problem) => problem.source === "activity");
  assert.deepEqual(activityProblems.map((problem) => [problem.state, problem.reason, problem.count]), [["orphaned", "call-owner-number-reused", 1]]);
});
