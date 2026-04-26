// Resource URI scheme:
//   jot://notes/<id>   — a single owned note (markdown body + inline threads)
//
// Threads are appended to the markdown body as a "## Comments" section so
// that attaching a note via the @-picker in Claude Desktop puts the
// conversation in context alongside the body. The section is clearly
// labeled as server-rendered (not part of the note's source) so agents
// don't try to anchor comment_on_note quotes against it.
import { request } from "./lib.mjs";

const DEFAULT_PAGE_SIZE = 200;

const COMMENTS_SECTION_HEADER =
  "\n\n---\n\n## Comments\n\n" +
  "*(Server-rendered from threads — not part of the note's source markdown. " +
  "Quote anchors for `comment_on_note` must come from the body above this divider.)*\n\n";

export function parseNoteUri(uri) {
  if (typeof uri !== "string") return null;
  const m = /^jot:\/\/notes\/([^/]+)$/.exec(uri);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

function quoteAsBlockquote(quote) {
  if (!quote) return "";
  return quote
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

export function threadsToMarkdown(threads) {
  if (!Array.isArray(threads) || threads.length === 0) return "";
  let out = COMMENTS_SECTION_HEADER;
  for (const t of threads) {
    const status = t.resolved ? " [resolved]" : "";
    out += `### Thread ${t.id}${status}\n\n`;
    if (t.anchor && t.anchor.quote) {
      out += `${quoteAsBlockquote(t.anchor.quote)}\n\n`;
    }
    for (const msg of t.messages ?? []) {
      out += `**${msg.authorName}** (${msg.updatedAt}):\n\n${msg.body}\n\n`;
    }
  }
  return out;
}

export function paginateNotes(items, cursor, pageSize = DEFAULT_PAGE_SIZE) {
  const list = Array.isArray(items) ? items : [];
  const parsed = Number.parseInt(cursor, 10);
  const offset = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  const page = list.slice(offset, offset + pageSize);
  const nextOffset = offset + page.length;
  const nextCursor = nextOffset < list.length ? String(nextOffset) : undefined;
  return { items: page, nextCursor };
}

export function makeResourceHandlers({
  instance,
  onNoteRead,
  pageSize = DEFAULT_PAGE_SIZE,
}) {
  return {
    listResources: async (params) => {
      const payload = await request(instance(), "GET", "/api/notes");
      const all = payload.notes ?? [];
      const { items, nextCursor } = paginateNotes(all, params?.cursor, pageSize);
      const result = {
        resources: items.map((n) => ({
          uri: `jot://notes/${n.id}`,
          name: n.title || `(untitled ${n.id})`,
          description: `Updated ${n.updatedAt}`,
          mimeType: "text/markdown",
        })),
      };
      if (nextCursor) result.nextCursor = nextCursor;
      return result;
    },

    readResource: async (params) => {
      const id = parseNoteUri(params?.uri);
      if (!id) {
        const err = new Error(
          `Unsupported resource URI: ${params?.uri}. Supported scheme: jot://notes/<id>`
        );
        err.code = "INVALID_URI";
        throw err;
      }
      const payload = await request(
        instance(),
        "GET",
        `/api/notes/${encodeURIComponent(id)}`
      );
      // Stale-tracker hook (option B): a resource read counts as a fresh
      // read for subsequent edit_note calls. Decoupled via callback so
      // this module never imports the tracker directly.
      if (typeof onNoteRead === "function") {
        onNoteRead(id, payload.note.updatedAt);
      }
      const body = payload.note.markdown + threadsToMarkdown(payload.threads);
      return {
        contents: [
          {
            uri: params.uri,
            mimeType: "text/markdown",
            text: body,
          },
        ],
      };
    },
  };
}
