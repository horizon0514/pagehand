import { defineConfig } from '@playwright/test';
import { loadLocalEnv } from './e2e/env';

loadLocalEnv();

const PORT = Number(process.env.E2E_PORT ?? 5599);

export default defineConfig({
  testDir: './e2e',
  // The benchmark driver has its own config (playwright.bench.config.ts): it
  // spends real money on live sites and must never run as part of the suite.
  testIgnore: '**/benchmark/**',
  // Extensions live in a single shared browser profile and this extension
  // deliberately allows only one debugger attachment at a time, so tests must
  // not run concurrently.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'list' : [['list']],
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node e2e/serve.mjs',
    url: `http://localhost:${PORT}/page.html`,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
  },
});
