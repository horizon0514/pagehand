import { streamText, tool, type LanguageModel } from 'ai';
import { z } from 'zod';
import { ensureSession } from './context';
import { evaluateFunction } from '../cdp';
import { getSettings } from '../storage/settingsStore';
import { resolveModel } from '../llm/providers';
import { applyLedgerMutations, getActiveLedger } from '../ledger/activeLedger';
import { MAX_FINDINGS } from '../ledger/types';
import type { LedgerMutation } from '../ledger/activeLedger';
import {
  EXTRACT_WITH_SCHEMA,
  GO_NEXT_PAGE,
  PROBE_LISTS,
  PROBE_PAGINATION,
  normalizeSchema,
  parseModelJson,
  schemaFromProbe,
  DEFAULT_MAX_PAGES,
  MAX_CELL_CHARS,
  MAX_FIELDS,
  MAX_MAX_PAGES,
  PAGE_SETTLE_MS,
  SAMPLE_ROWS,
  type ExtractedRow,
  type ProbeCandidate,
  type ProbePagination,
  type RowSchema,
} from './tableScripts';

/**
 * Structured list extraction — the "export this table" path.
 *
 * extract_content already reads a page cheaply, but it pays a model call *per
 * page*: 20 pages of a paginated list is 20 side calls, which is the difference
 * between a feature that can be bundled into a subscription and one that cannot.
 *
 * These two tools split that in half. infer_row_schema spends one model call on
 * the first page to work out where the rows are, what the columns should be
 * called, and how to reach page 2. extract_rows then replays that schema over
 * every remaining page as plain DOM code — no tokens at all, however many pages
 * there are.
 *
 * The rows themselves never enter the conversation: like update_task_ledger,
 * extract_rows writes to the durable ledger and returns a small ack. A list
 * worth exporting is precisely a list too big to be worth reading aloud.
 */

// ---------------------------------------------------------------------------
// Schema inference (the one model call)
// ---------------------------------------------------------------------------

const SCHEMA_TIMEOUT_MS = 30_000;
const SCHEMA_OUTPUT_TOKENS = 1_500;

const SCHEMA_SYSTEM =
  'You turn a probe of a web page into a row-extraction schema. You are given candidate repeating ' +
  'structures with sample cells (each has a CSS selector relative to its row) and candidate pagination ' +
  'controls. Reply with ONLY a JSON object — no markdown fences, no commentary — of the shape: ' +
  '{"rowSelector": string, "fields": [{"name": string, "selector": string, "attr"?: "href"|"src"|string}], ' +
  '"keyField": string, "nextPage": {"kind": "click"|"scroll"|"url"|"none", "selector"?: string, "param"?: string}}. ' +
  'Choosing the candidate is the decision that matters most; the fields are recoverable, a wrong list ' +
  'is not. Each candidate carries `label` (the nearest heading, i.e. what the page calls this list), ' +
  '`count`, `inMain`, `linkedRatio` (share of rows linking somewhere, so how record-like they are) and ' +
  '`nestedInside` (set when this list lives inside another candidate\'s rows — messages within a thread, ' +
  'variants within a product). Rules: if the user gave a hint, the candidate whose `label` and sample ' +
  'cells match it wins outright, whatever the scores say. Otherwise prefer the outermost list of ' +
  'records — a candidate with `nestedInside` set is one level too deep unless the hint asked for that ' +
  'level. Never a nav, menu, or footer list. Use the ' +
  'candidate\'s rowSelector verbatim. Field selectors are relative to the row and must come from the ' +
  'samples; use "" for the row itself. Name fields in the page\'s own language, as a spreadsheet column ' +
  'would be named. Include a link field with "attr":"href" when rows link to detail pages. At most ' +
  `${MAX_FIELDS} fields, and skip decorative ones. keyField must name a field that is unique per row — ` +
  'prefer a URL or id; never a price or a status. For nextPage prefer a "next-label" control, then ' +
  'rel-next, then a load-more control, then scroll if the page is scrollable, else "none".';

export function buildSchemaPrompt(probe: unknown, pagination: unknown): string {
  return [
    'Candidate row structures:',
    JSON.stringify(probe),
    '',
    'Candidate pagination controls:',
    JSON.stringify(pagination),
  ].join('\n');
}

