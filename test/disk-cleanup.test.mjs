// 2026-11-27: a Mac with 4.7 GB free held five Relay release copies of about
// 870 MB each and 4,127 update records that nothing ever removed.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keptReleaseRoots, pruneUpdateRequests, KEEP_UPDATE_REQUESTS, LOW_DISK_FREE_BYTES } from "../src/canonical-updater.js";
import { collectCompanionFleetTelemetry } from "../src/fleet-telemetry.js";

function home(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-disk-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  return homeDir;
}
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };

test("on a nearly full disk only the newest proven backup is kept; otherwise both", (t) => {
  const homeDir = home(t);
  write(path.join(homeDir, ".relay", "recovery", "runtime-good.json"), { version: "0.1.648", packageRoot: "/r/good" });
  write(path.join(homeDir, ".relay", "recovery", "runtime-previous-good.json"), { version: "0.1.634", packageRoot: "/r/previous" });
  const kept = (freeBytes) => keptReleaseRoots({ homeDir, getProtectedPackageRoots: () => ["/r/running"], space: () => ({ freeBytes, totalBytes: 10 * freeBytes }) });
  assert.deepEqual(kept(50 * 1024 ** 3), { protectedPackageRoots: ["/r/running", "/r/good", "/r/previous"], recoveryBackups: 2, lowDisk: false });
  assert.deepEqual(kept(4.7 * 1024 ** 3), { protectedPackageRoots: ["/r/running", "/r/good"], recoveryBackups: 1, lowDisk: true });
  assert.equal(kept(LOW_DISK_FREE_BYTES).lowDisk, false, "exactly at the line is not low");
  const unknown = keptReleaseRoots({ homeDir, getProtectedPackageRoots: () => [], space: () => null });
  assert.equal(unknown.recoveryBackups, 2, "unknown free space keeps both backups");
});

test("old update records are removed; the newest, recent and unfinished ones stay", (t) => {
  const homeDir = home(t);
  const directory = path.join(homeDir, ".relay", "runtime", "update-requests");
  const now = Date.parse("2026-11-27T12:00:00Z");
  const record = (index, state, ageMs) => {
    const file = path.join(directory, `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000.json`);
    write(file, { state });
    const at = new Date(now - ageMs);
    fs.utimesSync(file, at, at);
    return file;
  };
  const newest = Array.from({ length: KEEP_UPDATE_REQUESTS }, (_, i) => record(i, "failed", 3 * 86400_000 + i));
  const oldFailed = record(900, "failed", 4 * 86400_000);
  const oldCompleted = record(901, "completed", 2 * 3_600_000 + 4 * 86400_000);
  const recentFailed = record(902, "failed", 10 * 60_000);
  const runningToday = record(903, "admitted", 5 * 3_600_000);
  const abandoned = record(904, "admitted", 2 * 86400_000 + 5 * 86400_000);
  // The newest fifty by modification time are the recent ones plus the first 47 of `newest`.
  const result = pruneUpdateRequests({ homeDir, now: () => now });
  for (const file of [recentFailed, runningToday]) assert.equal(fs.existsSync(file), true, `${path.basename(file)} kept`);
  for (const file of [oldFailed, oldCompleted, abandoned]) assert.equal(fs.existsSync(file), false, `${path.basename(file)} removed`);
  assert.equal(fs.readdirSync(directory).length, KEEP_UPDATE_REQUESTS, "exactly the newest fifty remain");
  assert.equal(result.removed, newest.length + 5 - KEEP_UPDATE_REQUESTS);
  assert.deepEqual(pruneUpdateRequests({ homeDir: path.join(homeDir, "nowhere"), now: () => now }), { removed: 0 });
});

test("the health report carries free disk space and says when it is low", (t) => {
  const homeDir = home(t);
  const statfs = (bavail) => () => ({ bavail, bsize: 4096, blocks: 60_000_000 });
  const report = (bavail) => collectCompanionFleetTelemetry({ homeDir, platform: "darwin", channel: "stable", env: {},
    updateStatePath: path.join(homeDir, ".relay-companion", "update-state.json"), collectHealth: () => undefined, statfs: statfs(bavail) });
  assert.deepEqual(report(1_200_000).disk, { freeBytes: 1_200_000 * 4096, totalBytes: 60_000_000 * 4096, low: true });
  assert.equal(report(12_000_000).disk.low, false);
  const unreadable = collectCompanionFleetTelemetry({ homeDir, platform: "darwin", channel: "stable", env: {},
    updateStatePath: path.join(homeDir, "x.json"), collectHealth: () => undefined, statfs: () => { throw new Error("ENOSYS"); } });
  assert.equal("disk" in unreadable, false);
});
