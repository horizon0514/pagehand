import { test, expect, callTool, type StoredTask, type StoredTaskRun } from './extension';
import type { Page } from '@playwright/test';
import { type RowSchema } from '../src/lib/tools/tableScripts';

/**
 * Saved exports: the run that costs no model call.
 *
 * The fixture is static, so a diff is manufactured the way a real one happens —
 * the first run sees part of the list and a later one sees more of it. Saving
 * one page and re-running the default budget produces exactly that.
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

function tasks(panel: Page): Promise<StoredTask[]> {
  return panel.evaluate(() => window.__cdp.tasks.list());
}

async function clearTasks(panel: Page): Promise<void> {
  for (const task of await tasks(panel)) {
    await panel.evaluate((id) => window.__cdp.tasks.remove(id), task.id);
  }
}

test('a saved export re-runs without a model and reports what is new', async ({
  panel,
  openTarget,
}) => {
  await clearTasks(panel);
  await openTarget('/list.html');
  await panel.evaluate(() => window.__cdp.ledger.activate('e2e-task-first'));

  // First run: page one only, so the saved baseline is 10 of the 30 rows.
  await callTool(panel, 'extract_rows', { schema: SCHEMA, maxPages: 1 });

  // The walk records how to repeat itself, which is what the save button reads.
  const ledger = await panel.evaluate(() => window.__cdp.ledger.get());
  expect(ledger?.extraction?.url).toContain('/list.html');
  expect(ledger?.extraction?.schema).toMatchObject({
    rowSelector: '#item-list > li.item',
    keyField: '名称',
  });

  const saved = await panel.evaluate(() => window.__cdp.tasks.saveCurrent('商品导出'));
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ name: '商品导出', lastRowCount: 10 });
  expect(saved[0].lastKeys).toHaveLength(10);

  // Re-run against a fresh thread: it navigates itself and walks the default
  // budget, so it sees all three pages this time.
  await panel.evaluate(() => window.__cdp.ledger.activate('e2e-task-rerun'));
  const run = await panel.evaluate(
    (task) => window.__cdp.tasks.run(task),
    saved[0],
  );

  expect(run).toMatchObject({ rows: 30, pagesVisited: 3, firstRun: false });
  expect(run.newKeys).toHaveLength(20);
  expect(run.newKeys).toContain('Item-30');
  expect(run.newKeys).not.toContain('Item-01');

  // The diff is written where the user reads it, not only returned.
  const after = await panel.evaluate(() => window.__cdp.ledger.get());
  expect(after?.goal).toBe('商品导出');
  expect(after?.findings).toHaveLength(30);
  expect(after?.notes.at(-1)).toContain('20 new');

  // And the baseline moved, so the next run has 30 rows to compare against.
  const [stored] = await tasks(panel);
  expect(stored).toMatchObject({ lastRowCount: 30 });
  expect(stored.lastKeys).toHaveLength(30);
});

test('a re-run that finds nothing new says so', async ({ panel, openTarget }) => {
  await clearTasks(panel);
  await openTarget('/list.html');
  await panel.evaluate(() => window.__cdp.ledger.activate('e2e-task-same'));

  await callTool(panel, 'extract_rows', { schema: SCHEMA, maxPages: 10 });
  const [task] = await panel.evaluate(() => window.__cdp.tasks.saveCurrent('全量导出'));

  await panel.evaluate(() => window.__cdp.ledger.activate('e2e-task-same-2'));
  const run: StoredTaskRun = await panel.evaluate((t) => window.__cdp.tasks.run(t), task);

  expect(run).toMatchObject({ rows: 30, firstRun: false });
  expect(run.newKeys).toHaveLength(0);

  const after = await panel.evaluate(() => window.__cdp.ledger.get());
  expect(after?.notes.at(-1)).toContain('none of them new');
});

test('a failed run keeps the previous baseline instead of erasing it', async ({
  panel,
  openTarget,
}) => {
  await clearTasks(panel);
  await openTarget('/list.html');
  await panel.evaluate(() => window.__cdp.ledger.activate('e2e-task-keep'));

  await callTool(panel, 'extract_rows', { schema: SCHEMA, maxPages: 10 });
  const [good] = await panel.evaluate(() => window.__cdp.tasks.saveCurrent('会失败的导出'));
  expect(good.lastKeys).toHaveLength(30);

  // A page with no such rows stands in for the ordinary failure: signed out,
  // or the site moved the list. The run collects nothing.
  const broken = { ...good, url: `${new URL(good.url).origin}/page.html` };
  await panel.evaluate(() => window.__cdp.ledger.activate('e2e-task-keep-2'));
  const run: StoredTaskRun = await panel.evaluate((t) => window.__cdp.tasks.run(t), broken);
  expect(run.rows).toBe(0);

  // The baseline is untouched, so the next good run reports a real diff rather
  // than calling the whole table new.
  const [stored] = await tasks(panel);
  expect(stored.lastKeys).toHaveLength(30);
  expect(stored.lastRowCount).toBe(30);
});
