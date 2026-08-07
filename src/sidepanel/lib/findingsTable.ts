import type { Finding } from '../../lib/ledger/types';

/**
 * Findings, viewed as a spreadsheet.
 *
 * The ledger holds two quite different things under one type. A research task
 * saves a handful of findings whose worth is in the prose — key, summary, the
 * quote that proves it. extract_rows saves one finding per table row, where the
 * prose is noise and `data` is the whole point.
 *
 * So the shape is inferred rather than fixed: when every finding carries `data`
 * that already contains its own key, the rows came from an extraction and the
 * table is exactly those columns. Anything else keeps the columns a reader of a
 * research result would want.
 */

export interface FindingsTable {
  columns: string[];
  rows: string[][];
}

const KEY_COLUMN = 'Key';
const SUMMARY_COLUMN = 'Summary';
const EVIDENCE_COLUMN = 'Evidence';

function cellText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** Union of every row's data keys, in the order they were first seen. */
function dataColumns(findings: Finding[]): string[] {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const finding of findings) {
    for (const name of Object.keys(finding.data ?? {})) {
      if (seen.has(name)) continue;
      seen.add(name);
      columns.push(name);
    }
  }
  return columns;
}

/**
 * True when the findings are extracted rows: every one has data, and its key is
 * one of the values in that data — which is what extract_rows guarantees by
 * keying each row on one of its own fields.
 */
function isExtraction(findings: Finding[], columns: string[]): boolean {
  if (columns.length === 0) return false;
  return findings.every(
    (finding) =>
      finding.data !== undefined &&
      Object.values(finding.data).some((value) => cellText(value) === finding.key),
  );
}

/**
 * A whole result set stuffed into one finding's `data`, as
 * `{ columns: [...], rows: [{…}, {…}] }` or similar.
 *
 * The model does this whenever it collects a list by hand instead of through
 * extract_rows, and the ledger has no way to stop it: `data` is an open record.
 * Rendered by the ordinary path it produces a single row with JSON blobs in two
 * cells, which is what a real export looked like the first time it was tried.
 * A finding whose data is a table is a table.
 */
function embeddedRows(finding: Finding): Record<string, unknown>[] | undefined {
  if (!finding.data) return undefined;
  for (const value of Object.values(finding.data)) {
    if (
      Array.isArray(value) &&
      value.length >= 2 &&
      value.every((row) => typeof row === 'object' && row !== null && !Array.isArray(row))
    ) {
      return value as Record<string, unknown>[];
    }
  }
  return undefined;
}

export function toTable(findings: Finding[]): FindingsTable {
  // Only when *every* finding carries one: a mix means the embedded array is
  // some incidental field rather than the result the user is after.
  const embedded = findings.map(embeddedRows);
  if (findings.length > 0 && embedded.every((rows) => rows !== undefined)) {
    const rows = embedded.flat() as Record<string, unknown>[];
    const columns: string[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      for (const name of Object.keys(row)) {
        if (seen.has(name)) continue;
        seen.add(name);
        columns.push(name);
      }
    }
    if (columns.length > 0) {
      return { columns, rows: rows.map((row) => columns.map((name) => cellText(row[name]))) };
    }
  }

  const data = dataColumns(findings);

  if (isExtraction(findings, data)) {
    return {
      columns: data,
      rows: findings.map((finding) => data.map((name) => cellText(finding.data?.[name]))),
    };
  }

  const hasEvidence = findings.some((finding) => finding.evidence);
  const columns = [
    KEY_COLUMN,
    SUMMARY_COLUMN,
    ...(hasEvidence ? [EVIDENCE_COLUMN] : []),
    ...data,
  ];
  return {
    columns,
    rows: findings.map((finding) => [
      finding.key,
      finding.summary,
      ...(hasEvidence ? [finding.evidence ?? ''] : []),
      ...data.map((name) => cellText(finding.data?.[name])),
    ]),
  };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function csvCell(text: string): string {
  // Quote when the cell contains a delimiter, a quote, or any newline; inner
  // quotes double per RFC 4180.
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Excel and WPS decode a CSV as the system codepage unless it opens with a
 * UTF-8 BOM — without these three bytes every Chinese export is mojibake, which
 * is the first thing a user would see and the last time they would try.
 */
export const CSV_BOM = '﻿';

export function toCsv(table: FindingsTable): string {
  const lines = [table.columns, ...table.rows].map((row) => row.map(csvCell).join(','));
  // CRLF for the same reason as the BOM: it is what Excel expects.
  return CSV_BOM + lines.join('\r\n');
}

/**
 * The clipboard form. Pasting TSV into Excel, WPS or a Feishu sheet lands one
 * cell per column, which is how this actually gets used day to day — more often
 * than a downloaded file.
 */
export function toTsv(table: FindingsTable): string {
  const flat = (text: string) => text.replace(/[\t\r\n]+/g, ' ');
  return [table.columns, ...table.rows].map((row) => row.map(flat).join('\t')).join('\n');
}

export function toMarkdown(table: FindingsTable): string {
  const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const line = (row: string[]) => `| ${row.map(cell).join(' | ')} |`;
  return [
    line(table.columns),
    `| ${table.columns.map(() => '---').join(' | ')} |`,
    ...table.rows.map(line),
  ].join('\n');
}

/** A filename that sorts by run and says what it holds. */
export function exportFilename(goal: string | null, extension: string): string {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const name = (goal ?? 'pagehand')
    .trim()
    .slice(0, 40)
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${name || 'pagehand'}-${stamp}.${extension}`;
}
