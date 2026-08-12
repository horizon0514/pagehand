import { DebuggerSession } from '../debugger-bridge/DebuggerSession';
import { sessionRegistry } from '../debugger-bridge/sessionRegistry';
import { agentTabTracker } from './agentTabTracker';
import { setBoundTabId } from '../tools/context';

export interface PageInfo {
  pageId: number;
  url: string;
  title: string;
  active: boolean;
  attached: boolean;
  /** For the UI only — a person picks a tab by its icon. Stripped from list_pages. */
  favIconUrl?: string;
}

function toPageInfo(tab: chrome.tabs.Tab): PageInfo | null {
  if (tab.id === undefined) return null;
  return {
    pageId: tab.id,
    url: tab.url ?? tab.pendingUrl ?? '',
    title: tab.title ?? '',
    active: tab.active ?? false,
    attached: sessionRegistry.getAttached()?.getTabId() === tab.id,
    favIconUrl: tab.favIconUrl,
  };
}

export async function listPages(): Promise<PageInfo[]> {
  const tabs = await chrome.tabs.query({ windowType: 'normal' });
  return tabs.map(toPageInfo).filter((p): p is PageInfo => p !== null);
}

export function waitForTabComplete(tabId: number, timeout = 15_000): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, timeout);

    void chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') finish();
    });
  });
}

export async function newPage(
  url: string,
  opts: { background?: boolean; timeout?: number } = {},
): Promise<PageInfo> {
  const tab = await chrome.tabs.create({ url, active: !opts.background });
  if (tab.id === undefined) throw new Error('Failed to create tab');
  agentTabTracker.trackCreated(tab.id);
  await waitForTabComplete(tab.id, opts.timeout);
  const fresh = await chrome.tabs.get(tab.id);
  const info = toPageInfo(fresh);
  if (!info) throw new Error('Failed to read created tab');
  return info;
}

export async function selectPage(
  pageId: number,
  opts: { bringToFront?: boolean } = {},
): Promise<DebuggerSession> {
  if (opts.bringToFront) {
    await chrome.tabs.update(pageId, { active: true });
  }
  // Explicit user/model choice — rebind, but do NOT mark for auto-cleanup.
  setBoundTabId(pageId);
  return sessionRegistry.attach(pageId);
}

export async function closePage(pageId: number): Promise<void> {
  agentTabTracker.untrack(pageId);

  const attached = sessionRegistry.getAttached();
  if (attached?.getTabId() === pageId) {
    await sessionRegistry.detach();
  }

  const remaining = await chrome.tabs.query({ windowType: 'normal' });
  if (remaining.length <= 1) {
    throw new Error('The last open page cannot be closed.');
  }
  await chrome.tabs.remove(pageId);
}