async function inferSchema(
  model: LanguageModel,
  prompt: string,
  abortSignal: AbortSignal | undefined,
): Promise<string> {
  const deadline = AbortSignal.timeout(SCHEMA_TIMEOUT_MS);
  const signal = abortSignal ? AbortSignal.any([abortSignal, deadline]) : deadline;
  const result = streamText({
    model,
    instructions: SCHEMA_SYSTEM,
    prompt,
    maxOutputTokens: SCHEMA_OUTPUT_TOKENS,
    abortSignal: signal,
  });
  try {
    return await result.text;
  } catch (err) {
    if (deadline.aborted && abortSignal?.aborted !== true) {
      throw new Error(
        `Schema inference timed out after ${SCHEMA_TIMEOUT_MS / 1000}s. Scroll to the list and retry, ` +
          'or fall back to extract_content for this page.',
      );
    }
    throw err;
  }
}

export const infer_row_schema = tool({
  description:
    'Works out how to read a repeating list on the current page: which element is a row, what the ' +
    'columns should be called, and how to reach the next page. Returns a compact schema plus a couple ' +
    'of sample rows to check. Call this once, then call extract_rows with the schema to pull every page ' +
    'for free. Use this — not extract_content — whenever the user wants a list, table, or export; ' +
    'extract_content costs a model call per page, this costs one in total.',
  inputSchema: z.object({
    hint: z
      .string()
      .optional()
      .describe(
        'Optional nudge about which list and which columns matter, e.g. "the order table, I need order ' +
          'id, buyer, amount and date"',
      ),
  }),
  execute: async ({ hint }, { abortSignal }) => {
    const session = await ensureSession();
    const probe = await evaluateFunction<{
      url: string;
      title: string;
      candidates: ProbeCandidate[];
    }>(session, PROBE_LISTS);

    if (!probe || probe.candidates.length === 0) {
      throw new Error(
        'No repeating list found on this page. Scroll the list into view or expand it first, or use ' +
          'extract_content if the data is not in a repeating structure.',
      );
    }

    const pagination = await evaluateFunction<ProbePagination>(session, PROBE_PAGINATION);

    const settings = await getSettings();
    if (!settings) throw new Error('No model configured — open settings first.');

    const prompt = hint
      ? `${buildSchemaPrompt(probe, pagination)}\n\nUser hint: ${hint}`
      : buildSchemaPrompt(probe, pagination);

    /**
     * A failure here used to throw, and throwing turned out to be the worst
     * available answer: the agent's reaction was to extract the list by hand
     * with evaluate_script, which leaves every row in the conversation and none
     * in the ledger — so the run "succeeds", reports a row count, and gives the
     * user nothing to export. An empty or unparseable reply is not rare enough
     * to treat as exceptional, so the probe builds its own schema instead.
     * Worse column names, same rows, and they land where they can be downloaded.
     */
    let schema: RowSchema | undefined;
    let namedByModel = true;
    try {
      const answer = await inferSchema(resolveModel(settings), prompt, abortSignal);
      schema = normalizeSchema(parseModelJson(answer));
    } catch (err) {
      // A user-initiated stop is not something to paper over with a fallback.
      if (abortSignal?.aborted) throw err;
    }
    if (!schema) {
      schema = schemaFromProbe(probe.candidates, pagination);
      namedByModel = false;
    }
    if (!schema) {
      throw new Error(
        'Could not work out the row structure of this page, with or without the model. Use ' +
          'extract_content for this one.',
      );
    }

    // Prove the schema before the caller commits dozens of pages to it.
    const check = await evaluateFunction<{ rows: ExtractedRow[]; matched: number }>(
      session,
      EXTRACT_WITH_SCHEMA,
      [schema, MAX_CELL_CHARS],
    );
    if (!check || check.rows.length === 0) {
      throw new Error(
        `The inferred rowSelector "${schema.rowSelector}" matched ${check?.matched ?? 0} element(s) but ` +
          'produced no rows. Retry with a hint naming the list, or fall back to extract_content.',
      );
    }

    const pagingNote =
      schema.nextPage.kind === 'none'
        ? 'No pagination detected — extract_rows will read this page only.'
        : `Pagination: ${schema.nextPage.kind}. Pass this schema to extract_rows to collect every page.`;

    return {
      url: probe.url,
      schema,
      rowsOnThisPage: check.rows.length,
      sample: check.rows.slice(0, SAMPLE_ROWS),
      note: namedByModel
        ? pagingNote
        : `${pagingNote} Note: the schema was derived from the page structure because the naming step ` +
          'returned nothing usable, so the columns are named after their selectors. Pass it to ' +
          'extract_rows as it is — do not extract the list by hand with evaluate_script, which would ' +
          'leave the rows in this conversation instead of the ledger the user exports from.',
    };
  },
});

