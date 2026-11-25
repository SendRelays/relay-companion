import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const { write } = createRequire(import.meta.url)("../bootstrap/recovery-launcher.cjs");
const version = createRequire(import.meta.url)("../package.json").version;
const { installationId } = createRequire(import.meta.url)("../bootstrap/installation-health.cjs");
const sleepClock = createRequire(import.meta.url)("../bootstrap/sleep-clock.cjs");
const diagnostics = createRequire(import.meta.url)("../bootstrap/diagnostics.cjs");
// apiOkAt: when this daemon last got any HTTP answer from Relay. The pill reads
// it to decide whether a long run of its own failures is Relay being down or
// its own transport being wedged (src/pill-liveness.cjs).
// A tick this much later than its 5 s schedule, on a machine that did not
// sleep, means the daemon's own event loop was blocked (or the process frozen)
// for that long. That is what tells "Relay is stuck" from "the server is
// unreachable", which leaves the loop running (2026-11-24, Sven's Mac).
const LOOP_GAP_MS = 10_000;
const LOOP_BLOCKED_MS = 30_000;
const LOOP_WINDOW_MS = 15 * 60_000;

// The running heartbeat, for lastWokeAt() below. One per process.
let current = null;

/**
 * When this machine last woke (or this process last resumed after a long
 * pause), in epoch ms; 0 when it has not since this process started, or no
 * heartbeat runs here. After a wake the receiver
 * loop's timer can fire before the heartbeat's, so an overdue heartbeat ticks
 * first and the wake is never missed.
 */
export function lastWokeAt(now = Date.now()) {
  if (!current) return 0;
  if (now - current.lastTick() >= 5000) current.tick();
  return current.wokeAt();
}

/** Did this machine wake (or this process resume) after `since`? */
export function wokeSince(since, now = Date.now()) {
  return Number.isFinite(since) && lastWokeAt(now) > since;
}

export function startRecoveryHeartbeat({ homeDir = os.homedir(), hasActiveWork = () => false, apiOkAt = () => 0,
  connection = () => null,
  recordBlocked = (event) => diagnostics.record(event, { homeDir }),
  now = Date.now, setIntervalImpl = setInterval, slept = () => sleepClock.sleptMs(), sleepSource = sleepClock.sleepSource(), onWake = () => {},
  cpuMs = () => { const usage = process.cpuUsage(); return (usage.user + usage.system) / 1000; } } = {}) {
  const file = path.join(homeDir, ".relay", "recovery", "daemon.json");
  try { write(path.join(homeDir, ".relay", "recovery", "policy.json"), { autoUpdate: !/^(0|false|off|no)$/i.test(String(process.env.RELAY_AUTO_UPDATE || "")) }); } catch {}
  try { installationId({ homeDir, create: true }); } catch {}
  let lastTick = now(), awakeSince = lastTick, wokeAt = 0;
  let lastCpuMs = null;
  try { lastCpuMs = cpuMs(); } catch {}
  // sleptMs and sleeps let health checks tell a machine that slept from a
  // daemon that hung (bootstrap/sleep-clock.cjs).
  let previous = { at: null, sleptMs: null, sleeps: [] };
  const gaps = []; // { at, gapMs }: late ticks on an awake machine, last 15 minutes
  const tick = () => {
    const at = now();
    const gapMs = at - lastTick;
    // Sleep, a clock jump or a long process pause needs a new observation window.
    if (at < lastTick || at - lastTick > 2 * 60_000) awakeSince = wokeAt = at;
    lastTick = at;
    let sleptMs = null;
    try { sleptMs = slept(); } catch {}
    const sleptThrough = sleepClock.sleptBetween(previous.sleptMs, sleptMs);
    const sleeps = sleepClock.recordTick({ previous, at, slept: sleptMs });
    const woke = sleeps.at(-1)?.to === at;
    previous = { at, sleptMs, sleeps };
    if (woke) { awakeSince = wokeAt = at; try { onWake(at); } catch {} }
    let usedCpuMs = null;
    try { const cpu = cpuMs(); if (lastCpuMs !== null) usedCpuMs = cpu - lastCpuMs; lastCpuMs = cpu; } catch {}
    // Where sleep cannot be told (Windows), a blocked loop is told from a
    // sleeping machine by CPU: a loop stuck in work burns it, sleep does not.
    const blockedNotAsleep = sleptMs !== null || (usedCpuMs !== null && usedCpuMs >= gapMs / 4);
    if (gapMs >= LOOP_GAP_MS && !sleptThrough && blockedNotAsleep) {
      gaps.push({ at, gapMs });
      if (gapMs >= LOOP_BLOCKED_MS) {
        try { recordBlocked({ component: "daemon", stage: "event-loop", outcome: "failed", code: "event-loop-blocked", elapsedMs: gapMs }); } catch {}
      }
    }
    while (gaps.length && at - gaps[0].at > LOOP_WINDOW_MS) gaps.shift();
    let busy = true;
    try { busy = Boolean(hasActiveWork()); } catch {}
    let lastApiOkAt = 0;
    try { lastApiOkAt = Number(apiOkAt()) || 0; } catch {}
    let connectionSummary = null;
    try { connectionSummary = connection(at); } catch {}
    const loop = { maxGapMs: gaps.reduce((max, gap) => Math.max(max, gap.gapMs), 0) || null, gapsOver10s: gaps.length,
      lastGapAt: gaps.length ? new Date(gaps.at(-1).at).toISOString() : null };
    try { write(file, { schema: 1, pid: process.pid, version, busy, activityVersion: 1, awakeSince, at, apiOkAt: lastApiOkAt, sleptMs, sleepSource, sleeps,
      ...(connectionSummary ? { connection: connectionSummary } : {}), loop }); } catch {}
  };
  tick();
  current = { tick, lastTick: () => lastTick, wokeAt: () => wokeAt };
  const timer = setIntervalImpl(tick, 5000);
  timer.unref?.();
  return timer;
}
