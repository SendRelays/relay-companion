"use strict";
// How long this machine has slept, told apart from a process that merely hung.
// A "sleep reading" is a number that stays put while the machine is awake and
// grows by at least the length of every sleep, so a growth between two
// readings is sleep, while a hung process sees it unchanged.
//
// Linux ("uptime"): uptime (wall clock since boot) keeps counting through a
// suspend; the monotonic clock behind process.hrtime does not. Their
// difference is the reading.
//
// macOS ("waketime"): Node's monotonic clock there keeps counting through
// sleep, so the uptime difference never moves. Sven's Mac slept from 18:56 to
// 09:41 on 2026-11-24/25 and its heartbeat recorded no sleep at all. The
// reading is instead the kernel's last wake time (sysctl kern.waketime), which
// Power Nap's dark wakes also move. Spawning sysctl every 5 s would be waste:
// a sleep always leaves a gap between two calls in one process (timers do not
// fire while asleep), so the kernel is asked again only after such a gap.
//
// Windows' monotonic clock also counts through sleep, so sleep is not
// detected there (reported as unsupported rather than guessed).
//
// Sven's Mac on 2026-11-20 woke for a minute every 16-18 minutes with its lid
// closed. Every health and update check started in one wake and timed out in
// the next, and the fleet showed "daemon not responding", an invalid pill
// registration and failed recovery for a machine that was simply asleep.
const os = require("node:os");

const { execFileSync } = require("node:child_process");

const SOURCES = { darwin: "waketime", linux: "uptime" };
// Calls closer together than this cannot have a sleep that matters between them.
const REREAD_GAP_MS = 20_000;
// A failed kernel read is retried after this long, not on every tick.
const FAILED_READ_RETRY_MS = 60_000;
// Ignore drift and scheduling noise; a real sleep is minutes long.
const SLEEP_GAP_MS = 30_000;
// Wakes this short and this frequent are a closed lid's maintenance wakes.
const BRIEF_WAKE_MS = 5 * 60_000;
const RECENT_WAKE_MS = 3 * 60_000;
const HISTORY_MS = 24 * 60 * 60_000;
const MAX_SLEEPS = 24;

/** Which sleep reading this platform has, or null. */
function sleepSource(platform = process.platform) {
  return SOURCES[platform] || null;
}

const readKernelWake = () => execFileSync("/usr/sbin/sysctl", ["-n", "kern.waketime"],
  { encoding: "utf8", timeout: 2000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
let wakeCache = null; // { calledAt, readAt, value }

/** "{ sec = 1764060070, usec = 742196 } Tue Nov 25 …" as epoch milliseconds (0: not woken since boot). */
function parseKernelTime(text) {
  const match = String(text || "").match(/\bsec\s*=\s*(\d+)\s*,\s*usec\s*=\s*(\d+)/);
  return match ? Number(match[1]) * 1000 + Math.floor(Number(match[2]) / 1000) : null;
}

/** The kernel's last wake time on macOS, asked again only when a sleep could have happened since the last call. */
function lastWakeMs({ now = Date.now(), read = readKernelWake } = {}) {
  const cached = wakeCache;
  if (cached && now >= cached.calledAt && (cached.value === null
    ? now - cached.readAt < FAILED_READ_RETRY_MS
    : now - cached.calledAt < REREAD_GAP_MS)) {
    cached.calledAt = now;
    return cached.value;
  }
  let value = null;
  try { value = parseKernelTime(read()); } catch {}
  wakeCache = { calledAt: now, readAt: now, value };
  return value;
}

/** This platform's sleep reading (see above); null where sleep cannot be told. */
function sleptMs({ platform = process.platform, uptimeSeconds, monotonicMs, now, readWake } = {}) {
  const source = sleepSource(platform);
  if (source === "waketime") return lastWakeMs({ now, read: readWake });
  if (source !== "uptime") return null;
  const value = Math.round(Number(uptimeSeconds ?? os.uptime()) * 1000 - Number(monotonicMs ?? Number(process.hrtime.bigint() / 1_000_000n)));
  return Number.isFinite(value) ? value : null;
}

/** Did the machine sleep between two sleptMs readings? */
function sleptBetween(before, after) {
  return typeof before === "number" && typeof after === "number" && after - before > SLEEP_GAP_MS;
}

const isTime = value => Number.isFinite(value) && value > 0;
function validSleeps(list, now) {
  return (Array.isArray(list) ? list : [])
    .filter(item => isTime(item?.from) && isTime(item?.to) && item.from <= item.to && item.to <= now && now - item.to <= HISTORY_MS)
    .map(item => ({ from: item.from, to: item.to }));
}

/**
 * The heartbeat's sleep history after one tick: appends the gap since the last
 * tick when the machine slept through it.
 */
function recordTick({ previous, at, slept }) {
  const sleeps = validSleeps(previous?.sleeps, at);
  if (isTime(previous?.at) && sleptBetween(previous?.sleptMs, slept)) sleeps.push({ from: previous.at, to: at });
  return sleeps.slice(-MAX_SLEEPS);
}

/**
 * What the machine's power has been doing, from the daemon's heartbeat and a
 * fresh clock reading. "resuming": it slept since the daemon last ticked, so
 * the daemon has not run yet since waking. "brief-wakes": it keeps waking for a
 * few minutes and sleeping again.
 */
function powerState({ heartbeat, now = Date.now(), slept = sleptMs(), source = sleepSource() } = {}) {
  const supported = slept !== null;
  const sleeps = validSleeps(heartbeat?.sleeps, now);
  // Readings of two different kinds (a heartbeat written before an update
  // changed the kind) cannot be compared.
  const comparable = !heartbeat?.sleepSource || !source || heartbeat.sleepSource === source;
  const resuming = supported && comparable && isTime(heartbeat?.at) && heartbeat.at <= now && sleptBetween(heartbeat?.sleptMs, slept);
  // The daemon has not ticked since: the sleep began after its last tick and
  // ended at the kernel's wake time, or, from the uptime clocks, when this
  // machine's time stopped jumping, sleptSince ms later.
  if (resuming) {
    const woke = source === "waketime" ? Math.max(heartbeat.at, slept) : heartbeat.at + (slept - heartbeat.sleptMs);
    sleeps.push({ from: heartbeat.at, to: Math.min(now, woke) });
  }
  const lastHour = sleeps.filter(item => now - item.to <= 60 * 60_000);
  // Every awake stretch between those sleeps, and the current one, was short.
  const awake = lastHour.map((item, index) => (lastHour[index + 1]?.from ?? now) - item.to);
  const briefWakes = lastHour.length >= 2 && awake.every(ms => ms < BRIEF_WAKE_MS);
  const last = sleeps.at(-1);
  const state = !supported ? "unknown"
    : resuming || (last && now - last.to < RECENT_WAKE_MS) ? "resuming"
      : briefWakes ? "brief-wakes" : "awake";
  return {
    sleepDetection: supported,
    state,
    lastSleepAt: last ? new Date(last.from).toISOString() : null,
    lastWakeAt: last ? new Date(last.to).toISOString() : null,
    sleepsLastHour: lastHour.length,
  };
}

/** Test seam: forget the cached kernel wake time. */
function resetSleepClock() { wakeCache = null; }

module.exports = { sleptMs, sleepSource, sleptBetween, recordTick, powerState, parseKernelTime, resetSleepClock, SLEEP_GAP_MS };
