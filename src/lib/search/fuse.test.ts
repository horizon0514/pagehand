import { describe, it, expect } from 'vitest';
import { fuseResults, normalizeUrl } from './fuse';
import type { QueryHits } from './types';

const hits = (urls: string[]) =>
  urls.map((url, i) => ({ title: `title ${i}`, url, snippet: `snippet ${i}` }));

describe('normalizeUrl', () => {
  it('collapses the variants an engine returns for one page', () => {
    const canonical = normalizeUrl('https://example.com/a');
    expect(normalizeUrl('http://www.example.com/a/')).toBe(canonical);
    expect(normalizeUrl('https://EXAMPLE.com/a#section')).toBe(canonical);
    expect(normalizeUrl('https://example.com/a?utm_source=bing&fbclid=x')).toBe(canonical);
  });

  it('keeps meaningful query parameters, order-insensitively', () => {
    expect(normalizeUrl('https://example.com/s?b=2&a=1')).toBe(
      normalizeUrl('https://example.com/s?a=1&b=2'),
    );
    expect(normalizeUrl('https://example.com/s?a=1')).not.toBe(normalizeUrl('https://example.com/s'));
  });

  it('leaves something unparsable alone rather than dropping it', () => {
    expect(normalizeUrl('not a url')).toBe('not a url');
  });
});

describe('fuseResults', () => {
  it('ranks a page two queries agree on above either list leader', () => {
    const lists: QueryHits[] = [
      { query: 'q1', source: 'bing-rss', hits: hits(['https://one.com', 'https://both.com']) },
      { query: 'q2', source: 'bing-rss', hits: hits(['https://two.com', 'https://both.com']) },
    ];
    expect(fuseResults(lists, 5).map((r) => r.url)).toEqual([
      'https://both.com',
      'https://one.com',
      'https://two.com',
    ]);
  });

  it('does not let one list score the same page twice', () => {
    const lists: QueryHits[] = [
      {
        query: 'q1',
        source: 'bing-rss',
        // A repeated url (Bing relists a domain for its sublinks) must not beat
        // genuine cross-query agreement.
        hits: hits(['https://dup.com', 'https://dup.com/', 'https://other.com']),
      },
      { query: 'q2', source: 'bing-rss', hits: hits(['https://other.com']) },
    ];
    const fused = fuseResults(lists, 5);
    expect(fused.map((r) => r.url)).toEqual(['https://other.com', 'https://dup.com']);
  });

  it('numbers the output and caps it', () => {
    const lists: QueryHits[] = [
      { query: 'q', source: 'firecrawl', hits: hits(['https://a.com', 'https://b.com', 'https://c.com']) },
    ];
    const fused = fuseResults(lists, 2);
    expect(fused).toHaveLength(2);
    expect(fused.map((r) => r.rank)).toEqual([1, 2]);
  });

  it('drops entries missing a title or url', () => {
    const lists: QueryHits[] = [
      {
        query: 'q',
        source: 'firecrawl',
        hits: [
          { title: '', url: 'https://no-title.com', snippet: '' },
          { title: 'no url', url: '', snippet: '' },
          { title: 'good', url: 'https://good.com', snippet: '' },
        ],
      },
    ];
    expect(fuseResults(lists, 5).map((r) => r.url)).toEqual(['https://good.com']);
  });

  it('keeps the fuller snippet and clamps it', () => {
    const lists: QueryHits[] = [
      { query: 'q1', source: 'bing-rss', hits: [{ title: 't', url: 'https://a.com', snippet: 'short' }] },
      {
        query: 'q2',
        source: 'bing-rss',
        hits: [{ title: 't', url: 'https://a.com', snippet: `lots   of\n\nspace ${'y'.repeat(400)}` }],
      },
    ];
    const [result] = fuseResults(lists, 5);
    expect(result.snippet).not.toContain('\n');
    expect(result.snippet.length).toBeLessThanOrEqual(301);
    expect(result.snippet.endsWith('…')).toBe(true);
  });
});
