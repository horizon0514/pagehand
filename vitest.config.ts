import { defineConfig } from 'vitest/config';

// Deliberately separate from vite.config.ts so the CRX plugin is not loaded for
// unit tests, and so Vitest does not try to run the Playwright specs in e2e/
// (those are *.spec.ts and belong to the Playwright runner).
export default defineConfig({
  test: {
    // e2e/ holds pure Node modules (the v2 writer, the validator, the proxy flag
    // builder) whose tests need no browser; the Playwright specs beside them
    // stay excluded.
    include: ['src/**/*.test.ts', 'e2e/**/*.test.ts'],
    exclude: ['e2e/**/*.spec.ts', 'dist/**', 'node_modules/**'],
    setupFiles: ['src/test/setup.ts'],
  },
});

