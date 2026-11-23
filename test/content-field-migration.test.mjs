import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CONTENT_FIELD_SCHEMA_VERSION,
  migrateContentValue,
  migratePersistedContentFields,
} from "../src/content-field-migration.js";

const OLD_HUMAN = "body" + "Markdown";
const OLD_AGENT = "user" + "Instructions";

test("migrateContentValue destructively renames nested content lanes", () => {
  const value = {
    schemaVersion: 2,
    [OLD_HUMAN]: "human copy",
    [OLD_AGENT]: "agent copy",
    nested: [{ [OLD_HUMAN]: "nested human", forHuman: "new value wins" }],
  };

  assert.equal(migrateContentValue(value), true);
  assert.equal(value.schemaVersion, CONTENT_FIELD_SCHEMA_VERSION);
  assert.deepEqual(value, {
    schemaVersion: CONTENT_FIELD_SCHEMA_VERSION,
    forHuman: "human copy",
    forAgent: "agent copy",
    nested: [{ forHuman: "new value wins" }],
  });
  assert.equal(JSON.stringify(value).includes(OLD_HUMAN), false);
  assert.equal(JSON.stringify(value).includes(OLD_AGENT), false);
});

test("startup migration atomically upgrades state and every durable packet once", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-content-fields-"));
  const packetsDir = path.join(homeDir, "packets");
  fs.mkdirSync(packetsDir, { recursive: true });
  const referencedPath = path.join(packetsDir, "referenced.json");
  const orphanPath = path.join(packetsDir, "orphan.json");
  fs.writeFileSync(referencedPath, JSON.stringify({ schemaVersion: 2, [OLD_HUMAN]: "hello", [OLD_AGENT]: "details" }));
  fs.writeFileSync(orphanPath, JSON.stringify({ schemaVersion: 2, [OLD_HUMAN]: "history" }));
  const statePath = path.join(homeDir, "state.json");
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      version: 1,
      packets: {
        relay_1: { contentPath: referencedPath, packet: { [OLD_HUMAN]: "inline", [OLD_AGENT]: "inline detail" } },
      },
    }),
  );

  const first = migratePersistedContentFields({ homeDir, statePath });
  assert.equal(first.status, "migrated");
  assert.equal(first.migratedFiles, 3);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const referenced = JSON.parse(fs.readFileSync(referencedPath, "utf8"));
  const orphan = JSON.parse(fs.readFileSync(orphanPath, "utf8"));
  assert.equal(state.contentFieldSchemaVersion, CONTENT_FIELD_SCHEMA_VERSION);
  assert.deepEqual(state.packets.relay_1.packet, { forHuman: "inline", forAgent: "inline detail" });
  assert.deepEqual(referenced, { schemaVersion: CONTENT_FIELD_SCHEMA_VERSION, forHuman: "hello", forAgent: "details" });
  assert.deepEqual(orphan, { schemaVersion: CONTENT_FIELD_SCHEMA_VERSION, forHuman: "history" });
  for (const value of [state, referenced, orphan]) {
    assert.equal(JSON.stringify(value).includes(OLD_HUMAN), false);
    assert.equal(JSON.stringify(value).includes(OLD_AGENT), false);
  }

  assert.deepEqual(migratePersistedContentFields({ homeDir, statePath }), { status: "current", migratedFiles: 0 });
});

test("startup migration skips an unreadable packet file and never writes a newer marker down", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-content-fields-"));
  const packetsDir = path.join(homeDir, "packets");
  fs.mkdirSync(packetsDir, { recursive: true });
  const brokenPath = path.join(packetsDir, "broken.json");
  const goodPath = path.join(packetsDir, "good.json");
  fs.writeFileSync(brokenPath, "{ half a packet");
  fs.writeFileSync(goodPath, JSON.stringify({ [OLD_HUMAN]: "hello" }));
  const statePath = path.join(homeDir, "state.json");
  fs.writeFileSync(statePath, JSON.stringify({ version: 1, packets: {} }));

  const result = migratePersistedContentFields({ homeDir, statePath, log: () => {} });
  assert.equal(result.status, "migrated");
  assert.equal(result.skippedFiles, 1);
  assert.equal(fs.readFileSync(brokenPath, "utf8"), "{ half a packet", "the unreadable file is left exactly as it was");
  assert.deepEqual(JSON.parse(fs.readFileSync(goodPath, "utf8")), { forHuman: "hello" });

  // A newer Companion's marker is "current" here and is not rewritten down.
  fs.writeFileSync(statePath, JSON.stringify({ contentFieldSchemaVersion: CONTENT_FIELD_SCHEMA_VERSION + 1 }));
  assert.deepEqual(migratePersistedContentFields({ homeDir, statePath, log: () => {} }), { status: "current", migratedFiles: 0 });
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).contentFieldSchemaVersion, CONTENT_FIELD_SCHEMA_VERSION + 1);

  // An unreadable state file skips the sweep instead of crashing the daemon.
  fs.writeFileSync(statePath, "not json");
  assert.equal(migratePersistedContentFields({ homeDir, statePath, log: () => {} }).status, "skipped");
  assert.equal(fs.readFileSync(statePath, "utf8"), "not json");
});
