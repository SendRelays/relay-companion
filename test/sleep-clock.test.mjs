import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sleepClock from "../bootstrap/sleep-clock.cjs";
import health from "../bootstrap/installation-health.cjs";
import mac from "../bootstrap/mac-service-recovery.cjs";

const MIN = 60_000;

test("on Linux sleep is the gap between uptime and the monotonic clock; Windows cannot tell", () => {
  assert.equal(sleepClock.sleptMs({ platform: "linux", uptimeSeconds: 1000, monotonicMs: 400_000 }), 600_000);
  assert.equal(sleepClock.sleptMs({ platform: "linux", uptimeSeconds: 10, monotonicMs: 10_000 }), 0);
  assert.equal(sleepClock.sleptMs({ platform: "win32", uptimeSeconds: 1000, monotonicMs: 1 }), null);
  // A hung process sees both clocks advance together: no sleep.
  assert.equal(sleepClock.sleptBetween(5000, 5000 + 10), false);
  assert.equal(sleepClock.sleptBetween(5000, 5000 + 16 * MIN), true);
  assert.equal(sleepClock.sleptBetween(null, 5000), false);
});

test("on macOS the reading is the kernel's last wake, asked again only after a gap a sleep could fill", t => {
  sleepClock.resetSleepClock(); t.after(sleepClock.resetSleepClock);
  const start = Date.parse("2026-11-24T16:56:16Z");
  let wake = Date.parse("2026-11-24T08:00:00Z"), reads = 0;
  const readWake = () => { reads += 1; return `{ sec = ${Math.floor(wake / 1000)}, usec = 0 } Mon Nov 24 10:00:00 2026`; };
  const reading = at => sleepClock.sleptMs({ platform: "darwin", now: at, readWake });
  const before = reading(start);
  // Awake, ticking every 5 s: the kernel is not asked again.
  for (let i = 1; i <= 20; i += 1) assert.equal(reading(start + i * 5000), before);
  assert.equal(reads, 1);
  // Clamshell sleep, then a Power Nap dark wake 16 minutes later.
  wake = start + 100_000 + 16 * MIN;
  const after = reading(wake + 2000);
  assert.equal(reads, 2);
  assert.equal(after, wake);
  assert.equal(sleepClock.sleptBetween(before, after), true);
  assert.equal(sleepClock.sleepSource("darwin"), "waketime");
  // A failed read is retried a minute later, not on every tick.
  sleepClock.resetSleepClock(); reads = 0;
  const failing = () => { reads += 1; throw new Error("ENOENT"); };
  assert.equal(sleepClock.sleptMs({ platform: "darwin", now: start, readWake: failing }), null);
  assert.equal(sleepClock.sleptMs({ platform: "darwin", now: start + 5000, readWake: failing }), null);
  assert.equal(reads, 1);
  sleepClock.sleptMs({ platform: "darwin", now: start + 61_000, readWake: failing });
  assert.equal(reads, 2);
});

test("a Mac report sent in a dark wake, before the daemon ticked, is resuming from the kernel's wake time", () => {
  const now = Date.parse("2026-11-24T17:34:05Z");
  const lastTick = Date.parse("2026-11-24T17:12:30Z"), woke = Date.parse("2026-11-24T17:34:00Z");
  const heartbeat = { at: lastTick, sleptMs: Date.parse("2026-11-24T17:12:20Z"), sleepSource: "waketime", sleeps: [] };
  const power = sleepClock.powerState({ heartbeat, now, slept: woke, source: "waketime" });
  assert.equal(power.state, "resuming");
  assert.equal(power.lastWakeAt, new Date(woke).toISOString());
  // A heartbeat from before the update, with the old kind of reading, is not compared.
  assert.equal(sleepClock.powerState({ heartbeat: { ...heartbeat, sleepSource: "uptime" }, now, slept: woke, source: "waketime" }).state, "awake");
});

