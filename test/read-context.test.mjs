import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { BrokerStdioTransport } from "../src/mcp-broker-transport.js";
import { RelayClient, closeRelayConnections } from "../src/client.js";
import { withReadContext } from "../src/read-context.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-read-test-"));
const previous = process.env.RELAY_CONFIG;
const previousConfigDir = process.env.RELAY_CONFIG_DIR;
const previousStore = process.env.RELAY_HOME;
process.env.RELAY_CONFIG = path.join(dir, "config.json");
process.env.RELAY_CONFIG_DIR = dir;
process.env.RELAY_HOME = dir;
after(() => {
  if (previous === undefined) delete process.env.RELAY_CONFIG;
  else process.env.RELAY_CONFIG = previous;
  if (previousConfigDir === undefined) delete process.env.RELAY_CONFIG_DIR;
  else process.env.RELAY_CONFIG_DIR = previousConfigDir;
  if (previousStore === undefined) delete process.env.RELAY_HOME;
  else process.env.RELAY_HOME = previousStore;
  fs.rmSync(dir, { recursive: true, force: true });
});

async function serverFor(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await closeRelayConnections(); await new Promise((resolve) => server.close(resolve)); });
  return new RelayClient({ url: `http://127.0.0.1:${server.address().port}`, token: "test-private-token" });
}

