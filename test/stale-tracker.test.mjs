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
