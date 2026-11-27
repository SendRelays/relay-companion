"use strict";
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
function read(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function alive(pid) { if (!Number.isSafeInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; } }
// When a process started, in ms, or null when it cannot be told. A process
// number alone does not identify a process: after a restart the system hands
// the same low numbers to its own services. 2026-11-27: a Mac's week-old call
// marker named PID 872, which after the restart belonged to Apple's audio
// converter, so every update waited on a call that had ended long before.
const { spawnSync } = require("node:child_process");
function processStartedAt(pid, { platform = process.platform, run = spawnSync } = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  if (pid === process.pid) return ownStartedAt();
  try {
    if (platform === "win32") {
      const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { [DateTimeOffset]::new($p.StartTime).ToUnixTimeMilliseconds() }`],
      { encoding: "utf8", timeout: 10_000, windowsHide: true });
      const value = Number(String(result.stdout || "").trim());
      return result.status === 0 && Number.isFinite(value) && value > 0 ? value : null;
    }
    // lstart is local wall time to the second, e.g. "Fri Nov 27 10:18:43 2026".
    const result = run("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000, env: { ...process.env, LC_ALL: "C", LANG: "C" } });
    const value = Date.parse(String(result.stdout || "").trim().replace(/\s+/g, " "));
    return result.status === 0 && Number.isFinite(value) && value > 0 ? value : null;
  } catch { return null; }
}
let ownStart = null;
function ownStartedAt() { return ownStart ??= Math.round(Date.now() - process.uptime() * 1000); }
// Started after the marker was written: a different process now has that
// number, and the call it recorded is over. One second covers ps's whole-second
// start times. When the start cannot be told, the marker is still trusted: a
// genuine call is never cleared on a guess.
const REUSE_TOLERANCE_MS = 1_000;
// A process's start time does not change while it runs, so it is asked at most
// once a minute per number: a long genuine call must not cost a ps (or, on
// Windows, a PowerShell) every few seconds.
const startCache = new Map();
function cachedStartedAt(pid, now = Date.now()) {
  const hit = startCache.get(pid);
  if (hit && now - hit.at < 60_000) return hit.value;
  const value = processStartedAt(pid);
  startCache.set(pid, { value, at: now });
  if (startCache.size > 64) startCache.delete(startCache.keys().next().value);
  return value;
}
function ownerReused(report, { startedAtOf = cachedStartedAt } = {}) {
  const since = Number(report?.ownerStartedAt ?? report?.startedAt);
  if (!Number.isFinite(since) || since <= 0) return false;
  const started = startedAtOf(report.pid);
  return Number.isFinite(started) && started > since + REUSE_TOLERANCE_MS;
}
/** Whether the process a marker names is the one that wrote it and is still running. */
function ownerRunning(report, options = {}) {
  if (!report || !Number.isSafeInteger(report.pid) || report.pid < 1) return false;
  return (options.alive || alive)(report.pid) && !ownerReused(report, options);
}
function paths(homeDir, configDir) { const root = path.join(configDir || path.join(homeDir, ".relay"), "recovery", "activity"); return { root, drain: path.join(root, "drain.json") }; }
// What each in-progress marker records, so a computer whose update waits on one
// can say what it waits on: the kind ("call" for an MCP tool call, "work" for a
// session operation or a Relay-run AI turn), a content-free label (the tool or
// operation name), which process owns it and when it started.
const LABEL = /^[a-z0-9_.:-]{1,80}$/;
function processRole() {
  if (process.env.RELAY_PROCESS_ROLE && LABEL.test(process.env.RELAY_PROCESS_ROLE)) return process.env.RELAY_PROCESS_ROLE;
  if (process.versions.electron) return "app";
  const script = path.basename(String(process.argv[1] || "")).toLowerCase();
  if (/mcp-broker/.test(script)) return "broker";
  if (script === "relay.js" && process.argv.includes("daemon")) return "daemon";
  return script.replace(/\.c?js$/, "").replace(/[^a-z0-9_.:-]+/g, "-").slice(0, 40) || "unknown";
}
function beginCall({ homeDir = os.homedir(), configDir, kind = "call", label = null } = {}) {
  const { root, drain } = paths(homeDir, configDir);
  const blocked = () => alive(read(drain)?.pid);
  if (blocked()) throw Error("Relay is updating. Retry with the same idempotency key after it finishes.");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, `call-${crypto.randomUUID()}.json`);
  const name = typeof label === "string" && LABEL.test(label) ? label : null;
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, ownerStartedAt: ownStartedAt(), kind, ...(name ? { label: name } : {}), role: processRole(), startedAt: Date.now() }), { mode: 0o600, flag: "wx" });
  const release = () => { try { fs.rmSync(file, { force: true }); } catch {} };
  // Close admission racing the updater's drain barrier.
  if (blocked()) { release(); throw Error("Relay is updating. Retry with the same idempotency key after it finishes."); }
  return release;
}
/** Every in-progress marker, described; markers whose owner has exited are `alive: false`. */
function describeCalls({ homeDir = os.homedir(), configDir, now = Date.now, ...options } = {}) {
  const { root } = paths(homeDir, configDir);
  let names;
  try { names = fs.readdirSync(root); } catch { return []; }
  return names.filter(name => /^call-[a-f0-9-]+\.json$/.test(name)).map(name => {
    const report = read(path.join(root, name));
    const started = Number(report?.startedAt);
    return {
      kind: typeof report?.kind === "string" && LABEL.test(report.kind) ? report.kind : "unknown",
      label: typeof report?.label === "string" && LABEL.test(report.label) ? report.label : null,
      role: typeof report?.role === "string" && LABEL.test(report.role) ? report.role : "unknown",
      pid: Number.isSafeInteger(report?.pid) ? report.pid : null,
      alive: ownerRunning(report, options),
      // The number is in use, but by a process started after the marker.
      reused: Boolean(report) && Number.isSafeInteger(report.pid) && (options.alive || alive)(report.pid) && ownerReused(report, options),
      startedAt: Number.isFinite(started) && started > 0 ? started : null,
      ageMs: Number.isFinite(started) && started > 0 ? Math.max(0, now() - started) : null,
    };
  });
}
function summarizeCalls(calls) {
  const age = ms => ms === null ? "age unknown" : ms >= 3_600_000 ? `${Math.floor(ms / 3_600_000)}h${Math.floor(ms % 3_600_000 / 60_000)}m` : ms >= 60_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`;
  return calls.map(call => `${call.kind}${call.label ? `:${call.label}` : ""} by ${call.role} pid ${call.pid ?? "?"} for ${age(call.ageMs)}`).join("; ");
}
async function drainCalls({ homeDir = os.homedir(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 60, ...options } = {}) {
  const { root, drain } = paths(homeDir);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const nonce = crypto.randomUUID();
  // Caller holds the canonical transaction lock; only that owner may drain.
  fs.writeFileSync(drain, JSON.stringify({ pid: process.pid, nonce }), { mode: 0o600 });
  const release = () => { if (read(drain)?.nonce === nonce) fs.rmSync(drain, { force: true }); };
  try {
    for (let i = 0; i < attempts; i++) {
      let busy = false;
      for (const name of fs.readdirSync(root).filter(name => /^call-[a-f0-9-]+\.json$/.test(name))) {
        const file = path.join(root, name), report = read(file);
        // An unreadable marker cannot be proved over. One whose owner exited, or
        // whose number now belongs to a later process, is over: remove it.
        if (!report || !Number.isSafeInteger(report.pid) || report.pid < 1 || ownerRunning(report, options)) busy = true;
        else fs.rmSync(file, { force: true });
      }
      if (!busy) return release;
      await sleep(500);
    }
    // Say what is still running: this is the only record of why an update waited.
    const blocking = describeCalls({ homeDir, ...options }).filter(call => call.alive);
    const error = Error(`Relay calls still active; activation deferred without interrupting them: ${summarizeCalls(blocking) || "unreadable marker"}`);
    error.code = "relay-calls-active";
    error.blocking = blocking;
    throw error;
  } catch (e) { release(); throw e; }
}
function activeCalls({ homeDir = os.homedir(), configDir, ...options } = {}) {
  const { root } = paths(homeDir, configDir);
  let names;
  try { names = fs.readdirSync(root); } catch(e) { return e.code === "ENOENT" ? 0 : null; }
  let count = 0;
  for (const name of names.filter(name => /^call-[a-f0-9-]+\.json$/.test(name))) {
    const report = read(path.join(root, name));
    if (!report || !Number.isSafeInteger(report.pid) || report.pid < 1) return null; // cannot prove idle
    if (ownerRunning(report, options)) count++;
  }
  return count;
}
module.exports = { beginCall, drainCalls, activeCalls, describeCalls, summarizeCalls, ownerRunning, processStartedAt };
