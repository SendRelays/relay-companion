// One tidy of Relay's release copies, in its own short-lived process. Listing
// the running processes is synchronous (PowerShell on Windows can take
// seconds), and the background service must never stall on it: a stalled
// daemon fails its own health proof. The daemon starts this every few hours
// (see release-tidy.js) and reads one line of JSON back.
import { tidyCanonicalReleases } from "./canonical-runtime.js";
import { keptReleaseRoots, pruneUpdateRequests } from "./canonical-updater.js";

let result;
try {
  const { protectedPackageRoots, recoveryBackups, lowDisk } = keptReleaseRoots();
  result = { ...tidyCanonicalReleases({ protectedPackageRoots, recoveryBackups, lockIdentity: { purpose: "release-tidy" } }), lowDisk };
} catch (error) {
  result = { ok: false, skipped: "release-tidy-threw", detail: error?.message || String(error), removed: [] };
}
try { result.updateRequestsRemoved = pruneUpdateRequests().removed; } catch {}
process.stdout.write(`${JSON.stringify(result)}\n`);
