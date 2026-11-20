"use strict";
// How long this machine has slept, told apart from a process that merely hung.
// Uptime (wall clock since boot) keeps counting while macOS or Linux sleeps;
// the monotonic clock behind process.hrtime does not. Their difference grows
// only while the machine sleeps, so a growth between two readings is sleep,
// while a hung process sees both clocks advance together. Windows' monotonic
// clock keeps counting through sleep, so there the difference never moves and
// sleep is not detected (reported as unsupported rather than guessed).
//
// Sven's Mac on 2026-11-20 woke for a minute every 16-18 minutes with its lid
// closed. Every health and update check started in one wake and timed out in
// the next, and the fleet showed "daemon not responding", an invalid pill
// registration and failed recovery for a machine that was simply asleep.
const os = require("node:os");

const SUPPORTED = new Set(["darwin", "linux"]);
// Ignore drift and scheduling noise; a real sleep is minutes long.
const SLEEP_GAP_MS = 30_000;
// Wakes this short and this frequent are a closed lid's maintenance wakes.
const BRIEF_WAKE_MS = 5 * 60_000;
const RECENT_WAKE_MS = 3 * 60_000;
const HISTORY_MS = 24 * 60 * 60_000;
const MAX_SLEEPS = 24;

/** Milliseconds slept since boot, up to a constant offset; null where it cannot be told. */
function sleptMs({ platform = process.platform, uptimeSeconds = os.uptime(), monotonicMs = Number(process.hrtime.bigint() / 1_000_000n) } = {}) {
  if (!SUPPORTED.has(platform)) return null;
  const value = Math.round(Number(uptimeSeconds) * 1000 - Number(monotonicMs));
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
function powerState({ heartbeat, now = Date.now(), slept = sleptMs() } = {}) {
  const supported = slept !== null;
  const sleeps = validSleeps(heartbeat?.sleeps, now);
  const resuming = supported && isTime(heartbeat?.at) && heartbeat.at <= now && sleptBetween(heartbeat?.sleptMs, slept);
  // The daemon has not ticked since: the sleep began after its last tick and
  // ended when this machine's time stopped jumping, sleptSince ms later.
  if (resuming) sleeps.push({ from: heartbeat.at, to: Math.min(now, heartbeat.at + (slept - heartbeat.sleptMs)) });
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

module.exports = { sleptMs, sleptBetween, recordTick, powerState, SLEEP_GAP_MS };
