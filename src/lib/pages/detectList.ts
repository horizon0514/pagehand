/**
 * Does the page in front of the user hold a list worth exporting?
 *
 * This is only ever a hint for the UI, so it is deliberately the cheapest probe
 * that can answer. It never attaches the debugger — that would raise Chrome's
 * "is debugging this browser" banner for a question nobody asked — and it never
 * calls permissions.request(), because a dialog on every tab switch is worse
 * than not knowing. When the answer can't be had for free it returns null, and
 * the caller shows its affordance anyway rather than hiding a feature behind a
 * probe the user never opted into.
 */

/** Fewer repeats than this is a menu or a widget, not data. */
const MIN_REPEAT = 4;
/** Repeats this short are navigation, whatever their shape. */
const MIN_ROW_CHARS = 8;

/**
 * Injected into the page. Must be self-contained — chrome.scripting serializes
 * it with toString(), so it closes over nothing.
 */
export function countRepeatingRows(minRepeat: number, minChars: number): number {
  const textLen = (el: Element) => (el.textContent ?? '').trim().length;
  let best = 0;

  for (const table of document.querySelectorAll('table')) {
    const rows = (table.tBodies[0] ?? table).rows?.length ?? 0;
    if (rows >= minRepeat) best = Math.max(best, rows);
  }

  for (const parent of document.querySelectorAll('body *')) {
    if (parent.children.length < minRepeat) continue;
    if (parent.closest('table')) continue;

    const groups = new Map<string, Element[]>();
    for (const child of parent.children) {
      const key = child.tagName + '|' + Array.from(child.classList).sort().slice(0, 3).join('.');
      const group = groups.get(key);
      if (group) group.push(child);
      else groups.set(key, [child]);
    }

    for (const group of groups.values()) {
      if (group.length < minRepeat || group.length <= best) continue;
      const avg = group.reduce((sum, el) => sum + textLen(el), 0) / group.length;
      if (avg >= minChars) best = group.length;
    }
  }

  return best;
}

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const { protocol, origin } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? origin : null;
  } catch {
    return null;
  }
}

export interface ListDetection {
  /** The active tab can be acted on at all — false for chrome://, the store, … */
  scriptable: boolean;
  /** Rows found, or null when the page could not be probed for free. */
  rows: number | null;
}

export async function detectList(): Promise<ListDetection> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const origin = originOf(tab?.url);
  if (tab?.id == null || !origin) return { scriptable: false, rows: null };

  // contains(), never request(): silence is the correct answer here.
  const granted = await chrome.permissions
    .contains({ origins: [`${origin}/*`] })
    .catch(() => false);
  if (!granted || !chrome.scripting?.executeScript) return { scriptable: true, rows: null };

  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: countRepeatingRows,
      args: [MIN_REPEAT, MIN_ROW_CHARS],
    });
    return { scriptable: true, rows: typeof result?.result === 'number' ? result.result : null };
  } catch {
    // Injection blocked (CSP, a page mid-navigation, a revoked grant).
    return { scriptable: true, rows: null };
  }
}
