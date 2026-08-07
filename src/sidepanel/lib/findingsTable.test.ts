import { describe, it, expect } from 'vitest';
import { CSV_BOM, exportFilename, toCsv, toMarkdown, toTable, toTsv } from './findingsTable';
import type { Finding } from '../../lib/ledger/types';

function finding(partial: Partial<Finding> & Pick<Finding, 'key' | 'summary'>): Finding {
  return { createdAt: 0, ...partial };
}

const extracted: Finding[] = [
  finding({
    key: 'A-1',
    summary: '张三 · ¥120',
    data: { 订单号: 'A-1', 买家: '张三', 金额: '¥120' },
  }),
  finding({
    key: 'A-2',
    summary: '李四 · ¥80',
    data: { 订单号: 'A-2', 买家: '李四', 金额: '¥80' },
  }),
];

const researched: Finding[] = [
  finding({ key: 'user-1', summary: 'wants to sell', evidence: '房子想卖' }),
  finding({ key: 'user-2', summary: 'just browsing' }),
];

describe('toTable', () => {
  it('gives extracted rows exactly their own columns', () => {
    expect(toTable(extracted)).toEqual({
      columns: ['订单号', '买家', '金额'],
      rows: [
        ['A-1', '张三', '¥120'],
        ['A-2', '李四', '¥80'],
      ],
    });
  });

  it('keeps key, summary and evidence for research findings', () => {
    const table = toTable(researched);
    expect(table.columns).toEqual(['Key', 'Summary', 'Evidence']);
    expect(table.rows[1]).toEqual(['user-2', 'just browsing', '']);
  });

  it('drops the evidence column when nothing has evidence', () => {
    expect(toTable([researched[1]]).columns).toEqual(['Key', 'Summary']);
  });

  it('falls back to the labelled shape when a row has no data of its own', () => {
    const table = toTable([...extracted, researched[0]]);
    expect(table.columns).toEqual(['Key', 'Summary', 'Evidence', '订单号', '买家', '金额']);
    expect(table.rows[2]).toEqual(['user-1', 'wants to sell', '房子想卖', '', '', '']);
  });

  it('unions columns across rows that do not agree on fields', () => {
    const table = toTable([
      finding({ key: '1', summary: 'a', data: { id: '1', name: 'a' } }),
      finding({ key: '2', summary: 'b', data: { id: '2', price: '9' } }),
    ]);
    expect(table.columns).toEqual(['id', 'name', 'price']);
    expect(table.rows[1]).toEqual(['2', '', '9']);
  });

  it('renders non-string cells rather than dropping them', () => {
    const table = toTable([
      finding({ key: '7', summary: 's', data: { id: 7, ok: true, tags: ['a'], gone: null } }),
    ]);
    expect(table.rows[0]).toEqual(['7', 'true', '["a"]', '']);
  });
});

describe('toCsv', () => {
  it('leads with a UTF-8 BOM so Excel does not mojibake Chinese', () => {
    expect(toCsv(toTable(extracted)).startsWith(CSV_BOM)).toBe(true);
  });

  it('uses CRLF and a header row', () => {
    const csv = toCsv(toTable(extracted));
    expect(csv.slice(CSV_BOM.length).split('\r\n')[0]).toBe('订单号,买家,金额');
    expect(csv.split('\r\n')).toHaveLength(3);
  });

  it('quotes cells containing commas, quotes or newlines', () => {
    const csv = toCsv({
      columns: ['a', 'b', 'c'],
      rows: [['x,y', 'say "hi"', 'line1\nline2']],
    });
    expect(csv).toContain('"x,y"');
    expect(csv).toContain('"say ""hi"""');
    expect(csv).toContain('"line1\nline2"');
  });
});

