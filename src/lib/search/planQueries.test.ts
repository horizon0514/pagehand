import { describe, it, expect } from 'vitest';
import { buildPlannerPrompt, parseQueries } from './planQueries';

describe('parseQueries', () => {
  it('reads a plain JSON array', () => {
    expect(parseQueries('["hangzhou housing prices 2026", "杭州 二手房 成交价"]', 3)).toEqual([
      'hangzhou housing prices 2026',
      '杭州 二手房 成交价',
    ]);
  });

  it('tolerates fences and an object wrapper', () => {
    expect(parseQueries('```json\n{"queries": ["a b", "c d"]}\n```', 3)).toEqual(['a b', 'c d']);
  });

  it('falls back to one query per line when the model ignores JSON', () => {
    expect(parseQueries('1. firecrawl search api\n- "firecrawl pricing credits"\n', 3)).toEqual([
      'firecrawl search api',
      'firecrawl pricing credits',
    ]);
  });

  it('dedupes case-insensitively and honours the cap', () => {
    expect(parseQueries('["Same Query", "same query", "other"]', 2)).toEqual([
      'Same Query',
      'other',
    ]);
  });

  it('returns nothing when there is nothing usable', () => {
    expect(parseQueries('   ', 3)).toEqual([]);
    expect(parseQueries('[1, 2, 3]', 3)).toEqual([]);
  });
});

describe('buildPlannerPrompt', () => {
  it('carries the date, so "latest" means something', () => {
    const prompt = buildPlannerPrompt('newest react release', 3, new Date('2026-08-12T00:00:00Z'));
    expect(prompt).toContain('2026-08-12');
    expect(prompt).toContain('newest react release');
    expect(prompt).toContain('3 queries');
  });
});
