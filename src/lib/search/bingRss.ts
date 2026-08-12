import type { SearchHit } from './types';

/**
 * The keyless rung: Bing's RSS output, fetched straight from the side panel.
 *
 * `&format=rss` is a documented Bing output that returns the organic results as
 * a feed — title, link, description, nothing else. That makes it strictly
 * better than the two alternatives it replaces: unlike scraping the results
 * page there is no nav chrome, no ad block, and no "people also ask" to filter
 * out, and unlike driving a tab it costs no tab, so several queries run at once
 * and the page the user is looking at is never navigated away.
 *
 * It is a plain fetch, so it carries no cookies and no personalization. That is
 * a feature for a research query and a limitation for anything region- or
 * account-specific, which is what the tab rung below it is still for.
 */

const RSS_TIMEOUT_MS = 10_000;

export function bingSearchUrl(query: string, opts: { rss?: boolean; count?: number } = {}): string {
  const params = new URLSearchParams({ q: query });
  if (opts.count) params.set('count', String(opts.count));
  if (opts.rss) params.set('format', 'rss');
  return `https://www.bing.com/search?${params.toString()}`;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const code = entity[1] === 'x' || entity[1] === 'X'
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function tagText(item: string, tag: string): string {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(item);
  if (!match) return '';
  const inner = match[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1');
  // Descriptions occasionally carry <b> around the matched terms.
  return decodeEntities(inner.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

/**
 * Parsed by regex rather than DOMParser so it stays pure — this is the rung
 * most users will actually hit, and it needs to be testable without a browser.
 * The input is a machine-generated feed with a fixed shape, not arbitrary HTML.
 */
export function parseBingRss(xml: string): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const item = match[1];
    const url = tagText(item, 'link');
    const title = tagText(item, 'title');
    if (!url || !title) continue;
    hits.push({ title, url, snippet: tagText(item, 'description') });
  }
  return hits;
}

export async function bingRssSearch(
  query: string,
  { limit, signal }: { limit: number; signal?: AbortSignal },
): Promise<SearchHit[]> {
  const deadline = AbortSignal.timeout(RSS_TIMEOUT_MS);
  const res = await fetch(bingSearchUrl(query, { rss: true, count: limit }), {
    // No cookies, and no reason to want any: this is an anonymous lookup, and
    // sending the user's Bing session would only tie their account to it.
    credentials: 'omit',
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
  if (!res.ok) throw new Error(`Bing returned ${res.status}`);

  const hits = parseBingRss(await res.text());
  if (hits.length === 0) throw new Error('Bing returned no parsable results');
  return hits.slice(0, limit);
}
