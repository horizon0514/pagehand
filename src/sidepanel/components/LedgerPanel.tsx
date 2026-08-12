import { useEffect, useMemo, useRef, useState } from 'react';
import { BookmarkPlus, Check, ChevronDown, ClipboardList, Copy, Download, Table2 } from 'lucide-react';
import {
  isLedgerEmpty,
  type LedgerExtraction,
  type PlanItem,
  type TaskLedger,
} from '../../lib/ledger/types';
import { useT } from '../i18n/useT';
import { toMarkdown, toTable, toTsv } from '../lib/findingsTable';
import { downloadCsvFile } from '../lib/exportActions';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { cn } from '../lib/utils';

const STATUS_MARK: Record<PlanItem['status'], string> = {
  pending: '○',
  in_progress: '●',
  done: '✓',
  skipped: '—',
};

/**
 * Rows rendered before the table stops and offers the export instead. The
 * ledger holds up to MAX_FINDINGS (thousands, since extract_rows writes one
 * finding per table row), and a side panel 320px wide is not where anyone reads
 * the two-thousandth line — the file is.
 */
const MAX_RENDERED_ROWS = 100;

/**
 * A button that reports what it did, since a copy leaves nothing on screen.
 *
 * `text` carries the label for the one action worth spelling out. Rendered as
 * bare icons the whole row read as decoration — the download people wanted was
 * already there and simply never seen — so the primary action says what it is
 * and the rest stay icons with tooltips.
 */
function ActionButton({
  icon: Icon,
  label,
  text,
  done,
  primary,
  onClick,
}: {
  icon: typeof Copy;
  label: string;
  text?: string;
  done: boolean;
  primary?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={primary ? 'default' : 'outline'}
      className={cn('h-5 gap-1 text-[10px]', text ? 'px-1.5' : 'px-1.5')}
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      {done ? <Check className="size-2.5" /> : <Icon className="size-2.5" />}
      {text && <span>{done ? '✓' : text}</span>}
    </Button>
  );
}

/**
 * Renders the durable task ledger the agent maintains via update_task_ledger —
 * the user-facing answer to "what has it actually got so far", independent of
 * what the transcript says. Findings render as a grid rather than a list
 * because extraction runs fill them with rows, and a row is only legible next
 * to its neighbours under a column heading.
 */
