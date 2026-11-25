import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runReceiverLoop } from "../src/task-daemon.js";
import { createDaemonComponents } from "../src/daemon-components.js";
import { lastWokeAt, startRecoveryHeartbeat, wokeSince } from "../src/recovery-health.js";
import { processInboxAttachments, queueInboxAttachments, readInboxJson } from "../src/inbox-work.js";
import { createDaemonProgress } from "../bootstrap/daemon-progress.cjs";

const flush = () => new Promise(resolve => setImmediate(resolve));
const MIN = 60_000;
function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-wake-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("right after a wake the slow parts wait a minute while delivery carries on", async () => {
  const client = { token: "test", url: "https://example.invalid", accountDrift: () => ({ status: "same" }) };
  const health = createDaemonProgress({ packageRoot: "/test", version: "1.0.0", persist() {} });
  const ran = { deliveries: 0, sessions: 0, topics: 0, attachments: 0, wakes: 0 };
  let cycles = 0, wokeAt = Date.now() - 10_000;
  await runReceiverLoop({ client, me: { user: { id: "test" } }, health, wokeAt: () => wokeAt,
    getFeatures: () => ({ requests: true, topics: true }), followAccount: async () => null, makeClient: () => client,
    sessionTick: async () => { ran.sessions++; }, topicsPoll: async () => { ran.topics++; },
    attachments: async () => { ran.attachments++; }, completionWakes: async () => { ran.wakes++; },
    deliveryTick: async () => { ran.deliveries++; return { ordinaryOnly: true, ordinaryRelays: [], inboxOk: true }; },
    stop: () => cycles === 3,
    sleep: async () => { cycles++; if (cycles === 2) wokeAt = Date.now() - 2 * MIN; await flush(); },
  });
  assert.equal(ran.deliveries, 3);
  assert.equal(ran.wakes, 3);
  // Held for the first two cycles, run once the wake had settled.
  assert.deepEqual([ran.sessions, ran.topics, ran.attachments], [1, 1, 1]);
});

test("a part the machine slept through starts its stall clock again at the wake, and its failure is not recorded", async () => {
  let clock = 1_000;
  const health = createDaemonProgress({ packageRoot: "/test", version: "1.0.0", now: () => clock, persist() {} });
  const recorded = [];
  let wokeAt = 0, fail;
  const runner = createDaemonComponents({ health, now: () => clock, stalledMs: 60_000, wokeAt: () => wokeAt, record: event => recorded.push(event) });
  const pending = runner.run("agent-sessions", () => new Promise((_resolve, reject) => { fail = reject; }));
  await flush();
  // Asleep for 16 minutes, then 5 s into a dark wake: not stalled.
  clock += 16 * MIN; wokeAt = clock - 5_000;
  runner.inspect();
  assert.notEqual(health.snapshot().components["agent-sessions"], "stalled");
  // The sleep cut the request off: logged, not recorded.
  fail(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }));
  await pending;
  assert.deepEqual(recorded, []);
  // A part that hangs a minute on an awake machine is still reported.
  const hung = runner.run("topics", () => new Promise(() => {}));
  void hung; await flush();
  clock += 61_000;
  runner.inspect();
  assert.equal(health.snapshot().components.topics, "stalled");
  assert.equal(recorded[0].code, "component-stalled");
});

test("an attachment attempt the machine slept through is retried without counting", async t => {
  const dir = home(t); const file = path.join(dir, "work.json"); const statePath = path.join(dir, "state.json");
  const a = { id: "a", attachments: [{ id: "file-a" }] };
  fs.writeFileSync(statePath, JSON.stringify({ packets: { a } }));
  queueInboxAttachments({ item: { relayId: "a" }, packet: a }, { scope: "account", file });
  await processInboxAttachments({ scope: "account", file, statePath, now: () => 1_000, interrupted: () => true, materialize: async row => ({ ...row }) });
  assert.deepEqual(readInboxJson(file).jobs.a, { attempts: 0, nextAttemptAt: 61_000 });
  await processInboxAttachments({ scope: "account", file, statePath, now: () => 62_000, interrupted: () => false, materialize: async row => ({ ...row }) });
  assert.equal(readInboxJson(file).jobs.a.attempts, 1);
});

test("the heartbeat tells a wake from a start, and a frozen loop from an undetectable sleep", t => {
  const homeDir = home(t);
  let clock = 50_000_000, cpu = 0, tick;
  const blocked = [];
  startRecoveryHeartbeat({ homeDir, now: () => clock, slept: () => null, cpuMs: () => cpu, recordBlocked: event => blocked.push(event),
    setIntervalImpl: fn => { tick = fn; return { unref() {} }; } });
  assert.equal(lastWokeAt(clock), 0, "starting is not waking");
  clock += 5_000; tick();
  // Windows sleep: a 20-minute gap with no CPU used. Not a blocked loop, but a wake.
  clock += 20 * MIN;
  assert.equal(lastWokeAt(clock), clock, "an overdue heartbeat ticks before answering");
  assert.equal(wokeSince(clock - 1, clock), true);
  assert.deepEqual(blocked, []);
  // A loop stuck in work for 40 s: it burned the CPU.
  clock += 5_000; tick();
  clock += 40_000; cpu += 38_000; tick();
  assert.deepEqual(blocked.map(event => [event.code, event.elapsedMs]), [["event-loop-blocked", 40_000]]);
});
