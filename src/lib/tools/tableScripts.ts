/**
 * Everything the table tools run *inside* the page, plus the types and
 * validation that describe it.
 *
 * Split out from tableTools.ts because this module has no imports and must keep
 * none: the Playwright specs run these scripts in a real renderer, and pulling
 * in the settings store (and with it `import.meta.env`) would put the code most
 * worth testing behind a bundler.
 */

/** Fewer repeats than this is a nav menu or a widget, not a data list. */
const MIN_REPEAT = 4;
const MAX_CANDIDATES = 3;
const MAX_SAMPLE_CELLS = 25;

export const SAMPLE_ROWS = 2;
export const MAX_FIELDS = 12;
export const MAX_CELL_CHARS = 200;
export const DEFAULT_MAX_PAGES = 10;
export const MAX_MAX_PAGES = 50;
/** Time for a click/scroll to bring the next batch in before we read again. */
export const PAGE_SETTLE_MS = 1_200;

export interface SchemaField {
  name: string;
  /** Selector relative to the row element. Empty string means the row itself. */
  selector: string;
  /** Read this attribute instead of the text — 'href', 'src', 'title', … */
  attr?: string;
}

export type NextPage =
  | { kind: 'click'; selector: string }
  | { kind: 'scroll' }
  | { kind: 'url'; param: string }
  | { kind: 'none' };

export interface RowSchema {
  rowSelector: string;
  fields: SchemaField[];
  /** Field whose value identifies a row across pages and re-runs. */
  keyField: string;
  nextPage: NextPage;
}

export type ExtractedRow = Record<string, string>;

// ---------------------------------------------------------------------------
// Page-side probes
// ---------------------------------------------------------------------------

/**
 * Shared helpers injected into every page script. cssPath builds a selector we
 * can hand back to the page later; ids are used when they look stable (a
 * framework-generated `:r7:` or `ember1043` is not), otherwise an nth-of-type
 * chain, which survives re-renders better than class soup does.
 */
const PAGE_HELPERS = `
  const STABLE_ID = /^[A-Za-z][\\w-]{2,40}$/;
  const GENERATED_ID = /^(:|ember|react-|radix-|mui-|headlessui-|v-|_)/;
  const isStableId = (id) => !!id && STABLE_ID.test(id) && !GENERATED_ID.test(id) && !/\\d{6,}/.test(id);
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^\\w-]/g, '\\\\$&'));

  const nth = (el) => {
    const tag = el.tagName.toLowerCase();
    const parent = el.parentElement;
    if (!parent) return tag;
    const sibs = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
    return sibs.length > 1 ? tag + ':nth-of-type(' + (sibs.indexOf(el) + 1) + ')' : tag;
  };

  const cssPath = (el, root) => {
    const parts = [];
    let node = el;
    while (node && node !== root && node.nodeType === 1 && parts.length < 8) {
      if (!root && isStableId(node.id)) {
        parts.unshift('#' + esc(node.id));
        return parts.join(' > ');
      }
      parts.unshift(nth(node));
      node = node.parentElement;
    }
    return parts.join(' > ');
  };

  const textOf = (el) => ((el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' '));
  const inChrome = (el) => !!el.closest('nav, header, footer, aside, [role="navigation"]');

  // Classes carrying digits are hashed or utility classes (css-1x2y3z, mb-2) —
  // they identify a build, not a thing.
  const namedClasses = (el) => Array.from(el.classList).filter((c) => !/\\d/.test(c));

  /**
   * A row selector must match every row, so the last hop is the row's shape
   * (tag + meaningful classes) and never an nth-of-type, which would pin the
   * selector to row one and quietly export a single line.
   */
  const rowPath = (el) => {
    const shape = el.tagName.toLowerCase() + namedClasses(el).slice(0, 2).map((c) => '.' + esc(c)).join('');
    const parent = el.parentElement;
    const base = parent ? cssPath(parent) : '';
    return base ? base + ' > ' + shape : shape;
  };

  /** Within a row, a unique class beats a positional path: it survives re-renders. */
  const cellPath = (row, el) => {
    for (const cls of namedClasses(el)) {
      if (row.querySelectorAll('.' + esc(cls)).length === 1) return '.' + esc(cls);
    }
    return cssPath(el, row);
  };
`;

/**
 * Finds repeating structures that look like data rows. Real tables score
 * highest; beyond those, any container whose children share a shape is a
 * candidate, ranked by how much text each repeat carries — the test that
 * separates a list of orders from a list of menu links.
 */