describe('toTsv', () => {
  it('is one cell per column with no BOM, for pasting into a sheet', () => {
    const tsv = toTsv(toTable(extracted));
    expect(tsv.split('\n')[0]).toBe('订单号\t买家\t金额');
    expect(tsv.startsWith(CSV_BOM)).toBe(false);
  });

  it('flattens tabs and newlines so a cell cannot break the grid', () => {
    const tsv = toTsv({ columns: ['a'], rows: [['x\ty\nz']] });
    expect(tsv.split('\n')).toHaveLength(2);
    expect(tsv.split('\n')[1]).toBe('x y z');
  });
});

describe('toMarkdown', () => {
  it('writes a header, a divider and one line per row', () => {
    const lines = toMarkdown(toTable(extracted)).split('\n');
    expect(lines[0]).toBe('| 订单号 | 买家 | 金额 |');
    expect(lines[1]).toBe('| --- | --- | --- |');
    expect(lines).toHaveLength(4);
  });

  it('escapes pipes so a cell cannot forge a column', () => {
    expect(toMarkdown({ columns: ['a'], rows: [['x|y']] })).toContain('x\\|y');
  });
});

describe('exportFilename', () => {
  it('builds a name from the goal and the extension', () => {
    expect(exportFilename('导出订单列表', 'csv')).toMatch(/^导出订单列表-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.csv$/);
  });

  it('strips characters a filesystem would reject', () => {
    expect(exportFilename('a/b:c*d?"<>|e', 'csv')).toMatch(/^a-b-c-d-e-/);
  });

  it('falls back when there is no goal', () => {
    expect(exportFilename(null, 'tsv')).toMatch(/^pagehand-/);
    expect(exportFilename('   ', 'csv')).toMatch(/^pagehand-/);
  });
});

/**
 * What a real export produced the first time it was tried: infer_row_schema
 * failed, the agent collected the list by hand, and dropped all nine rows into
 * one finding's `data`. The ordinary path renders that as a single row with two
 * JSON blobs in it — a CSV nobody can use.
 */
describe('toTable with a result set embedded in one finding', () => {
  const dumped: Finding[] = [
    finding({
      key: 'supabase-signin-emails',
      summary: '9 emails in the thread',
      evidence: 'Extracted 9 listitems',
      data: {
        columns: ['sender', 'subject', 'time'],
        rows: [
          { sender: 'Supabase Auth', subject: 'Your sign-in link', time: '13:38' },
          { sender: 'Supabase Auth', subject: 'Your sign-in link', time: '15:52' },
          { sender: 'Supabase Auth', subject: 'Your sign-in link', time: '16:10' },
        ],
      },
    }),
  ];

  it('unwraps the rows instead of serializing them into a cell', () => {
    const table = toTable(dumped);
    expect(table.columns).toEqual(['sender', 'subject', 'time']);
    expect(table.rows).toHaveLength(3);
    expect(table.rows[0]).toEqual(['Supabase Auth', 'Your sign-in link', '13:38']);
  });

  it('produces a CSV with a row per record, not one row of JSON', () => {
    const csv = toCsv(toTable(dumped));
    expect(csv.split('\r\n')).toHaveLength(4);
    expect(csv).not.toContain('[{');
  });

  it('concatenates when several findings each carry a batch', () => {
    const second = finding({
      key: 'batch-2',
      summary: 'more',
      data: { rows: [{ sender: 'A', subject: 'x', time: '1' }, { sender: 'B', subject: 'y', time: '2' }] },
    });
    expect(toTable([...dumped, second]).rows).toHaveLength(5);
  });

  it('leaves ordinary findings alone, however array-ish their data', () => {
    // One finding with a batch and one without is not a result set.
    const mixed = [...dumped, finding({ key: 'k', summary: 's' })];
    expect(toTable(mixed).columns).toContain('Key');

    // A single short array is a field, not a table.
    const tagged = [finding({ key: 'k', summary: 's', data: { tags: [{ a: 1 }] } })];
    expect(toTable(tagged).columns).toContain('Key');
  });
});
