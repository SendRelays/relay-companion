import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  connectionFailureCode, connectionHealth, enableOutageDiagnostics, oldestRequestFor, requestAnswered,
  requestFailed, requestLabel, requestScope, requestStarted, resetConnectionHealth,
} from "../src/connection-health.js";
import { createDaemonComponents } from "../src/daemon-components.js";
import { startRecoveryHeartbeat } from "../src/recovery-health.js";
import { encodeCompanionFleetTelemetry } from "../src/fleet-telemetry.js";
import { createDaemonProgress } from "../bootstrap/daemon-progress.cjs";
import { collectInstallationHealth } from "../bootstrap/installation-health.cjs";

const flush = () => new Promise(resolve => setImmediate(resolve));
const withCause = (code, name = "TypeError") => Object.assign(new Error("fetch failed"), { name, cause: Object.assign(new Error(code), { code }) });

test("request labels keep the route shape and never an id or query", () => {
  assert.equal(requestLabel("get", "/v1/relays/relay_20261125_abc/task?x=secret"), "GET /v1/relays/:id/task");
  assert.equal(requestLabel("POST", "/v1/inbox"), "POST /v1/inbox");
  assert.equal(requestLabel("GET", "/v1/files/7f3a9c/download"), "GET /v1/files/:id/download");
});

test("a request that got no answer is one closed code", () => {
  assert.equal(connectionFailureCode(withCause("ENOTFOUND")), "dns-failed");
  assert.equal(connectionFailureCode(withCause("ECONNREFUSED")), "connection-refused");
  assert.equal(connectionFailureCode(withCause("UND_ERR_SOCKET")), "connection-reset");
  assert.equal(connectionFailureCode(withCause("UNABLE_TO_VERIFY_LEAF_SIGNATURE")), "tls-failed");
  assert.equal(connectionFailureCode(Object.assign(new Error("aborted"), { name: "TimeoutError" })), "timeout");
  assert.equal(connectionFailureCode(withCause("EHOSTUNREACH")), "connection-failed");
  assert.equal(connectionFailureCode(new Error("something else")), "connection-failed");
});

test("the summary counts outcomes, times answers and lists requests still waiting", t => {
  resetConnectionHealth(); t.after(resetConnectionHealth);
  const at = 1_000_000_000;
  requestAnswered(requestStarted("GET", "/v1/inbox", at), 200, at + 100);
  requestAnswered(requestStarted("GET", "/v1/inbox", at), 503, at + 6_000);
  requestFailed(requestStarted("GET", "/v1/inbox", at), withCause("ECONNRESET"), at + 7_000);
  requestScope.run({ component: "tasks" }, () => requestStarted("GET", "/v1/relays/r_1/task", at));
  const summary = connectionHealth(at + 20_000);
  assert.deepEqual(summary.window, { minutes: 15, ok: 1, serverError: 1, failed: 1, slow: 1, p50Ms: 6_000, p95Ms: 6_000 });
  assert.equal(summary.lastFailureCode, "connection-reset");
  assert.equal(summary.failingSince, new Date(at + 7_000).toISOString());
  assert.deepEqual(summary.waiting, [{ label: "GET /v1/relays/:id/task", component: "tasks", waitingMs: 20_000 }]);
  assert.deepEqual(oldestRequestFor("tasks", at + 20_000), { label: "GET /v1/relays/:id/task", waitingMs: 20_000 });
  assert.equal(oldestRequestFor("topics", at + 20_000), null);
  assert.equal(connectionHealth(at + 16 * 60_000).window.ok, 0, "samples leave the 15-minute window");
});

test("an outage is recorded once after a minute of failing, and its end when an answer returns", t => {
  resetConnectionHealth(); t.after(resetConnectionHealth);
  const recorded = [];
  enableOutageDiagnostics({ record: event => recorded.push(event) });
  const at = 2_000_000_000;
  for (const offset of [0, 30_000, 60_000, 90_000]) requestFailed(requestStarted("GET", "/v1/inbox", at + offset), withCause("ECONNREFUSED"), at + offset);
  assert.deepEqual(recorded, [{ component: "daemon", stage: "connection", outcome: "failed", code: "connection-refused", elapsedMs: 60_000 }]);
  requestAnswered(requestStarted("GET", "/v1/inbox", at + 120_000), 200, at + 120_500);
  assert.deepEqual(recorded[1], { component: "daemon", stage: "connection", outcome: "succeeded", code: null, elapsedMs: 120_500 });
  assert.equal(connectionHealth(at + 121_000).failingSince, null);
  requestFailed(requestStarted("GET", "/v1/inbox", at + 130_000), withCause("ECONNREFUSED"), at + 130_000);
  assert.equal(recorded.length, 2, "a short failure is not an outage");
});

