import { streamText, type LanguageModel } from 'ai';

/**
 * The half of "search is bad" that no backend can fix.
 *
 * A model handed a web_search tool pastes the user's sentence into it —
 * "帮我找一下杭州哪个区的二手房 2026 年跌得最少" — and every engine answers a
 * question like that with SEO sludge. The queries that actually work are three
 * or four keywords, sometimes in a different language from the question, and
 * they are worth writing deliberately rather than as a side effect of the
 * agent's main reasoning.
 *
 * So the information need is planned into several queries by one cheap side
 * call, and those run concurrently (see runSearch.ts). The side call is the
 * same model the agent uses; it costs a fraction of one agent step and replaces
 * the retry loop where the agent reformulates by hand, one round trip at a time.
 */

const PLANNER_SYSTEM =
  'You turn an information need into web search queries. Reply with ONLY a JSON array of strings — ' +
  'no markdown fences, no commentary.\n' +
  'Rules:\n' +
  '- Keywords, not sentences. Drop question words, politeness, and anything an index would not match.\n' +
  '- Keep each query SHORT — two to four words, or one Chinese phrase. This matters more than being ' +
  'precise: an over-specified query has no exact match, so engines silently answer a broader one and ' +
  'return the encyclopedia entry for its first word. Stack qualifiers across separate queries, never ' +
  'inside one.\n' +
  '- Make the queries genuinely different: a plain keyword one, a narrower/technical one, and where ' +
  'it helps a site: or quoted-phrase one. Near-duplicates waste a slot.\n' +
  '- Write each query in the language its best sources are written in. For a topic covered mainly in ' +
  'Chinese, keep a Chinese query; for one documented mainly in English, include an English query.\n' +
  '- Leave the year out unless it is the point of the question — it is the single most common way a ' +
  'query stops matching anything.\n' +
  '- Never include operators the engine cannot parse (no boolean AND/OR, no parentheses).';

/** Enough phrasings to disagree usefully; past this the extra hits are noise. */
export const MAX_PLANNED_QUERIES = 4;
export const DEFAULT_PLANNED_QUERIES = 3;

/** A query longer than this is a sentence wearing a costume. */
const MAX_QUERY_CHARS = 120;

/** Planning is a means, not the task: past this it is cheaper to search badly. */
const PLAN_TIMEOUT_MS = 12_000;
const PLAN_MAX_OUTPUT_TOKENS = 200;

export function buildPlannerPrompt(need: string, count: number, today = new Date()): string {
  return [
    `Information need: ${need}`,
    `Today: ${today.toISOString().slice(0, 10)}`,
    `Return ${count} queries as a JSON array of strings.`,
  ].join('\n');
}

/**
 * Models wrap JSON in fences, return an object with a `queries` key, or answer
 * with one query per line. All three are the model doing its job; only the
 * shape is wrong, so normalize rather than discard.
 */
export function parseQueries(raw: string, max: number): string[] {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

  let candidates: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) candidates = parsed;
    else if (parsed && typeof parsed === 'object') {
      const values = Object.values(parsed as Record<string, unknown>);
      candidates = values.find(Array.isArray) ?? [];
    }
  } catch {
    candidates = text.split('\n');
  }

  const seen = new Set<string>();
  const queries: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    // Strips list markers and stray quoting from the line-by-line fallback.
    const query = candidate
      .trim()
      .replace(/^[-*\d.)\s]+/, '')
      .replace(/^["']|["'],?$/g, '')
      .trim()
      .slice(0, MAX_QUERY_CHARS);
    if (!query) continue;
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
    if (queries.length >= max) break;
  }
  return queries;
}

/**
 * Never throws and never returns empty: a planner that fails leaves the
 * original need as the single query, which is exactly the behaviour this
 * replaced. Search is too central to fail because a side call timed out.
 */
export async function planQueries(
  model: LanguageModel,
  need: string,
  { count = DEFAULT_PLANNED_QUERIES, signal }: { count?: number; signal?: AbortSignal } = {},
): Promise<string[]> {
  const want = Math.min(Math.max(1, count), MAX_PLANNED_QUERIES);
  if (want === 1) return [need];

  const deadline = AbortSignal.timeout(PLAN_TIMEOUT_MS);
  try {
    const result = streamText({
      model,
      instructions: PLANNER_SYSTEM,
      prompt: buildPlannerPrompt(need, want),
      maxOutputTokens: PLAN_MAX_OUTPUT_TOKENS,
      abortSignal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
    const queries = parseQueries(await result.text, want);
    return queries.length > 0 ? queries : [need];
  } catch {
    return [need];
  }
}