export const PROBE_LISTS = `() => {
  ${PAGE_HELPERS}
  const MIN = ${MIN_REPEAT};
  const candidates = [];

  const sampleCells = (row) => {
    const cells = [];
    const seen = new Set();
    for (const el of row.querySelectorAll('*')) {
      if (el.children.length > 0) continue;
      const text = textOf(el);
      const href = el.tagName === 'A' ? el.href : '';
      if (!text && !href) continue;
      const sel = cellPath(row, el);
      if (seen.has(sel)) continue;
      seen.add(sel);
      cells.push({ sel, text: text.slice(0, 120), ...(href ? { href } : {}) });
      if (cells.length >= ${MAX_SAMPLE_CELLS}) break;
    }
    return cells;
  };

  /**
   * What this list appears to be, in the page's own words: the nearest heading
   * above it, or a label on one of its ancestors. Row shape alone cannot tell
   * an order table from a thread of messages, and a model asked to choose
   * between two candidates on count and text length is guessing.
   */
  const labelFor = (el) => {
    let node = el;
    while (node && node !== document.body) {
      for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
        const h = sib.matches('h1,h2,h3,h4,h5,h6') ? sib : sib.querySelector('h1,h2,h3,h4,h5,h6');
        if (h && textOf(h)) return textOf(h).slice(0, 80);
      }
      const label = node.getAttribute('aria-label') || node.getAttribute('data-testid') || '';
      if (label) return label.slice(0, 80);
      node = node.parentElement;
    }
    return '';
  };

  const push = (container, rows, kind) => {
    if (rows.length < MIN) return;
    const chars = rows.reduce((sum, r) => sum + textOf(r).length, 0) / rows.length;
    if (chars < 8) return;
    // Records tend to link somewhere — to a detail page, a profile, an order.
    // Chrome and widgets tend not to, and this separates them where text
    // length does not.
    const linked = rows.filter((r) => r.querySelector('a[href]')).length / rows.length;
    const inMain = !!container.closest('main, [role="main"], article');
    candidates.push({
      rowSelector: rowPath(rows[0]),
      containerSelector: cssPath(container),
      kind,
      label: labelFor(container),
      count: rows.length,
      avgChars: Math.round(chars),
      linkedRatio: Math.round(linked * 100) / 100,
      inMain,
      score: Math.round(
        chars *
          Math.log(rows.length + 1) *
          (inChrome(container) ? 0.2 : 1) *
          (kind === 'table' ? 2 : 1) *
          (inMain ? 1.3 : 1) *
          (linked > 0.5 ? 1.2 : 1),
      ),
      headers: kind === 'table'
        ? Array.from(container.querySelectorAll('th')).map((th) => textOf(th).slice(0, 60)).slice(0, ${MAX_FIELDS})
        : [],
      samples: rows.slice(0, ${SAMPLE_ROWS}).map(sampleCells),
    });
  };

  for (const table of document.querySelectorAll('table')) {
    const body = table.tBodies[0] || table;
    push(table, Array.from(body.rows || []).filter((r) => r.cells.length > 0), 'table');
  }

  for (const parent of document.querySelectorAll('body *')) {
    if (parent.children.length < MIN) continue;
    if (parent.closest('table')) continue;
    const groups = new Map();
    for (const child of parent.children) {
      const key = child.tagName + '|' + Array.from(child.classList).sort().slice(0, 3).join('.');
      const group = groups.get(key);
      if (group) group.push(child);
      else groups.set(key, [child]);
    }
    let best = [];
    for (const group of groups.values()) if (group.length > best.length) best = group;
    push(parent, best, 'repeat');
  }

  candidates.sort((a, b) => b.score - a.score);
  // Only three candidates are shown, and a footer's four links are not a choice
  // anyone would make — offering them costs a slot a real sub-list could use.
  // A floor relative to the leader says that without naming any one region: far
  // enough below the best and it is noise, whatever it is made of.
  const floor = (candidates[0]?.score ?? 0) * 0.15;
  const top = [];
  for (const c of candidates) {
    if (c.score < floor) break;
    // One candidate per row shape: a list and its wrapper describe the same rows.
    if (top.some((t) => t.rowSelector === c.rowSelector)) continue;
    // A list sitting inside another candidate's rows is a level down from it —
    // messages within a thread, tags within a product. Saying so lets the model
    // choose the level the user asked for instead of inferring it from size.
    c.nestedInside = top.find((t) => {
      try {
        const outer = document.querySelector(t.containerSelector);
        const inner = document.querySelector(c.containerSelector);
        return outer && inner && outer !== inner && outer.contains(inner);
      } catch {
        return false;
      }
    })?.rowSelector ?? null;
    top.push(c);
    if (top.length >= ${MAX_CANDIDATES}) break;
  }
  return { url: location.href, title: document.title, candidates: top };
}`;

