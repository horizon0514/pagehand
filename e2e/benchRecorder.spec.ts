import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, callTool, uidFor, type BenchStep, type SnapshotResult } from './extension';
import type { Page } from '@playwright/test';
import { writeSubmission } from './benchmark/v2.ts';
import { validateSubmission } from './benchmark/validate.ts';

/**
 * The benchmark recorder, proven against the local fixture page — no model, no
 * API key, no live site. Everything the Online-Mind2Web driver depends on is
 * mechanical and testable here: that wrapping tools[name].execute intercepts
 * every call, that a pre-action screenshot and URL land on each step, that a
 * failed action is recorded rather than lost, and that an occluded tab still
 * yields real pixels.
 *
 * That last one is the reason this file exists rather than a comment: in the
 * E2E harness the side panel is an ordinary tab competing for the foreground,
 * so a capture path that silently blanked in the background would have produced
 * a whole benchmark run of grey rectangles.
 */

const readSteps = (panel: Page): Promise<BenchStep[]> =>
  panel.evaluate(() => window.__cdp.bench.steps());

async function installRecorder(panel: Page, options: { allowSearch?: boolean } = {}): Promise<void> {
  await panel.evaluate((opts) => {
    window.__cdp.bench.reset();
    window.__cdp.bench.install(opts);
  }, options);
}

