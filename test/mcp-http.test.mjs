import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getInstance } from "../cli/lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "..", "cli", "jot.mjs");
const INSTANCE = process.env.JOT_INSTANCE ?? "smirnov";
const ENABLED = process.env.JOT_TEST_INTEGRATION === "1";

let serverProc;
let port;
let baseUrl;
let token;

function pickPort() {
  return 30000 + Math.floor(Math.random() * 30000);
}

function waitForReady(p) {
  const stderrChunks = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`server didn't print listening line within 10s; stderr:\n${stderrChunks.join("")}`));
    }, 10000);
    const onData = (buf) => {
      const s = buf.toString();
      stderrChunks.push(s);
      if (s.includes("listening on")) {
        clearTimeout(timer);
        p.stderr.off("data", onData);
        p.off("exit", onExit);
        resolve();
      }
    };
    const onExit = (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with code ${code} before ready; stderr:\n${stderrChunks.join("")}`));
    };
    p.stderr.on("data", onData);
    p.once("exit", onExit);
  });
}

before(async () => {
  if (!ENABLED) return;
  const inst = getInstance(INSTANCE);
  baseUrl = inst.baseUrl;
  token = inst.token;
  port = pickPort();
  serverProc = spawn(process.execPath, [CLI, "mcp", "--http", `--port=${port}`], {
    env: { ...process.env, JOT_INSTANCE_BASE_URL: baseUrl },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForReady(serverProc);
});

after(async () => {
  if (serverProc && !serverProc.killed) {
    serverProc.kill("SIGTERM");
    await new Promise((r) => serverProc.once("exit", r));
  }
});

async function makeClient(bearerToken = token) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${bearerToken}` } },
  });
  const client = new Client({ name: "http-test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

test("HTTP integration: /health returns ok", { skip: !ENABLED }, async () => {
  const r = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.transport, "streamable-http");
});

test("HTTP integration: /ready connectivity-checks jot", { skip: !ENABLED }, async () => {
  const r = await fetch(`http://127.0.0.1:${port}/ready`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.jotReachable, true);
});

test("HTTP integration: GET /mcp returns 405 (no bearer needed)", { skip: !ENABLED }, async () => {
  const r = await fetch(`http://127.0.0.1:${port}/mcp`);
  assert.equal(r.status, 405);
  const body = await r.json();
  assert.match(body.error.message, /GET not supported/i);
});

test("HTTP integration: POST /mcp without bearer returns 401", { skip: !ENABLED }, async () => {
  const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(r.status, 401);
});

test("HTTP integration: tools/list returns 7 tools via SDK Client", { skip: !ENABLED }, async () => {
  const client = await makeClient();
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
  await client.close();
});

test("HTTP integration: list_notes round-trips with valid bearer", { skip: !ENABLED }, async () => {
  const client = await makeClient();
  const out = await client.callTool({ name: "list_notes", arguments: {} });
  assert.notEqual(out.isError, true, `list_notes failed: ${out.content?.[0]?.text}`);
  const items = JSON.parse(out.content[0].text);
  assert.ok(items.some((n) => n.id === "slvisfqn"), "expected slvisfqn fixture");
  await client.close();
});

test("HTTP integration: bad bearer surfaces 401 from jot via tool error", { skip: !ENABLED }, async () => {
  const client = await makeClient("definitely-not-a-real-token-1234567890");
  const out = await client.callTool({ name: "list_notes", arguments: {} });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /401|Unauthorized/i);
  await client.close();
});

test("HTTP integration: resources/list and prompts/list work", { skip: !ENABLED }, async () => {
  const client = await makeClient();
  const rs = await client.listResources();
  assert.ok(Array.isArray(rs.resources));
  const ps = await client.listPrompts();
  const names = ps.prompts.map((p) => p.name).sort();
  assert.deepEqual(names, ["extract-action-items", "review-note", "summarize-note"]);
  await client.close();
});

test("HTTP integration: TWO concurrent clients can call tools/list (singleton-Server regression)", { skip: !ENABLED }, async () => {
  // If we accidentally regressed to a singleton Server, the second client's
  // connect would fail with "Already connected" per SDK 1.29's Protocol.
  const [c1, c2] = await Promise.all([makeClient(), makeClient()]);
  const [r1, r2] = await Promise.all([c1.listTools(), c2.listTools()]);
  assert.equal(r1.tools.length, 7);
  assert.equal(r2.tools.length, 7);
  await Promise.all([c1.close(), c2.close()]);
});
