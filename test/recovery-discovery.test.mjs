// The independent repair must learn the current release from the same signed
// records the updater follows. Until 2026-11 it read companion-releases/stable/,
// the old-key bridge record frozen at 0.1.550 for installs that only know the
// old signing key, so repairing a broken computer could install 0.1.550.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { discover } = require("../bootstrap/recovery-runner.cjs");

const keyId = "relay-runtime-release-v99";
const keys = crypto.generateKeyPairSync("ed25519");
const trustStore = { schema: 2, activeKeyId: keyId, keys: [{ keyId, algorithm: "ED25519_SHA_512", publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString() }] };
const signed = (value) => {
  const payload = Buffer.from(JSON.stringify(value));
  return { schema: 1, algorithm: "ED25519_SHA_512", keyId, payload: payload.toString("base64"), signature: crypto.sign(null, payload, keys.privateKey).toString("base64") };
};
const NOW = Date.parse("2026-11-26T12:00:00Z");
const ORIGIN = "https://api.sendrelays.com/v1/companion-releases";
const stable = (version) => signed({ product: "Relay", version, sourceSha: "a".repeat(40) });
const cohort = (fields = {}) => signed({ schema: 1, product: "Relay", kind: "runtime-cohort", version: "0.1.660", sourceSha: "b".repeat(40),
  deviceIds: ["dev_member_0001"], expiresAt: NOW + 86400_000, ...fields });

function computer(t, deviceId = "dev_member_0001") {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-discovery-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(homeDir, ".relay"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".relay", "config.json"), JSON.stringify({ deviceId }));
  return homeDir;
}
function edge(records) {
  const asked = [];
  const fetchImpl = async (url) => {
    const key = String(url).split("?")[0];
    asked.push(key);
    const body = records[key];
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetchImpl, asked };
}

test("stable repair reads the current stable record, never the old-key bridge record", async (t) => {
  const { fetchImpl, asked } = edge({ [`${ORIGIN}/stable-v3/manifest.json`]: stable("0.1.648"), [`${ORIGIN}/stable/manifest.json`]: stable("0.1.550") });
  assert.equal(await discover("stable", { fetchImpl, trustStore, homeDir: computer(t, "dev_other_0002"), now: () => NOW }), "0.1.648");
  assert.equal(asked.includes(`${ORIGIN}/stable/manifest.json`), false);
});

test("a device named in the cohort is repaired to the cohort's newer version; every other case keeps the general one", async (t) => {
  const records = (cohortBody) => ({ [`${ORIGIN}/stable-v3/manifest.json`]: stable("0.1.648"), ...(cohortBody ? { [`${ORIGIN}/stable-v3-cohort/manifest.json`]: cohortBody } : {}) });
  const run = (cohortBody, deviceId) => discover("stable", { ...edge(records(cohortBody)), trustStore, homeDir: computer(t, deviceId), now: () => NOW });
  assert.equal(await run(cohort()), "0.1.660");
  assert.equal(await run(cohort(), "dev_other_0002"), "0.1.648", "not listed");
  assert.equal(await run(cohort({ expiresAt: NOW - 1 })), "0.1.648", "expired");
  assert.equal(await run(cohort({ version: "0.1.640" })), "0.1.648", "a cohort never moves a device backwards");
  assert.equal(await run(null), "0.1.648", "no cohort published");
  const forged = cohort(); forged.signature = Buffer.alloc(64).toString("base64");
  assert.equal(await run(forged), "0.1.648", "a bad signature is ignored, not obeyed");
});

test("a dev or staging repair still follows its npm tag and that version's exact record", async (t) => {
  const records = { "https://registry.npmjs.org/-/package/relay-companion/dist-tags": { dev: "0.1.700" }, [`${ORIGIN}/v0.1.700/manifest.json`]: stable("0.1.700") };
  assert.equal(await discover("dev", { ...edge(records), trustStore, homeDir: computer(t), now: () => NOW }), "0.1.700");
});
