import type { QueryHits, SearchHit, SearchResult } from './types';

/**
 * Turning several ranked lists into one.
 *
 * Running three phrasings of the same question concurrently is only an
 * improvement if the merge is: the same page comes back from two queries at
 * rank 4 and 5, and a page that only one phrasing found sits at rank 1. Naive
 * concatenation rewards whichever query happened to run first; scoring by
 * position within a list can't be compared across lists that scored the world
 * differently.
 *
 * Reciprocal rank fusion is the standard answer, and it says exactly the right
 * thing here: agreement across differently-worded queries is evidence, and the
 * constant keeps a single top hit from dominating three near-misses.
 */
const RRF_K = 60;

const MAX_TITLE_CHARS = 200;
const MAX_SNIPPET_CHARS = 300;

/** Tracking parameters that make one page look like several. */
const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|msclkid$|ref$|spm$)/i;

export function clamp(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * A dedupe key, not a fetchable url — the original is what we hand back.
 *
 * Search engines return the same document under http/https, with and without
 * `www.`, with a trailing slash, and dressed in campaign parameters. Left
 * alone, one page can occupy three of eight slots.
 */
export function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = '';
    url.protocol = 'https:';
    url.hostname = url.hostname.replace(/^www\./i, '').toLowerCase();
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    const normalized = url.toString();
    return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  } catch {
    return raw.trim();
  }
}

interface Fused {
  hit: SearchHit;
  score: number;
  bestRank: number;
  /** Which phrasings found it — the agent's cue that a hit is corroborated. */
  queries: string[];
}

/**
 * Merge, dedupe, and rank. Pure on purpose: the ladder above it needs a browser
 * and a network, and the ranking is the part most worth pinning down in tests.
 */
export function fuseResults(lists: QueryHits[], count: number): SearchResult[] {
  const byUrl = new Map<string, Fused>();

  for (const { query, hits } of lists) {
    let rank = 0;
    const seenHere = new Set<string>();
    for (const hit of hits) {
      if (!hit.url || !hit.title) continue;
      const key = normalizeUrl(hit.url);
      // A list that repeats a url (Bing lists a domain again for its sublinks)
      // must not score it twice — that would beat genuine cross-query agreement.
      if (seenHere.has(key)) continue;
      seenHere.add(key);
      rank += 1;

      const existing = byUrl.get(key);
      if (!existing) {
        byUrl.set(key, {
          hit: {
            title: clamp(hit.title, MAX_TITLE_CHARS),
            url: hit.url,
            snippet: clamp(hit.snippet ?? '', MAX_SNIPPET_CHARS),
          },
          score: 1 / (RRF_K + rank),
          bestRank: rank,
          queries: [query],
        });
        continue;
      }

      existing.score += 1 / (RRF_K + rank);
      existing.queries.push(query);
      if (rank < existing.bestRank) {
        existing.bestRank = rank;
        existing.hit.title = clamp(hit.title, MAX_TITLE_CHARS);
        existing.hit.url = hit.url;
      }
      // Keep whichever snippet says more — engines truncate differently per query.
      const snippet = clamp(hit.snippet ?? '', MAX_SNIPPET_CHARS);
      if (snippet.length > existing.hit.snippet.length) existing.hit.snippet = snippet;
    }
  }

  return [...byUrl.values()]
    .sort((a, b) => b.score - a.score || a.bestRank - b.bestRank)
    .slice(0, count)
    .map((entry, index) => ({ rank: index + 1, ...entry.hit }));
}
