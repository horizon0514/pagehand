import { exportFilename, toCsv, toTsv, type FindingsTable } from './findingsTable';

/**
 * The two things anyone does with a finished table, shared by the ledger panel
 * and the bar above the composer.
 *
 * Both surfaces exist on purpose. The panel is pinned to the top of the side
 * panel, which is the wrong end of a long run — by the time an export finishes,
 * the user is reading the last message at the bottom and the result is
 * off-screen above them. The bar puts the same two actions where they are
 * looking; this module is what keeps the two from drifting apart.
 */

export function downloadCsvFile(table: FindingsTable, goal: string | null): void {
  const blob = new Blob([toCsv(table)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = exportFilename(goal, 'csv');
  anchor.click();
  URL.revokeObjectURL(url);
}

export function copyTableToClipboard(table: FindingsTable): Promise<void> {
  return navigator.clipboard.writeText(toTsv(table));
}