/** Anything that could carry us to page 2, for the model to choose between. */
export const PROBE_PAGINATION = `() => {
  ${PAGE_HELPERS}
  const NEXT = /^(next|next page|下一页|下一頁|下页|›|»|>)$/i;
  const MORE = /(load more|show more|view more|加载更多|查看更多|展开更多|更多)/i;
  const controls = [];
  const add = (el, label, why) => {
    if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    controls.push({ selector: cssPath(el), label: label.slice(0, 60), why });
  };

  const relNext = document.querySelector('a[rel="next"], link[rel="next"]');
  if (relNext) add(relNext, textOf(relNext) || 'rel=next', 'rel-next');

  for (const el of document.querySelectorAll('a, button, [role="button"]')) {
    const label = textOf(el) || el.getAttribute('aria-label') || el.title || '';
    if (NEXT.test(label.trim())) add(el, label, 'next-label');
    else if (MORE.test(label)) add(el, label, 'load-more');
    if (controls.length >= 8) break;
  }

  const params = [];
  for (const [k, v] of new URL(location.href).searchParams) {
    if (/^(page|p|pn|pageno|pageindex|pagenum|offset|start)$/i.test(k) && /^\\d+$/.test(v)) {
      params.push({ param: k, value: Number(v) });
    }
  }

  return {
    controls,
    urlParams: params,
    scrollable: document.documentElement.scrollHeight > window.innerHeight * 1.5,
  };
}`;

/** Replays a schema over whatever is currently rendered. Zero model tokens. */
export const EXTRACT_WITH_SCHEMA = `(schema, maxCells) => {
  const rows = [];
  const nodes = document.querySelectorAll(schema.rowSelector);
  for (const node of nodes) {
    const row = {};
    let filled = 0;
    for (const field of schema.fields) {
      const target = field.selector ? node.querySelector(field.selector) : node;
      if (!target) { row[field.name] = ''; continue; }
      let value;
      if (field.attr === 'href' || field.attr === 'src') value = target[field.attr] || '';
      else if (field.attr) value = target.getAttribute(field.attr) || '';
      else value = (target.innerText || target.textContent || '').trim().replace(/\\s+/g, ' ');
      value = String(value).slice(0, maxCells);
      if (value) filled++;
      row[field.name] = value;
    }
    // A selector that matches headers or spacers yields empty rows — drop them.
    if (filled > 0) rows.push(row);
  }
  return { rows, matched: nodes.length, url: location.href };
}`;

/**
 * Advances one page and reports whether anything actually changed. The caller
 * needs that answer more than it needs the click to succeed: a "next" button
 * that stays enabled on the last page is the normal way these loops run
 * forever.
 */
export const GO_NEXT_PAGE = `async (next, rowSelector, settleMs) => {
  const before = document.querySelectorAll(rowSelector).length;
  const firstText = (document.querySelector(rowSelector)?.innerText || '').slice(0, 200);
  const urlBefore = location.href;

  if (next.kind === 'click') {
    const el = document.querySelector(next.selector);
    if (!el) return { advanced: false, reason: 'next-control-gone' };
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
      return { advanced: false, reason: 'next-control-disabled' };
    }
    el.scrollIntoView({ block: 'center' });
    el.click();
  } else if (next.kind === 'scroll') {
    window.scrollTo(0, document.documentElement.scrollHeight);
  } else {
    return { advanced: false, reason: 'no-pagination' };
  }

  await new Promise((r) => setTimeout(r, settleMs));

  const after = document.querySelectorAll(rowSelector).length;
  const firstAfter = (document.querySelector(rowSelector)?.innerText || '').slice(0, 200);
  const advanced = location.href !== urlBefore || after > before || firstAfter !== firstText;
  return { advanced, before, after, reason: advanced ? 'ok' : 'page-unchanged' };
}`;


