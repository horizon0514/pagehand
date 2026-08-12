import { test, expect, callTool, type StoredLedger } from './extension';
import type { Page } from '@playwright/test';
import {
  PROBE_LISTS,
  PROBE_PAGINATION,
  EXTRACT_WITH_SCHEMA,
  GO_NEXT_PAGE,
  type RowSchema,
} from '../src/lib/tools/tableScripts';
import { countRepeatingRows } from '../src/lib/pages/detectList';

/**
 * The table tools are mostly hand-written JS that only ever runs inside a page,
 * so unit tests can reach the schema plumbing but not the part most likely to
 * be wrong. These run the shipped scripts in a real renderer against
 * list.html — a three-page list behind a Next button that disables at the end.
 */

interface Candidate {
  rowSelector: string;
  kind: string;
  label: string;
  count: number;
  inMain: boolean;
  linkedRatio: number;
  nestedInside: string | null;
  samples: { sel: string; text: string; href?: string }[][];
}

/**
 * Chinese column names on purpose. CDP hands objects back with their keys
 * sorted, and '价' sorts before '名' — so an export that leaked that order would
 * come out as 价格 | 名称 here, while ASCII headers would hide the bug behind an
 * order that happens to match.
 */
const SCHEMA: RowSchema = {
  rowSelector: '#item-list > li.item',
  fields: [
    { name: '名称', selector: '.name' },
    { name: '价格', selector: '.price' },
  ],
  keyField: '名称',
  nextPage: { kind: 'click', selector: '#next' },
};

function ledger(panel: Page): Promise<StoredLedger | null> {
  return panel.evaluate(() => window.__cdp.ledger.get());
}

test('the list probe finds the data rows and a selector that matches all of them', async ({
  panel,
  openTarget,
}) => {
  await openTarget('/list.html');

  const { value } = await callTool<{ value: { candidates: Candidate[] } }>(
    panel,
    'evaluate_script',
    { function: PROBE_LISTS },
  );

  const [best] = value.candidates;
  expect(best.count).toBe(10);
  // Not li:nth-of-type(1) — a row selector pinned to row one exports one line.
  expect(best.rowSelector).toBe('#item-list > li.item');

  const { value: matched } = await callTool<{ value: number }>(panel, 'evaluate_script', {
    function: '(sel) => document.querySelectorAll(sel).length',
    args: [best.rowSelector],
  });
  expect(matched).toBe(10);

  // Cells prefer a unique class over a positional path.
  expect(best.samples[0].map((c) => c.sel)).toEqual(['.name', '.price']);
  expect(best.samples[0].map((c) => c.text)).toEqual(['Item-01', '$20']);
});

/**
 * Ranking is the decision that matters most — a wrong list cannot be recovered
 * from downstream, and picking one is exactly what a model cannot do from row
 * shape alone. lists.html puts the three cases on one page: a nav that repeats
 * convincingly and holds nothing, the records, and a sub-list living inside one
 * of those records.
 */
test('the probe ranks records above chrome, and says which list is a level down', async ({
  panel,
  openTarget,
}) => {
  await openTarget('/lists.html');

  const { value } = await callTool<{ value: { candidates: Candidate[] } }>(
    panel,
    'evaluate_script',
    { function: PROBE_LISTS },
  );

  const [best] = value.candidates;
  expect(best.rowSelector).toBe('#orders > li.order-row');
  expect(best.count).toBe(8);
  // What the page calls this list, which is the signal the model actually needs.
  expect(best.label).toBe('订单列表');
  expect(best.inMain).toBe(true);
  expect(best.linkedRatio).toBe(1);
  expect(best.nestedInside).toBeNull();

  // The nav and the footer repeat just as cleanly and must not win.
  const selectors = value.candidates.map((c) => c.rowSelector);
  expect(selectors).not.toContain('#nav-links > li.nav-item');
  expect(selectors).not.toContain('#footer-links > li.foot');

  // The tag list is real content one level below the records, and is offered as
  // such rather than silently dropped or silently preferred.
  const tags = value.candidates.find((c) => c.rowSelector.includes('tag'));
  expect(tags?.nestedInside).toBe(best.rowSelector);
});

