import { waitForTabComplete } from '../pages/PageManager';
import { bingSearchUrl } from './bingRss';
import type { SearchHit } from './types';

/**
 * The last rung: a real Bing results page, in a real tab.
 *
 * Everything above it is a plain fetch, which is anonymous, uncookied, and the
 * first thing an engine throttles. When that fails — a captcha, a region wall,
 * a feed we can't parse — a tab still works, because it is the user's own
 * browser with the user's own session, which is the whole premise of this
 * product.
 *
 * Two things separate this from the version it replaces. The tab is created in
 * the background and closed afterwards, so the page the user was reading is
 * never navigated away (the old implementation drove the *bound* tab to Bing
 * and left it there — the agent then had to find its way back). And the results
 * are read with chrome.scripting instead of a debugger attach, so it neither
 * fights the agent's CDP session for the tab nor raises the "being debugged"
 * banner for something the user never asked to watch.
 */

const TAB_TIMEOUT_MS = 20_000;

/**
 * Serialized into the results page by chrome.scripting, so it must be
 * self-contained — no imports, no closure over anything in this module.
 */
export function scrapeBingResults(): SearchHit[] {
  const out: SearchHit[] = [];
  for (const li of document.querySelectorAll('#b_results > li.b_algo')) {
    const anchor = li.querySelector<HTMLAnchorElement>('h2 a');
    if (!anchor?.href) continue;
    const caption = li.querySelector('.b_caption p') ?? li.querySelector('p');
    out.push({
      title: (anchor.innerText || '').trim(),
      url: anchor.href,
      snippet: caption ? ((caption as HTMLElement).innerText || '').trim() : '',
    });
  }
  return out;
}

export async function bingTabSearch(
  query: string,
  { limit, signal }: { limit: number; signal?: AbortSignal },
): Promise<SearchHit[]> {
  const tab = await chrome.tabs.create({
    url: bingSearchUrl(query, { count: limit }),
    active: false,
  });
  const tabId = tab.id;
  if (tabId === undefined) throw new Error('Could not open a tab to search in');

  try {
    await waitForTabComplete(tabId, TAB_TIMEOUT_MS);
    if (signal?.aborted) throw new Error('Search aborted');

    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: scrapeBingResults,
    });
    const hits = (injection?.result ?? []) as SearchHit[];
    if (hits.length === 0) throw new Error('No results found on the Bing page');
    return hits.slice(0, limit);
  } finally {
    // Never leave the user with a stray tab, whatever went wrong above.
    await chrome.tabs.remove(tabId).catch(() => {});
  }
}
