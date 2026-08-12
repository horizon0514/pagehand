import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { proxySearch, toResults, type SearchDeps } from './search.ts';

process.env.FIRECRAWL_API_KEY = 'fc-test';

interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

/** Stands in for Firecrawl and records exactly what we sent it. */
function captureUpstream(respond: () => Response): { calls: Captured[] } {
  const calls: Captured[] = [];
  mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return respond();
  });
  return { calls };
}

function post(body: unknown): Request {
  return new Request('https://pagehand.test/api/v1/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function deps(): SearchDeps & { credits: (number | null)[] } {
  const credits: (number | null)[] = [];
  return { userId: 'user-1', credits, onCredits: (used) => credits.push(used) };
}

const firecrawlBody = {
  success: true,
  data: {
    web: [
      { url: 'https://a.com', title: 'A', description: 'about a' },
      { url: 'https://b.com', title: 'B' },
    ],
  },
  creditsUsed: 2,
};

test('forwards only the fields it validated, on our key', async (t) => {
  t.after(() => mock.restoreAll());
  const upstream = captureUpstream(() => Response.json(firecrawlBody));
  const d = deps();

  const res = await proxySearch(
    // scrapeOptions would bill us a credit per scraped page — it must not survive.
    post({ query: '  firecrawl search  ', limit: 5, scrapeOptions: { formats: ['markdown'] } }),
    d,
  );

  assert.equal(res.status, 200);
  assert.equal(upstream.calls.length, 1);
  assert.deepEqual(upstream.calls[0]!.body, { query: 'firecrawl search', limit: 5 });
  assert.equal(upstream.calls[0]!.headers.get('authorization'), 'Bearer fc-test');
  assert.deepEqual(await res.json(), {
    results: [
      { title: 'A', url: 'https://a.com', snippet: 'about a' },
      { title: 'B', url: 'https://b.com', snippet: '' },
    ],
  });
  assert.deepEqual(d.credits, [2]);
});

test('clamps the result count rather than trusting it', async (t) => {
  t.after(() => mock.restoreAll());
  const upstream = captureUpstream(() => Response.json(firecrawlBody));

  await proxySearch(post({ query: 'q', limit: 500 }), deps());
  assert.equal(upstream.calls[0]!.body.limit, 20);

  await proxySearch(post({ query: 'q' }), deps());
  assert.equal(upstream.calls[1]!.body.limit, 10);
});

test('rejects a request with no query before spending anything', async (t) => {
  t.after(() => mock.restoreAll());
  const upstream = captureUpstream(() => Response.json(firecrawlBody));

  const res = await proxySearch(post({ limit: 5 }), deps());

  assert.equal(res.status, 400);
  assert.equal(upstream.calls.length, 0);
});

test('reports an upstream failure as unavailable, so the client falls back', async (t) => {
  t.after(() => mock.restoreAll());
  // 402: our account is out of credits. That is our problem, not the user's.
  captureUpstream(() => Response.json({ error: 'Insufficient credits' }, { status: 402 }));

  const res = await proxySearch(post({ query: 'q' }), deps());

  assert.equal(res.status, 503);
  const body = (await res.json()) as { error: { code: string } };
  assert.equal(body.error.code, 'search_unavailable');
});

test('reads results out of the documented shape and tolerates the rest', () => {
  assert.deepEqual(toResults(firecrawlBody), [
    { title: 'A', url: 'https://a.com', snippet: 'about a' },
    { title: 'B', url: 'https://b.com', snippet: '' },
  ]);
  assert.deepEqual(toResults({ data: { web: [{ url: 'https://c.com' }] } }), []);
  assert.deepEqual(toResults(null), []);
});
