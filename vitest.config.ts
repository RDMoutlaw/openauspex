import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Resolve workspace packages to their source so tests run with no build step.
const src = (pkg: string): string => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts'],
  },
  resolve: {
    alias: {
      // The published `opentimestamps` package's `main` points to a non-existent file; its real
      // CommonJS entry is index.js. Node falls back to it automatically, but vite's resolver is
      // stricter and needs it spelled out. (Test-only — real Node consumers resolve it natively.)
      opentimestamps: 'opentimestamps/index.js',
      '@openauspex/core': src('core'),
      '@openauspex/publisher': src('publisher'),
      '@openauspex/monitor': src('monitor'),
      '@openauspex/notify': src('notify'),
    },
  },
});
