import { test, expect, callTool } from './extension';
import { scrapeBingResults } from '../src/lib/search/tabSearch';
import { fuseResults } from '../src/lib/search/fuse';
import type { SearchHit } from '../src/lib/search/types';

/**
 * The tab rung's selectors are the one part of search that can rot without any
 * test noticing — the rungs above it are fetch + JSON, covered by unit tests.
 * So the same scraper the tool injects is run here against a Bing-shaped
 * fixture in a real renderer.
 */

test('the Bing extraction selectors pick organic results out of a real render', async ({
  panel,
  openTarget,
}) => {
  await openTarget('/bing.html');

  const { value: raw } = await callTool<{ value: SearchHit[] }>(panel, 'evaluate_script', {
    function: scrapeBingResults.toString(),
  });

  // The ad (li.b_ad) and the related-searches block (li.b_ans) are skipped.
  expect(raw).toHaveLength(3);
  expect(raw[0]).toMatchObject({
    title: 'First Result Title',
    url: 'https://example.com/one',
    snippet: 'Snippet for the first result.',
  });

  // And fusion turns that into clean ranked output.
  const results = fuseResults([{ query: 'q', source: 'bing-tab', hits: raw }], 8);
  expect(results.map((r) => r.rank)).toEqual([1, 2, 3]);
  expect(results.map((r) => r.url)).toEqual([
    'https://example.com/one',
    'https://example.com/two',
    'https://example.com/three',
  ]);
});

test('web_search returns ranked results from a live query', async ({ panel, openTarget }) => {
  test.skip(!process.env.E2E_NETWORK, 'set E2E_NETWORK=1 to run the live Bing search test');

  // The page the user is on must survive the search — unlike the old
  // implementation, nothing here may navigate the bound tab.
  await openTarget('/page.html');

  // Explicit queries, so this exercises the search ladder and not the planner's
  // model call.
  const { results, sources } = await callTool<{
    results: { rank: number; title: string; url: string }[];
    sources: string[];
  }>(panel, 'web_search', { query: 'what is openai', queries: ['openai'], count: 5 });

  expect(results.length).toBeGreaterThan(0);
  expect(results[0].url).toMatch(/^https?:\/\//);
  expect(results[0].title.length).toBeGreaterThan(0);
  expect(sources.length).toBeGreaterThan(0);

  const { value: stillThere } = await callTool<{ value: string }>(panel, 'evaluate_script', {
    function: '() => location.pathname',
  });
  expect(stillThere).toBe('/page.html');
});
