import { HOSTED_BASE_URL } from '../storage/schema';
import { getAccessToken } from '../auth/session';
import type { SearchHit } from './types';

/**
 * The top rung: a real search API instead of a results page.
 *
 * Firecrawl's /v2/search returns the organic results as JSON, which removes the
 * two failure modes the free rungs can only mitigate — no parsing, and no bot
 * wall. It is not free (2 credits per 10 results against a 1,000-credit monthly
 * allowance), which is why it is a rung and not the implementation: everything
 * still works without it.
 *
 * Two ways to reach it, in this order:
 *
 * 1. The user's own key, from settings. Their allowance, their quota, no
 *    round trip through us.
 * 2. Our key, through the hosted proxy, for signed-in accounts. The credential
 *    never leaves the server — same rule as the model proxy.
 *
 * Scrape options are deliberately not sent. Firecrawl will happily return the
 * markdown of every hit, at one credit per page, to fill a context window with
 * pages the agent has not chosen to read.
 */

const FIRECRAWL_SEARCH_URL = 'https://api.firecrawl.dev/v2/search';
const SEARCH_TIMEOUT_MS = 20_000;

/** Their cap is 100; ours is what an agent can usefully read in one step. */
export const MAX_FIRECRAWL_LIMIT = 20;

interface FirecrawlItem {
  url?: string;
  title?: string;
  description?: string;
}

/**
 * Tolerant on purpose: `data` is documented as `{ web: [...] }` but older
 * deployments (and our own proxy's flattened reply) hand back a bare array.
 */
export function parseFirecrawlResults(payload: unknown): SearchHit[] {
  if (!payload || typeof payload !== 'object') return [];
  const data = (payload as { data?: unknown; results?: unknown }).data
    ?? (payload as { results?: unknown }).results;
  const items = Array.isArray(data)
    ? data
    : Array.isArray((data as { web?: unknown })?.web)
      ? ((data as { web: unknown[] }).web)
      : [];

  const hits: SearchHit[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as FirecrawlItem & { snippet?: string };
    if (!item.url || !item.title) continue;
    hits.push({
      title: item.title,
      url: item.url,
      snippet: item.description ?? item.snippet ?? '',
    });
  }
  return hits;
}

function timeout(signal: AbortSignal | undefined): AbortSignal {
  const deadline = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

async function readError(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  try {
    const parsed = JSON.parse(body) as { error?: string | { message?: string } };
    const error = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message;
    if (error) return error;
  } catch {
    // Not JSON — the status line is all we have.
  }
  return `HTTP ${res.status}`;
}

/** Direct, with the user's own key. */
export async function firecrawlSearch(
  query: string,
  { apiKey, limit, signal }: { apiKey: string; limit: number; signal?: AbortSignal },
): Promise<SearchHit[]> {
  const res = await fetch(FIRECRAWL_SEARCH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, limit: Math.min(limit, MAX_FIRECRAWL_LIMIT) }),
    signal: timeout(signal),
  });
  if (!res.ok) throw new Error(`Firecrawl search failed: ${await readError(res)}`);

  const hits = parseFirecrawlResults(await res.json());
  if (hits.length === 0) throw new Error('Firecrawl returned no results');
  return hits;
}

/** Through Pagehand, on our key and the caller's session. */
export async function hostedFirecrawlSearch(
  query: string,
  { limit, signal }: { limit: number; signal?: AbortSignal },
): Promise<SearchHit[]> {
  const token = await getAccessToken();
  if (!token) throw new Error('Not signed in');

  const res = await fetch(`${HOSTED_BASE_URL}/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, limit: Math.min(limit, MAX_FIRECRAWL_LIMIT) }),
    signal: timeout(signal),
  });
  if (!res.ok) throw new Error(`Hosted search failed: ${await readError(res)}`);

  const hits = parseFirecrawlResults(await res.json());
  if (hits.length === 0) throw new Error('Hosted search returned no results');
  return hits;
}
