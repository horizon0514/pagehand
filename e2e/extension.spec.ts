import { test, expect } from './extension';

test('loads with a registered service worker and the expected manifest', async ({
  context,
  extensionId,
  panel,
}) => {
  expect(extensionId).toMatch(/^[a-p]{32}$/);
  expect(context.serviceWorkers()).not.toHaveLength(0);

  const manifest = await panel.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.permissions).toEqual(
    expect.arrayContaining(['sidePanel', 'debugger', 'tabs', 'storage', 'scripting']),
  );
  expect(manifest.side_panel?.default_path).toContain('sidepanel');
});

/**
 * Sign-in ends with the page the emailed link opened calling
 * `chrome.runtime.sendMessage`, which exists only on origins the manifest lists
 * under `externally_connectable`. A development build lists localhost so the
 * whole flow can run against a local cloud/ — and whether Chrome honoured that
 * pattern cannot be read off the manifest, since getManifest() echoes back what
 * was written rather than what was accepted. Only a page can answer it.
 *
 * The distinction that makes this worth a test: `http://localhost:3000/*` is
 * accepted into the manifest and matches nothing, because match patterns have
 * no ports. Portless is the whole trick, and nothing else would notice it
 * breaking.
 */
test('a local page can reach the extension, which is what local sign-in needs', async ({
  context,
  panel,
}) => {
  const matches = await panel.evaluate(
    () => chrome.runtime.getManifest().externally_connectable?.matches ?? [],
  );
  expect(matches).toContain('http://localhost/*');

  const page = await context.newPage();
  await page.goto('/page.html');
  const reachable = await page.evaluate(
    () =>
      typeof (globalThis as { chrome?: { runtime?: { sendMessage?: unknown } } }).chrome?.runtime
        ?.sendMessage === 'function',
  );
  expect(reachable).toBe(true);
});

test('side panel renders without console errors', async ({ context, extensionId }) => {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  // A fresh profile opens on sign-in — heading is localized (en / zh).
  await expect(
    page.getByRole('heading', { name: /^(Sign in to Pagehand|登录 Pagehand)$/ }),
  ).toBeVisible();

  expect(errors).toEqual([]);
});

test('leads a fresh profile to sign-in, with BYOK one click away', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);

  // A fresh profile has no key to offer, so hosted is the only mode it can
  // actually complete — the panel asks for an account, not a key.
  await expect(page.getByPlaceholder('you@example.com')).toBeVisible();
  await expect(page.getByRole('button', { name: /Continue with email|用邮箱继续/ })).toBeVisible();

  // Demoted to an icon, but an icon still owes assistive tech a name.
  await expect(page.getByRole('combobox', { name: /Language|语言/ })).toBeVisible();

  // Prefer the textbox role so the "Show API key" toggle (same /API key/ label
  // match) doesn't collide, and anchor the name so the search section's own
  // "Firecrawl API key" — which is not part of provider setup — doesn't either.
  const keyField = page.getByRole('textbox', { name: /^(API key|API 密钥)$/i });
  await expect(keyField).toHaveCount(0);

  // Weakened, not removed: anyone who wants their own key is one click away.
  await page
    .getByRole('button', { name: /Use your own API key instead|改用自己的 API 密钥/ })
    .click();
  await expect(keyField).toBeVisible();
});

test('persists provider settings to chrome.storage.local', async ({ panel }) => {
  await panel.evaluate(() =>
    chrome.storage.local.set({
      'pagehand:settings': {
        provider: 'openai-compatible',
        apiKey: 'test-key',
        model: 'test-model',
        baseURL: 'http://localhost:5599/v1',
      },
    }),
  );

  const stored = await panel.evaluate(async () => {
    const r = await chrome.storage.local.get('pagehand:settings');
    return r['pagehand:settings'];
  });

  expect(stored).toMatchObject({ provider: 'openai-compatible', model: 'test-model' });

  // Keys must never be written to synced storage.
  const synced = await panel.evaluate(() => chrome.storage.sync.get(null));
  expect(JSON.stringify(synced)).not.toContain('test-key');
});

test('refuses to send when hosted settings have no account behind them', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  // Settings a signed-out user can plausibly be left holding: signing out, or a
  // refresh token the server revoked, both land here.
  await page.evaluate(() =>
    chrome.storage.local.set({
      'pagehand:settings': { provider: 'hosted', model: 'deepseek/deepseek-v4-flash-0731' },
    }),
  );
  await page.reload();

  // Said before the turn, not a minute into one.
  await expect(page.getByText(/Signed out|未登录/)).toBeVisible();

  await page.getByRole('textbox', { name: /Message|消息/ }).fill('summarize this page');
  await expect(page.getByRole('button', { name: /^(Send|发送)$/ })).toBeDisabled();
});

test('exposes the full v1 tool set', async ({ panel }) => {
  const names = await panel.evaluate(() => window.__cdp.toolNames());

  expect(names).toEqual(
    expect.arrayContaining([
      'take_snapshot',
      'click',
      'hover',
      'fill',
      'fill_form',
      'type_text',
      'press_key',
      'navigate_page',
      'new_page',
      'list_pages',
      'select_page',
      'close_page',
      'wait_for',
      'evaluate_script',
      'take_screenshot',
      'list_console_messages',
      'get_console_message',
      'list_network_requests',
      'get_network_request',
    ]),
  );
});