test("the heartbeat records a sleep only when the machine slept between two ticks", () => {
  const start = Date.parse("2026-11-20T12:00:00Z");
  let sleeps = sleepClock.recordTick({ previous: { at: start, sleptMs: 0, sleeps: [] }, at: start + 5000, slept: 0 });
  assert.deepEqual(sleeps, []);
  // The tick fired 16 minutes late and 16 minutes of sleep accrued: that was sleep.
  sleeps = sleepClock.recordTick({ previous: { at: start, sleptMs: 0, sleeps: [] }, at: start + 16 * MIN, slept: 16 * MIN });
  assert.deepEqual(sleeps, [{ from: start, to: start + 16 * MIN }]);
  // The same late tick with no sleep accrued is a stalled process, not sleep.
  assert.deepEqual(sleepClock.recordTick({ previous: { at: start, sleptMs: 0, sleeps: [] }, at: start + 16 * MIN, slept: 0 }), []);
});

test("power state tells a sleeping, briefly waking or awake machine apart", () => {
  const now = Date.parse("2026-11-20T13:30:00Z");
  // Slept since the daemon's last tick: resuming.
  let power = sleepClock.powerState({ heartbeat: { at: now - 17 * MIN, sleptMs: 0, sleeps: [] }, now, slept: 16 * MIN });
  assert.equal(power.state, "resuming");
  assert.equal(power.sleepDetection, true);
  // Sven's Mac: a minute awake every 16-18 minutes.
  const sleeps = [0, 1, 2].map(i => ({ from: now - (55 - 18 * i) * MIN, to: now - (39 - 18 * i) * MIN }));
  power = sleepClock.powerState({ heartbeat: { at: now - 2 * MIN, sleptMs: 0, sleeps }, now, slept: 0 });
  assert.equal(power.state, "brief-wakes");
  assert.equal(power.sleepsLastHour, 3);
  // Awake for a long while since the last sleep.
  power = sleepClock.powerState({ heartbeat: { at: now - 1000, sleptMs: 0, sleeps: [{ from: now - 90 * MIN, to: now - 40 * MIN }] }, now, slept: 0 });
  assert.equal(power.state, "awake");
  // Windows: the clocks cannot tell, so nothing is guessed.
  power = sleepClock.powerState({ heartbeat: { at: now - 17 * MIN }, now, slept: null });
  assert.deepEqual(power, { sleepDetection: false, state: "unknown", lastSleepAt: null, lastWakeAt: null, sleepsLastHour: 0 });
});

test("a daemon silent because the computer slept is waiting, not failed; a hung one still fails", t => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-sleep-health-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const root = path.join(homeDir, ".relay"), packageRoot = path.join(root, "runtime", "releases", "1.0.0-test", "node_modules", "relay-companion");
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
  const now = Date.parse("2026-11-20T13:30:00Z");
  write(path.join(root, "runtime", "current.json"), { active: true, version: "1.0.0", packageRoot, bin: path.join(packageRoot, "bin", "relay.js") });
  write(path.join(root, "recovery", "daemon.json"), { version: "1.0.0", pid: 12, at: now - 17 * MIN, sleptMs: 1000, sleeps: [] });
  const commands = [`node ${packageRoot}/bin/relay.js daemon`, `electron ${packageRoot}/overlay/main.cjs`];
  const asleep = health.collectInstallationHealth({ homeDir, commands, now, slept: 1000 + 16 * MIN });
  assert.equal(asleep.daemonResponsive, false);
  assert.deepEqual([asleep.health.state, asleep.health.reason], ["waiting", "resuming-from-sleep"]);
  assert.equal(asleep.power.state, "resuming");
  assert.match(health.describeInstallationHealth(asleep), /asleep or just woke/);
  const hung = health.collectInstallationHealth({ homeDir, commands, now, slept: 1000 });
  assert.deepEqual([hung.health.state, hung.health.reason], ["failed", "daemon-not-responsive"]);
  assert.equal(hung.power.state, "awake");
});

test("a plist check that timed out says nothing about the registration", () => {
  const homeDir = "/Users/test";
  const contents = "<plist/>";
  const timedOut = () => ({ error: Object.assign(new Error("spawnSync /usr/bin/plutil ETIMEDOUT"), { code: "ETIMEDOUT" }), status: null, signal: "SIGTERM" });
  assert.throws(() => mac.readRegistration("work.relay.companion.pill", { homeDir, run: timedOut, contents }), /^Error: check-timed-out: work\.relay\.companion\.pill$/);
  const broken = () => ({ status: 1, stdout: "", stderr: "bad" });
  assert.throws(() => mac.readRegistration("work.relay.companion.pill", { homeDir, run: broken, contents }), /^Error: invalid-service-plist/);
});
