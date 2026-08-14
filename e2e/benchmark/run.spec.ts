import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from '../extension';
import { loadDatasetSync } from './dataset.ts';
import { loadSample, resolveSample } from './sample.ts';
import { writeSubmission } from './v2.ts';
import { validateSubmission } from './validate.ts';
import type { BenchRunResult } from '../../src/e2e/bench/recorder.ts';

/**
 * The Online-Mind2Web driver: one task per test, one fresh browser profile per
 * task. Excluded from `npm run test:e2e` (playwright.config.ts ignores this
 * directory) — it only runs through `npm run bench:om2w`, which is the command
 * that provisions the keys it needs.
 *
 * Each task is independent and idempotent: a crashed run resumes with
 * --resume, and a single task re-runs alone with --tasks <id>, byte-identical
 * in setup to its position in the batch.
 */

const OUT_DIR = path.join(import.meta.dirname, 'out');
const TASK_TIMEOUT_MS = Number(process.env.BENCH_TASK_TIMEOUT_MS ?? 900_000);
const RESUME = process.env.BENCH_RESUME === '1';
const ALLOW_SEARCH = process.env.BENCH_ALLOW_SEARCH === '1';
const ONLY = (process.env.BENCH_TASKS ?? '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

interface BenchSettings {
  provider: string;
  model: string;
  apiKey?: string;
  baseURL?: string;
}

/**
 * Provider, model and key come from the environment and are written straight
 * into the settings the panel reads. Nothing about the benchmark is bound to a
 * particular vendor — Pagehand is BYOK, and the model is part of the headline
 * result, not a constant of the driver.
 */
function settingsFromEnv(): BenchSettings {
  const provider = process.env.PAGEHAND_PROVIDER?.trim();
  const model = process.env.PAGEHAND_MODEL?.trim();
  const apiKey = process.env.PAGEHAND_API_KEY?.trim();
  const baseURL = process.env.PAGEHAND_BASE_URL?.trim();

  if (!provider || !model) {
    throw new Error('Set PAGEHAND_PROVIDER and PAGEHAND_MODEL (and PAGEHAND_API_KEY) before running the benchmark.');
  }
  if (provider === 'hosted') {
    throw new Error(
      'PAGEHAND_PROVIDER=hosted is refused: the hosted path bills Pagehand rather than the operator, ' +
        'and it halves the per-turn step budget, which would make the number incomparable.',
    );
  }
  if (!apiKey) throw new Error(`PAGEHAND_API_KEY is required for provider "${provider}".`);

  return { provider, model, apiKey, ...(baseURL ? { baseURL } : {}) };
}

function startUrl(website: string): string {
  return /^https?:\/\//i.test(website) ? website : `https://${website}`;
}

/**
 * Navigates to the task's start URL, retrying once. Returns null on success, or
 * the error message when the site never served a page (`ERR_HTTP2_PROTOCOL_ERROR`
 * and friends). A 403 bot wall is *not* a dead site: it loads, so the agent runs
 * and the outcome is judged — only a failed navigation lands here.
 */
async function gotoStartSite(target: Page, url: string): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await target.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      return null;
    } catch (error) {
      if (attempt === 1) return error instanceof Error ? error.message.split('\n')[0] : String(error);
    }
  }
  return null;
}

const sample = loadSample();
const dataset = loadDatasetSync();
const tasks = resolveSample(sample, dataset.tasks).filter(
  (task) => ONLY.length === 0 || ONLY.includes(task.task_id),
);

if (ONLY.length > 0 && tasks.length === 0) {
  throw new Error(`None of --tasks ${ONLY.join(',')} are in ${sample.tasks.length} pinned sample tasks.`);
}

test.describe.configure({ mode: 'serial' });

