import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseNoteUri,
  threadsToMarkdown,
  paginateNotes,
} from "../cli/mcp-resources.mjs";

// --- parseNoteUri ---

test("parseNoteUri accepts jot://notes/<id>", () => {
  assert.equal(parseNoteUri("jot://notes/slvisfqn"), "slvisfqn");
  assert.equal(parseNoteUri("jot://notes/0ykqifkt"), "0ykqifkt");
});

test("parseNoteUri returns null for unsupported URIs", () => {
  assert.equal(parseNoteUri("jot://note/abc"), null);
  assert.equal(parseNoteUri("jot://shares/abc"), null);
  assert.equal(parseNoteUri("https://example.com/abc"), null);
  assert.equal(parseNoteUri("jot://notes/"), null);
  assert.equal(parseNoteUri(""), null);
  assert.equal(parseNoteUri(undefined), null);
});

test("parseNoteUri url-decodes the id", () => {
  assert.equal(parseNoteUri("jot://notes/abc%2Ddef"), "abc-def");
});

// --- threadsToMarkdown ---

test("threadsToMarkdown renders empty array as empty string", () => {
  assert.equal(threadsToMarkdown([]), "");
  assert.equal(threadsToMarkdown(undefined), "");
});

test("threadsToMarkdown labels appended section as non-source", () => {
  const out = threadsToMarkdown([
    {
      id: "t1",
      resolved: false,
      anchor: { quote: "x" },
      messages: [{ id: "m1", authorName: "A", updatedAt: "t", body: "b" }],
    },
  ]);
  // Must clearly label the section as server-rendered (not part of the note's
  // source markdown) so agents don't try to anchor comment_on_note quotes
  // against text that lives only in this appended section.
  assert.match(out, /not part of the note's source/i);
});

test("threadsToMarkdown renders a single open thread with anchor + author", () => {
  const out = threadsToMarkdown([
    {
      id: "t1",
      resolved: false,
      anchor: { quote: "stale-read protection working" },
      messages: [
        { id: "m1", authorName: "Claude", updatedAt: "2026-04-26T00:20:00Z", body: "Nice rail." },
      ],
    },
  ]);
  assert.match(out, /### Thread t1\n/);
  assert.doesNotMatch(out, /\[resolved\]/);
  assert.match(out, /^> stale-read protection working$/m);
  assert.match(out, /\*\*Claude\*\* \(2026-04-26T00:20:00Z\):/);
  assert.match(out, /Nice rail\./);
});

test("threadsToMarkdown marks resolved threads with [resolved]", () => {
  const out = threadsToMarkdown([
    { id: "t1", resolved: true, anchor: { quote: "x" }, messages: [
      { id: "m1", authorName: "A", updatedAt: "t", body: "b" },
    ] },
  ]);
  assert.match(out, /### Thread t1 \[resolved\]/);
});

test("threadsToMarkdown prefixes every line of multi-line quotes with '> '", () => {
  const out = threadsToMarkdown([
    {
      id: "t1",
      resolved: false,
      anchor: { quote: "first line\nsecond line\nthird line" },
      messages: [{ id: "m1", authorName: "A", updatedAt: "t", body: "b" }],
    },
  ]);
  // Each line of the quote must start with "> " for proper blockquote rendering
  assert.match(out, /^> first line$/m);
  assert.match(out, /^> second line$/m);
  assert.match(out, /^> third line$/m);
});

test("threadsToMarkdown renders multiple replies in order", () => {
  const out = threadsToMarkdown([
    { id: "t1", resolved: false, anchor: { quote: "x" }, messages: [
      { id: "m1", authorName: "A", updatedAt: "t1", body: "first" },
      { id: "m2", authorName: "B", updatedAt: "t2", body: "second" },
      { id: "m3", authorName: "A", updatedAt: "t3", body: "third" },
    ] },
  ]);
  const f = out.indexOf("first");
  const s = out.indexOf("second");
  const t = out.indexOf("third");
  assert.ok(f > 0 && f < s && s < t);
});

test("threadsToMarkdown handles thread with no anchor gracefully", () => {
  const out = threadsToMarkdown([
    { id: "t1", resolved: false, anchor: null, messages: [
      { id: "m1", authorName: "A", updatedAt: "t", body: "anchor-less" },
    ] },
  ]);
  assert.match(out, /### Thread t1\n/);
  assert.doesNotMatch(out, /^>/m);
  assert.match(out, /anchor-less/);
});

// --- paginateNotes ---

test("paginateNotes returns all items when under the page size", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const r = paginateNotes(items, undefined, 10);
  assert.deepEqual(r.items, items);
  assert.equal(r.nextCursor, undefined);
});

test("paginateNotes returns a nextCursor when more items remain", () => {
  const items = Array.from({ length: 250 }, (_, i) => ({ id: String(i) }));
  const r = paginateNotes(items, undefined, 200);
  assert.equal(r.items.length, 200);
  assert.equal(r.items[0].id, "0");
  assert.equal(r.items[199].id, "199");
  assert.equal(r.nextCursor, "200");
});

test("paginateNotes respects a passed cursor", () => {
  const items = Array.from({ length: 250 }, (_, i) => ({ id: String(i) }));
  const r = paginateNotes(items, "200", 200);
  assert.equal(r.items.length, 50);
  assert.equal(r.items[0].id, "200");
  assert.equal(r.items[49].id, "249");
  assert.equal(r.nextCursor, undefined);
});

test("paginateNotes treats invalid cursor as offset 0", () => {
  const items = [{ id: "a" }, { id: "b" }];
  const r = paginateNotes(items, "garbage", 10);
  assert.equal(r.items.length, 2);
});

test("paginateNotes handles empty list", () => {
  const r = paginateNotes([], undefined, 200);
  assert.deepEqual(r.items, []);
  assert.equal(r.nextCursor, undefined);
});
