import { test } from "node:test";
import assert from "node:assert/strict";
import { makeStaleTracker } from "../cli/stale-tracker.mjs";

test("require() throws when note was never read", () => {
  const t = makeStaleTracker();
  assert.throws(
    () => t.require("abc", "2026-04-25T00:00:00Z"),
    /Must call read_note.*"abc".*before edit_note/
  );
});

test("require() passes when updatedAt matches recorded value", () => {
  const t = makeStaleTracker();
  t.record("abc", "2026-04-25T00:00:00Z");
  assert.doesNotThrow(() => t.require("abc", "2026-04-25T00:00:00Z"));
});

test("require() throws when updatedAt has changed since last read", () => {
  const t = makeStaleTracker();
  t.record("abc", "2026-04-25T00:00:00Z");
  assert.throws(
    () => t.require("abc", "2026-04-25T01:00:00Z"),
    /Stale read.*your version.*current/
  );
});

test("forget() drops a tracked note so subsequent require() throws", () => {
  const t = makeStaleTracker();
  t.record("abc", "2026-04-25T00:00:00Z");
  t.forget("abc");
  assert.throws(() => t.require("abc", "2026-04-25T00:00:00Z"), /Must call read_note/);
});

test("tracker isolates notes by id", () => {
  const t = makeStaleTracker();
  t.record("abc", "2026-04-25T00:00:00Z");
  assert.throws(() => t.require("xyz", "2026-04-25T00:00:00Z"), /Must call read_note/);
});

// --- scope isolation (forward-compat for HTTP mode keying by tokenHash) ---

test("scope isolates: read in scope A does not authorize require in scope B", () => {
  const t = makeStaleTracker();
  t.record("abc", "2026-04-25T00:00:00Z", "tokenA");
  assert.doesNotThrow(() => t.require("abc", "2026-04-25T00:00:00Z", "tokenA"));
  assert.throws(
    () => t.require("abc", "2026-04-25T00:00:00Z", "tokenB"),
    /Must call read_note/
  );
});

test("scope isolates: default (undefined) scope is independent of named scopes", () => {
  const t = makeStaleTracker();
  t.record("abc", "2026-04-25T00:00:00Z"); // default scope
  t.record("abc", "2026-04-25T01:00:00Z", "tokenA");
  // Default-scope require uses the default-scope value
  assert.doesNotThrow(() => t.require("abc", "2026-04-25T00:00:00Z"));
  // tokenA-scope require uses the tokenA-scope value
  assert.doesNotThrow(() => t.require("abc", "2026-04-25T01:00:00Z", "tokenA"));
  // Cross-scope use: default-scope value should not satisfy tokenA require
  assert.throws(
    () => t.require("abc", "2026-04-25T00:00:00Z", "tokenA"),
    /Stale read/
  );
});

test("forget is scope-aware: forgetting in scope A leaves scope B intact", () => {
  const t = makeStaleTracker();
  t.record("abc", "2026-04-25T00:00:00Z", "tokenA");
  t.record("abc", "2026-04-25T00:00:00Z", "tokenB");
  t.forget("abc", "tokenA");
  assert.throws(
    () => t.require("abc", "2026-04-25T00:00:00Z", "tokenA"),
    /Must call read_note/
  );
  assert.doesNotThrow(() => t.require("abc", "2026-04-25T00:00:00Z", "tokenB"));
});
