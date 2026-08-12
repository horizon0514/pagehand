import { idbGet, idbSet } from '../storage/idb';
import { navigate } from '../cdp';
import { ensureSession } from '../tools/context';
import { collectRows } from '../tools/tableTools';
import { applyLedgerMutations } from '../ledger/activeLedger';
import { MAX_FINDINGS } from '../ledger/types';
import type { RowSchema } from '../tools/tableScripts';

/**
 * A saved export: where it starts, how to read a row, and what it found last
 * time.
 *
 * This is the part that makes an export worth subscribing to rather than
 * bookmarking. The first run costs one model call to work out the schema; every
 * run after it costs none, because the schema is right here. What the user
 * comes back for is not the same table again — it is the answer to "what
 * changed since Monday", which is why lastKeys is stored alongside.
 */

const IDB_KEY = 'exportTasks';
const MAX_TASKS = 20;

export interface ExportTask {
  id: string;
  name: string;
  /** The page a run starts on. */
  url: string;
  schema: RowSchema;
  maxPages?: number;
  createdAt: number;
  lastRunAt: number | null;
  lastRowCount: number;
  /** Keys seen on the previous run — what "new since last time" is measured against. */
  lastKeys: string[];
}

interface TaskStoreSnapshot {
  tasks: ExportTask[];
}

export async function loadTasks(): Promise<ExportTask[]> {
  const raw = await idbGet<TaskStoreSnapshot>(IDB_KEY);
  if (!raw || !Array.isArray(raw.tasks)) return [];
  return raw.tasks;
}

async function writeTasks(tasks: ExportTask[]): Promise<void> {
  const kept = [...tasks]
    .sort((a, b) => (b.lastRunAt ?? b.createdAt) - (a.lastRunAt ?? a.createdAt))
    .slice(0, MAX_TASKS);
  await idbSet(IDB_KEY, { tasks: kept } satisfies TaskStoreSnapshot);
}

export async function saveTask(task: ExportTask): Promise<ExportTask[]> {
  const tasks = await loadTasks();
  const next = [task, ...tasks.filter((t) => t.id !== task.id)];
  await writeTasks(next);
  return loadTasks();
}

export async function deleteTask(id: string): Promise<ExportTask[]> {
  await writeTasks((await loadTasks()).filter((t) => t.id !== id));
  return loadTasks();
}

/** Builds a task from a finished extraction. Naming it is the goal's job. */
export function taskFromExtraction(
  name: string,
  url: string,
  schema: RowSchema,
  rowCount: number,
  keys: string[],
): ExportTask {
  return {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: name.trim().slice(0, 80) || new URL(url).host,
    url,
    schema,
    createdAt: Date.now(),
    lastRunAt: Date.now(),
    lastRowCount: rowCount,
    lastKeys: keys.slice(0, MAX_FINDINGS),
  };
}

export interface TaskRunResult {
  rows: number;
  pagesVisited: number;
  stopReason: string;
  /** Keys this run found that the previous one did not. */
  newKeys: string[];
  /** True on the very first run, where "new" would mean every row. */
  firstRun: boolean;
}

/** How many new keys the handoff note spells out before it just counts them. */
const NOTED_NEW_KEYS = 10;

/**
 * Re-runs a saved task against a fresh ledger and reports the difference.
 *
 * No model is involved anywhere in here — that is the entire point. The caller
 * is expected to have activated an empty ledger first, so the diff is between
 * runs rather than between this run and whatever the thread already held.
 */
export async function runExportTask(
  task: ExportTask,
  abortSignal?: AbortSignal,
): Promise<TaskRunResult> {
  const session = await ensureSession();
  await navigate(session, task.url, { waitUntil: 'load' });

  await applyLedgerMutations([{ type: 'set_goal', goal: task.name }]);
  const result = await collectRows(task.schema, task.maxPages, abortSignal);

  const previous = new Set(task.lastKeys);
  const firstRun = task.lastKeys.length === 0;
  const newKeys = firstRun ? [] : result.addedKeys.filter((key) => !previous.has(key));

  const note = firstRun
    ? `Re-run: ${result.rowsAdded} rows. Nothing to compare against yet — the next run will report what changed.`
    : newKeys.length === 0
      ? `Re-run: ${result.rowsAdded} rows, none of them new since the last run.`
      : `Re-run: ${result.rowsAdded} rows, ${newKeys.length} new since the last run` +
        ` (${newKeys.slice(0, NOTED_NEW_KEYS).join(', ')}${newKeys.length > NOTED_NEW_KEYS ? ', …' : ''}).`;
  await applyLedgerMutations([{ type: 'add_note', text: note }]);

  // Only a run that saw rows may overwrite the baseline: a walk that failed
  // because the user was signed out would otherwise erase the history it was
  // meant to be compared against, and report the whole table as new next time.
  if (result.rowsAdded > 0) {
    await saveTask({
      ...task,
      lastRunAt: Date.now(),
      lastRowCount: result.rowsAdded,
      lastKeys: result.addedKeys.slice(0, MAX_FINDINGS),
    });
  }

  return {
    rows: result.rowsAdded,
    pagesVisited: result.pagesVisited,
    stopReason: result.stopReason,
    newKeys,
    firstRun,
  };
}
