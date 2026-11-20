// A named-device runtime cohort: a newer stable runtime offered to a short list
// of Relay devices before everyone gets it.
//
// The stable pointer (companion-releases/stable-v3/manifest.json) is what every
// stable Companion follows, and Companions before this one read only its
// product and version, ignoring anything else in it. So a cohort cannot be a
// field on that pointer: every older Companion would take the new version at
// once. It is a separate signed object, read only by Companions that know
// about it. A device takes the cohort's version only when its own device ID is
// listed, the offer has not expired, and the version is newer than the general
// one. Anything else (no cohort, a bad signature, an expired or paused offer,
// a network error) leaves the device on the general stable version.
//
// Widening to everyone is the ordinary production promotion, which moves the
// general pointer. scripts/publish-runtime-cohort.mjs is the only writer.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { verifyReleaseEnvelope } = require("../bootstrap/release-signature.cjs");
const releaseTrust = require("./release-trust.json");

export const RUNTIME_COHORT_URL = "https://api.sendrelays.com/v1/companion-releases/stable-v3-cohort/manifest.json";
export const RUNTIME_COHORT_KEY = "companion-releases/stable-v3-cohort/manifest.json";
export const MAX_COHORT_DEVICES = 50;
export const MAX_EXPIRY_DAYS = 31;
const DAY = 86400_000;
const VERSION = /^\d+\.\d+\.\d+$/;
const DEVICE_ID = /^[A-Za-z0-9_-]{8,160}$/;

/** The payload a cohort offer must have; throws on anything else. */
export function validateRuntimeCohort(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("runtime cohort must be an object");
  const keys = Object.keys(payload).sort().join(",");
  if (keys !== "deviceIds,expiresAt,kind,product,schema,sourceSha,version") throw new Error("runtime cohort has unexpected fields");
  if (payload.schema !== 1 || payload.product !== "Relay" || payload.kind !== "runtime-cohort") throw new Error("not a Relay runtime cohort");
  if (!VERSION.test(payload.version || "")) throw new Error("runtime cohort version must be x.y.z");
  if (!/^[0-9a-f]{40}$/.test(payload.sourceSha || "")) throw new Error("runtime cohort needs the exact public source commit");
  if (!Array.isArray(payload.deviceIds) || payload.deviceIds.length > MAX_COHORT_DEVICES
    || new Set(payload.deviceIds).size !== payload.deviceIds.length || !payload.deviceIds.every(id => typeof id === "string" && DEVICE_ID.test(id))) {
    throw new Error(`runtime cohort names 0 to ${MAX_COHORT_DEVICES} distinct Relay device IDs`);
  }
  if (!Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= 0) throw new Error("runtime cohort needs an expiry");
  return payload;
}

/**
 * What this device should do with a verified cohort offer: "member" means it
 * may take payload.version. An offer expiring further ahead than a publisher
 * may set is treated as expired, so a mistaken one cannot pin devices forever.
 */
export function cohortDecision(payload, { deviceId, now = Date.now() } = {}) {
  if (!payload) return "no-cohort";
  if (payload.expiresAt <= now || payload.expiresAt > now + MAX_EXPIRY_DAYS * DAY) return "expired";
  if (!payload.deviceIds.length) return "paused";
  return deviceId && payload.deviceIds.includes(deviceId) ? "member" : "not-member";
}

/** Read and verify the live cohort offer; null when there is none. */
export async function readRuntimeCohort({ fetchImpl = globalThis.fetch, trustStore = releaseTrust, url = RUNTIME_COHORT_URL,
  now = () => Date.now(), timeoutMs = 10_000 } = {}) {
  const response = await fetchImpl(`${url}?relay_update=${encodeURIComponent(now())}`, {
    cache: "no-store",
    headers: { Accept: "application/json", "Cache-Control": "no-cache, no-store, max-age=0", Pragma: "no-cache" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  // Until the first cohort is published (and until the edge serves the path)
  // there is nothing to read: that is the normal state, not an error.
  if (response?.status === 404 || response?.status === 403) return null;
  if (!response?.ok) throw new Error(`runtime cohort returned ${response?.status}`);
  const envelope = await response.json();
  return { envelope, payload: validateRuntimeCohort(JSON.parse(verifyReleaseEnvelope(envelope, trustStore).toString("utf8"))) };
}