// ---------------------------------------------------------------------------
// Bulk extraction
// ---------------------------------------------------------------------------

/**
 * Rows land in the ledger as findings so the panel can render and export them,
 * and so they survive context trimming. Deliberately no evidence/rationale:
 * the digest spells out the newest findings on every step, and a hundred rows
 * of quoted page text would cost more than the extraction saved. The row data
 * *is* the evidence, and keyField points back at the source.
 */
export function rowsToMutations(rows: ExtractedRow[], schema: RowSchema): LedgerMutation[] {
  const summaryFields = schema.fields.filter((f) => f.name !== schema.keyField).slice(0, 3);
  return rows.map((row) => ({
    type: 'upsert_finding' as const,
    finding: {
      key: row[schema.keyField] || JSON.stringify(row).slice(0, 200),
      summary:
        summaryFields
          .map((f) => row[f.name])
          .filter((value) => value)
          .join(' · ') || row[schema.keyField] || '(empty row)',
      // Rebuilt in schema order rather than passed through. CDP's returnByValue
      // does not preserve a page object's key insertion order — it comes back
      // sorted — and the panel reads column order off these keys. Passing the
      // row through would sort every export's columns by codepoint, which is
      // invisible for ASCII headers and scrambles every Chinese one.
      data: Object.fromEntries(schema.fields.map((f) => [f.name, row[f.name] ?? ''])),
    },
  }));
}

/** Rows already in the ledger, so a re-run tops up instead of duplicating. */
function existingKeys(): Set<string> {
  const ledger = getActiveLedger();
  return new Set(ledger ? ledger.findings.map((f) => f.key) : []);
}

function nextPageUrl(current: string, param: string): string | null {
  const url = new URL(current);
  const value = Number(url.searchParams.get(param));
  if (!Number.isFinite(value)) return null;
  url.searchParams.set(param, String(value + 1));
  return url.toString();
}

export const extract_rows = tool({
  description:
    'Collects every row of a list into the task ledger using a schema from infer_row_schema, walking ' +
    'pagination on its own. Costs no model tokens per page — call it once with a page budget instead of ' +
    'looping yourself. Rows are saved to the ledger (the user sees and exports them there), not returned ' +
    'here: you get counts and a two-row sample back.',
  inputSchema: z.object({
    schema: z
      .object({
        rowSelector: z.string(),
        fields: z.array(
          z.object({
            name: z.string(),
            selector: z.string(),
            attr: z.string().optional(),
          }),
        ),
        keyField: z.string(),
        nextPage: z.object({
          kind: z.enum(['click', 'scroll', 'url', 'none']),
          selector: z.string().optional(),
          param: z.string().optional(),
        }),
      })
      .describe('The schema returned by infer_row_schema, passed through unchanged'),
    maxPages: z
      .number()
      .optional()
      .describe(`How many pages to walk at most (default ${DEFAULT_MAX_PAGES}, cap ${MAX_MAX_PAGES})`),
  }),
  execute: async ({ schema: input, maxPages }, { abortSignal }) => {
    const schema = normalizeSchema(input);
    if (!schema) throw new Error('Invalid schema — re-run infer_row_schema and pass its schema through.');

    const result = await collectRows(schema, maxPages, abortSignal);
    return {
      ...result,
      columns: schema.fields.map((f) => f.name),
      note:
        result.stopReason === 'ledger-full'
          ? `Ledger is full at ${MAX_FINDINGS} rows — report the partial result rather than retrying.`
          : 'Rows are saved and already on screen. Do not repeat them back — say how many rows you ' +
            'collected and that the table is in the panel at the top, where it can be copied or ' +
            'downloaded as CSV. A count on its own reads as if nothing happened.',
    };
  },
});