test('the pagination probe offers the Next control', async ({ panel, openTarget }) => {
  await openTarget('/list.html');

  const { value } = await callTool<{
    value: { controls: { selector: string; label: string; why: string }[] };
  }>(panel, 'evaluate_script', { function: PROBE_PAGINATION });

  expect(value.controls.some((c) => c.why === 'next-label' && c.label === 'Next page')).toBe(true);
});

test('a schema replayed against the page yields typed rows', async ({ panel, openTarget }) => {
  await openTarget('/list.html');

  const { value } = await callTool<{ value: { rows: Record<string, string>[]; matched: number } }>(
    panel,
    'evaluate_script',
    { function: EXTRACT_WITH_SCHEMA, args: [SCHEMA, 200] },
  );

  expect(value.matched).toBe(10);
  expect(value.rows).toHaveLength(10);
  expect(value.rows[0]).toEqual({ 名称: 'Item-01', 价格: '$20' });
  expect(value.rows[9]).toEqual({ 名称: 'Item-10', 价格: '$20' });
});

test('the pager reports a real advance, and refuses once Next is disabled', async ({
  panel,
  openTarget,
}) => {
  await openTarget('/list.html');

  // This fixture re-renders in place: the row count never changes, so only the
  // content check can tell page 2 from page 1.
  const { value: first } = await callTool<{ value: { advanced: boolean } }>(
    panel,
    'evaluate_script',
    { function: GO_NEXT_PAGE, args: [SCHEMA.nextPage, SCHEMA.rowSelector, 300] },
  );
  expect(first.advanced).toBe(true);

  await callTool(panel, 'evaluate_script', {
    function: GO_NEXT_PAGE,
    args: [SCHEMA.nextPage, SCHEMA.rowSelector, 300],
  });

  const { value: past } = await callTool<{ value: { advanced: boolean; reason: string } }>(
    panel,
    'evaluate_script',
    { function: GO_NEXT_PAGE, args: [SCHEMA.nextPage, SCHEMA.rowSelector, 300] },
  );
  expect(past).toMatchObject({ advanced: false, reason: 'next-control-disabled' });
});

test('extract_rows walks every page into the ledger without repeating rows', async ({
  panel,
  openTarget,
}) => {
  await openTarget('/list.html');
  await panel.evaluate(() => window.__cdp.ledger.activate('e2e-table'));

  const result = await callTool<{
    rowsAdded: number;
    pagesVisited: number;
    duplicatesSkipped: number;
    columns: string[];
    stopReason: string;
    sample: Record<string, string>[];
  }>(panel, 'extract_rows', { schema: SCHEMA, maxPages: 10 });

  expect(result).toMatchObject({
    rowsAdded: 30,
    pagesVisited: 3,
    duplicatesSkipped: 0,
    columns: ['名称', '价格'],
    // It stops because the fixture disables Next, not because it ran out of budget.
    stopReason: 'next-control-disabled',
  });

  const state = await ledger(panel);
  expect(state?.findings).toHaveLength(30);
  expect(state?.findings.map((f) => f.key)).toContain('Item-30');
  expect(state?.findings[0]).toMatchObject({ key: 'Item-01', summary: '$20' });
  expect(state?.findings[0].data).toEqual({ 名称: 'Item-01', 价格: '$20' });
});

/**
 * The chip's detector is shipped to chrome.scripting as a serialized function,
 * so running its own toString() in a page is exactly how it executes in
 * production — and the only way to see it meet a real DOM.
 */
test('the chip detector counts a real list and stays quiet on a page without one', async ({
  panel,
  openTarget,
}) => {
  await openTarget('/list.html');
  const onList = await callTool<{ value: number }>(panel, 'evaluate_script', {
    function: countRepeatingRows.toString(),
    args: [4, 8],
  });
  expect(onList.value).toBe(10);

  await openTarget('/page.html');
  const onPlain = await callTool<{ value: number }>(panel, 'evaluate_script', {
    function: countRepeatingRows.toString(),
    args: [4, 8],
  });
  expect(onPlain.value).toBe(0);
});

