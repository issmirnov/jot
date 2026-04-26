# jot

https://github.com/user-attachments/assets/542c333c-c26e-4f04-a5bb-2cf4131e60f3

Minimal self-hosted collaborative markdown editor with inline comment threads. Built for humans and agents.

## Quick Start

```bash
npm install -g @mariozechner/jot
jot serve
```

Open `http://localhost:3210`. Set the owner password on first visit.

## Features

- Collaborative real-time editing (multiple tabs, multiple users)
- Remote cursors with names
- Inline comment threads anchored to text selections
- Threaded replies, resolve/reopen
- Share notes with configurable access (view, comment, edit)
- CLI for humans and agents (owner API keys or share links)
- Agent setup modal with copy-paste instructions
- Dark and light theme
- Mobile support
- `.md` files on disk (derived from collaborative state)

## Server

```bash
npm install -g @mariozechner/jot
jot serve                    # port 3210, data in ./data
jot serve --port=8080        # custom port
jot serve --data=/var/jot    # custom data dir
```

## Docker

```bash
cd docker
bash control.sh start
```

## Sharing

Click the share icon in the editor to configure access:

- **Not shared** (default)
- **View only**: read-only preview
- **View & comment**: preview with comment threads
- **Edit & comment**: full collaborative editor with comments

Each note has a stable share URL (`/s/<id>`). Anyone with the link gets the configured level of access, both in the browser and via the CLI. Toggle access without changing the link.

## CLI

The CLI works in two modes depending on how you register.

### Owner mode

The instance owner creates API keys from the settings gear on the landing page. An API key grants full access to all notes.

```bash
jot register myserver https://jot.example.com <api-key>
jot myserver list
jot myserver search "query"
jot myserver read <note-id>
jot myserver create "My note"
jot myserver edit <note-id> '[{"oldText":"foo","newText":"bar"}]'
jot myserver comment <note-id> "quoted text" "comment body"
jot myserver reply <note-id> <thread-id> <message-id> "reply"
jot myserver resolve <note-id> <thread-id>
jot myserver reopen <note-id> <thread-id>
jot myserver edit-comment <note-id> <message-id> "new body"
jot myserver delete-comment <note-id> <message-id>
jot myserver delete-thread <note-id> <thread-id>
jot myserver update <note-id> title "New title"
jot myserver delete <note-id>
```

### Shared mode

Anyone with a share link can use it to register. No API key needed. The link itself is the credential, and access depends on what the owner configured (view, comment, or edit). This works for both humans and their agents. Humans can use the link in the browser for better UX.

```bash
jot register shared https://jot.example.com/s/abc123
jot shared read
jot shared edit '[{"oldText":"foo","newText":"bar"}]'
jot shared comment "quoted text" "comment body" --name="My Agent"
jot shared reply <thread-id> <message-id> "reply" --name="My Agent"
```

### Agent integration

Click the robot icon in the editor or on a shared note to get copy-paste CLI instructions. The instructions are pre-filled with the instance URL and note ID. Hand them to your agent and it can read, edit, and comment on the note.

## MCP server

`jot mcp` runs a Model Context Protocol server over stdio so any MCP-capable client (Claude Code, Claude Desktop, Cursor, Continue) can manage your notes through structured tool calls.

### Setup

Register a jot instance first if you haven't:

```bash
jot register myserver https://jot.example.com <api-key>
```

Then add to your client's MCP config. Claude Desktop example (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "jot": {
      "command": "npx",
      "args": ["-y", "@mariozechner/jot", "mcp"],
      "env": { "JOT_INSTANCE": "myserver" }
    }
  }
}
```

If you're running from a local clone (e.g. testing an unpublished branch), point at the CLI directly:

```json
{
  "mcpServers": {
    "jot": {
      "command": "node",
      "args": ["/absolute/path/to/jot/cli/jot.mjs", "mcp"],
      "env": { "JOT_INSTANCE": "myserver" }
    }
  }
}
```

For multiple jot instances, register multiple MCP servers (`jot-personal`, `jot-work`, etc.) each with its own `JOT_INSTANCE`. Share-link instances are not supported by the MCP server in v1 — register an owner instance with an API key.

### Tools

| Tool | Purpose |
|---|---|
| `list_notes` | List notes (id, title, updatedAt, shareId, snippet) |
| `read_note(id)` | Read full markdown + threads. Records the note version for stale-read protection. |
| `create_note(title, markdown)` | Create a note in one call. |
| `update_note(id, {title?, markdown?, shareAccess?})` | Partial update — server merges only the fields you pass. |
| `edit_note(id, edits[])` | Apply `[{oldText, newText}]` edits. **Requires a prior `read_note` call** — hard-errors if the note has been modified since you last read it. **`oldText` is matched as a literal substring** of the source markdown, including formatting characters (backticks, asterisks, underscores). If you "see" `code` in a rendered view but write `code` without the backticks, the edit will fail with a hint. Re-read the raw markdown if working from a rendered view. |
| `share_note(id, access)` | Set share access (`none`/`view`/`comment`/`edit`); returns the `/s/<shareId>` URL. |
| `comment_on_note(id, quote, body)` | Add an anchored inline comment thread. |

### Resources

Each owned note is exposed as a read-only MCP resource at `jot://notes/<id>`. Clients with resource pickers (Claude Desktop, Cursor) let you `@`-attach a note to a chat — the markdown body and any inline comment threads are pulled into context with no tool call required.

