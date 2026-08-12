import type { SearchHit } from './types';

/**
 * The failure that survives every other fix: an engine that answers a question
 * it wasn't asked.
 *
 * Bing does not say "no results". When a query is more specific than anything
 * it has indexed — 「杭州二手房成交量统计」, 「深圳落户条件2026」 — it silently
 * broadens to a prefix and returns the encyclopedia entry for the first word:
 * 百度百科, the municipal government portal, 百度地图. Measured on real queries,
 * this is the single largest source of useless search output, and nothing
 * downstream can tell those hits from good ones — they are well-formed results
 * about the wrong thing.
 *
 * What they do have in common is that the query's own words are missing from
 * them. So a list is judged by how much of the query it echoes back, and one
 * that echoes almost nothing is treated as a failed lookup rather than an
 * answer: the query falls through to the next rung, and if nothing recovers it
 * the agent is told to try a shorter phrase — which is the fix, since these
 * queries fail for being over-specified.
 */

/**
 * Below this share of the query echoed back, a hit is about something else.
 *
 * Calibrated against live Bing rather than guessed. Healthy lists keep 7–10 of
 * 10 hits at this threshold (「飞书多维表格权限设置」 10/10, 「深圳落户条件」
 * 8/10, `firecrawl search api pricing` 7/10); broadened ones keep 0–2
 * (「杭州二手房成交量统计」 0/10, 「深圳落户条件2026」 0/10, every hit matching
 * only the leading city). The two populations are far enough apart that the
 * exact number does not matter much; it sits low so a relevant page that
 * paraphrases is never thrown away.
 */
const MIN_COVERAGE = 0.35;

/**
 * Below this, a query is too short to have been broadened away from — there is
 * nothing to drop — and judging it would only misfire.
 */
const MIN_SPECIFICITY = 3;

const CJK = /[㐀-鿿぀-ヿ가-힯]/;

/**
 * Query terms, treating a CJK run as a phrase rather than a word.
 *
 * CJK has no spaces, so 「杭州二手房成交量」 is one token to a tokenizer and
 * nine to a reader. Character bigrams are the standard cheap stand-in for
 * segmentation and they are exactly what is needed here: a hit that carries
 * 杭州 but not 二手房 or 成交量 scores low, which is the whole judgment.
 */
export function queryTerms(query: string): string[][] {
  const terms: string[][] = [];
  for (const chunk of query.toLowerCase().split(/[\s,，、"'()（）]+/)) {
    if (!chunk) continue;
    // Search operators constrain the query rather than describing the subject —
    // a page matching `site:example.com` never says so in its title.
    if (chunk.includes(':')) continue;

    for (const run of chunk.split(/([㐀-鿿぀-ヿ가-힯]+)/)) {
      if (!run) continue;
      if (!CJK.test(run)) {
        if (run.length >= 2) terms.push([run]);
        continue;
      }
      if (run.length <= 2) {
        terms.push([run]);
        continue;
      }
      const bigrams: string[] = [];
      for (let i = 0; i < run.length - 1; i += 1) bigrams.push(run.slice(i, i + 2));
      terms.push(bigrams);
    }
  }
  return terms;
}

/**
 * How much of the query this text echoes back, from 0 to 1.
 *
 * Weighted by bigram, not by group: a year or a stray English word is one
 * token, and a nine-bigram Chinese phrase is nine, so averaging the groups
 * would let 「2026」 alone carry half the score. Measured on
 * 「杭州二手房成交量统计2026」 that is exactly what happened — the municipal
 * portal scored 0.56 for matching a city and a year, and stayed in.
 */
export function coverage(terms: string[][], text: string): number {
  const haystack = text.toLowerCase();
  let matched = 0;
  let total = 0;
  for (const alternatives of terms) {
    matched += alternatives.filter((term) => haystack.includes(term)).length;
    total += alternatives.length;
  }
  return total === 0 ? 1 : matched / total;
}

/** How many distinct things the query asks for; a CJK phrase counts its bigrams. */
export function specificity(terms: string[][]): number {
  return terms.reduce((total, alternatives) => total + alternatives.length, 0);
}

/**
 * Drops the hits that don't answer this query, per hit rather than per list.
 *
 * Per hit because broadening is not always total: a list can lead with two real
 * answers and fill the rest with the encyclopedia. The ladder reads an empty
 * result as a failed lookup, so a wholly broadened list falls through to the
 * next rung on its own — no separate verdict is needed.
 */
export function filterRelevant(query: string, hits: SearchHit[]): SearchHit[] {
  const terms = queryTerms(query);
  if (specificity(terms) < MIN_SPECIFICITY) return hits;
  return hits.filter((hit) => coverage(terms, `${hit.title} ${hit.snippet}`) >= MIN_COVERAGE);
}