export default function LedgerPanel({
  ledger,
  onSaveTask,
}: {
  ledger: TaskLedger | null;
  /** Offered only when the rows came from a repeatable extraction. */
  onSaveTask?: (name: string, extraction: LedgerExtraction, keys: string[]) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [acted, setActed] = useState<string | null>(null);

  const findings = ledger?.findings ?? [];
  const table = useMemo(() => toTable(findings), [findings]);

  /**
   * Open itself the first time rows arrive.
   *
   * Collapsed is right for a ledger being filled in a step at a time, and wrong
   * for the end of an export: the agent is told to report a count rather than
   * recite the rows, so a panel that stays shut means a finished extraction
   * shows the user nothing but the word "9". Reopening is left alone after
   * that — a run that starts from an empty ledger gets one nudge, and a
   * deliberate collapse stays collapsed.
   */
  const seenRows = useRef(0);
  useEffect(() => {
    if (seenRows.current === 0 && findings.length > 0) setOpen(true);
    seenRows.current = findings.length;
  }, [findings.length]);

  useEffect(() => {
    if (!acted) return;
    const timer = setTimeout(() => setActed(null), 1500);
    return () => clearTimeout(timer);
  }, [acted]);

  if (!ledger || isLedgerEmpty(ledger)) return null;

  const planDone = ledger.plan.filter((p) => p.status === 'done' || p.status === 'skipped').length;
  const hidden = table.rows.length - MAX_RENDERED_ROWS;

  const copy = async (text: string, action: string) => {
    await navigator.clipboard.writeText(text);
    setActed(action);
  };

  const downloadCsv = () => {
    downloadCsvFile(table, ledger.goal);
    setActed('csv');
  };

  return (
    <div className="shrink-0 border-b border-line bg-bg text-[11px]">
      <button
        type="button"
        className="flex h-8 w-full items-center gap-2 overflow-hidden px-3 text-left hover:bg-surface"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={open ? t('ledger.collapse') : t('ledger.expand')}
      >
        <ClipboardList className="size-3 shrink-0 text-fg-tertiary" aria-hidden />
        <span className="min-w-0 truncate font-medium text-fg-secondary">
          {ledger.goal ?? t('ledger.title')}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {ledger.plan.length > 0 && (
            <Badge variant="neutral">
              {t('ledger.planProgress', { done: planDone, total: ledger.plan.length })}
            </Badge>
          )}
          {findings.length > 0 && (
            <Badge variant="positive">{t('ledger.rowsCount', { count: findings.length })}</Badge>
          )}
          <ChevronDown
            className={cn('size-3 text-fg-tertiary transition-transform', open && 'rotate-180')}
            aria-hidden
          />
        </span>
      </button>

      {open && (
        <div className="max-h-64 overflow-y-auto border-t border-line px-3 py-2 leading-[1.5]">
          {ledger.plan.length > 0 && (
            <section className="mb-2">
              <h3 className="mb-1 font-semibold text-fg-tertiary uppercase tracking-wide text-[10px]">
                {t('ledger.plan')}
              </h3>
              <ol className="space-y-0.5">
                {ledger.plan.map((item, i) => (
                  <li
                    key={i}
                    className={cn(
                      'flex gap-1.5',
                      item.status === 'done' || item.status === 'skipped'
                        ? 'text-fg-tertiary line-through'
                        : 'text-fg-secondary',
                      item.status === 'in_progress' && 'font-medium text-fg',
                    )}
                  >
                    <span className="shrink-0" aria-hidden>
                      {STATUS_MARK[item.status]}
                    </span>
                    <span className="min-w-0">{item.text}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {findings.length > 0 && (
            <section className="mb-2">
              <div className="mb-1 flex items-center justify-between gap-2">
                <h3 className="font-semibold text-fg-tertiary uppercase tracking-wide text-[10px]">
                  {t('ledger.findings')}
                </h3>
                <div className="flex shrink-0 items-center gap-1">
                  <ActionButton
                    icon={Table2}
                    label={t('ledger.copyTable')}
                    done={acted === 'tsv'}
                    onClick={() => void copy(toTsv(table), 'tsv')}
                  />
                  <ActionButton
                    icon={Copy}
                    label={t('ledger.copy')}
                    done={acted === 'md'}
                    onClick={() => void copy(toMarkdown(table), 'md')}
                  />
                  <ActionButton
                    icon={Download}
                    label={t('ledger.downloadCsv')}
                    text={t('ledger.downloadCsvShort')}
                    primary
                    done={acted === 'csv'}
                    onClick={downloadCsv}
                  />
                  {/* Only for rows that came from a walk we know how to repeat. */}
                  {ledger.extraction && onSaveTask && (
                    <ActionButton
                      icon={BookmarkPlus}
                      label={t('ledger.saveTask')}
                      done={acted === 'task'}
                      onClick={() => {
                        onSaveTask(
                          ledger.goal ?? '',
                          ledger.extraction!,
                          findings.map((f) => f.key),
                        );
                        setActed('task');
                      }}
                    />
                  )}
                </div>
              </div>

              {/* The grid scrolls inside its own box: a wide export must never
                  make the whole panel scroll sideways. */}
              <div className="-mx-1 overflow-x-auto px-1">
                <table className="w-max min-w-full border-collapse text-[10.5px]">
                  <thead>
                    <tr>
                      {table.columns.map((column) => (
                        <th
                          key={column}
                          scope="col"
                          className="border-b border-line px-1.5 py-1 text-left font-semibold text-fg-tertiary whitespace-nowrap"
                        >
                          {column}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {table.rows.slice(0, MAX_RENDERED_ROWS).map((row, i) => (
                      <tr key={i} className="align-top hover:bg-surface">
                        {row.map((cell, j) => (
                          <td
                            key={j}
                            className="max-w-[220px] truncate border-b border-line/50 px-1.5 py-1 text-fg-secondary"
                            title={cell}
                          >
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {hidden > 0 && (
                <p className="mt-1 text-[10px] text-fg-tertiary">
                  {t('ledger.rowsHidden', { count: hidden })}
                </p>
              )}
            </section>
          )}

          {ledger.notes.length > 0 && (
            <section>
              <h3 className="mb-1 font-semibold text-fg-tertiary uppercase tracking-wide text-[10px]">
                {t('ledger.notes')}
              </h3>
              <ul className="space-y-0.5 text-fg-tertiary">
                {ledger.notes.map((note, i) => (
                  <li key={i}>{note}</li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
