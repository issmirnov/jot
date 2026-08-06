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

// --- unit: static tool-schema invariants (no live jot instance needed) ---

test("every tool input-schema property declares a JSON-Schema type", async () => {
  const { buildTools } = await import("../cli/jot-mcp.mjs");
  // Handlers are never invoked here, so stub deps are sufficient to build the
  // schema table.
  const tools = buildTools({
    instanceAccessor: () => ({ baseUrl: "http://example.test" }),
    stale: { record() {}, forget() {}, require() {} },
    mu: { withNote: (_id, fn) => fn() },
    scope: undefined,
  });
  const offenders = [];
  for (const [name, t] of Object.entries(tools)) {
    for (const [prop, schema] of Object.entries(t.inputSchema?.properties ?? {})) {
      if (typeof schema.type !== "string") offenders.push(`${name}.${prop}`);
    }
  }
  // A property with `enum` but no `type` is valid JSON Schema but is rejected or
  // degraded by strict tool-schema validators (e.g. Gemini function-calling,
  // some MCP client SDKs). Every param must carry an explicit type.
  assert.deepEqual(
    offenders,
    [],
    `tool params missing a JSON-Schema "type": ${offenders.join(", ")}`
  );
});

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

// --- v2: edit_note formatting-hint regression ---

test("integration: edit_note returns formatting-character hint when oldText not found", { skip: !ENABLED }, async () => {
  // The fixture body so far: started as "# Hello\n\nThis is the **fixture** for stale-read tests.\n",
  // then "Hello" -> "Hi" was applied. Current body contains "**fixture**" with literal asterisks.
  // Asking edit_note to match "fixture" without the asterisks should fail and return our hint.
  await callOk("read_note", { id: createdId });
  const out = await client.callTool({
    name: "edit_note",
    arguments: {
      id: createdId,
      edits: [
        {
          oldText: "This is the fixture for stale-read tests.",
          newText: "Replaced.",
        },
      ],
    },
  });
  assert.equal(out.isError, true, "expected edit_note to error on stripped formatting");
  const msg = out.content[0].text;
  assert.match(msg, /oldText not found/i);
  assert.match(msg, /Hint:/);
  assert.match(msg, /formatting characters|backticks|asterisks/i);
});

// --- v2: resources ---

test("integration: resources/list returns the fixture", { skip: !ENABLED }, async () => {
  const r = await client.listResources();
  assert.ok(Array.isArray(r.resources));
  const fixture = r.resources.find((res) => res.uri === `jot://notes/${createdId}`);
  assert.ok(fixture, "expected fixture note in resource list");
  assert.equal(fixture.mimeType, "text/markdown");
  assert.match(fixture.description, /^Updated /);
});

test("integration: resources/read returns the markdown body", { skip: !ENABLED }, async () => {
  const r = await client.readResource({ uri: `jot://notes/${createdId}` });
  assert.equal(r.contents.length, 1);
  assert.equal(r.contents[0].uri, `jot://notes/${createdId}`);
  assert.equal(r.contents[0].mimeType, "text/markdown");
  // Body should reference the fixture's content
  assert.match(r.contents[0].text, /Hi|fixture|stale/);
});

test("integration: resources/read updates the stale tracker (option B)", { skip: !ENABLED }, async () => {
  // Mutate via update_note (forces stale.forget), then attach via resource.
  // After the resource read, edit_note should succeed without an explicit
  // read_note call — proving the tracker hooked the resource path.
  await callOk("update_note", { id: createdId, title: `mcp test stale-via-resource ${Date.now()}` });
  await client.readResource({ uri: `jot://notes/${createdId}` });
  const r = await callOk("edit_note", {
    id: createdId,
    edits: [{ oldText: "fixture", newText: "fixture" }],
  });
  assert.equal(r.editsApplied, 1);
});

test("integration: resources/read on unsupported URI returns InvalidParams", { skip: !ENABLED }, async () => {
  await assert.rejects(
    () => client.readResource({ uri: "jot://nope/xyz" }),
    (e) => /Unsupported resource URI/.test(e.message) && /-32602/.test(e.message)
  );
});

// --- v2: prompts ---

test("integration: prompts/list returns the 3 v2 prompts", { skip: !ENABLED }, async () => {
  const r = await client.listPrompts();
  const names = r.prompts.map((p) => p.name).sort();
  assert.deepEqual(names, ["extract-action-items", "review-note", "summarize-note"]);
});

test("integration: prompts/get resolves summarize-note with the id substituted", { skip: !ENABLED }, async () => {
  const r = await client.getPrompt({ name: "summarize-note", arguments: { id: createdId } });
  assert.equal(r.messages.length, 1);
  assert.match(r.messages[0].content.text, new RegExp(`jot://notes/${createdId}`));
  assert.match(r.messages[0].content.text, /TL;DR/);
});

test("integration: prompts/get rejects empty id with InvalidParams", { skip: !ENABLED }, async () => {
  await assert.rejects(
    () => client.getPrompt({ name: "summarize-note", arguments: { id: "" } }),
    (e) => /must not be empty/i.test(e.message) && /-32602/.test(e.message)
  );
});