test("a stalled part names the server request it is waiting on", async t => {
  resetConnectionHealth(); t.after(resetConnectionHealth);
  let clock = 1000;
  const health = createDaemonProgress({ packageRoot: "/test", version: "1.0.0", now: () => clock, persist() {} });
  const recorded = [];
  const runner = createDaemonComponents({ health, now: () => clock, stalledMs: 10, record: event => recorded.push(event) });
  let id;
  const pending = runner.run("agent-sessions", () => { id = requestStarted("GET", "/v1/agent-sessions/s_9"); return new Promise(() => {}); });
  await flush(); clock += 20; health.advance?.();
  runner.inspect();
  assert.equal(health.snapshot().componentErrors["agent-sessions"].waitingOn, "GET /v1/agent-sessions/:id");
  assert.equal(recorded[0].code, "component-stalled");
  requestAnswered(id, 200);
  void pending;
});

test("the heartbeat records event-loop stalls but not sleep, and the report carries them", t => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-loop-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  let clock = 10_000_000, slept = 0, tick;
  const blocked = [];
  startRecoveryHeartbeat({ homeDir, now: () => clock, slept: () => slept, recordBlocked: event => blocked.push(event),
    connection: () => ({ lastSuccessAt: null, failingSince: new Date(clock).toISOString(), lastFailureAt: null, lastFailureCode: "dns-failed",
      window: { minutes: 15, ok: 0, serverError: 0, failed: 3, slow: 0, p50Ms: null, p95Ms: null },
      waiting: [{ label: "GET /v1/inbox", component: "inbox-background", waitingMs: 40_000 }, { label: "not a route", component: null, waitingMs: 1 }] }),
    setIntervalImpl: fn => { tick = fn; return { unref() {} }; } });
  clock += 5_000; tick();
  clock += 12_000; tick();
  clock += 45_000; tick();
  clock += 60_000; slept += 59_000; tick();
  assert.deepEqual(blocked, [{ component: "daemon", stage: "event-loop", outcome: "failed", code: "event-loop-blocked", elapsedMs: 45_000 }]);
  const heartbeat = JSON.parse(fs.readFileSync(path.join(homeDir, ".relay", "recovery", "daemon.json"), "utf8"));
  assert.deepEqual({ max: heartbeat.loop.maxGapMs, count: heartbeat.loop.gapsOver10s }, { max: 45_000, count: 2 });
  const report = collectInstallationHealth({ homeDir, commands: [], now: clock });
  assert.equal(report.loop.gapsOver10s, 2);
  assert.equal(report.connection.lastFailureCode, "dns-failed");
  assert.equal(report.connection.asOf, new Date(clock).toISOString());
  assert.deepEqual(report.connection.waiting, [{ label: "GET /v1/inbox", component: "inbox-background", waitingMs: 40_000 }]);
});

test("an oversized header sheds the connection detail before the installation report", () => {
  const at = "2026-11-25T08:00:00.000Z";
  const installation = { padding: "x".repeat(2_300),
    connection: { asOf: at, waiting: Array.from({ length: 3 }, () => ({ label: "GET /v1/relays/:id/attachments/:id/download", component: "inbox-background", waitingMs: 1 })) },
    loop: { asOf: at, maxGapMs: 1, gapsOver10s: 1, lastGapAt: at },
    health: { state: "degraded", errors: [{ component: "tasks", stage: "tasks", code: "component-stalled", at, waitingOn: "GET /v1/inbox" }] } };
  let truncated = 0;
  const decode = header => JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
  const small = decode(encodeCompanionFleetTelemetry({ schema: 1, installation }, { onTruncated: () => truncated++ }));
  assert.equal(small.installation.padding.length, 2_300);
  assert.equal(truncated, 0);
  const big = decode(encodeCompanionFleetTelemetry({ schema: 1, installation: { ...installation, padding: "x".repeat(2_700) } }, { onTruncated: () => truncated++ }));
  assert.ok(big.installation, "the installation report survives");
  assert.ok(!big.installation.connection?.waiting?.length);
  assert.equal(big.installation.health.errors[0].waitingOn, undefined);
  assert.equal(truncated, 0);
});
