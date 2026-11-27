// Run by an older release's update worker, from this release's own tree: this
// release switches the computer over to itself (mode "activate"), or restores
// the release it was replacing (mode "restore"), with its own activation code.
//
// Why: the update worker that installs a new release is the OLD release's
// code, so until now a fix to activation reached a computer only on the update
// after the one that shipped it. 2026-11-26: a Mac on 0.1.634 updated to
// 0.1.648 with 0.1.634's activation, which still had the MCP broker race
// fixed in 0.1.648, and was left needing recovery. The old worker still holds
// the transaction lock, verified this tree before running it, and restores
// itself with its own code if this one crashes, hangs or fails
// (canonical-updater.js, runDelegatedActivation).
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { activateCanonicalRuntime, ACTIVATION_RESULT_PREFIX } from "./canonical-updater.js";

export const ACTIVATION_WORKER_ENV = "RELAY_ACTIVATION_WORKER";
const OWN_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODES = new Set(["activate", "restore"]);

function sameTree(a, b, platform) {
  const api = platform === "win32" ? path.win32 : path.posix;
  const left = api.resolve(String(a || "")), right = api.resolve(String(b || ""));
  return platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function validTarget(target, platform) {
  const api = platform === "win32" ? path.win32 : path.posix;
  return Boolean(target && typeof target === "object" && typeof target.packageRoot === "string" && target.packageRoot
    && typeof target.node === "string" && target.node && typeof target.version === "string"
    && /^\d+\.\d+\.\d+$/.test(target.version) && sameTree(target.bin, api.join(target.packageRoot, "bin", "relay.js"), platform));
}

/**
 * The request, checked: only this release may be activated by its own entry,
 * a restore must name a well-formed release and may only repair through this
 * release, and only the activation options the worker uses pass through.
 */
export function parseActivationRequest(payload, {
  ownPackageRoot = OWN_PACKAGE_ROOT,
  homeDir = os.homedir(),
  platform = process.platform,
} = {}) {
  let request;
  try { request = JSON.parse(Buffer.from(String(payload || ""), "base64url").toString("utf8")); }
  catch { throw new Error("activation-request-unreadable"); }
  if (request?.schema !== 1 || !MODES.has(request.mode)) throw new Error("activation-request-invalid");
  if (request.platform !== platform || !sameTree(request.homeDir, homeDir, platform)) throw new Error("activation-request-foreign");
  if (!validTarget(request.target, platform)) throw new Error("activation-target-invalid");
  if (request.mode === "activate" && !sameTree(request.target.packageRoot, ownPackageRoot, platform)) throw new Error("activation-target-not-this-release");
  const raw = request.options && typeof request.options === "object" ? request.options : {};
  const options = {};
  if (typeof raw.allowRebuildRegistrations === "boolean") options.allowRebuildRegistrations = raw.allowRebuildRegistrations;
  if (typeof raw.restoreRegistrations === "boolean") options.restoreRegistrations = raw.restoreRegistrations;
  if (raw.repairExecutable !== undefined && raw.repairExecutable !== null) {
    if (!validTarget(raw.repairExecutable, platform) || !sameTree(raw.repairExecutable.packageRoot, ownPackageRoot, platform)) {
      throw new Error("activation-repair-executable-invalid");
    }
    options.repairExecutable = raw.repairExecutable;
  }
  return { mode: request.mode, target: request.target, homeDir: request.homeDir, platform: request.platform, options };
}

export async function runActivationRequest(request, { activate = activateCanonicalRuntime } = {}) {
  return activate(request.target, { homeDir: request.homeDir, platform: request.platform, ...request.options });
}

function compact(result) {
  // The worker needs the verdict and enough to log; never an unbounded object.
  const text = JSON.stringify(result ?? { ok: false, reason: "activation-returned-nothing" });
  return text.length <= 16_000 ? text : JSON.stringify({ ok: result?.ok === true, reason: result?.reason || null,
    detail: String(result?.detail || "").slice(0, 2000), unchanged: result?.unchanged === true, truncated: true });
}

if (process.env[ACTIVATION_WORKER_ENV] === "1" && process.argv[2]) {
  (async () => {
    let result;
    try {
      result = await runActivationRequest(parseActivationRequest(process.argv[2]));
    } catch (error) {
      result = { ok: false, reason: "delegated-activation-threw", detail: String(error?.message || error).slice(0, 2000) };
    }
    process.stdout.write(`\n${ACTIVATION_RESULT_PREFIX}${compact(result)}\n`);
  })().finally(() => { process.exitCode = 0; });
}
