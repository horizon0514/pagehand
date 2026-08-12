# Pagehand

**Install:** [Chrome Web Store](https://chromewebstore.google.com/detail/pagehand/pcecngibbelhajhanohmcidacfmkekbb) · **Site:** https://pagehand.app · **Privacy:** https://pagehand.app/privacy

An AI that lives in Chrome’s side panel and reads / automates the current tab
via the Chrome DevTools Protocol — no external MCP client or Node process
required. Bring your own OpenAI / Anthropic / OpenAI-compatible API key, chat
with it from the side panel, and let it read page content, click, fill forms,
navigate, and inspect console/network activity.

This is a from-scratch port of the *capability* behind
[chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)
(read page state + automate the browser via CDP) into a self-contained
Manifest V3 extension. It does not reuse chrome-devtools-mcp's code — CDP
access here comes from `chrome.debugger`, which exposes the same protocol
directly to extensions.

## How it works

- The **side panel** (not the background service worker) is the brain: it
  holds the chat/agent loop and owns the `chrome.debugger` session for the
  currently attached tab. This sidesteps MV3 service-worker lifecycle issues
  entirely, since the worker is never involved in tool execution.
- Tool calls (`take_snapshot`, `click`, `fill`, `navigate_page`,
  `evaluate_script`, `list_network_requests`, …) are implemented directly
  against CDP domains (`Accessibility`, `DOM`, `Input`, `Page`, `Network`,
  `Log`, `Runtime`), the same domains Puppeteer speaks over a debug port.
- The LLM layer uses the [Vercel AI SDK](https://ai-sdk.dev) for unified
  tool-calling across providers.

See the code under `src/lib/tools` for the full v1 tool list.

## Setup

```bash
npm install
npm run dev      # CRXJS dev build with HMR, writes to dist/
# or
npm run build    # production build
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load
unpacked** → select the `dist/` folder. Click the extension's action icon to
open the side panel, then open Settings (⚙) to enter your LLM provider and
API key. It defaults to DeepSeek (`deepseek-v4-flash`), so a key is the only
thing you have to supply; OpenAI, Anthropic and any OpenAI-compatible endpoint
are in the same dropdown.

### The development extension id

Every non-store build carries a fixed `key` in its manifest, so the unpacked
extension always installs as:

```
mcandaiakmaohgjcfmfihgollgnpghfd
```

Without that key Chrome derives an unpacked id from the absolute path the
folder was loaded from — it changes when the folder moves, on a second
checkout, on another machine, and even between `/Users/me/Project/…` and
`/Users/me/project/…`. Since the sign-in page has to name the id to hand a
session back, a drifting id shows up as *"its id isn't one this site knows"* at
the end of an otherwise successful sign-in.

The sign-in page has to name an id because `chrome.runtime.sendMessage` from a
web page cannot broadcast, so both ids are listed in
[`cloud/lib/deliver-session.ts`](cloud/lib/deliver-session.ts), which tries each
in turn. That list is addressing, not a security boundary —
`externally_connectable` in the manifest is what decides who may message the
extension, and it is enforced by Chrome.

### Working on sign-in locally

A development build points at a local `cloud/` (`http://localhost:3000/api/v1`)
and lists `http://localhost/*` under both `host_permissions` and
`externally_connectable`, so the whole round trip runs without deploying:

```bash
npm run dev                 # the extension (writes dist/) and cloud/ together
```

One Ctrl-C stops both, and either falling over takes the other with it rather
than leaving half a stack up. A `cloud/` dev server that is already running is
adopted rather than fought over — Next refuses to start a second one for the
same directory, and losing both halves to that would be a poor trade. Use
`npm run dev:ext` for the extension alone.

Then **reload the extension** at `chrome://extensions`. That step is the one
that bites: `dist/` is whatever was built last, so a stray `npm run build`
leaves a *production* bundle there, pointing at `https://pagehand.app`. The
emailed link then comes back to production, because it is production that
issued it — `send-link` derives the return URL from the origin it was called
on. If a link points somewhere unexpected, check which build is loaded before
anything else.

Both localhost entries are dropped from the store build, which has no business
reaching a developer's machine.

One detail worth keeping: the pattern is `http://localhost/*`, without a port.
Match patterns have no concept of a port, so `http://localhost:3000/*` is
accepted into the manifest and then matches nothing at all.

Only the public half of the key is committed; it fixes the id and nothing else.
The private half (`dev-key.pem`, gitignored) is needed only to hand-sign a
`.crx`, which this project never does. To use your own key instead, set
`PAGEHAND_DEV_KEY` to its base64 public key — and put the resulting id in the
allowlists.

## Packaging for the Chrome Web Store

```bash
npm run pack     # production build + zip → pagehand.zip
```

`pack` sets `PAGEHAND_STORE_BUILD=true`, which drops the development `key` from
the manifest: the store assigns its own id, and an upload carrying a key that
isn't the listing's is rejected. Build any other way and the key is present.

Upload `pagehand.zip` at [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
Privacy policy: hosted on the marketing site under `/privacy`.

## Releasing

GitHub Actions owns the cut:

1. Open [Actions → Release](https://github.com/horizon0514/pagehand/actions/workflows/release.yml)
2. **Run workflow** on `main`, pick `patch` / `minor` / `major`
3. CI bumps `package.json`, commits, tags `vX.Y.Z`, packs `pagehand.zip`, and publishes the GitHub Release

The marketing site download buttons always resolve to the latest Release (`/releases/latest/…`), and [`cloud/components/release.tsx`](cloud/components/release.tsx) fills in the current tag label. No website edit per release.

Pushing an annotated `v*` tag yourself still triggers the same pack + release path.

## Website

The marketing site lives in [`cloud/`](cloud/) — the same Next.js app that will
host accounts and the model proxy (see [`docs/PLAN-subscription.md`](docs/PLAN-subscription.md)).
It was a separate folder of static HTML until the two were merged; keeping one
deployment means `/pricing` can share the marketing pages' stylesheet instead of
growing a second look.

Deploys via **Vercel Git integration** (not GitHub Actions):

1. In the [Vercel dashboard](https://vercel.com), connect this GitHub repo
2. Set **Root Directory** to `cloud`
3. Leave **Ignored Build Step** empty. The obvious setting here —
   skip when the changes are outside the root directory — compares only the head
   commit, so a push whose last commit misses `cloud/` is skipped however much
   the rest of the range touched it. That cost three silent non-deploys before
   it was spotted; a build is ~9s. See [`cloud/README.md`](cloud/README.md).

After that:

- push / merge to `main` → production (`https://pagehand.app`)
- open a PR that touches `cloud/` → preview deployment

Local: `cd cloud && npm run dev`.

You can remove the unused GitHub secrets `VERCEL_TOKEN`, `VERCEL_ORG_ID`, and
`VERCEL_PROJECT_ID` if they were only used by the old Actions deploy workflow.

## Security notes

- Your API key is stored **unencrypted** in `chrome.storage.local`, scoped to
  this browser profile. It is never synced to your Google account and never
  leaves your machine except in requests to the provider you configured.
- While the extension is attached to a tab, Chrome shows a persistent
  **"Pagehand is debugging this browser"** banner on that tab. This is a
  Chrome safety feature and cannot be suppressed — it's your signal that the
  extension currently has full CDP-level access to that tab's content.
- Custom OpenAI-compatible base URLs (OpenRouter, Azure OpenAI, local Ollama,
  etc.) require an extra one-time permission grant, requested the first time
  you save a non-default base URL in Settings. This keeps the extension's
  default install-time permissions narrow.

## Known limitations (v1)

- Single attached tab at a time — switching pages detaches from the previous
  one (its console/network capture history is frozen at that point).
- Single window at a time — a second browser window's side panel will refuse
  to attach while another window is active.
- Closing the side panel mid-conversation loses in-memory chat/tool state.
- Cross-origin iframes are not visible to `take_snapshot`.
- No performance tracing, heap snapshots, Lighthouse audits, or extension
  management tools (all present in upstream chrome-devtools-mcp) — deferred
  to a later version.

## Development

- `npm run typecheck` — TypeScript, no emit
- `npm run lint` — ESLint
- `npm test` / `npm run test:watch` — Vitest (unit)
- `npm run build:e2e && npm run test:e2e` — Playwright (end-to-end)
- `npm run build` — production build to `dist/`

### Testing

The agent loop and all page-state logic run headlessly under Vitest, so most
changes can be verified without building, reloading the extension, and clicking
through the side panel:

- `src/test/mockModel.ts` — a scripted `LanguageModelV4` mock. Give it a list of
  per-step actions (`tool` / `text` / `silent` / `error`) and it replays them, so
  a full multi-step ReAct turn runs deterministically with no API key.
- `agentLoop.test.ts` — multi-step tool loops, recovery from a throwing tool, and
  the `StopInfo` diagnostics (step-limit cutoff vs. clean stop vs. tools-with-no-answer).
- `formatSnapshot.test.ts` — uid assignment, AX-tree pruning, and the line/character
  budgets that keep a huge page from exhausting the model's context.
- `navigationInvalidation.test.ts` — drives fake CDP events through a stub session to
  check that a main-frame navigation clears console, network, and uid state (and that
  a subframe navigation does not).
- `keyTable.test.ts`, `uidMap.test.ts` — key-combo parsing and uid lifetime.

#### End-to-end (Playwright)

```bash
npm run build:e2e && npm run test:e2e
```

Runs headless against a real Chromium with the extension loaded, covering the
things unit tests structurally cannot: a genuine `chrome.debugger` attachment,
live CDP responses from a real renderer, and input dispatched through the
browser rather than simulated.

`e2e/fixtures/` is served over HTTP (extensions need an explicit opt-in for
`file://`) and includes a pre-filled input, a click counter, real console output,
and a `fetch` — so assertions can prove effects rather than just that a call
returned. Notably, `click` is verified by the page's own handler running, and
`type_text` by the keystrokes the page actually received.

`npm run build:e2e` sets `VITE_E2E=true`, which exposes a `window.__cdp` bridge
(`src/e2e/hook.ts`) on the side panel page so Playwright can invoke tools the way
the agent loop does. The flag is statically false in normal builds, so the branch
and its chunk are dropped — **never ship an E2E build.**

Two bugs found by this suite that unit tests had passed clean on: `fill`
prepending instead of replacing (synthetic Ctrl/Cmd+A does not trigger
select-all; CDP's `commands: ['selectAll']` does), and `parseKeyCombo('+')`
throwing.

#### Live-LLM E2E (optional)

One spec (`e2e/live-llm.spec.ts`) runs the whole stack for real — a live model
chooses the tools, the tool layer executes them over CDP, and the fixture page
actually changes. It **skips by default**; to enable it:

```bash
cp .env.example .env.local   # then paste your key
npm run build:e2e && npm run test:e2e
```

`.env.local` is gitignored, and the key name is deliberately **not**
`VITE_`-prefixed — Vite only exposes `VITE_*` to the client bundle, so the key
stays on the Node side and is written into `chrome.storage.local` at test time
rather than compiled in. This was verified with a canary value: it appears in
neither the E2E nor the production bundle.

Because a live model is non-deterministic, these assert observable effects (a
tool call happened; `#counter` really reads "Clicked 1 times") rather than exact
wording. They cost tokens and need network, so they stay out of CI.

Note that E2E builds pre-grant wildcard `host_permissions`, since
`chrome.permissions.request()` opens a native dialog Playwright cannot dismiss.
Production builds keep those optional and ask at runtime.

What still needs a manual pass: the side panel opening as an actual Chrome side
panel rather than a tab, and the debugger permission banner.
