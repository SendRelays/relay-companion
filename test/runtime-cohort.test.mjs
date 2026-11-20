import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { fetchLatestVersion } from "../src/auto-update.js";
import { validateRuntimeCohort, cohortDecision, readRuntimeCohort, RUNTIME_COHORT_URL } from "../src/runtime-cohort.js";

const DAY = 86400_000;
const NOW = Date.parse("2026-11-20T12:00:00Z");
const SHA = "a".repeat(40);
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const trustStore = { schema: 2, activeKeyId: "relay-runtime-release-v3",
  keys: [{ keyId: "relay-runtime-release-v3", algorithm: "ED25519_SHA_512", publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) }] };
const sign = (value, key = privateKey) => {
  const payload = Buffer.from(JSON.stringify(value));
  return { schema: 1, algorithm: "ED25519_SHA_512", keyId: "relay-runtime-release-v3", payload: payload.toString("base64"), signature: crypto.sign(null, payload, key).toString("base64") };
};
const cohort = (overrides = {}) => ({ schema: 1, product: "Relay", kind: "runtime-cohort", version: "0.1.642", sourceSha: SHA,
  deviceIds: ["dev_sven_mac_0001"], expiresAt: NOW + 14 * DAY, ...overrides });

// A stable Companion's two reads: the general pointer and the cohort.
function edge({ general = "0.1.641", offer = cohort(), status = 200 } = {}) {
  return async (url) => {
    if (url.startsWith(RUNTIME_COHORT_URL)) {
      if (status !== 200) return { ok: false, status, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => (offer === null ? {} : sign(offer)) };
    }
    return { ok: true, status: 200, json: async () => sign({ schema: 1, product: "Relay", version: general, sourceSha: SHA, artifacts: {} }) };
  };
}
const latest = (deviceId, options) => fetchLatestVersion({ channel: "stable", trustStore, now: () => NOW, deviceId: () => deviceId, fetchImpl: edge(options) });

test("a named device takes the cohort's newer version; everyone else stays on the general one", async () => {
  assert.equal(await latest("dev_sven_mac_0001"), "0.1.642");
  assert.equal(await latest("dev_someone_else_01"), "0.1.641");
  assert.equal(await latest(""), "0.1.641");
});

test("an expired, paused, older or unreadable cohort leaves every device on the general version", async () => {
  const member = "dev_sven_mac_0001";
  assert.equal(await latest(member, { offer: cohort({ expiresAt: NOW - 1 }) }), "0.1.641");
  // Further ahead than any publisher may set: treated as expired.
  assert.equal(await latest(member, { offer: cohort({ expiresAt: NOW + 40 * DAY }) }), "0.1.641");
  assert.equal(await latest(member, { offer: cohort({ deviceIds: [] }) }), "0.1.641");
  assert.equal(await latest(member, { offer: cohort({ version: "0.1.640" }) }), "0.1.641");
  assert.equal(await latest(member, { general: "0.1.642" }), "0.1.642");
  assert.equal(await latest(member, { status: 404 }), "0.1.641");
  assert.equal(await latest(member, { status: 500 }), "0.1.641");
  // Signed by someone else: refused.
  const forged = async url => url.startsWith(RUNTIME_COHORT_URL)
    ? { ok: true, status: 200, json: async () => sign(cohort(), crypto.generateKeyPairSync("ed25519").privateKey) }
    : edge()(url);
  assert.equal(await fetchLatestVersion({ channel: "stable", trustStore, now: () => NOW, deviceId: () => member, fetchImpl: forged }), "0.1.641");
});

test("the cohort payload is closed: unknown fields, bad IDs and duplicates are refused", () => {
  assert.doesNotThrow(() => validateRuntimeCohort(cohort()));
  assert.throws(() => validateRuntimeCohort({ ...cohort(), everyone: true }), /unexpected fields/);
  assert.throws(() => validateRuntimeCohort(cohort({ deviceIds: ["short"] })), /device IDs/);
  assert.throws(() => validateRuntimeCohort(cohort({ deviceIds: ["dev_sven_mac_0001", "dev_sven_mac_0001"] })), /device IDs/);
  assert.throws(() => validateRuntimeCohort(cohort({ deviceIds: Array.from({ length: 51 }, (_, i) => `dev_device_${String(i).padStart(4, "0")}`) })), /device IDs/);
  assert.throws(() => validateRuntimeCohort(cohort({ sourceSha: "abc" })), /source commit/);
  assert.equal(cohortDecision(null, {}), "no-cohort");
  assert.equal(cohortDecision(cohort(), { deviceId: "dev_sven_mac_0001", now: NOW }), "member");
});

test("no cohort published yet is the normal state, not an error", async () => {
  assert.equal(await readRuntimeCohort({ trustStore, now: () => NOW, fetchImpl: async () => ({ ok: false, status: 404 }) }), null);
  await assert.rejects(readRuntimeCohort({ trustStore, now: () => NOW, fetchImpl: async () => ({ ok: false, status: 502 }) }), /502/);
});
