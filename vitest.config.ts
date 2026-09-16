// vitest runs in a plain Node environment: the modules under test are the pure ones (the hash parser,
// the feed and settings parsers, the invented stats, the feed generator), none of which touches the DOM
// at import time — collection.ts reads document.baseURI when loadIndex runs, not when it is imported.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
