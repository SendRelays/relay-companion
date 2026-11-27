// Executed from a signature-verified download or a validated, previously
// installed release. Normal updates and recovery share the canonical lock.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCanonicalUpdateTransaction } from "./canonical-updater.js";
import { updateChannel } from "./config.js";

export async function runRecovery(version, channel) {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  if (manifest.version !== version || updateChannel() !== channel) throw new Error("Recovery release or channel changed");
  const execute = () => runCanonicalUpdateTransaction({ version, runningVersion: version, runningPackageRoot: packageRoot,
    requestId: /^[a-f0-9-]{36}$/i.test(process.env.RELAY_RECOVERY_ATTEMPT_ID || "") ? process.env.RELAY_RECOVERY_ATTEMPT_ID : null,
    supersedeBrokenRecovery: true,
    repairExecutableOverride: { bin: path.join(packageRoot, "bin", "relay.js"), node: process.execPath },
    installCandidate: async ({ stagingRoot }) => {
      fs.cpSync(path.resolve(packageRoot, "../.."), stagingRoot, { recursive: true, dereference: false, verbatimSymlinks: true });
      return { ok: true, source: "verified-recovery-runtime" };
    }, log: (line) => console.log(`[recovery] ${line}`) });
  let result = await execute();
  // A recovered journal restores service first; then advance to the selected fix.
  if (result.ok && result.recovered) result = await execute();
  if (!result.ok) {
    const error = new Error(`${result.phase}: ${result.reason}: ${result.detail || ""}`);
    // Another live process owns the transaction. This worker judged nothing
    // about the release, and the runner must not count it as a failure.
    error.transactionInProgress = result.phase === "lock" && result.reason === "transaction-in-progress";
    throw error;
  }
  return result;
}
// EX_TEMPFAIL, shared with bootstrap/recovery-transaction.cjs.
export const EXIT_TRANSACTION_IN_PROGRESS = 75;
export function recoveryExitCode(error) {
  return error?.transactionInProgress === true ? EXIT_TRANSACTION_IN_PROGRESS : 1;
}
// The runner only sees this worker's exit code (recovery-worker-exit-1), so the
// worker leaves its real cause beside the runner's status for the runner to
// keep (lastErrorDetail) and the fleet report to carry (fleet-problems.js).
// A worker that only lost the lock judged nothing and leaves nothing.
export function workerFailurePath(homeDir = os.homedir()) {
  return path.join(homeDir, ".relay", "recovery", "worker-failure.json");
}
export function recordWorkerFailure(error, { version, homeDir = os.homedir(), now = Date.now } = {}) {
  try {
    const file = workerFailurePath(homeDir);
    if (error?.transactionInProgress === true) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ schema: 1, at: now(), version: version || null,
      attemptId: process.env.RELAY_RECOVERY_ATTEMPT_ID || null, message: String(error?.message || error).slice(0, 600) }));
    fs.renameSync(temporary, file);
  } catch {}
}
export function clearWorkerFailure({ homeDir = os.homedir() } = {}) {
  try { fs.rmSync(workerFailurePath(homeDir), { force: true }); } catch {}
}
if (process.env.RELAY_RECOVERY_WORKER === "1") {
  runRecovery(process.argv[2], process.argv[3]).then(() => clearWorkerFailure(), (error) => {
    console.error(error.message);
    recordWorkerFailure(error, { version: process.argv[2] });
    process.exitCode = recoveryExitCode(error);
  });
}
