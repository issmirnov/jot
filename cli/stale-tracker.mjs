export function makeStaleTracker() {
  const versions = new Map();
  return {
    record(noteId, updatedAt) {
      versions.set(noteId, updatedAt);
    },
    require(noteId, currentUpdatedAt) {
      if (!versions.has(noteId)) {
        throw new Error(
          `Must call read_note(id="${noteId}") before edit_note. ` +
          `The MCP server requires a recent read to prevent stale-overwrite bugs.`
        );
      }
      const known = versions.get(noteId);
      if (known !== currentUpdatedAt) {
        throw new Error(
          `Stale read: note "${noteId}" was modified since you last read it ` +
          `(your version: ${known}, current: ${currentUpdatedAt}). ` +
          `Re-read the note before editing.`
        );
      }
    },
    forget(noteId) {
      versions.delete(noteId);
    },
  };
}
