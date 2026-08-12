import { describe, it, expect } from 'vitest';
import { parseFirecrawlResults } from './firecrawl';

describe('parseFirecrawlResults', () => {
  it('reads the documented { data: { web: [...] } } shape', () => {
    expect(
      parseFirecrawlResults({
        success: true,
        data: {
          web: [
            { url: 'https://a.com', title: 'A', description: 'about a' },
            { url: 'https://b.com', title: 'B' },
          ],
        },
        creditsUsed: 2,
      }),
    ).toEqual([
      { title: 'A', url: 'https://a.com', snippet: 'about a' },
      { title: 'B', url: 'https://b.com', snippet: '' },
    ]);
  });

  it('reads our own proxy’s flattened reply', () => {
    expect(
      parseFirecrawlResults({ results: [{ url: 'https://a.com', title: 'A', snippet: 'about a' }] }),
    ).toEqual([{ title: 'A', url: 'https://a.com', snippet: 'about a' }]);
  });

  it('skips items missing a url or title instead of failing the search', () => {
    expect(
      parseFirecrawlResults({
        data: { web: [{ url: 'https://a.com' }, { title: 'no url' }, null, 'nonsense'] },
      }),
    ).toEqual([]);
  });

  it('returns nothing for an error body', () => {
    expect(parseFirecrawlResults({ error: 'Insufficient credits' })).toEqual([]);
    expect(parseFirecrawlResults(null)).toEqual([]);
  });
});
