import { test } from "node:test";
import assert from "node:assert/strict";
import { makeNoteMutex } from "../cli/note-mutex.mjs";

test("withNote serializes calls for the same id", async () => {
  const mu = makeNoteMutex();
  const order = [];
  const a = mu.withNote("x", async () => {
    order.push("a-start");
    await new Promise((r) => setTimeout(r, 20));
    order.push("a-end");
    return "A";
  });
  const b = mu.withNote("x", async () => {
    order.push("b-start");
    return "B";
  });
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra, "A");
  assert.equal(rb, "B");
  assert.deepEqual(order, ["a-start", "a-end", "b-start"]);
});

test("withNote does NOT serialize across different ids", async () => {
  const mu = makeNoteMutex();
  const order = [];
  const a = mu.withNote("x", async () => {
    order.push("x-start");
    await new Promise((r) => setTimeout(r, 20));
    order.push("x-end");
  });
  const b = mu.withNote("y", async () => {
    order.push("y-start");
    order.push("y-end");
  });
  await Promise.all([a, b]);
  assert.deepEqual(order, ["x-start", "y-start", "y-end", "x-end"]);
});

test("withNote propagates errors and continues serialization", async () => {
  const mu = makeNoteMutex();
  await assert.rejects(
    mu.withNote("x", async () => {
      throw new Error("boom");
    }),
    /boom/
  );
  const r = await mu.withNote("x", async () => "ok");
  assert.equal(r, "ok");
});
