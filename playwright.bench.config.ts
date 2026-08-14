import { defineConfig } from '@playwright/test';
import { loadLocalEnv } from './e2e/env';

loadLocalEnv();

/**
 * The Online-Mind2Web benchmark driver, deliberately separate from the E2E
 * config: it drives live sites with a real model, needs minutes per test rather
 * than seconds, and has no fixture web server to start.
 *
 * Serial by default. The single debugger attachment is guarded per browser
 * profile, and each task gets a fresh profile, so parallelism is probably
 * available — but it is unverified, and three workers hammering the same 136
 * live sites is its own problem. BENCH_WORKERS exists for whoever proves it.
 */
export default defineConfig({
  testDir: './e2e/benchmark',
  // Only the driver: the v2 writer's own tests live beside it as *.test.ts and
  // belong to Vitest, but Playwright's default testMatch would claim them too.
  testMatch: '**/*.spec.ts',
  workers: Number(process.env.BENCH_WORKERS ?? 1),
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  // The per-task budget plus room for profile launch, settings reload and the
  // post-turn capture; the run itself is bounded by BENCH_TASK_TIMEOUT_MS.
  timeout: Number(process.env.BENCH_TASK_TIMEOUT_MS ?? 900_000) + 120_000,
  use: {
    trace: 'off',
  },
});
