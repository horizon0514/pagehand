import { describe, it, expect } from 'vitest';
import { coverage, filterRelevant, queryTerms, specificity } from './relevance';
import type { SearchHit } from './types';

const hit = (title: string, snippet = ''): SearchHit => ({
  title,
  snippet,
  url: `https://example.com/${encodeURIComponent(title)}`,
});

describe('queryTerms', () => {
  it('splits a CJK phrase into bigrams, since it has no spaces to split on', () => {
    expect(queryTerms('二手房')).toEqual([['二手', '手房']]);
  });

  it('separates ASCII words from CJK runs in a mixed query', () => {
    expect(queryTerms('飞书多维表格API')).toEqual([
      ['飞书', '书多', '多维', '维表', '表格'],
      ['api'],
    ]);
  });

  it('ignores operators, which no page echoes back', () => {
    expect(queryTerms('site:feishu.cn 权限设置')).toEqual([['权限', '限设', '设置']]);
  });

  it('drops one-character noise', () => {
    expect(queryTerms('a vue3 响应式')).toEqual([['vue3'], ['响应', '应式']]);
  });
});

describe('coverage', () => {
  const terms = queryTerms('杭州二手房成交数据');

  it('scores a page that echoes the phrase far above one that echoes its first word', () => {
    const good = coverage(terms, '杭州二手房网签-杭州二手房成交价格-我爱我家');
    const broadened = coverage(terms, '杭州市_百度百科');
    expect(good).toBeGreaterThan(0.5);
    expect(broadened).toBeLessThan(0.2);
  });

  it('is case-insensitive for ASCII', () => {
    expect(coverage(queryTerms('firecrawl search api'), 'FIRECRAWL SEARCH API')).toBe(1);
  });

  it('does not let a bare year outweigh the phrase it qualifies', () => {
    // The municipal portal, matching the city and the year and nothing else —
    // the exact hit that a group-averaged score used to wave through at 0.56.
    const score = coverage(queryTerms('杭州二手房成交量统计2026'), '杭州市人民政府门户网站 2026');
    expect(score).toBeLessThan(0.35);
  });
});

describe('filterRelevant', () => {
  /** Real Bing output for 「杭州二手房成交量统计」 — a query it had no match for. */
  const broadened = [
    hit('杭州市_百度百科', '杭州市，简称杭，古称临安、钱塘'),
    hit('杭州市人民政府门户网站', '政务服务'),
    hit('百度地图', '百度地图为您提供路线规划'),
    hit('2025杭州旅游全攻略', '一年去了5次杭州'),
  ];

  it('drops a whole list when the engine answered a broader question', () => {
    expect(filterRelevant('杭州二手房成交量统计', broadened)).toEqual([]);
  });

  it('keeps the answers when the engine actually had them', () => {
    const good = [
      hit('杭州二手房网签-杭州二手房成交价格-我爱我家官网', '杭州二手房成交数据'),
      hit('杭州商品住宅成交数据 | 中指云', '杭州新房成交查询'),
    ];
    expect(filterRelevant('杭州二手房成交数据', good)).toHaveLength(2);
  });

  it('keeps the real hits out of a partly broadened list', () => {
    const mixed = [hit('Firecrawl search API pricing', 'credits per search'), ...broadened];
    expect(filterRelevant('firecrawl search api pricing', mixed).map((h) => h.title)).toEqual([
      'Firecrawl search API pricing',
    ]);
  });

  it('never judges a query too short to have been broadened', () => {
    // Nothing was dropped from it, so a thin match is not evidence of anything.
    expect(filterRelevant('杭州', broadened)).toEqual(broadened);
    expect(filterRelevant('react', broadened)).toEqual(broadened);
  });
});

describe('specificity', () => {
  it('counts what the query is asking for, not how it is written', () => {
    expect(specificity(queryTerms('杭州'))).toBe(1);
    expect(specificity(queryTerms('杭州二手房成交数据'))).toBe(8);
    expect(specificity(queryTerms('firecrawl search api pricing'))).toBe(4);
  });
});