export interface CollectResult {
  rowsAdded: number;
  totalRowsInLedger: number;
  pagesVisited: number;
  duplicatesSkipped: number;
  stopReason: string;
  sample: ExtractedRow[];
  /** Keys written by this walk, in page order — the basis of a re-run's diff. */
  addedKeys: string[];
}

/**
 * The pagination walk itself, with no tool wrapper around it. A saved task
 * re-runs through here: replaying a known schema is pure DOM work, and routing
 * it back through the agent would put a model call in front of the one path
 * that was built not to need one.
 */
export async function collectRows(
  schema: RowSchema,
  maxPages: number | undefined,
  abortSignal: AbortSignal | undefined,
): Promise<CollectResult> {
  const session = await ensureSession();
  const budget = Math.min(Math.max(1, maxPages ?? DEFAULT_MAX_PAGES), MAX_MAX_PAGES);
  const seen = existingKeys();
  const addedKeys: string[] = [];
  const startUrl = (await chrome.tabs.get(session.getTabId()).catch(() => null))?.url ?? '';

  let pagesVisited = 0;
  let rowsAdded = 0;
  let duplicates = 0;
  let stopReason = 'page-budget-reached';
  let sample: ExtractedRow[] = [];

  for (let page = 0; page < budget; page++) {
    if (abortSignal?.aborted) {
      stopReason = 'stopped';
      break;
    }

    const result = await evaluateFunction<{ rows: ExtractedRow[]; matched: number; url: string }>(
      session,
      EXTRACT_WITH_SCHEMA,
      [schema, MAX_CELL_CHARS],
    );
    pagesVisited++;

    const fresh: ExtractedRow[] = [];
    for (const row of result?.rows ?? []) {
      const key = row[schema.keyField] || JSON.stringify(row).slice(0, 200);
      if (seen.has(key)) {
        duplicates++;
        continue;
      }
      seen.add(key);
      fresh.push(row);
    }

    // Capacity is checked before writing: applyLedgerMutations throws at the
    // cap, and losing a 40-page walk to the last row is not an acceptable way
    // to learn the ledger is full.
    const room = MAX_FINDINGS - (getActiveLedger()?.findings.length ?? 0);
    const writable = fresh.slice(0, Math.max(0, room));
    if (writable.length > 0) {
      await applyLedgerMutations(rowsToMutations(writable, schema));
      rowsAdded += writable.length;
      for (const row of writable) {
        addedKeys.push(row[schema.keyField] || JSON.stringify(row).slice(0, 200));
      }
      if (sample.length === 0) sample = writable.slice(0, SAMPLE_ROWS);
    }
    if (writable.length < fresh.length) {
      stopReason = 'ledger-full';
      break;
    }

    // A page that produced nothing new means pagination is looping or done —
    // either way, walking further just burns time.
    if (fresh.length === 0 && page > 0) {
      stopReason = 'no-new-rows';
      break;
    }
    if (page === budget - 1) break;

    if (schema.nextPage.kind === 'none') {
      stopReason = 'single-page';
      break;
    }

    if (schema.nextPage.kind === 'url') {
      const target = nextPageUrl(result?.url ?? '', schema.nextPage.param);
      if (!target) {
        stopReason = 'no-pagination';
        break;
      }
      await session.send('Page.navigate', { url: target });
      await new Promise((resolve) => setTimeout(resolve, PAGE_SETTLE_MS));
      continue;
    }

    const step = await evaluateFunction<{ advanced: boolean; reason: string }>(
      session,
      GO_NEXT_PAGE,
      [schema.nextPage, schema.rowSelector, PAGE_SETTLE_MS],
    );
    if (!step?.advanced) {
      stopReason = step?.reason ?? 'page-unchanged';
      break;
    }
  }

  // Recorded only on a walk that produced something: this is what the panel
  // offers to save as a repeatable task, and an empty run has nothing to
  // repeat.
  if (rowsAdded > 0 && startUrl) {
    await applyLedgerMutations([{ type: 'set_extraction', extraction: { schema, url: startUrl } }]);
  }

  return {
    rowsAdded,
    totalRowsInLedger: getActiveLedger()?.findings.length ?? rowsAdded,
    pagesVisited,
    duplicatesSkipped: duplicates,
    stopReason,
    sample,
    addedKeys,
  };
}
