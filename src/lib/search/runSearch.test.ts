import { describe, it, expect, vi } from 'vitest';
import { runLadder, type Rung } from './runSearch';
import type { SearchHit } from './types';

const hit = (url: string): SearchHit => ({ title: url, url, snippet: '' });

/** A rung that answers for the listed queries and fails for the rest. */
function fakeRung(
  source: Rung['source'],
  answers: Record<string, SearchHit[]>,
  extra: Partial<Rung> = {},
): Rung & { calls: string[] } {
  const calls: string[] = [];
  return {
    source,
    calls,
    backend: async (query) => {
      calls.push(query);
      const hits = answers[query];
      if (!hits) throw new Error('nothing here');
      return hits;
    },
    ...extra,
  };
}

describe('runLadder', () => {
  it('never reaches a lower rung when the first one answers', async () => {
    const top = fakeRung('firecrawl', { a: [hit('https://a.com')], b: [hit('https://b.com')] });
    const bottom = fakeRung('bing-tab', { a: [hit('https://tab.com')] });

    const { perQuery, failures } = await runLadder(['a', 'b'], [top, bottom], { limit: 5 });

    expect(bottom.calls).toEqual([]);
    expect(perQuery.map((entry) => entry.source)).toEqual(['firecrawl', 'firecrawl']);
    expect(failures).toEqual([]);
  });

  it('drops only the query that failed, not the whole search', async () => {
    const top = fakeRung('bing-rss', { a: [hit('https://a.com')] });
    const bottom = fakeRung('bing-tab', { b: [hit('https://b.com')] });

    const { perQuery, failures } = await runLadder(['a', 'b'], [top, bottom], { limit: 5 });

    expect(bottom.calls).toEqual(['b']);
    expect(perQuery).toEqual([
      { query: 'a', source: 'bing-rss', hits: [hit('https://a.com')] },
      { query: 'b', source: 'bing-tab', hits: [hit('https://b.com')] },
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('bing-rss · b');
  });

  it('treats an empty result as a failure worth falling through for', async () => {
    const top = fakeRung('bing-rss', { a: [] });
    const bottom = fakeRung('bing-tab', { a: [hit('https://a.com')] });

    const { perQuery } = await runLadder(['a'], [top, bottom], { limit: 5 });

    expect(bottom.calls).toEqual(['a']);
    expect(perQuery).toHaveLength(1);
    expect(perQuery[0].source).toBe('bing-tab');
  });

  it('falls through an engine that answered a broader question', async () => {
    // Real Bing output for this query: confident, well-formed, about a city.
    const broadened: SearchHit[] = [
      { title: '杭州市_百度百科', url: 'https://baike.baidu.com/item/杭州市', snippet: '' },
      { title: '杭州市人民政府门户网站', url: 'https://www.hangzhou.gov.cn/', snippet: '' },
    ];
    const top = fakeRung('bing-rss', { 杭州二手房成交量统计: broadened });
    const bottom = fakeRung('bing-tab', {
      杭州二手房成交量统计: [
        { title: '杭州二手房成交量统计月报', url: 'https://fangchan.example/hz', snippet: '成交量统计' },
      ],
    });

    const { perQuery, failures } = await runLadder(['杭州二手房成交量统计'], [top, bottom], {
      limit: 5,
    });

    expect(bottom.calls).toEqual(['杭州二手房成交量统计']);
    expect(perQuery).toHaveLength(1);
    expect(perQuery[0].source).toBe('bing-tab');
    expect(failures[0]).toContain('off-topic');
  });

  it('reports the queries it could not answer at all', async () => {
    const { perQuery, failures } = await runLadder(['a'], [fakeRung('bing-rss', {})], { limit: 5 });
    expect(perQuery).toEqual([]);
    expect(failures).toHaveLength(1);
  });

  it('runs a fetch rung concurrently and a tab rung two at a time', async () => {
    let live = 0;
    let peak = 0;
    const rung: Rung = {
      source: 'bing-tab',
      concurrency: 2,
      backend: async (query) => {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise((resolve) => setTimeout(resolve, 5));
        live -= 1;
        return [hit(`https://${query}.com`)];
      },
    };

    await runLadder(['a', 'b', 'c', 'd'], [rung], { limit: 5 });
    expect(peak).toBe(2);

    live = 0;
    peak = 0;
    await runLadder(['a', 'b', 'c', 'd'], [{ ...rung, source: 'bing-rss', concurrency: undefined }], {
      limit: 5,
    });
    expect(peak).toBe(4);
  });

  it('stops descending once the turn is aborted', async () => {
    const controller = new AbortController();
    const top = fakeRung('bing-rss', {});
    const bottom = fakeRung('bing-tab', { a: [hit('https://a.com')] });
    const abortingTop: Rung = {
      ...top,
      backend: async (query) => {
        controller.abort();
        return top.backend(query, { limit: 5 });
      },
    };

    const { perQuery } = await runLadder(['a'], [abortingTop, bottom], {
      limit: 5,
      signal: controller.signal,
    });

    expect(bottom.calls).toEqual([]);
    expect(perQuery).toEqual([]);
  });
});

describe('buildRungs', () => {
  it('prefers the user key, and never spends ours as well', async () => {
    vi.resetModules();
    vi.doMock('../auth/session', () => ({ isSignedIn: async () => true }));
    const { buildRungs } = await import('./runSearch');

    const withKey = await buildRungs({
      provider: 'hosted',
      model: 'm',
      firecrawlApiKey: 'fc-user',
    });
    expect(withKey.map((rung) => rung.source)).toEqual(['firecrawl', 'bing-rss', 'bing-tab']);

    const withoutKey = await buildRungs({ provider: 'hosted', model: 'm' });
    expect(withoutKey.map((rung) => rung.source)).toEqual([
      'firecrawl-hosted',
      'bing-rss',
      'bing-tab',
    ]);
    vi.doUnmock('../auth/session');
  });

  it('falls to the keyless rungs for a signed-out user with no key', async () => {
    vi.resetModules();
    vi.doMock('../auth/session', () => ({ isSignedIn: async () => false }));
    const { buildRungs } = await import('./runSearch');

    const rungs = await buildRungs({ provider: 'deepseek', model: 'm', apiKey: 'sk-x' });
    expect(rungs.map((rung) => rung.source)).toEqual(['bing-rss', 'bing-tab']);
    vi.doUnmock('../auth/session');
  });
});
