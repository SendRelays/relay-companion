import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ACTIVATION_RESULT_PREFIX,
  canDelegateActivation,
  runCanonicalUpdateTransaction,
  runDelegatedActivation,
} from "../src/canonical-updater.js";
import { parseActivationRequest, runActivationRequest } from "../src/activation-entry.js";

const posixTest = process.platform === "win32" ? test.skip : test;

// A release tree whose activation entry is a stand-in script, run by a real Node.
function release(t, script, version = "0.1.700") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-delegated-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, ".relay", "runtime", "releases", `${version}-a`, "node_modules", "relay-companion");
  fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "bin", "relay.js"), "// relay\n");
  if (script !== null) fs.writeFileSync(path.join(packageRoot, "src", "activation-entry.js"), script);
  return { root, owner: { version, node: process.execPath, packageRoot, bin: path.join(packageRoot, "bin", "relay.js") } };
}

test("a release can activate itself only when it ships the entry, unless turned off", (t) => {
  const { owner } = release(t, "");
  assert.equal(canDelegateActivation(owner, { env: {} }), true);
  assert.equal(canDelegateActivation(owner, { env: { RELAY_DELEGATED_ACTIVATION: "0" } }), false);
  assert.equal(canDelegateActivation(release(t, null).owner, { env: {} }), false, "releases before this one have no entry");
  assert.equal(canDelegateActivation({ packageRoot: owner.packageRoot }, { env: {} }), false);
});

posixTest("the new release's verdict is read from its own process", async (t) => {
  const { root, owner } = release(t, `
    const request = JSON.parse(Buffer.from(process.argv[2], "base64url").toString("utf8"));
    console.log("some activation log line");
    console.log("${ACTIVATION_RESULT_PREFIX}" + JSON.stringify({ ok: true, mode: request.mode, worker: process.env.RELAY_ACTIVATION_WORKER, target: request.target.version }));
  `);
  const result = await runDelegatedActivation("activate", owner, { owner, homeDir: root, platform: "linux", env: {} });
  assert.deepEqual(result, { ok: true, mode: "activate", worker: "1", target: "0.1.700", completed: true, delegated: true, delegatedTo: "0.1.700" });
});

posixTest("a crash, an overrun or an unreadable answer is a failure the old release recovers from", async (t) => {
  const crash = release(t, `console.error("TypeError: cannot read x"); process.exit(3);`);
  const crashed = await runDelegatedActivation("activate", crash.owner, { owner: crash.owner, homeDir: crash.root, platform: "linux", env: {} });
  assert.equal(crashed.ok, false);
  assert.equal(crashed.completed, false);
  assert.equal(crashed.reason, "delegated-activation-no-verdict");
  assert.match(crashed.detail, /exit=3 .*TypeError: cannot read x/);

  const hang = release(t, `setInterval(() => {}, 1000);`);
  const overran = await runDelegatedActivation("activate", hang.owner, { owner: hang.owner, homeDir: hang.root, platform: "linux", env: {}, timeoutMs: 300 });
  assert.deepEqual([overran.ok, overran.completed, overran.reason], [false, false, "delegated-activation-timeout"]);

  const garbage = release(t, `console.log("${ACTIVATION_RESULT_PREFIX}{not json");`);
  const unreadable = await runDelegatedActivation("activate", garbage.owner, { owner: garbage.owner, homeDir: garbage.root, platform: "linux", env: {} });
  assert.deepEqual([unreadable.ok, unreadable.completed], [false, false]);

  const failing = release(t, `console.log("${ACTIVATION_RESULT_PREFIX}" + JSON.stringify({ ok: false, reason: "activation-not-ready" }));`);
  const failed = await runDelegatedActivation("activate", failing.owner, { owner: failing.owner, homeDir: failing.root, platform: "linux", env: {} });
  assert.deepEqual([failed.ok, failed.completed, failed.reason], [false, true, "activation-not-ready"], "a verdict of failure is still a completed run");
});

