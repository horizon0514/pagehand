import { useCallback, useEffect, useState } from 'react';
import {
  deleteTask,
  loadTasks,
  runExportTask,
  saveTask,
  taskFromExtraction,
  type ExportTask,
} from '../../lib/tasks/exportTasks';
import type { LedgerExtraction } from '../../lib/ledger/types';

export interface TaskRunOutcome {
  /** i18n key for the sentence to show — tasks.doneFirst / doneNew / doneSame / failed. */
  key: 'tasks.doneFirst' | 'tasks.doneNew' | 'tasks.doneSame' | 'tasks.failed';
  vars: Record<string, string | number>;
}

/**
 * Saved exports and the one action that replays them.
 *
 * A run drives the tool layer directly rather than sending a message, so it
 * never touches the agent loop: the whole value of a saved schema is that the
 * second run costs nothing, and going back through the model would undo that.
 */
export function useExportTasks() {
  const [tasks, setTasks] = useState<ExportTask[]>([]);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<TaskRunOutcome | null>(null);

  useEffect(() => {
    void loadTasks().then(setTasks);
  }, []);

  const save = useCallback(
    async (name: string, extraction: LedgerExtraction, keys: string[]) => {
      setTasks(
        await saveTask(
          taskFromExtraction(name, extraction.url, extraction.schema, keys.length, keys),
        ),
      );
    },
    [],
  );

  const remove = useCallback(async (id: string) => {
    setTasks(await deleteTask(id));
  }, []);

  const run = useCallback(async (task: ExportTask) => {
    setRunningId(task.id);
    setOutcome(null);
    try {
      const result = await runExportTask(task);
      setOutcome({
        key: result.firstRun
          ? 'tasks.doneFirst'
          : result.newKeys.length > 0
            ? 'tasks.doneNew'
            : 'tasks.doneSame',
        vars: { count: result.rows, added: result.newKeys.length },
      });
      setTasks(await loadTasks());
    } catch (err) {
      setOutcome({
        key: 'tasks.failed',
        vars: { error: err instanceof Error ? err.message : String(err) },
      });
    } finally {
      setRunningId(null);
    }
  }, []);

  return { tasks, runningId, outcome, save, remove, run };
}
