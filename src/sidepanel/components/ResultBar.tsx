import { useEffect, useMemo, useState } from 'react';
import { Check, Download, Table2 } from 'lucide-react';
import type { TaskLedger } from '../../lib/ledger/types';
import { toTable } from '../lib/findingsTable';
import { copyTableToClipboard, downloadCsvFile } from '../lib/exportActions';
import { useT } from '../i18n/useT';
import { Button } from './ui/button';

/**
 * The finished table, offered where the user is standing.
 *
 * The ledger panel holds the same two buttons, but it is pinned to the top of
 * the side panel — and a run long enough to be worth exporting ends with the
 * user reading the last message at the bottom, several screens below it. The
 * first person to try this reported not being able to find the download at all.
 */
export default function ResultBar({ ledger }: { ledger: TaskLedger }) {
  const t = useT();
  const [acted, setActed] = useState<string | null>(null);
  const table = useMemo(() => toTable(ledger.findings), [ledger.findings]);

  useEffect(() => {
    if (!acted) return;
    const timer = setTimeout(() => setActed(null), 1500);
    return () => clearTimeout(timer);
  }, [acted]);

  return (
    <div className="mb-1.5 flex items-center gap-1.5 rounded-xl border border-line bg-surface px-2.5 py-1.5">
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg-secondary">
        {t('result.ready', { count: table.rows.length })}
      </span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-6 shrink-0 gap-1 px-1.5 text-[10px]"
        onClick={() => void copyTableToClipboard(table).then(() => setActed('tsv'))}
        title={t('ledger.copyTable')}
        aria-label={t('ledger.copyTable')}
      >
        {acted === 'tsv' ? <Check className="size-3" /> : <Table2 className="size-3" />}
      </Button>
      <Button
        type="button"
        size="sm"
        className="h-6 shrink-0 gap-1 px-2 text-[10px]"
        onClick={() => {
          downloadCsvFile(table, ledger.goal);
          setActed('csv');
        }}
        title={t('ledger.downloadCsv')}
      >
        {acted === 'csv' ? <Check className="size-3" /> : <Download className="size-3" />}
        {t('ledger.downloadCsvShort')}
      </Button>
    </div>
  );
}