for (const task of tasks) {
  test(`[${task.tier}] ${task.task_id}`, async ({ context, panel }) => {
    const dir = path.join(OUT_DIR, task.task_id);
    test.skip(RESUME && fs.existsSync(path.join(dir, 'result.json')), 'already has a result.json');
    test.skip(
      RESUME && fs.existsSync(path.join(dir, 'not-executable.json')),
      'start site already recorded as not executable',
    );
    test.setTimeout(TASK_TIMEOUT_MS + 120_000);

    await panel.evaluate(
      (settings) => chrome.storage.local.set({ 'pagehand:settings': settings }),
      settingsFromEnv(),
    );
    // Settings only take effect after a reload, which also drops the JS context
    // and any attachment — so attaching comes strictly after this.
    await panel.reload();
    await panel.waitForFunction(() => typeof window.__cdp !== 'undefined');

    // Straight to the task's real start URL: about:blank and chrome:// pages
    // reject debugger attachment.
    const target = await context.newPage();
    const deadSite = await gotoStartSite(target, startUrl(task.website));
    if (deadSite) {
      // A start site that never serves a page is an environment failure, not an
      // agent failure. Recording it keeps it out of the judged denominator
      // instead of crashing the task with no artefact at all.
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'not-executable.json'),
        `${JSON.stringify(
          {
            task_id: task.task_id,
            website: task.website,
            reason: 'start site did not load',
            error: deadSite,
            at: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
      );
      appendRunSummary({
        task_id: task.task_id,
        tier: task.tier,
        website: task.website,
        dataset_sha: sample.dataset_sha,
        not_executable: true,
        error: deadSite,
        finished_at: new Date().toISOString(),
      });
      console.log(`[bench] ${task.task_id} (${task.tier}): not executable — ${deadSite}`);
      test.skip(true, `start site did not load: ${deadSite}`);
    }

    const tabId = await panel.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({});
      const tab =
        tabs.find((t) => t.url === url) ??
        // A live site may have redirected between goto() and here.
        tabs.filter((t) => t.url?.startsWith('http')).pop();
      if (tab?.id === undefined) throw new Error(`No attachable tab for ${url}`);
      await window.__cdp.attach(tab.id);
      return tab.id;
    }, target.url());
    expect(tabId).toBeGreaterThan(0);

    const result: BenchRunResult = await panel.evaluate(
      (options) => window.__cdp.bench.run(options),
      {
        task: task.confirmed_task,
        taskId: task.task_id,
        timeoutMs: TASK_TIMEOUT_MS,
        allowSearch: ALLOW_SEARCH,
      },
    );

    fs.mkdirSync(dir, { recursive: true });
    const submission = writeSubmission(dir, {
      task: task.confirmed_task,
      taskId: task.task_id,
      referenceLength: task.reference_length,
      result,
    });

    const errors = validateSubmission(dir, { referenceLength: task.reference_length });
    appendRunSummary({
      task_id: task.task_id,
      tier: task.tier,
      website: task.website,
      dataset_sha: sample.dataset_sha,
      provider: result.provider,
      model: result.model,
      search_disabled: result.searchDisabled,
      finish_reason: result.stop?.finishReason ?? null,
      steps: result.stop?.steps ?? 0,
      v2_steps: submission.document.action_history.length,
      hit_step_limit: result.stop?.hitStepLimit ?? false,
      completed: result.completed,
      timed_out: result.timedOut,
      error: result.error,
      total_tokens: result.stop?.totalTokens ?? null,
      wall_clock_ms: result.endedAt - result.startedAt,
      placeholders: submission.placeholders,
      validation_errors: errors,
      finished_at: new Date().toISOString(),
    });

    console.log(
      `[bench] ${task.task_id} (${task.tier}): ${submission.document.action_history.length} v2 steps, ` +
        `finish=${result.stop?.finishReason ?? 'none'}, tokens=${result.stop?.totalTokens ?? 'n/a'}, ` +
        `${((result.endedAt - result.startedAt) / 1000).toFixed(0)}s` +
        (submission.placeholders > 0 ? `, ${submission.placeholders} placeholder shot(s)` : ''),
    );

    // A submission that fails the spec is worse than no submission: it would be
    // rejected downstream after the money has already been spent on the run.
    expect(errors, `v2 validation failed for ${task.task_id}`).toEqual([]);
  });
}

interface RunSummaryRow {
  task_id: string;
  [key: string]: unknown;
}

/** Read-modify-write is safe at the default workers: 1; BENCH_WORKERS>1 is opt-in and unverified. */
function appendRunSummary(row: RunSummaryRow): void {
  const file = path.join(OUT_DIR, 'run-summary.json');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const rows: RunSummaryRow[] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  fs.writeFileSync(file, `${JSON.stringify([...rows.filter((r) => r.task_id !== row.task_id), row], null, 2)}\n`);
}