test("the entry only activates its own release and passes only the worker's options through", () => {
  const own = "/h/.relay/runtime/releases/0.1.700-a/node_modules/relay-companion";
  const other = "/h/.relay/runtime/releases/0.1.648-a/node_modules/relay-companion";
  const target = (packageRoot, version) => ({ version, node: "/usr/bin/node", packageRoot, bin: `${packageRoot}/bin/relay.js` });
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const parse = (value) => parseActivationRequest(encode(value), { ownPackageRoot: own, homeDir: "/h", platform: "linux" });
  const base = { schema: 1, mode: "activate", homeDir: "/h", platform: "linux", target: target(own, "0.1.700") };

  assert.deepEqual(parse({ ...base, options: { allowRebuildRegistrations: true, shell: "rm -rf /" } }).options, { allowRebuildRegistrations: true });
  assert.throws(() => parse({ ...base, target: target(other, "0.1.648") }), /activation-target-not-this-release/);
  assert.throws(() => parse({ ...base, homeDir: "/elsewhere" }), /activation-request-foreign/);
  assert.throws(() => parse({ ...base, mode: "uninstall" }), /activation-request-invalid/);
  assert.throws(() => parse({ ...base, target: { ...target(own, "0.1.700"), bin: "/tmp/evil.js" } }), /activation-target-invalid/);
  assert.throws(() => parseActivationRequest("%%%", { ownPackageRoot: own, homeDir: "/h", platform: "linux" }), /unreadable/);

  // A restore names the release being replaced, and may repair only through this one.
  const restore = parse({ ...base, mode: "restore", target: target(other, "0.1.648"),
    options: { restoreRegistrations: true, repairExecutable: target(own, "0.1.700") } });
  assert.equal(restore.target.version, "0.1.648");
  assert.equal(restore.options.repairExecutable.packageRoot, own);
  assert.throws(() => parse({ ...base, mode: "restore", target: target(other, "0.1.648"), options: { repairExecutable: target(other, "0.1.648") } }),
    /activation-repair-executable-invalid/);
});

test("the entry runs this release's own activation with the checked request", async () => {
  const seen = [];
  const result = await runActivationRequest({ target: { version: "0.1.700" }, homeDir: "/h", platform: "linux", options: { restoreRegistrations: true } },
    { activate: async (target, options) => { seen.push({ target, options }); return { ok: true }; } });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(seen, [{ target: { version: "0.1.700" }, options: { homeDir: "/h", platform: "linux", restoreRegistrations: true } }]);
});

posixTest("the update worker delegates the switch, lets a new release that gave a verdict restore first, and always has the last word", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-delegated-transaction-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, "lib", "node_modules", "relay-companion");
  for (const [relative, contents] of [["package.json", JSON.stringify({ version: "0.1.650" })], ["bin/relay.js", "// bin"],
    ["src/task-daemon.js", "// daemon"], ["overlay/main.cjs", "// pill"], ["node_modules/electron/dist/electron", ""]]) {
    const file = path.join(packageRoot, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents, { mode: 0o700 });
  }
  const candidate = { version: "0.1.700", node: process.execPath, packageRoot: "/new", bin: "/new/bin/relay.js" };
  const previous = { version: "0.1.650", node: process.execPath, packageRoot, bin: path.join(packageRoot, "bin", "relay.js") };
  const run = async ({ delegateAnswers, canDelegate = () => true }) => {
    const calls = [];
    let options;
    await runCanonicalUpdateTransaction({
      version: "0.1.700", runningVersion: "0.1.650", runningPackageRoot: packageRoot, platform: "linux", homeDir: root,
      node: process.execPath, npmCommand: "npm", resolveServiceNode: () => process.execPath, getProtectedPackageRoots: () => [],
      canDelegate,
      delegateActivation: async (mode, target, { owner }) => { calls.push(["delegated", mode, target.version, owner.version]); return delegateAnswers.shift(); },
      activate: async (target) => { calls.push(["own", target.version]); return { ok: true }; },
      repair: async (received) => { options = received; return { ok: true, candidate }; },
    });
    return { calls, options };
  };

  // The switch itself runs the new release's code.
  let { calls, options } = await run({ delegateAnswers: [{ ok: false, completed: true, delegated: true, reason: "activation-not-ready" }] });
  const activated = await options.postCommitActivate(candidate);
  assert.equal(activated.delegated, true);
  assert.deepEqual(calls, [["delegated", "activate", "0.1.700", "0.1.700"]]);

  // It ran to the end and failed: it restores first, and succeeds.
  ({ calls, options } = await run({ delegateAnswers: [{ ok: true, completed: true, delegated: true }] }));
  assert.equal((await options.rollbackActivate(previous, { failed: candidate, activation: activated })).ok, true);
  assert.deepEqual(calls, [["delegated", "restore", "0.1.650", "0.1.700"]]);

  // Its restore fails too: this release's own code restores.
  ({ calls, options } = await run({ delegateAnswers: [{ ok: false, completed: true, delegated: true, reason: "x" }] }));
  assert.equal((await options.rollbackActivate(previous, { failed: candidate, activation: activated })).ok, true);
  assert.deepEqual(calls, [["delegated", "restore", "0.1.650", "0.1.700"], ["own", "0.1.650"]]);

  // It crashed or overran: it is not trusted with the rollback.
  ({ calls, options } = await run({ delegateAnswers: [] }));
  await options.rollbackActivate(previous, { failed: candidate, activation: { ok: false, delegated: true, completed: false } });
  assert.deepEqual(calls, [["own", "0.1.650"]]);

  // A release without the entry is activated by this release's code, as before.
  ({ calls, options } = await run({ delegateAnswers: [], canDelegate: () => false }));
  await options.postCommitActivate(candidate);
  assert.deepEqual(calls, [["own", "0.1.700"]]);
});
