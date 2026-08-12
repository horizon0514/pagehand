import { describe, it, expect } from 'vitest';
import { bingSearchUrl, decodeEntities, parseBingRss } from './bingRss';

describe('bingSearchUrl', () => {
  it('encodes the query, including CJK and spaces', () => {
    expect(bingSearchUrl('杭州 二手房 2026')).toBe(
      'https://www.bing.com/search?q=%E6%9D%AD%E5%B7%9E+%E4%BA%8C%E6%89%8B%E6%88%BF+2026',
    );
  });

  it('asks for the feed only when requested', () => {
    expect(bingSearchUrl('x', { rss: true, count: 10 })).toBe(
      'https://www.bing.com/search?q=x&count=10&format=rss',
    );
    expect(bingSearchUrl('x')).not.toContain('format=rss');
  });
});

describe('decodeEntities', () => {
  it('decodes named and numeric references', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &#39;d&#39; &#x27;e&#x27;')).toBe(
      "a & b <c> 'd' 'e'",
    );
  });

  it('leaves an unknown entity as written', () => {
    expect(decodeEntities('&notanentity;')).toBe('&notanentity;');
  });
});

describe('parseBingRss', () => {
  const feed = `<?xml version="1.0" encoding="utf-8" ?><rss version="2.0"><channel>
    <title>必应：firecrawl</title>
    <link>http://www.bing.com:80/search?q=firecrawl</link>
    <item>
      <title>Firecrawl &amp; the context API</title>
      <link>https://www.firecrawl.dev/</link>
      <description>Turn any source into <b>clean</b> Markdown.</description>
      <pubDate>周三, 12 8月 2026 00:10:00 GMT</pubDate>
    </item>
    <item>
      <title><![CDATA[快速入门 | Firecrawl 文档]]></title>
      <link>https://docs.firecrawl.dev/</link>
      <description>欢迎来到 Firecrawl</description>
    </item>
    <item>
      <title>No link here</title>
      <description>should be dropped</description>
    </item>
  </channel></rss>`;

  it('reads the items and not the channel', () => {
    const hits = parseBingRss(feed);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({
      title: 'Firecrawl & the context API',
      url: 'https://www.firecrawl.dev/',
      snippet: 'Turn any source into clean Markdown.',
    });
  });

  it('unwraps CDATA titles', () => {
    expect(parseBingRss(feed)[1].title).toBe('快速入门 | Firecrawl 文档');
  });

  it('returns nothing for a page that is not a feed', () => {
    expect(parseBingRss('<html><body>captcha</body></html>')).toEqual([]);
  });
});
