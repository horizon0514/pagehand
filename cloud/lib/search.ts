/**
 * The hosted web-search proxy.
 *
 * Same rule as the model proxy, for the same reason: the credential is ours and
 * must never reach the client, so the extension asks us and we ask Firecrawl.
 * Same shape too — a plain `(Request) => Promise<Response>` with its
 * dependencies injected, importing nothing from `next/*`.
 *
 * Unlike the model proxy this is not on the hot path: one search is one request,
 * not one of a hundred steps. What it needs instead is a bounded bill — search
 * costs credits per call against a monthly allowance, so the request the client
 * sends is not forwarded, it is rebuilt from two validated fields. In
 * particular `scrapeOptions` is never honoured: it would let a client charge us
 * a credit per scraped page, ten pages at a time, from a tool call we cannot see.
 */
import { FIRECRAWL_SEARCH_URL, firecrawlApiKey } from './config.ts';

/** What an agent can usefully read in one step; mirrors the extension's cap. */
const MAX_LIMIT = 20;
const MAX_QUERY_CHARS = 500;

/** Firecrawl's own default is 60s. A search that slow has already failed the
 * caller, who has a keyless fallback rung waiting. */
const UPSTREAM_TIMEOUT_MS = 20_000;

export interface SearchDeps {
  userId: string;
  /** Where the ledger will hook in; for now this is how spend becomes visible. */
  onCredits: (credits: number | null, meta: { userId: string; query: string }) => void;
}

export interface SearchRequest {
  query: string;
  limit: number;
}

/** Fields assigned in the body rather than as constructor parameter properties:
 * `node --test` runs these files in strip-only TypeScript mode, which rejects
 * that syntax outright. */
export class SearchRequestError extends Error {
  readonly status: 400 | 503;
  readonly code: string;

  constructor(status: 400 | 503, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function parseSearchRequest(body: unknown): SearchRequest {
  if (!body || typeof body !== 'object') {
    throw new SearchRequestError(400, 'invalid_body', 'Expected a JSON object.');
  }
  const { query, limit } = body as { query?: unknown; limit?: unknown };
  if (typeof query !== 'string' || !query.trim()) {
    throw new SearchRequestError(400, 'missing_query', 'A non-empty `query` is required.');
  }
  if (query.length > MAX_QUERY_CHARS) {
    throw new SearchRequestError(400, 'query_too_long', `\`query\` must be under ${MAX_QUERY_CHARS} characters.`);
  }
  const requested = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : 10;
  return { query: query.trim(), limit: Math.min(Math.max(1, requested), MAX_LIMIT) };
}

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

interface FirecrawlResponse {
  data?: { web?: { url?: string; title?: string; description?: string }[] };
  creditsUsed?: number;
}

/**
 * Flattened to our own shape rather than passed through. The client then
 * depends on Pagehand's contract, not Firecrawl's — which is what lets the
 * vendor be swapped without shipping an extension update to every user.
 */
export function toResults(payload: unknown): SearchResultItem[] {
  const web = (payload as FirecrawlResponse | null)?.data?.web;
  if (!Array.isArray(web)) return [];
  const results: SearchResultItem[] = [];
  for (const item of web) {
    if (!item?.url || !item.title) continue;
    results.push({ title: item.title, url: item.url, snippet: item.description ?? '' });
  }
  return results;
}

export async function proxySearch(request: Request, deps: SearchDeps): Promise<Response> {
  let parsed: SearchRequest;
  try {
    parsed = parseSearchRequest(await request.json().catch(() => null));
  } catch (err) {
    if (!(err instanceof SearchRequestError)) throw err;
    return Response.json({ error: { message: err.message, code: err.code } }, { status: err.status });
  }

  let apiKey: string;
  try {
    apiKey = firecrawlApiKey();
  } catch {
    // Deliberately a clean 503: the client's answer is to drop to its keyless
    // rung, and it can only do that if this reads as "backend unavailable"
    // rather than "your search failed".
    return Response.json(
      { error: { message: 'Hosted search is not configured.', code: 'search_unavailable' } },
      { status: 503 },
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(FIRECRAWL_SEARCH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query: parsed.query, limit: parsed.limit }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return Response.json(
      { error: { message: 'Search backend did not respond.', code: 'search_unavailable' } },
      { status: 503 },
    );
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    // Upstream statuses are not passed through: a 402 (out of credits) or a 429
    // on our account is our problem, and telling the client "unavailable" sends
    // it down the fallback instead of surfacing our billing to the user.
    return Response.json(
      {
        error: {
          message: `Search backend returned ${upstream.status}.`,
          code: upstream.status === 400 ? 'invalid_query' : 'search_unavailable',
        },
      },
      { status: upstream.status === 400 ? 400 : 503, headers: { 'x-upstream-detail': detail.slice(0, 200).replace(/[^\x20-\x7e]/g, ' ') } },
    );
  }

  const payload = (await upstream.json().catch(() => null)) as FirecrawlResponse | null;
  deps.onCredits(payload?.creditsUsed ?? null, { userId: deps.userId, query: parsed.query });

  return Response.json({ results: toResults(payload) });
}