| URI scheme | Returns |
|---|---|
| `jot://notes/<id>` | Note's markdown body, with comment threads rendered as a `## Comments` section appended |

When a note is read via `resources/read`, the MCP server records its `updatedAt` in the stale-read tracker — so attaching a note via the picker counts as a fresh read for subsequent `edit_note` calls. You don't have to ask the agent to "read it first."

`resources/list` returns up to 200 notes per page with a `nextCursor` for pagination.

**Transparency note:** the appended `## Comments` section includes thread author names — anyone who has commented on the note is named. This is the same data the v1 `read_note` tool already returns; mentioned here because resource attachment is a more user-facing surface and the inclusion is worth knowing about.

### Prompts

Three prompt templates ship in v2, surfaced by clients as discoverable commands (e.g. Claude Desktop's `/` menu).

| Prompt | Args | Behavior |
|---|---|---|
| `summarize-note` | `id` | Produces a 2-3 paragraph TL;DR of the note. |
| `review-note` | `id`, `focus?` | Reads the note, identifies the 3 most important weak points, and uses `comment_on_note` to leave inline annotations. Optionally focused on e.g. clarity / technical accuracy / tone. Falls back to inline findings if `comment_on_note` is unavailable. |
| `extract-action-items` | `id`, `post_as_note?` | Returns a markdown checklist of action items. With `post_as_note="true"`, also creates a new note containing the checklist via `create_note`. |

Argument validation is strict — note ids must match `/^[a-z0-9]+$/`, `post_as_note` accepts only the literal strings `"true"` or `"false"` (no silent treatment of `yes`/`1`/`TRUE`). Invalid args return MCP `-32602 InvalidParams`.

### Stale-read protection

`edit_note` requires the agent to have called `read_note` first. If the note has changed between read and edit (e.g. another agent or a human edited it), the edit hard-errors with a "stale read" message instructing the agent to re-read. Within one MCP server process, a per-note mutex serializes mutating tool calls so concurrent same-server requests can't race.

This protection is **best-effort** across processes: jot's server has no conditional-write endpoint, so a human or a second MCP server can still slip an edit in between this server's read and POST. For most agent workflows this is fine; for hard guarantees, add server-side `If-Unmodified-Since` semantics.

`update_note` does NOT require a prior read — it's an explicit wholesale-replacement tool. Use `edit_note` for surgical changes, `update_note` when you intentionally want to replace fields.

### Comment authorship

Owner-side comments are attributed to the API key. To label MCP-originated comments distinctly, register a dedicated API key per agent (e.g. `claude-code`, `cursor`) in your jot admin and use that key in the MCP server's `JOT_INSTANCE`.

### Remote MCP (Streamable HTTP)

Run jot-mcp as a network service so any MCP client (local or remote) can connect over HTTP:

```bash
JOT_INSTANCE_BASE_URL=https://jot.example.com \
  jot mcp --http --port=3211
```

Endpoints:
- `POST /mcp` — Streamable HTTP transport (JSON responses; `enableJsonResponse: true`)
- `GET /health` — process up
- `GET /ready` — process up AND can reach jot's `/health`

**Auth:** every request must carry `Authorization: Bearer <jot-api-key>`. The MCP server does NOT hold its own auth secret — it passes the token through to jot's REST API per request. A bad token causes the first jot call to return 401, surfaced as an MCP tool error. Same key works for jot's UI, the CLI, and remote MCP. Rotate the key in jot's admin and clients pick it up on the next request.

**Per-request server:** SDK 1.x rejects reconnecting a Protocol, so HTTP mode constructs a fresh `Server + StreamableHTTPServerTransport` per request. The stale-read tracker and per-note mutex are shared at process scope but keyed by `tokenHash` (sha256 prefix of the bearer), so different bearer tokens get isolated tracker state — agent A's `read_note` does not authorize agent B's `edit_note` even when they target the same note id.

**Client compatibility:**

| Client | Works? | How |
|---|---|---|
| **Claude Code** | ✅ | `claude mcp add <name> --transport http <url> --header "Authorization: Bearer <token>"` |
| **Claude Desktop** | ❌ for internal-only URLs | Desktop's remote-connector traffic originates from Anthropic infra, can't reach internal `.k.s`/VPN-only URLs. Use the local stdio mode (`jot mcp`) for Desktop. |
| **Cursor / Continue / other MCP clients** | ✅ if they support Streamable HTTP transport | Standard transport; `Mcp-Protocol-Version` header negotiation per spec |
| **curl / scripts** | ✅ | Standard JSON-RPC POST to `/mcp` with bearer header and `Accept: application/json, text/event-stream` |

**Single replica:** the in-memory stale tracker and mutex assume a single process. Run `replicas: 1` with `Recreate` strategy (rolling updates would briefly run two pods with split tracker state). For HA with multiple replicas, externalize state to Redis — out of scope.

**Kubernetes deploy reference:** the `command:` override pattern for using the published image as a jot-mcp service:

```yaml
spec:
  template:
    spec:
      containers:
        - name: jot-mcp
          image: ghcr.io/issmirnov/jot:v0.4.0
          command: ["node", "cli/jot.mjs", "mcp", "--http", "--port=3211"]
          env:
            - name: JOT_INSTANCE_BASE_URL
              value: "http://jot.jot.svc.cluster.local"  # or public URL
          ports:
            - name: http
              containerPort: 3211
          readinessProbe:
            httpGet: { path: /ready, port: 3211 }
          livenessProbe:
            httpGet: { path: /health, port: 3211 }
          lifecycle:
            preStop:
              exec: { command: ["sleep", "5"] }
      terminationGracePeriodSeconds: 30
```

## Data

```
data/
  auth.json
  notes/
    <id>.md
    <id>.json
```

The `.md` files are derived from the collaborative editing state stored in the `.json` sidecar. The JSON is the source of truth. The markdown files are written for convenience (grep, backup, external tooling).

## HTTP API

All owner endpoints require `Authorization: Bearer <api-key>`.

| Method | Endpoint                              | Description                         |
| ------ | ------------------------------------- | ----------------------------------- |
| GET    | `/api/notes?q=<query>`                | List/search notes                   |
| POST   | `/api/notes`                          | Create note                         |
| GET    | `/api/notes/:id`                      | Read note                           |
| PUT    | `/api/notes/:id`                      | Update title, markdown, shareAccess |
| DELETE | `/api/notes/:id`                      | Delete note                         |
| POST   | `/api/notes/:id/edit`                 | Apply text edits                    |
| POST   | `/api/notes/:id/threads`              | Create comment thread               |
| POST   | `/api/notes/:id/threads/:tid/replies` | Reply to thread                     |
| PATCH  | `/api/notes/:id/threads/:tid`         | Resolve/reopen thread               |
| DELETE | `/api/notes/:id/threads/:tid`         | Delete thread                       |
| PATCH  | `/api/notes/:id/messages/:mid`        | Edit comment                        |
| DELETE | `/api/notes/:id/messages/:mid`        | Delete comment                      |
| GET    | `/api/keys`                           | List API keys                       |
| POST   | `/api/keys`                           | Create API key                      |
| DELETE | `/api/keys/:id`                       | Delete API key                      |

Share endpoints (no auth, access controlled by `shareAccess`):

| Method | Endpoint                               | Description                    |
| ------ | -------------------------------------- | ------------------------------ |
| GET    | `/api/share/:sid`                      | Read shared note               |
| GET    | `/api/share/:sid/note`                 | Read shared note (lightweight) |
| POST   | `/api/share/:sid/edit`                 | Edit (requires edit access)    |
| POST   | `/api/share/:sid/threads`              | Create comment                 |
| POST   | `/api/share/:sid/threads/:tid/replies` | Reply                          |
| POST   | `/api/share/:sid/render`               | Render markdown to HTML        |

## License

MIT
