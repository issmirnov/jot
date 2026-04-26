// IMPORTANT: stdout is reserved for JSON-RPC. Never use console.log here.
// All diagnostic output must go through `log()` (-> stderr).
import { AsyncLocalStorage } from "node:async_hooks";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import { getInstance, request, isShareInstance } from "./lib.mjs";
import { makeStaleTracker } from "./stale-tracker.mjs";
import { makeNoteMutex } from "./note-mutex.mjs";
import { makeResourceHandlers } from "./mcp-resources.mjs";
import { listPrompts, getPrompt } from "./mcp-prompts.mjs";

const log = (...a) => console.error("[jot-mcp]", ...a);

/**
 * HTTP mode populates this per request with { instance, tokenHash } so
 * tool handlers see the right per-request instance and the stale tracker
 * scopes correctly. stdio mode never populates it; the runMcp() entry
 * passes its own instanceAccessor to the factory directly.
 */
export const requestCtx = new AsyncLocalStorage();

const INSTANCE_NAME = process.env.JOT_INSTANCE;

function ensureStdioInstanceConfigured() {
  if (!INSTANCE_NAME) {
    log("JOT_INSTANCE env var is required for stdio mode (e.g. JOT_INSTANCE=smirnov).");
    log("For HTTP mode, set JOT_INSTANCE_BASE_URL instead and pass --http.");
    log("Register a stdio instance first with: jot register <name> <baseUrl> <token>");
    process.exit(1);
  }
  const probe = getInstance(INSTANCE_NAME);
  if (isShareInstance(probe)) {
    log(`Instance "${INSTANCE_NAME}" is a share-link instance.`);
    log("MCP only exposes owner endpoints; register an API-key instance.");
    process.exit(1);
  }
}

/**
 * Build the tools registry. Each handler closes over `instanceAccessor`
 * (called per-handler-invocation, returns the active jot instance) and
 * `scope` (passed as 3rd arg to stale.* calls so HTTP mode isolates
 * trackers per token).
 */
function buildTools({ instanceAccessor, stale, mu, scope }) {
  const baseUrl = () => instanceAccessor().baseUrl.replace(/\/$/, "");
  return {
    list_notes: {
      description:
        "List all notes owned by this jot instance. Returns id, title, updatedAt, shareId, snippet.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => {
        const payload = await request(instanceAccessor(), "GET", "/api/notes");
        return payload.notes.map((n) => ({
          id: n.id,
          title: n.title,
          updatedAt: n.updatedAt,
          shareId: n.shareId,
          snippet: n.snippet,
        }));
      },
    },

    read_note: {
      description:
        "Read a note's full markdown body and comment threads. Records the note's version so it can be safely edited with edit_note.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "Note id" } },
        required: ["id"],
        additionalProperties: false,
      },
      handler: async ({ id }) => {
        const payload = await request(instanceAccessor(), "GET", `/api/notes/${encodeURIComponent(id)}`);
        stale.record(id, payload.note.updatedAt, scope);
        return {
          id: payload.note.id,
          title: payload.note.title,
          updatedAt: payload.note.updatedAt,
          shareAccess: payload.note.shareAccess,
          shareId: payload.note.shareId,
          markdown: payload.note.markdown,
          threads: payload.threads ?? [],
        };
      },
    },

    create_note: {
      description:
        "Create a new note with title and markdown content in a single call. Returns the new note id and owner URL.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Note title" },
          markdown: { type: "string", description: "Full markdown body" },
        },
        required: ["title", "markdown"],
        additionalProperties: false,
      },
      handler: async ({ title, markdown }) => {
        const created = await request(instanceAccessor(), "POST", "/api/notes");
        await request(instanceAccessor(), "PUT", `/api/notes/${encodeURIComponent(created.note.id)}`, {
          title,
          markdown,
        });
        return {
          id: created.note.id,
          title,
          ownerUrl: `${baseUrl()}/notes/${created.note.id}`,
        };
      },
    },

    update_note: {
      description:
        "Update title, markdown, and/or shareAccess on a note. Only fields you pass are changed. Returns the updated note's metadata.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          markdown: { type: "string" },
          shareAccess: { enum: ["none", "view", "comment", "edit"] },
        },
        required: ["id"],
        additionalProperties: false,
      },
      handler: async ({ id, title, markdown, shareAccess }) =>
        mu.withNote(id, async () => {
          const body = {};
          if (title !== undefined) body.title = title;
          if (markdown !== undefined) body.markdown = markdown;
          if (shareAccess !== undefined) body.shareAccess = shareAccess;
          if (Object.keys(body).length === 0) {
            throw new Error(
              "update_note requires at least one of: title, markdown, shareAccess."
            );
          }
          const result = await request(
            instanceAccessor(),
            "PUT",
            `/api/notes/${encodeURIComponent(id)}`,
            body
          );
          stale.forget(id, scope);
          const fresh = await request(instanceAccessor(), "GET", `/api/notes/${encodeURIComponent(id)}`);
          return {
            id: fresh.note.id,
            title: fresh.note.title,
            updatedAt: fresh.note.updatedAt,
            shareAccess: fresh.note.shareAccess,
            shareId: fresh.note.shareId,
            savedAt: result.savedAt,
          };
        }),
    },

    edit_note: {
      description:
        "Apply [{oldText, newText}] edits to a note. REQUIRES a prior read_note call — hard-errors if the note has been modified since you last read it. Use this for surgical edits; use update_note for wholesale rewrites. IMPORTANT: oldText is matched as a LITERAL SUBSTRING of the note's source markdown — markdown formatting characters (backticks, asterisks, underscores) must be present in oldText exactly as they appear in the source. If you 'see' `code` in a rendered view but write 'code' in oldText, the edit will fail. Re-read the note's raw markdown if unsure. Note: stale-read protection is best-effort across processes; same-process MCP calls are serialized via per-note mutex.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                oldText: { type: "string" },
                newText: { type: "string" },
              },
              required: ["oldText", "newText"],
              additionalProperties: false,
            },
            minItems: 1,
          },
        },
        required: ["id", "edits"],
        additionalProperties: false,
      },
      handler: async ({ id, edits }) =>
        mu.withNote(id, async () => {
          const cur = await request(instanceAccessor(), "GET", `/api/notes/${encodeURIComponent(id)}`);
          stale.require(id, cur.note.updatedAt, scope);
          let result;
          try {
            result = await request(
              instanceAccessor(),
              "POST",
              `/api/notes/${encodeURIComponent(id)}/edit`,
              { edits }
            );
          } catch (e) {
            if (e.status === 400 && /oldText not found/i.test(e.message)) {
              throw new Error(
                `${e.message}\n\nHint: oldText is matched as a literal substring of ` +
                  `the note's source markdown. Markdown formatting characters ` +
                  `(backticks, asterisks, underscores) must appear in oldText ` +
                  `exactly as they do in the source. Re-read the note to see the raw ` +
                  `markdown if you've been working from a rendered view.`
              );
            }
            throw e;
          }
          const fresh = await request(instanceAccessor(), "GET", `/api/notes/${encodeURIComponent(id)}`);
          stale.record(id, fresh.note.updatedAt, scope);
          return {
            id,
            updatedAt: fresh.note.updatedAt,
            editsApplied: edits.length,
            savedAt: result.savedAt,
          };
        }),
    },

    share_note: {
      description:
        "Set share access on a note. Returns the public share URL (or null if access=none). Access levels: none | view | comment | edit.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          access: { enum: ["none", "view", "comment", "edit"] },
        },
        required: ["id", "access"],
        additionalProperties: false,
      },
      handler: async ({ id, access }) =>
        mu.withNote(id, async () => {
          await request(instanceAccessor(), "PUT", `/api/notes/${encodeURIComponent(id)}`, {
            shareAccess: access,
          });
          const fresh = await request(instanceAccessor(), "GET", `/api/notes/${encodeURIComponent(id)}`);
          stale.forget(id, scope);
          return {
            id,
            access,
            url: access === "none" ? null : `${baseUrl()}/s/${fresh.note.shareId}`,
          };
        }),
    },

    comment_on_note: {
      description:
        "Add an inline comment thread anchored to a quoted passage in a note. The quote must appear in the note's markdown. Note: comment authorship uses your jot API key's label; rename the API key to label agent comments.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          quote: { type: "string", description: "Exact text from the note to anchor the comment to" },
          body: { type: "string", description: "Comment body (markdown supported)" },
        },
        required: ["id", "quote", "body"],
        additionalProperties: false,
      },
      handler: async ({ id, quote, body }) =>
        mu.withNote(id, async () => {
          const payload = await request(
            instanceAccessor(),
            "POST",
            `/api/notes/${encodeURIComponent(id)}/threads`,
            { quote, body }
          );
          return { threadId: payload.thread.id, noteId: id };
        }),
    },
  };
}

