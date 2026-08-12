import type { Settings } from '../storage/schema';
import { resolveModel } from '../llm/providers';
import { isSignedIn } from '../auth/session';
import { bingRssSearch } from './bingRss';
import { firecrawlSearch, hostedFirecrawlSearch } from './firecrawl';
import { bingTabSearch } from './tabSearch';
import { fuseResults } from './fuse';
import { DEFAULT_PLANNED_QUERIES, MAX_PLANNED_QUERIES, planQueries } from './planQueries';
import { filterRelevant } from './relevance';
import type { QueryHits, SearchBackend, SearchResult, SearchSource } from './types';

/**
 * One search = several queries, run concurrently, across a ladder of backends.
 *
 * The ladder is per query, not per search: if the Firecrawl key is out of
 * credits for all three queries they all drop to Bing together, but if one
 * query trips a bot wall while the others come back fine, only that one pays
 * for a tab. That is the shape the failures actually take, and it keeps the
 * expensive rung as rare as it should be.
 */

const DEFAULT_COUNT = 8;
export const MAX_COUNT = 20;

/** Per query, before fusion — fusion needs depth to have anything to agree on. */
const PER_QUERY_LIMIT = 10;

/** Tabs are the one rung with a visible cost, so they queue rather than swarm. */
const TAB_CONCURRENCY = 2;

export interface Rung {
  source: SearchSource;
  backend: SearchBackend;
  /** Unlimited when absent — a fetch rung has no reason to queue. */
  concurrency?: number;
}

export interface LadderOutcome {
  perQuery: QueryHits[];
  /** Why a query fell through a rung, in the order it happened. */
  failures: string[];
}

/** Bounded concurrency, because `Promise.all` over a tab rung opens N tabs at once. */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Walks the ladder until every query has results or the rungs run out. Pure
 * with respect to the backends, so the fallback behaviour can be tested without
 * a network or a browser.
 */
export async function runLadder(
  queries: string[],
  rungs: Rung[],
  { limit, signal }: { limit: number; signal?: AbortSignal },
): Promise<LadderOutcome> {
  const perQuery: QueryHits[] = [];
  const failures: string[] = [];
  let pending = queries;

  for (const rung of rungs) {
    if (pending.length === 0 || signal?.aborted) break;

    const outcomes = await mapPool(pending, rung.concurrency ?? pending.length, async (query) => {
      try {
        const hits = await rung.backend(query, { limit, signal });
        // An engine that broadened the query returns a full page of confident,
        // well-formed results about something else. Treated as a miss, not an
        // answer — see relevance.ts.
        const relevant = filterRelevant(query, hits);
        if (relevant.length === 0 && hits.length > 0) {
          failures.push(`${rung.source} · ${query}: results were off-topic (query too specific?)`);
        }
        return { query, hits: relevant };
      } catch (err) {
        failures.push(`${rung.source} · ${query}: ${err instanceof Error ? err.message : String(err)}`);
        return { query, hits: null };
      }
    });

    const stillPending: string[] = [];
    for (const { query, hits } of outcomes) {
      if (hits && hits.length > 0) perQuery.push({ query, source: rung.source, hits });
      else stillPending.push(query);
    }
    pending = stillPending;
  }

  return { perQuery, failures };
}

/**
 * Which rungs exist for this user, cheapest-and-best first. Assembled per
 * search rather than at module load because both conditions — a key in
 * settings, a live session — change while the panel is open.
 */
export async function buildRungs(settings: Settings): Promise<Rung[]> {
  const rungs: Rung[] = [];

  const apiKey = settings.firecrawlApiKey?.trim();
  if (apiKey) {
    rungs.push({
      source: 'firecrawl',
      backend: (query, opts) => firecrawlSearch(query, { ...opts, apiKey }),
    });
  } else if (await isSignedIn()) {
    // Only when the user has no key of their own: their allowance should be
    // spent before ours, and running both would just double the bill.
    rungs.push({ source: 'firecrawl-hosted', backend: hostedFirecrawlSearch });
  }

  rungs.push({ source: 'bing-rss', backend: bingRssSearch });
  rungs.push({ source: 'bing-tab', backend: bingTabSearch, concurrency: TAB_CONCURRENCY });
  return rungs;
}

export interface SearchRun {
  /** What was actually searched — the agent sees how its need was translated. */
  queries: string[];
  sources: SearchSource[];
  results: SearchResult[];
  note?: string;
}

export async function runSearch(
  settings: Settings,
  need: string,
  {
    queries,
    count = DEFAULT_COUNT,
    plan = DEFAULT_PLANNED_QUERIES,
    signal,
  }: { queries?: string[]; count?: number; plan?: number; signal?: AbortSignal } = {},
): Promise<SearchRun> {
  const want = Math.min(Math.max(1, count), MAX_COUNT);

  // An explicit list from the agent is a deliberate reformulation — planning on
  // top of it would throw away the thing it just decided.
  const planned = queries?.length
    ? queries.slice(0, MAX_PLANNED_QUERIES)
    : await planQueries(resolveModel(settings), need, { count: plan, signal });

  const { perQuery, failures } = await runLadder(planned, await buildRungs(settings), {
    limit: PER_QUERY_LIMIT,
    signal,
  });

  const results = fuseResults(perQuery, want);
  const sources = [...new Set(perQuery.map((entry) => entry.source))];

  if (results.length === 0) {
    return {
      queries: planned,
      sources,
      results,
      note:
        'No usable results. This is rarely proof that nothing exists: an over-specified query makes ' +
        'engines quietly answer a broader one, and those results are discarded here. Retry with ' +
        'shorter `queries` — two or three words, one idea, no year — before concluding anything. ' +
        `Details: ${failures.join(' | ')}`,
    };
  }

  // Only worth a line when a rung actually failed; a clean run says nothing.
  return {
    queries: planned,
    sources,
    results,
    ...(failures.length > 0 ? { note: `Some queries fell back: ${failures.join(' | ')}` } : {}),
  };
}