// The read's wall clock and its timeout timers belong to the test, so a loaded
// machine cannot decide whether a socket failure or the budget's expiry is
// seen first. Each AbortSignal.timeout(ms) is recorded and fires only on expire().
function controlledClock(t) {
  let now = Date.now();
  const timers = [];
  t.mock.method(Date, "now", () => now);
  t.mock.method(AbortSignal, "timeout", (ms) => {
    const controller = new AbortController();
    timers.push({ ms, controller });
    return controller.signal;
  });
  return {
    timers,
    advance(ms) { now += ms; },
    expire(timer) { timer.controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")); },
  };
}

test("a retry uses the original budget and returns an actionable timeout", async (t) => {
  let attempts = 0;
  const records = [];
  let clock;
  const client = await serverFor(t, (req, res) => {
    if (req.url === "/v1/me") { res.end("{}"); return; }
    attempts++;
    // 150 ms of the 220 ms budget pass before the first connection breaks.
    if (attempts === 1) { clock.advance(150); req.socket.destroy(); return; }
    // The retry is held unanswered until its budget, not a fresh 15 s, runs out.
    clock.expire(clock.timers[0]);
  });
  await client.me(); // Load the transport before taking control of the clock.
  clock = controlledClock(t);
  await assert.rejects(withReadContext("relay_chat_fetch", () => client.chat("chat_test", { limit: 25 }), { budgetMs: 220, record: (r) => records.push(r) }), { code: "relay_timeout", retryable: true });
  assert.equal(attempts, 2);
  assert.deepEqual(clock.timers.map((timer) => timer.ms), [220, 220, 70], "the retry gets the 70 ms left of the budget, never a restarted 15-second timeout");
  assert.equal(records.find((r) => r.phase === "tool").outcome, "timeout");
  assert.equal(new Set(records.map((r) => r.requestId)).size, 1);
});

test("a connection failure seen after the budget ran out is still an actionable timeout", async (t) => {
  // On a starved machine the reset socket can be read after the deadline has
  // passed but before the budget's timer has fired. No retry fits; the caller
  // must still learn that the read timed out, not a bare "fetch failed".
  let attempts = 0;
  const records = [];
  let clock;
  const client = await serverFor(t, (req, res) => {
    if (req.url === "/v1/me") { res.end("{}"); return; }
    attempts++;
    clock.advance(250);
    req.socket.destroy();
  });
  await client.me();
  clock = controlledClock(t);
  await assert.rejects(withReadContext("relay_chat_fetch", () => client.chat("chat_test", { limit: 25 }), { budgetMs: 220, record: (r) => records.push(r) }), { code: "relay_timeout", retryable: true });
  assert.equal(attempts, 1, "no retry starts once the budget is spent");
  assert.equal(clock.timers[0].controller.signal.aborted, false, "the budget timer had not fired");
  assert.equal(records.find((r) => r.phase === "tool").outcome, "timeout");
});

test("caller cancellation aborts the request without retrying", async (t) => {
  let attempts = 0;
  const controller = new AbortController();
  const client = await serverFor(t, () => { attempts++; controller.abort(); });
  await assert.rejects(withReadContext("relay_chat_fetch", () => client.chat("chat_test"), { signal: controller.signal, record() {} }), { code: "relay_cancelled", retryable: false });
  assert.equal(attempts, 1);
});

test("an interrupted response body is not automatically downloaded again", async (t) => {
  let attempts = 0;
  const client = await serverFor(t, (_req, res) => {
    attempts++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"items":[');
    setTimeout(() => res.destroy(), 40);
  });
  await assert.rejects(withReadContext("relay_chat_fetch", () => client.chat("chat_test"), { record() {} }));
  assert.equal(attempts, 1);
});

test("large documents are intact, paging parameters arrive, and diagnostics contain no content", async (t) => {
  const records = [];
  const item = { relayId: "relay_private", forHuman: "private-human-text", forAgent: "private-agent-text".repeat(30000) };
  const client = await serverFor(t, (req, res) => {
    assert.match(req.url, /limit=25/);
    assert.match(req.url, /beforeCursor=opaque/);
    assert.match(req.headers["x-relay-request-id"], /^[a-f0-9-]{36}$/);
    res.end(JSON.stringify({ items: [item], nextBeforeCursor: "next" }));
  });
  const result = await withReadContext("relay_chat_fetch", () => client.chat("chat_private", { limit: 25, beforeCursor: "opaque" }), { record: (r) => records.push(r) });
  assert.deepEqual(result.items, [item]);
  assert.equal(result.nextBeforeCursor, "next");
  assert.ok(records.some((r) => r.responseBytes > 500000));
  assert.doesNotMatch(JSON.stringify(records), /private|opaque|forAgent|Bearer/);
});

test("MCP broker framing carries a large page and forwards host cancellation to HTTP", async (t) => {
  const { createRelayMcpSession } = await import("../src/mcp.js");
  let started;
  const requestStarted = new Promise((resolve) => { started = resolve; });
  let disconnected = false;
  const bigDoc = "Experiment details. ".repeat(30000);
  const relay = await serverFor(t, (req, res) => {
    if (req.url === "/v1/me") { res.end(JSON.stringify({ user: { id: "usr_test" } })); return; }
    if (req.url.includes("chat_slow")) {
      req.on("close", () => { disconnected = true; });
      started();
      return;
    }
    res.end(JSON.stringify({ items: [{ relayId: "relay_test", forAgent: bigDoc }], nextBeforeCursor: "opaque" }));
  });
  relay.accountDrift = () => ({ status: "same" });
  const requests = new PassThrough(), responses = new PassThrough();
  const session = await createRelayMcpSession({ transport: new BrokerStdioTransport(requests, responses), clientFactory: () => relay, sessionDigestEnabled: false });
  const host = new Client({ name: "codex-mcp-client", version: "test" }, { capabilities: {} });
  await host.connect(new BrokerStdioTransport(responses, requests));
  t.after(async () => { await host.close(); await session.close(); });
  const result = await host.callTool({ name: "relay_chat_fetch", arguments: { chatId: "chat_large" } });
  assert.equal(JSON.parse(result.content[0].text).items[0].forAgent, bigDoc);
  assert.equal(JSON.parse(result.content[0].text).nextBeforeCursor, "opaque");
  const cancel = new AbortController();
  const slow = host.callTool({ name: "relay_chat_fetch", arguments: { chatId: "chat_slow" } }, undefined, { signal: cancel.signal });
  const rejected = assert.rejects(slow);
  await requestStarted;
  cancel.abort();
  await rejected;
  for (let i = 0; i < 50 && !disconnected; i++) await delay(10);
  assert.equal(disconnected, true, "host cancellation must reach the outstanding HTTP request");
  assert.equal((await host.callTool({ name: "relay_chat_fetch", arguments: { chatId: "chat_large" } })).isError, undefined, "the next read still works");
});
