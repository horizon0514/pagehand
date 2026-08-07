import { Loader2, RotateCw, Trash2 } from 'lucide-react';
import type { ExportTask } from '../../lib/tasks/exportTasks';
import { useT } from '../i18n/useT';
import { SectionLabel } from './ui/label';

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Saved exports, offered on an empty thread.
 *
 * Re-running one is the only path in the product that reaches a full table
 * without a model in the loop, so it stays a plain button rather than a
 * suggested prompt — routing it through the chat would put back exactly the
 * cost the saved schema exists to remove.
 */
export default function ExportTaskList({
  tasks,
  runningId,
  disabled,
  onRun,
  onDelete,
}: {
  tasks: ExportTask[];
  runningId: string | null;
  disabled: boolean;
  onRun: (task: ExportTask) => void;
  onDelete: (id: string) => void;
}) {
  const t = useT();
  if (tasks.length === 0) return null;

  return (
    <div className="animate-enter w-full max-w-[320px]">
      <SectionLabel className="mb-2 text-center">{t('tasks.title')}</SectionLabel>
      <ul className="flex flex-col gap-1.5">
        {tasks.map((task) => {
          const running = runningId === task.id;
          return (
            <li
              key={task.id}
              className="group flex h-9 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 text-[12.5px]"
            >
              <button
                type="button"
                disabled={disabled || running}
                onClick={() => onRun(task)}
                title={t('tasks.run', { name: task.name })}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left outline-none disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-accent-line"
              >
                {running ? (
                  <Loader2 className="size-3.5 shrink-0 animate-spin text-accent-text" />
                ) : (
                  <RotateCw className="size-3.5 shrink-0 text-fg-tertiary transition-colors duration-200 group-hover:text-accent-text" />
                )}
                <span className="min-w-0 flex-1 truncate text-fg-secondary group-hover:text-fg">
                  {task.name}
                </span>
                <span className="shrink-0 text-[10px] text-fg-tertiary">
                  {running
                    ? t('tasks.running')
                    : t('tasks.lastRun', { count: task.lastRowCount, host: hostOf(task.url) })}
                </span>
              </button>
              <button
                type="button"
                disabled={running}
                onClick={() => onDelete(task.id)}
                title={t('tasks.delete')}
                aria-label={t('tasks.delete')}
                className="shrink-0 cursor-pointer text-fg-tertiary opacity-0 outline-none transition-opacity duration-200 hover:text-negative focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent-line group-hover:opacity-100 disabled:cursor-not-allowed"
              >
                <Trash2 className="size-3" />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