test('export is offered before the first message and stays in reach after it', async ({
  panel,
  openTarget,
}) => {
  await panel.evaluate(() =>
    chrome.storage.local.set({
      'pagehand:settings': {
        provider: 'openai-compatible',
        apiKey: 'test-key',
        model: 'test-model',
        baseURL: 'http://localhost:5599/v1',
      },
    }),
  );
  await panel.reload();
  await panel.waitForFunction(() => typeof window.__cdp !== 'undefined');

  // On an empty thread it is the first suggestion, and it sends the full
  // instruction rather than its own three-word label.
  await panel.getByRole('button', { name: /Export this list as a table|导出这个列表/ }).click();
  await expect(panel.getByText(/collect every row|翻页收集所有行/)).toBeVisible({ timeout: 20_000 });

  // The turn fails (nothing serves that base URL) but the thread is no longer
  // empty — which is exactly where the suggestions disappear and the chip has
  // to carry the path. Under Playwright the panel is an ordinary tab, so a real
  // page has to be foregrounded for the chip to probe what a user would see.
  await openTarget('/list.html');
  const chip = panel.getByRole('button', { name: /Export this list|导出本页列表/ });
  await expect(chip).toBeVisible({ timeout: 15_000 });
  // Host access is pre-granted in E2E builds, so the probe runs and counts.
  await expect(chip).toContainText(/10/);
});

test('extracted rows render as a grid the user can export', async ({ panel, openTarget }) => {
  // A fresh profile opens on setup, and the ledger lives behind it. BYOK
  // settings are the cheapest way to a panel that shows the chat surface.
  await panel.evaluate(() =>
    chrome.storage.local.set({
      'pagehand:settings': {
        provider: 'openai-compatible',
        apiKey: 'test-key',
        model: 'test-model',
        baseURL: 'http://localhost:5599/v1',
      },
    }),
  );
  await panel.reload();
  await panel.waitForFunction(() => typeof window.__cdp !== 'undefined');

  await openTarget('/list.html');
  // No activate() here: the rows must land in the thread the panel is showing.
  await callTool(panel, 'extract_rows', { schema: SCHEMA, maxPages: 1 });

  // No click to expand: the agent is told to report a count rather than recite
  // the rows, so an export that leaves the panel shut shows the user nothing.
  await expect(
    panel.getByRole('button', { name: /Hide task ledger|收起任务账本/ }),
  ).toBeVisible();

  // Columns come from the extracted fields, not from Key/Summary — and they
  // keep the schema's order, which CDP's returnByValue does not preserve.
  await expect(panel.getByRole('columnheader')).toHaveText(['名称', '价格']);
  await expect(panel.getByRole('columnheader', { name: 'Key' })).toHaveCount(0);
  await expect(panel.getByRole('cell', { name: 'Item-01', exact: true })).toBeVisible();
  await expect(panel.getByRole('row')).toHaveCount(11); // header + 10 rows

  const download = panel.waitForEvent('download');
  await panel.getByRole('button', { name: /Download CSV|下载 CSV/ }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.csv$/);

  const stream = await file.createReadStream();
  const csv = (await stream.toArray()).join('');
  // The BOM is what keeps Excel from mojibaking a Chinese export.
  expect(csv.startsWith('﻿')).toBe(true);
  expect(csv.split('\r\n')[0]).toBe('﻿名称,价格');
  expect(csv).toContain('Item-10,$20');
});

test('a second extract_rows run tops up instead of duplicating', async ({ panel, openTarget }) => {
  await openTarget('/list.html');
  await panel.evaluate(() => window.__cdp.ledger.activate('e2e-table-rerun'));

  await callTool(panel, 'extract_rows', { schema: SCHEMA, maxPages: 1 });

  await openTarget('/list.html');
  const again = await callTool<{ rowsAdded: number; duplicatesSkipped: number }>(
    panel,
    'extract_rows',
    { schema: SCHEMA, maxPages: 2 },
  );

  // Page 1 is already in the ledger; only page 2 is new.
  expect(again).toMatchObject({ rowsAdded: 10, duplicatesSkipped: 10 });
  const state = await ledger(panel);
  expect(state?.findings).toHaveLength(20);
});