/** Models wrap JSON in fences despite instructions — tolerate it. */
export function parseModelJson(raw: string): unknown | undefined {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const NEXT_KINDS = new Set(['click', 'scroll', 'url', 'none']);

// ---------------------------------------------------------------------------
// Deterministic fallback
// ---------------------------------------------------------------------------

/** Shapes of the probe output this module needs to build a schema unaided. */
export interface ProbeCell {
  sel: string;
  text: string;
  href?: string;
}
export interface ProbeCandidate {
  rowSelector: string;
  kind: string;
  headers?: string[];
  samples?: ProbeCell[][];
}
export interface ProbePagination {
  controls?: { selector: string; label: string; why: string }[];
  urlParams?: { param: string; value: number }[];
  scrollable?: boolean;
}

/** `.order-id` / `td:nth-of-type(2)` → something a column heading could say. */
function nameForCell(cell: ProbeCell, index: number): string {
  const fromClass = cell.sel.startsWith('.')
    ? cell.sel.slice(1).replace(/[-_]+/g, ' ').trim()
    : '';
  return fromClass || `列${index + 1}`;
}

/**
 * Builds a schema from the probe alone, with no model involved.
 *
 * The reason this exists: infer_row_schema used to throw when the model replied
 * with anything unparseable, and a model that returns an empty string is not a
 * rare event. The agent's response to that was to hand-roll the extraction with
 * evaluate_script — which works, and puts every row in the conversation instead
 * of the ledger, so the user is told "I got 9 rows" and has nothing to download.
 * A worse schema that still lands rows in the ledger beats a perfect one that
 * never runs.
 *
 * Columns come out named after their own selectors rather than the page's
 * language, which is exactly the part worth having a model for — so this stays
 * a fallback, not the default path.
 */
export function schemaFromProbe(
  candidates: ProbeCandidate[],
  pagination: ProbePagination | undefined,
): RowSchema | undefined {
  // The probe already ranked these; the leader is the best guess available.
  const best = candidates?.[0];
  const cells = best?.samples?.[0];
  if (!best || !cells || cells.length === 0) return undefined;

  const fields: SchemaField[] = [];
  const seen = new Set<string>();
  cells.slice(0, MAX_FIELDS).forEach((cell, i) => {
    const name = (best.kind === 'table' && best.headers?.[i]) || nameForCell(cell, i);
    if (seen.has(name)) return;
    seen.add(name);
    fields.push({ name, selector: cell.sel });
  });

  // A row that links somewhere gets that link as a column, and as its key: a
  // URL is the one field on a page reliably unique per row.
  const linkCell = cells.find((cell) => cell.href);
  let keyField = fields[0]?.name ?? '';
  if (linkCell && fields.length < MAX_FIELDS && !seen.has('链接')) {
    fields.push({ name: '链接', selector: linkCell.sel, attr: 'href' });
    keyField = '链接';
  }
  if (fields.length === 0) return undefined;

  const controls = pagination?.controls ?? [];
  const next =
    controls.find((c) => c.why === 'next-label') ??
    controls.find((c) => c.why === 'rel-next') ??
    controls.find((c) => c.why === 'load-more');
  const param = pagination?.urlParams?.[0]?.param;

  let nextPage: NextPage = { kind: 'none' };
  if (next) nextPage = { kind: 'click', selector: next.selector };
  else if (param) nextPage = { kind: 'url', param };
  else if (pagination?.scrollable) nextPage = { kind: 'scroll' };

  return { rowSelector: best.rowSelector, fields, keyField, nextPage };
}

/**
 * Validates and normalizes what the model returned. Anything malformed is
 * dropped rather than trusted: this schema is about to be replayed unattended
 * across dozens of pages, so a bad field here is a bad column everywhere.
 */
export function normalizeSchema(raw: unknown): RowSchema | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.rowSelector !== 'string' || obj.rowSelector.trim() === '') return undefined;
  if (!Array.isArray(obj.fields)) return undefined;

  const seen = new Set<string>();
  const fields: SchemaField[] = [];
  for (const item of obj.fields) {
    if (typeof item !== 'object' || item === null) continue;
    const field = item as Record<string, unknown>;
    const name = typeof field.name === 'string' ? field.name.trim() : '';
    if (!name || seen.has(name)) continue;
    if (typeof field.selector !== 'string') continue;
    seen.add(name);
    fields.push({
      name,
      selector: field.selector.trim(),
      ...(typeof field.attr === 'string' && field.attr.trim() !== ''
        ? { attr: field.attr.trim() }
        : {}),
    });
    if (fields.length >= MAX_FIELDS) break;
  }
  if (fields.length === 0) return undefined;

  const rawNext = (typeof obj.nextPage === 'object' && obj.nextPage !== null
    ? (obj.nextPage as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const kind = typeof rawNext.kind === 'string' && NEXT_KINDS.has(rawNext.kind) ? rawNext.kind : 'none';
  let nextPage: NextPage = { kind: 'none' };
  if (kind === 'click' && typeof rawNext.selector === 'string' && rawNext.selector.trim() !== '') {
    nextPage = { kind: 'click', selector: rawNext.selector.trim() };
  } else if (kind === 'scroll') {
    nextPage = { kind: 'scroll' };
  } else if (kind === 'url' && typeof rawNext.param === 'string' && rawNext.param.trim() !== '') {
    nextPage = { kind: 'url', param: rawNext.param.trim() };
  }

  const named = typeof obj.keyField === 'string' ? obj.keyField.trim() : '';
  // A key that names no field would silently collapse every row onto one entry.
  const keyField = fields.some((f) => f.name === named) ? named : fields[0].name;

  return { rowSelector: obj.rowSelector.trim(), fields, keyField, nextPage };
}