/** JPEG dimensions from the SOF marker — proof the frame holds a real image. */
function jpegSize(base64: string): { width: number; height: number } {
  const buffer = Buffer.from(base64, 'base64');
  expect(buffer.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  for (let i = 2; i < buffer.length - 9; ) {
    if (buffer[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buffer[i + 1];
    const length = buffer.readUInt16BE(i + 2);
    // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11 — all carry the frame dimensions.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
    }
    i += 2 + length;
  }
  throw new Error('no SOF marker in the captured JPEG');
}

test('records url, screenshot and status for every tool call — including the ones that throw', async ({
  panel,
  openTarget,
}) => {
  await installRecorder(panel);
  const { page } = await openTarget('/page.html');

  const { snapshot } = await callTool<SnapshotResult>(panel, 'take_snapshot');
  await callTool(panel, 'click', { uid: uidFor(snapshot, 'Clicked 0 times') });
  await expect(page.locator('#counter')).toHaveText('Clicked 1 times');

  // A stale uid: the tool throws, and the step must survive that.
  await callTool(panel, 'click', { uid: '99999' }).catch(() => {});

  const steps = await readSteps(panel);
  expect(steps.map((s) => s.tool)).toEqual(['take_snapshot', 'click', 'click']);
  expect(steps.map((s) => s.status)).toEqual(['SUCCESS', 'SUCCESS', 'FAILED']);
  expect(steps.map((s) => s.order)).toEqual([0, 1, 2]);
  expect(steps[2].error).toMatch(/uid/i);

  for (const step of steps) {
    expect(step.url).toContain('/page.html');
    expect(step.screenshotPlaceholder).toBe(false);
    expect(step.captureMs).toBeLessThan(5_000);
    const { width, height } = jpegSize(step.screenshot!);
    expect(width).toBeGreaterThan(300);
    expect(height).toBeGreaterThan(300);
  }

  // The click's uid resolves to the coords v2 uses as its target; the stale one
  // cannot, and falls back to the `page` target rather than inventing a point.
  expect(steps[1].coords!.x).toBeGreaterThan(0);
  expect(steps[1].coords!.y).toBeGreaterThan(0);
  expect(steps[2].coords).toBeNull();
});

test('captures the attached tab even when another tab is in front', async ({
  panel,
  openTarget,
  context,
}) => {
  await installRecorder(panel);
  await openTarget('/page.html');

  // Occlude the target: in the harness the panel is itself a tab, and the agent
  // opening a new one mid-task must not blank the record.
  const decoy = await context.newPage();
  await decoy.goto('/other.html');
  await decoy.bringToFront();

  await callTool<SnapshotResult>(panel, 'take_snapshot');

  const [step] = await readSteps(panel);
  expect(step.url).toContain('/page.html');
  expect(step.screenshotPlaceholder).toBe(false);
  const { width, height } = jpegSize(step.screenshot!);
  expect(width).toBeGreaterThan(300);
  expect(height).toBeGreaterThan(300);
});

test('records a navigation destination rather than where it started', async ({ panel, openTarget }) => {
  await installRecorder(panel);
  await openTarget('/page.html');

  await callTool(panel, 'navigate_page', { type: 'url', url: 'http://localhost:5599/other.html' });

  const [step] = await readSteps(panel);
  // v2 rule 8: the step's url is the destination; the screenshot is still the
  // page the agent was looking at when it decided to go.
  expect(step.url).toContain('/page.html');
  expect(step.destinationUrl).toContain('/other.html');
});

test('disables web_search by default, and records the attempt', async ({ panel, openTarget }) => {
  await installRecorder(panel);
  await openTarget('/page.html');

  const result = await callTool<{ error?: string }>(panel, 'web_search', { query: 'anything at all' });
  expect(result.error).toMatch(/disabled for benchmark runs/);

  const [step] = await readSteps(panel);
  expect(step.tool).toBe('web_search');
  expect(step.status).toBe('FAILED');
});

/**
 * The whole chain — bench.run -> writer -> validator — on the one failure the
 * driver can reproduce without a key: a model endpoint that isn't there. A run
 * that never reaches a model must still produce a submission a consumer would
 * accept, because the alternative is discovering it after paying for 30 tasks.
 */
test('a turn that never reaches a model still writes a valid v2 submission', async ({
  panel,
  openTarget,
}) => {
  test.setTimeout(120_000);

  await panel.evaluate(() =>
    chrome.storage.local.set({
      'pagehand:settings': {
        provider: 'openai-compatible',
        model: 'not-a-real-model',
        apiKey: 'not-a-real-key',
        // The fixture server answers 404 to anything that isn't a fixture, so
        // the first model call fails without leaving the machine.
        baseURL: 'http://localhost:5599/v1',
      },
    }),
  );
  await panel.reload();
  await panel.waitForFunction(() => typeof window.__cdp !== 'undefined');
  await openTarget('/page.html');

  const result = await panel.evaluate(() =>
    window.__cdp.bench.run({ task: 'Find the opening hours.', taskId: 'fixture01', timeoutMs: 30_000 }),
  );

  expect(result.error).toBeTruthy();
  expect(result.completed).toBe(false);
  expect(result.searchDisabled).toBe(true);
  expect(result.model).toBe('not-a-real-model');
  expect(result.final.url).toContain('/page.html');
  expect(result.final.screenshotPlaceholder).toBe(false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagehand-bench-run-'));
  const submission = writeSubmission(dir, {
    task: 'Find the opening hours.',
    taskId: 'fixture01',
    referenceLength: 6,
    result,
  });

  expect(validateSubmission(dir, { referenceLength: 6 })).toEqual([]);
  // Nothing happened on the page, so the trajectory is the terminal step alone —
  // and it says so honestly rather than claiming an answer.
  expect(submission.document.agent_final_answer).toBeNull();
  expect(submission.document.action_history).toHaveLength(1);
  expect(submission.document.action_history[0].action).toBe('TASK_COMPLETE -> ANSWER:');
  expect(submission.document.action_history[0].thought).toMatch(/Run ended without an answer/);
  expect(fs.existsSync(path.join(dir, 'trajectory', '0000.jpg'))).toBe(true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('uninstall restores the shipped tools', async ({ panel, openTarget }) => {
  await installRecorder(panel);
  await openTarget('/page.html');
  await callTool<SnapshotResult>(panel, 'take_snapshot');
  expect(await readSteps(panel)).toHaveLength(1);

  await panel.evaluate(() => window.__cdp.bench.uninstall());
  await callTool<SnapshotResult>(panel, 'take_snapshot');
  expect(await readSteps(panel)).toHaveLength(1);
});
