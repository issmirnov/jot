import { test } from "node:test";
import assert from "node:assert/strict";
import { listPrompts, getPrompt } from "../cli/mcp-prompts.mjs";

// --- listPrompts ---

test("listPrompts returns the 3 v2 prompts", () => {
  const r = listPrompts();
  const names = r.prompts.map((p) => p.name).sort();
  assert.deepEqual(names, ["extract-action-items", "review-note", "summarize-note"]);
  for (const p of r.prompts) {
    assert.ok(p.description, `${p.name} has description`);
    assert.ok(Array.isArray(p.arguments), `${p.name} has arguments array`);
    const idArg = p.arguments.find((a) => a.name === "id");
    assert.ok(idArg && idArg.required, `${p.name} requires id`);
  }
});

// --- summarize-note ---

test("summarize-note resolves with the resource URI substituted", () => {
  const r = getPrompt({ name: "summarize-note", arguments: { id: "abc123" } });
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].role, "user");
  assert.match(r.messages[0].content.text, /jot:\/\/notes\/abc123/);
  assert.match(r.messages[0].content.text, /TL;DR/i);
});

// --- review-note ---

test("review-note without focus omits focus phrase", () => {
  const r = getPrompt({ name: "review-note", arguments: { id: "abc" } });
  const text = r.messages[0].content.text;
  assert.match(text, /jot:\/\/notes\/abc/);
  assert.match(text, /comment_on_note/);
  assert.doesNotMatch(text, /focus/i);
});

test("review-note with focus embeds focus phrase", () => {
  const r = getPrompt({ name: "review-note", arguments: { id: "abc", focus: "clarity" } });
  assert.match(r.messages[0].content.text, /focusing on clarity/i);
});

test("review-note warns about literal substring matching for comment quotes", () => {
  const r = getPrompt({ name: "review-note", arguments: { id: "abc" } });
  // The prompt should pre-warn the LLM since comment_on_note quotes share the
  // same literal-substring requirement as edit_note's oldText.
  assert.match(r.messages[0].content.text, /literal|exact substring|formatting/i);
});

test("review-note instructs anchoring against source body, NOT the appended Comments section", () => {
  const r = getPrompt({ name: "review-note", arguments: { id: "abc" } });
  // Codex caught this: comment_on_note's server-side anchor check looks at
  // note.markdown only, so quotes copied from the resource's appended
  // Comments section will fail. The prompt must tell the LLM to anchor
  // against the body only.
  const text = r.messages[0].content.text.toLowerCase();
  assert.ok(
    /body|source|before.*comments|not.*comments/.test(text),
    "review-note must steer the agent toward source body anchors only"
  );
});

test("review-note describes a graceful fallback if comment_on_note is unavailable", () => {
  const r = getPrompt({ name: "review-note", arguments: { id: "abc" } });
  // If the client/agent doesn't have comment_on_note, the prompt should
  // still produce useful output (findings + quote anchors as text).
  assert.match(r.messages[0].content.text, /unavailable|fallback|cannot|return.*findings/i);
});

// --- extract-action-items ---

test("extract-action-items without post_as_note omits create_note instruction", () => {
  const r = getPrompt({ name: "extract-action-items", arguments: { id: "abc" } });
  const text = r.messages[0].content.text;
  assert.match(text, /jot:\/\/notes\/abc/);
  assert.match(text, /\[ \]/);
  assert.doesNotMatch(text, /create_note/);
});

test('extract-action-items with post_as_note="true" mentions create_note', () => {
  const r = getPrompt({
    name: "extract-action-items",
    arguments: { id: "abc", post_as_note: "true" },
  });
  assert.match(r.messages[0].content.text, /create_note/);
});

test('extract-action-items with post_as_note="false" omits create_note', () => {
  const r = getPrompt({
    name: "extract-action-items",
    arguments: { id: "abc", post_as_note: "false" },
  });
  assert.doesNotMatch(r.messages[0].content.text, /create_note/);
});

// --- arg validation ---

test("getPrompt rejects unknown prompt name", () => {
  assert.throws(
    () => getPrompt({ name: "nonsense", arguments: {} }),
    (e) => e.code === "INVALID_PARAMS" && /Unknown prompt/.test(e.message)
  );
});

test("getPrompt rejects missing required id", () => {
  assert.throws(
    () => getPrompt({ name: "summarize-note", arguments: {} }),
    (e) => e.code === "INVALID_PARAMS" && /Missing required argument: id/.test(e.message)
  );
});

test("getPrompt rejects empty id", () => {
  assert.throws(
    () => getPrompt({ name: "summarize-note", arguments: { id: "" } }),
    (e) => e.code === "INVALID_PARAMS" && /id.*empty|empty.*id/i.test(e.message)
  );
});

test("getPrompt rejects whitespace-only id", () => {
  assert.throws(
    () => getPrompt({ name: "summarize-note", arguments: { id: "   " } }),
    (e) => e.code === "INVALID_PARAMS"
  );
});

test("getPrompt rejects ids that don't match /^[a-z0-9]+$/", () => {
  for (const bad of ["UPPERCASE", "with-dash", "with space", "../../etc", "abc!"]) {
    assert.throws(
      () => getPrompt({ name: "summarize-note", arguments: { id: bad } }),
      (e) => e.code === "INVALID_PARAMS",
      `expected ${bad} to be rejected`
    );
  }
});

test("getPrompt rejects post_as_note values other than absent/true/false", () => {
  for (const bad of ["yes", "1", "TRUE", "True", "y", "no"]) {
    assert.throws(
      () => getPrompt({
        name: "extract-action-items",
        arguments: { id: "abc", post_as_note: bad },
      }),
      (e) => e.code === "INVALID_PARAMS",
      `expected post_as_note=${bad} to be rejected`
    );
  }
});
