export function makeNoteMutex() {
  const tails = new Map();
  return {
    async withNote(noteId, fn) {
      const prev = tails.get(noteId) ?? Promise.resolve();
      let release;
      const next = new Promise((r) => (release = r));
      tails.set(noteId, next);
      try {
        await prev.catch(() => {});
        return await fn();
      } finally {
        release();
        if (tails.get(noteId) === next) tails.delete(noteId);
      }
    },
  };
}
