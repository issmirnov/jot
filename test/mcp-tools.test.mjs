import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "..", "cli", "jot.mjs");
const INSTANCE = process.env.JOT_INSTANCE ?? "smirnov";
const ENABLED = process.env.JOT_TEST_INTEGRATION === "1";

let client;
let createdId;

before(async () => {
  if (!ENABLED) return;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "mcp"],
    env: { ...process.env, JOT_INSTANCE: INSTANCE },
  });
  client = new Client({ name: "jot-mcp-test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
});

after(async () => {
  if (!ENABLED) return;
  if (createdId) {
    const { getInstance, request } = await import("../cli/lib.mjs");
    try {
      await request(getInstance(INSTANCE), "DELETE", `/api/notes/${encodeURIComponent(createdId)}`);
    } catch (e) {
      console.error("[test cleanup] failed to delete note", createdId, e.message);
    }
  }
  if (client) await client.close();
});

async function callOk(name, args = {}) {
  const out = await client.callTool({ name, arguments: args });
  assert.notEqual(out.isError, true, `tool ${name} failed: ${out.content?.[0]?.text}`);
  return JSON.parse(out.content[0].text);
}
async function callErr(name, args = {}) {
  const out = await client.callTool({ name, arguments: args });
  assert.equal(out.isError, true, `tool ${name} unexpectedly succeeded`);
  return out.content[0].text;
}

test("integration: tools/list returns the 7 v1 tools", { skip: !ENABLED }, async () => {
  const r = await client.listTools();
  const names = r.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "comment_on_note",
    "create_note",
    "edit_note",
    "list_notes",
    "read_note",
    "share_note",
    "update_note",
  ]);
});

test("integration: create_note → list_notes finds the new note", { skip: !ENABLED }, async () => {
  const created = await callOk("create_note", {
    title: `mcp test ${new Date().toISOString()}`,
    markdown: "# Hello\n\nThis is the **fixture** for stale-read tests.\n",
  });
  assert.match(created.id, /^[a-z0-9]+$/);
  createdId = created.id;

  const items = await callOk("list_notes");
  assert.ok(items.some((n) => n.id === createdId), "expected new note in list_notes");
});

test("integration: edit_note without prior read_note hard-errors", { skip: !ENABLED }, async () => {
  const msg = await callErr("edit_note", {
    id: createdId,
    edits: [{ oldText: "Hello", newText: "Hi" }],
  });
  assert.match(msg, /Must call read_note/);
});

test("integration: read_note then edit_note succeeds", { skip: !ENABLED }, async () => {
  await callOk("read_note", { id: createdId });
  const r = await callOk("edit_note", {
    id: createdId,
    edits: [{ oldText: "Hello", newText: "Hi" }],
  });
  assert.equal(r.editsApplied, 1);
});

test("integration: edit_note after stale read hard-errors", { skip: !ENABLED }, async () => {
  await callOk("read_note", { id: createdId });
  await callOk("update_note", { id: createdId, title: `mcp test rev ${Date.now()}` });
  const msg = await callErr("edit_note", {
    id: createdId,
    edits: [{ oldText: "Hi", newText: "Hey" }],
  });
  assert.match(msg, /Must call read_note|Stale read/);
});

test("integration: share_note returns a /s/<sid> URL for view access", { skip: !ENABLED }, async () => {
  const r = await callOk("share_note", { id: createdId, access: "view" });
  assert.equal(r.access, "view");
  assert.match(r.url, /\/s\/[a-z0-9]+$/);
});