/**
 * Build a configured MCP Server with all tools/resources/prompts wired.
 *
 * stdio mode calls this once at startup and reuses for the session.
 * HTTP mode calls this per request (SDK 1.29 rejects reconnecting a
 * Protocol, so each request needs its own Server + Transport).
 */
export function createMcpServer({ instanceAccessor, stale, mu, scope }) {
  const server = new Server(
    { name: "jot", version: "0.4.0" },
    {
      capabilities: {
        tools: {},
        resources: { subscribe: false, listChanged: false },
        prompts: { listChanged: false },
      },
    }
  );

  const tools = buildTools({ instanceAccessor, stale, mu, scope });
  const resources = makeResourceHandlers({
    instance: instanceAccessor,
    onNoteRead: (id, updatedAt) => stale.record(id, updatedAt, scope),
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(tools).map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools[req.params.name];
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
      };
    }
    try {
      const result = await tool.handler(req.params.arguments ?? {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: e.message }] };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async (req) => {
    try {
      return await resources.listResources(req.params);
    } catch (e) {
      log("listResources failed:", e.message);
      throw e;
    }
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    try {
      return await resources.readResource(req.params);
    } catch (e) {
      if (e.code === "INVALID_URI") {
        throw new McpError(ErrorCode.InvalidParams, e.message);
      }
      log("readResource failed:", e.message);
      throw e;
    }
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => listPrompts());

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    try {
      return getPrompt(req.params);
    } catch (e) {
      if (e.code === "INVALID_PARAMS") {
        throw new McpError(ErrorCode.InvalidParams, e.message);
      }
      log("getPrompt failed:", e.message);
      throw e;
    }
  });

  return server;
}

export async function runMcp() {
  ensureStdioInstanceConfigured();
  const stale = makeStaleTracker();
  const mu = makeNoteMutex();
  const server = createMcpServer({
    instanceAccessor: () => getInstance(INSTANCE_NAME),
    stale,
    mu,
    scope: undefined, // stdio: single client, default scope
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise((resolve) => {
    const finish = () => resolve();
    const prev = transport.onclose;
    transport.onclose = (...args) => {
      if (typeof prev === "function") prev(...args);
      finish();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

export async function runMcpHttp({ port, baseUrl }) {
  const { runMcpHttp: _impl } = await import("./mcp-http.mjs");
  return _impl({
    port,
    baseUrl,
    createMcpServer,
    makeStaleTracker,
    makeNoteMutex,
    requestCtx,
  });
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  await runMcp();
}
