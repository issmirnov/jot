// Stale-read tracker.
//
// Each method takes an optional `scope` argument (default: undefined).
// Buckets are isolated by scope, so e.g. in HTTP mode where each request
// carries its own bearer token, scoping by `tokenHash` prevents agent A's
// read from authorizing agent B's edit even if they target the same noteId.
//
// Stdio mode (single client, single process) calls without a scope and
// shares the `undefined` bucket — behavior unchanged.
export function makeStaleTracker() {
  const buckets = new Map(); // scope -> Map<noteId, updatedAt>
  function bucket(scope) {
    let b = buckets.get(scope);
    if (!b) {
      b = new Map();
      buckets.set(scope, b);
    }
    return b;
  }
  return {
    record(noteId, updatedAt, scope) {
      bucket(scope).set(noteId, updatedAt);
    },
    require(noteId, currentUpdatedAt, scope) {
      const b = bucket(scope);
      if (!b.has(noteId)) {
        throw new Error(
          `Must call read_note(id="${noteId}") before edit_note. ` +
          `The MCP server requires a recent read to prevent stale-overwrite bugs.`
        );
      }
      const known = b.get(noteId);
      if (known !== currentUpdatedAt) {
        throw new Error(
          `Stale read: note "${noteId}" was modified since you last read it ` +
          `(your version: ${known}, current: ${currentUpdatedAt}). ` +
          `Re-read the note before editing.`
        );
      }
    },
    forget(noteId, scope) {
      const b = buckets.get(scope);
      if (b) b.delete(noteId);
    },
  };
}
