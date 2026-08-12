import { test as base, chromium, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const DIST = path.resolve(import.meta.dirname, '..', 'dist');

/** Shape of the test bridge installed by src/e2e/hook.ts. */
export interface StoredLedger {
  threadId: string;
  goal: string | null;
  plan: { text: string; status: string }[];
  findings: { key: string; summary: string; data?: Record<string, unknown> }[];
  notes: string[];
  extraction?: { url: string; schema: { rowSelector: string; keyField: string } };
}

/** Mirrors StopInfo in lib/llm/agentLoop — how a turn ended. */
export interface TranscriptStop {
  finishReason: string;
  steps: number;
  hitStepLimit: boolean;
  totalTokens?: number;
  aborted?: boolean;
}

export interface TranscriptMessage {
  role: 'user' | 'assistant';
  text: string;
  toolCalls: { name: string; status: string }[];
  stop: TranscriptStop | null;
  error: string | null;
}

export interface Transcript {
  isStreaming: boolean;
  messages: TranscriptMessage[];
}

export interface CdpTestApi {
  attach(tabId: number): Promise<unknown>;
  detach(): Promise<void>;
  attachedTabId(): number | null;
  call(name: string, args?: unknown): Promise<unknown>;
  toolNames(): string[];
  transcript(): Transcript;
  ledger: {
    activate(threadId: string): Promise<StoredLedger>;
    get(): StoredLedger | null;
  };
  tasks: {
    list(): Promise<StoredTask[]>;
    remove(id: string): Promise<StoredTask[]>;
    run(task: StoredTask): Promise<StoredTaskRun>;
    saveCurrent(name: string): Promise<StoredTask[]>;
  };
}

export interface StoredTask {
  id: string;
  name: string;
  url: string;
  lastRunAt: number | null;
  lastRowCount: number;
  lastKeys: string[];
}

export interface StoredTaskRun {
  rows: number;
  pagesVisited: number;
  stopReason: string;
  newKeys: string[];
  firstRun: boolean;
}

declare global {
  interface Window {
    __cdp: CdpTestApi;
    __keys?: string[];
  }
}

export interface ExtensionFixtures {
  context: BrowserContext;
  extensionId: string;
  /** The extension page exposing window.__cdp — drive the tool layer from here. */
  panel: Page;
  /** Opens a fixture page and attaches the extension's debugger to it. */
  openTarget: (urlPath: string) => Promise<{ page: Page; tabId: number }>;
}

export const test = base.extend<ExtensionFixtures>({
  // Playwright parses this signature to infer fixture dependencies and rejects
  // anything but a destructuring pattern, so the empty pattern is required here.
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    if (!fs.existsSync(path.join(DIST, 'manifest.json'))) {
      throw new Error(`No build found at ${DIST}. Run: npm run build:e2e`);
    }

    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagehand-e2e-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    });

    await use(context);

    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  },

  extensionId: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await use(new URL(sw.url()).host);
  },

  panel: async ({ context, extensionId }, use) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
    await page.waitForFunction(() => typeof window.__cdp !== 'undefined');
    await use(page);
  },

  openTarget: async ({ context, panel }, use) => {
    await use(async (urlPath: string) => {
      const page = await context.newPage();
      await page.goto(urlPath.startsWith('http') ? urlPath : `http://localhost:${port()}${urlPath}`);

      const url = page.url();
      const tabId = await panel.evaluate(async (target) => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((t) => t.url === target);
        if (tab?.id === undefined) throw new Error(`No tab found for ${target}`);
        await window.__cdp.attach(tab.id);
        return tab.id;
      }, url);

      return { page, tabId };
    });
  },
});

function port(): number {
  return Number(process.env.E2E_PORT ?? 5599);
}

/** Invoke a tool in the extension exactly as the agent loop would. */
export async function callTool<T = unknown>(
  panel: Page,
  name: string,
  args: unknown = {},
): Promise<T> {
  return panel.evaluate(
    ([n, a]) => window.__cdp.call(n as string, a),
    [name, args] as [string, unknown],
  ) as Promise<T>;
}

export interface SnapshotResult {
  url: string;
  snapshot: string;
  uidCount: number;
  truncated: boolean;
  chars: number;
}

/** Pull the uid the model would use for the element whose line mentions `needle`. */
export function uidFor(snapshot: string, needle: string): string {
  const line = snapshot.split('\n').find((l) => l.includes(needle));
  if (!line) throw new Error(`No snapshot line matching "${needle}". Snapshot:\n${snapshot}`);
  const match = line.match(/\[uid=(\d+)\]/);
  if (!match) throw new Error(`Line has no uid: ${line}`);
  return match[1];
}

export { expect } from '@playwright/test';
