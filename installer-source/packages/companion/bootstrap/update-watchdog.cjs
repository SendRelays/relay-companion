"use strict";
// First: started as an Electron app instead of Node, re-run as Node and quit.
require("./electron-as-node.cjs");
// The guardian does not load the application's module graph. A broken import or
// blocked worker event loop cannot disable its deadline.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execute } = require("./recovery-runner.cjs");

// launchd and systemd-run redirect the whole worker tree to ~/.relay/update.log.
// Windows launches through WMI, which cannot redirect stdio, and the worker's
// console is hidden — so without this the setup script's progress lines vanish.
function updateLogStdio(platform = process.platform, homeDir = os.homedir()) {
  if (platform !== "win32") return { stdio: "inherit", logPath: null };
  const logPath = path.join(homeDir, ".relay", "update.log");
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const fd = fs.openSync(logPath, "a");
    return { stdio: ["ignore", fd, fd], logPath };
  } catch {
    return { stdio: "inherit", logPath: null };
  }
}

// The deadline or exit that ended a worker, for the fleet report: appended to
// the update loop's error ring beside update-state.json (src/auto-update.js,
// recordUpdateError, same format). Never allowed to affect the worker's exit.
function recordWatchdogError(entry, message, { env = process.env, homeDir = os.homedir(), now = Date.now } = {}) {
  try {
    const store = env.RELAY_HOME || env.RELAY_COMPANION_HOME || path.join(homeDir, ".relay-companion");
    const file = path.join(store, "update-errors.json");
    let errors = [];
    try { const stored = JSON.parse(fs.readFileSync(file, "utf8")); if (Array.isArray(stored?.errors)) errors = stored.errors.filter(item => item && typeof item === "object"); } catch {}
    const detail = String(message || "").replace(/\s+/g, " ").trim().slice(0, 300);
    const kind = path.basename(String(entry || "")).replace(/\.c?js$/, "").slice(0, 40) || null;
    const reason = (/recovery-worker-(deadline-exceeded|exit-\d+)/.exec(detail) || [])[0] || "worker-failed";
    const last = errors.at(-1);
    if (last && last.status === "watchdog" && last.kind === kind && last.detail === detail) errors[errors.length - 1] = { ...last, at: now(), count: (Number(last.count) || 1) + 1 };
    else errors.push({ at: now(), status: "watchdog", kind, reason, detail, count: 1 });
    fs.mkdirSync(store, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ schema: 1, errors: errors.slice(-6) })}\n`);
    fs.renameSync(temporary, file);
  } catch {}
}

if (require.main === module) {
  if (process.versions.electron) throw Error("Relay update workers require the verified Node runtime, not Electron");
  const [entry, mode, payload] = process.argv.slice(2);
  if (!entry || mode !== "--worker" || !payload) throw Error("Missing update worker arguments");
  const { stdio, logPath } = updateLogStdio();
  // A job can outlive the release tree that named this entry. Say so once and
  // exit cleanly instead of crashing on every relaunch.
  if (!fs.existsSync(entry)) {
    const line = `[relay-update] worker entry missing: ${entry}`;
    console.error(line);
    if (logPath) { try { fs.appendFileSync(logPath, `${line}\n`); } catch {} }
    recordWatchdogError(entry, "worker entry missing");
    process.exit(0);
  }
  execute(process.execPath, entry, [mode, payload], { stdio }).catch(error => {
    const line = `[relay-update] ${error.message}`;
    console.error(line);
    if (logPath) { try { fs.appendFileSync(logPath, `${line}\n`); } catch {} }
    recordWatchdogError(entry, error.message);
    // launchd must not resurrect a failed attempt with a stale target.
    process.exitCode = 0;
  });
}

module.exports = { updateLogStdio, recordWatchdogError };
