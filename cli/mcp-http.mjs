// Streamable HTTP transport for the jot MCP server.
//
// Auth: each request must carry "Authorization: Bearer <jot-api-key>".
// The token is passed through to jot's REST API per request — we do
// NOT validate it here. A bad token causes the first jot call to
// return 401, surfaced as an MCP tool error. This delegates auth to
// jot itself, eliminating duplicate token state.
//
// Per-request Server: SDK 1.29 rejects reconnecting a Protocol. We
// create a fresh MCP Server (via the createMcpServer factory) AND a
// fresh StreamableHTTPServerTransport for each POST /mcp. Shared state
// (stale tracker + per-note mutex) lives at module scope.
//
// JSON responses only: enableJsonResponse: true on the transport.
// GET /mcp returns 405 (we don't run the long-lived SSE channel).
import express from "express";
import crypto from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const log = (...a) => console.error("[jot-mcp-http]", ...a);

// Never log raw bearer tokens — only a short prefix of a sha256 hash.
function safeBearerHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 12);
}

export async function runMcpHttp({
  port,
  baseUrl,
  createMcpServer,
  makeStaleTracker,
  makeNoteMutex,
  requestCtx,
}) {
  if (!baseUrl) {
    log("HTTP mode requires JOT_INSTANCE_BASE_URL env var (e.g. https://jot.example.com).");
    process.exit(1);
  }

  // Process-scope state shared across requests
  const stale = makeStaleTracker();
  const mu = makeNoteMutex();
  const baseUrlNormalized = baseUrl.replace(/\/$/, "");

  const app = express();
  app.use(express.json({ limit: "4mb" }));

  // CORS preflight on /mcp — required for browser-based MCP clients;
  // native clients (Claude Desktop, Claude Code) ignore it.
  app.options("/mcp", (req, res) => {
    res.set({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id",
      "Access-Control-Max-Age": "86400",
    });
    res.status(204).end();
  });

  // /health: process is up. Use for k8s livenessProbe.
  app.get("/health", (req, res) => {
    res.json({ ok: true, transport: "streamable-http" });
  });

  // /ready: process is up AND can reach jot. Use for k8s readinessProbe.
  app.get("/ready", async (req, res) => {
    try {
      const r = await fetch(`${baseUrlNormalized}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) throw new Error(`jot /health returned ${r.status}`);
      res.json({
        ok: true,
        jotReachable: true,
        jotBaseUrl: baseUrlNormalized,
      });
    } catch (e) {
      res.status(503).json({
        ok: false,
        jotReachable: false,
        error: e.message,
      });
    }
  });

  // GET /mcp -> 405 (registered BEFORE bearer middleware so unsupported
  // method takes precedence over auth requirement)
  app.get("/mcp", (req, res) => {
    res.set("Allow", "POST, OPTIONS");
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32601,
        message: "GET not supported on /mcp; use POST with JSON-RPC body",
      },
      id: null,
    });
  });

  // Bearer middleware on /mcp (POST only — GET handled above)
  app.use("/mcp", (req, res, next) => {
    if (req.method === "GET") return next(); // already handled
    const auth = req.headers.authorization ?? "";
    const m = /^Bearer (.+)$/.exec(auth);
    if (!m) {
      res.set("Access-Control-Allow-Origin", "*");
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Missing or malformed Bearer token" },
        id: null,
      });
      return;
    }
    const token = m[1];
    const tokenHash = safeBearerHash(token);
    const instance = {
      name: `http:${tokenHash}`,
      baseUrl: baseUrlNormalized,
      token,
    };
    requestCtx.run({ instance, tokenHash }, () => next());
  });

  // POST /mcp — fresh Server + Transport per request
  app.post("/mcp", async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    const ctx = requestCtx.getStore();
    if (!ctx) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Missing request context (bearer middleware bug)",
        },
        id: null,
      });
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close();
    });
    try {
      const server = createMcpServer({
        instanceAccessor: () => ctx.instance,
        stale,
        mu,
        scope: ctx.tokenHash,
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      // NEVER log req.headers (would leak Authorization). Only log message.
      log("MCP request handler error:", e.message);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: e.message },
          id: null,
        });
      }
    }
  });

  return new Promise((resolve) => {
    const httpServer = app.listen(port, () => {
      log(`Streamable HTTP MCP listening on :${port} (jot base: ${baseUrlNormalized})`);
    });
    const finish = () => {
      log("shutting down");
      httpServer.close(() => resolve());
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}
