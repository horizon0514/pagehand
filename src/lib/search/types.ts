/**
 * What every search backend returns, and what the ranker consumes.
 *
 * Deliberately the smallest thing a result page and an API both have: a title,
 * a url, and a line of context. Anything richer (Firecrawl can return the
 * scraped markdown of every hit) would blow up the agent's context for results
 * it hasn't decided to read yet — that's what navigate_page + extract_content
 * are for.
 */
export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** A hit after fusion, in the order the agent should read them. */
export interface SearchResult extends SearchHit {
  rank: number;
}

/**
 * Which rung of the ladder answered. Reported back to the agent because the
 * rungs differ in quality: a `bing-tab` result set means both the paid API and
 * the plain fetch failed, and the agent should treat thin results as a
 * transport problem rather than evidence that nothing exists.
 */
export type SearchSource = 'firecrawl' | 'firecrawl-hosted' | 'bing-rss' | 'bing-tab';

/** One query's results, kept separate until fusion so rank survives. */
export interface QueryHits {
  query: string;
  source: SearchSource;
  hits: SearchHit[];
}

/** Every backend is this shape, which is what makes the ladder a loop. */
export type SearchBackend = (
  query: string,
  opts: { limit: number; signal?: AbortSignal },
) => Promise<SearchHit[]>;
