import { describe, it, expect } from 'vitest';
import { buildSchemaPrompt, rowsToMutations } from './tableTools';
import {
  normalizeSchema,
  parseModelJson,
  schemaFromProbe,
  type ProbeCandidate,
  type RowSchema,
} from './tableScripts';

const schema: RowSchema = {
  rowSelector: 'table > tbody > tr',
  fields: [
    { name: '订单号', selector: 'td:nth-of-type(1)' },
    { name: '买家', selector: 'td:nth-of-type(2)' },
    { name: '金额', selector: 'td:nth-of-type(3)' },
    { name: '链接', selector: 'a', attr: 'href' },
  ],
  keyField: '订单号',
  nextPage: { kind: 'click', selector: '.pager .next' },
};

describe('parseModelJson', () => {
  it('parses plain JSON and JSON wrapped in fences', () => {
    expect(parseModelJson('{"rowSelector":"tr"}')).toEqual({ rowSelector: 'tr' });
    expect(parseModelJson('```json\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  it('returns undefined for prose', () => {
    expect(parseModelJson('I could not find a list on this page.')).toBeUndefined();
  });
});

describe('buildSchemaPrompt', () => {
  it('carries both probes so the model can pick a list and a pager', () => {
    const prompt = buildSchemaPrompt(
      { candidates: [{ rowSelector: 'tr', count: 20 }] },
      { controls: [{ selector: '.next', label: '下一页' }] },
    );
    expect(prompt).toContain('Candidate row structures:');
    expect(prompt).toContain('"rowSelector":"tr"');
    expect(prompt).toContain('Candidate pagination controls:');
    expect(prompt).toContain('下一页');
  });
});

describe('normalizeSchema', () => {
  it('accepts a well-formed schema unchanged', () => {
    expect(normalizeSchema(schema)).toEqual(schema);
  });

  it('rejects input with no rowSelector or no usable fields', () => {
    expect(normalizeSchema(null)).toBeUndefined();
    expect(normalizeSchema({ fields: [{ name: 'a', selector: '' }] })).toBeUndefined();
    expect(normalizeSchema({ rowSelector: 'tr', fields: [] })).toBeUndefined();
    expect(normalizeSchema({ rowSelector: 'tr', fields: [{ name: 'a' }] })).toBeUndefined();
  });

  it('drops malformed and duplicate fields but keeps the good ones', () => {
    const result = normalizeSchema({
      rowSelector: 'li',
      fields: [
        { name: 'name', selector: '.n' },
        { name: 'name', selector: '.other' },
        { name: '', selector: '.x' },
        { name: 'price', selector: 42 },
        { name: 'url', selector: 'a', attr: 'href' },
      ],
      keyField: 'url',
      nextPage: { kind: 'scroll' },
    });
    expect(result?.fields).toEqual([
      { name: 'name', selector: '.n' },
      { name: 'url', selector: 'a', attr: 'href' },
    ]);
  });

  it('falls back to the first field when keyField names nothing', () => {
    const result = normalizeSchema({ ...schema, keyField: '不存在的列' });
    expect(result?.keyField).toBe('订单号');
  });

  it('downgrades pagination it cannot act on to none', () => {
    expect(normalizeSchema({ ...schema, nextPage: { kind: 'click' } })?.nextPage).toEqual({
      kind: 'none',
    });
    expect(normalizeSchema({ ...schema, nextPage: { kind: 'teleport' } })?.nextPage).toEqual({
      kind: 'none',
    });
    expect(normalizeSchema({ ...schema, nextPage: { kind: 'url' } })?.nextPage).toEqual({
      kind: 'none',
    });
    expect(normalizeSchema({ ...schema, nextPage: { kind: 'url', param: 'page' } })?.nextPage).toEqual(
      { kind: 'url', param: 'page' },
    );
  });

  it('caps field count so one bad reply cannot widen every page', () => {
    const fields = Array.from({ length: 30 }, (_, i) => ({ name: `f${i}`, selector: `.c${i}` }));
    expect(normalizeSchema({ rowSelector: 'tr', fields, keyField: 'f0' })?.fields).toHaveLength(12);
  });
});

describe('rowsToMutations', () => {
  const rows = [
    { 订单号: 'A-1', 买家: '张三', 金额: '¥120', 链接: 'https://shop/o/1' },
    { 订单号: 'A-2', 买家: '李四', 金额: '¥80', 链接: 'https://shop/o/2' },
  ];

  it('keys each row by keyField and keeps the whole row as data', () => {
    const mutations = rowsToMutations(rows, schema);
    expect(mutations).toHaveLength(2);
    expect(mutations[0]).toMatchObject({
      type: 'upsert_finding',
      finding: { key: 'A-1', data: rows[0] },
    });
  });

  it('summarizes with the non-key columns so the digest stays readable', () => {
    const [first] = rowsToMutations(rows, schema);
    expect(first.type === 'upsert_finding' && first.finding.summary).toBe(
      '张三 · ¥120 · https://shop/o/1',
    );
  });

  it('carries no evidence or rationale — the digest re-injects those every step', () => {
    const [first] = rowsToMutations(rows, schema);
    expect(first.type === 'upsert_finding' && first.finding.evidence).toBeUndefined();
    expect(first.type === 'upsert_finding' && first.finding.rationale).toBeUndefined();
  });

  it('rebuilds data in schema order, since CDP returns page objects key-sorted', () => {
    // What extract_rows actually receives back from the page: sorted, not the
    // order the fields were written in.
    const sorted = { 买家: '张三', 订单号: 'A-1', 金额: '¥120', 链接: 'https://shop/o/1' };
    const [first] = rowsToMutations([sorted], schema);
    expect(first.type === 'upsert_finding' && Object.keys(first.finding.data!)).toEqual([
      '订单号',
      '买家',
      '金额',
      '链接',
    ]);
  });

  it('fills a column the page had nothing for, so rows stay rectangular', () => {
    const [first] = rowsToMutations([{ 订单号: 'A-9' }], schema);
    expect(first.type === 'upsert_finding' && first.finding.data).toEqual({
      订单号: 'A-9',
      买家: '',
      金额: '',
      链接: '',
    });
  });

  it('falls back to the serialized row when the key cell is empty', () => {
    const [only] = rowsToMutations([{ 订单号: '', 买家: '王五', 金额: '', 链接: '' }], schema);
    expect(only.type === 'upsert_finding' && only.finding.key).toContain('王五');
  });
});

/**
 * The path that runs when the model returns nothing usable — which happened on
 * a real Gmail thread, and cost the user the export entirely: the tool threw,
 * the agent extracted the list by hand with evaluate_script, and the rows ended
 * up in the conversation rather than in the ledger the download button reads.
 */
describe('schemaFromProbe', () => {
  const candidate: ProbeCandidate = {
    rowSelector: '#orders > li.order-row',
    kind: 'repeat',
    samples: [
      [
        { sel: '.order-id', text: 'SO-2026-001', href: 'https://shop/orders/SO-2026-001' },
        { sel: '.buyer', text: '买家01' },
        { sel: '.amount', text: '¥240' },
      ],
    ],
  };

  it('builds a usable schema with no model involved', () => {
    const schema = schemaFromProbe([candidate], {});
    expect(schema?.rowSelector).toBe('#orders > li.order-row');
    expect(schema?.fields.map((f) => f.selector)).toEqual(['.order-id', '.buyer', '.amount', '.order-id']);
  });

  it('names columns after their own classes, since the page cannot name them', () => {
    expect(schemaFromProbe([candidate], {})?.fields.map((f) => f.name)).toEqual([
      'order id',
      'buyer',
      'amount',
      '链接',
    ]);
  });

  it('keys rows on the link, the one field reliably unique per row', () => {
    const schema = schemaFromProbe([candidate], {});
    expect(schema?.keyField).toBe('链接');
    expect(schema?.fields.at(-1)).toEqual({ name: '链接', selector: '.order-id', attr: 'href' });
  });

  it('falls back to the first column when no row links anywhere', () => {
    const noLinks: ProbeCandidate = {
      ...candidate,
      samples: [[{ sel: '.a', text: 'x' }, { sel: '.b', text: 'y' }]],
    };
    const schema = schemaFromProbe([noLinks], {});
    expect(schema?.keyField).toBe('a');
    expect(schema?.fields).toHaveLength(2);
  });

  it('uses table headers when the candidate is a real table', () => {
    const table: ProbeCandidate = {
      rowSelector: 'table > tbody > tr',
      kind: 'table',
      headers: ['订单号', '买家'],
      samples: [[{ sel: 'td:nth-of-type(1)', text: 'A-1' }, { sel: 'td:nth-of-type(2)', text: '张三' }]],
    };
    expect(schemaFromProbe([table], {})?.fields.map((f) => f.name)).toEqual(['订单号', '买家']);
  });

  it('names positional cells rather than dropping them', () => {
    const positional: ProbeCandidate = {
      rowSelector: 'li',
      kind: 'repeat',
      samples: [[{ sel: 'span:nth-of-type(1)', text: 'x' }]],
    };
    expect(schemaFromProbe([positional], {})?.fields[0].name).toBe('列1');
  });

  it('picks pagination in the same order of preference the prompt asks for', () => {
    const withNext = { controls: [{ selector: '.next', label: '下一页', why: 'next-label' }] };
    expect(schemaFromProbe([candidate], withNext)?.nextPage).toEqual({
      kind: 'click',
      selector: '.next',
    });
    expect(schemaFromProbe([candidate], { urlParams: [{ param: 'page', value: 1 }] })?.nextPage).toEqual(
      { kind: 'url', param: 'page' },
    );
    expect(schemaFromProbe([candidate], { scrollable: true })?.nextPage).toEqual({ kind: 'scroll' });
    expect(schemaFromProbe([candidate], {})?.nextPage).toEqual({ kind: 'none' });
  });

  it('gives up only when the probe itself found nothing to work with', () => {
    expect(schemaFromProbe([], {})).toBeUndefined();
    expect(schemaFromProbe([{ rowSelector: 'li', kind: 'repeat', samples: [[]] }], {})).toBeUndefined();
    expect(schemaFromProbe([{ rowSelector: 'li', kind: 'repeat' }], {})).toBeUndefined();
  });
});
