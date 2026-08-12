import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json';

const IS_E2E = process.env.VITE_E2E === 'true';
/** Set by `npm run pack` — the only build whose id is assigned by the store. */
const IS_STORE = process.env.PAGEHAND_STORE_BUILD === 'true';

/**
 * Pins the extension id for every build that isn't the store upload.
 *
 * Without a key, Chrome derives an unpacked extension's id from the absolute
 * path it was loaded from — so the id changes with a moved folder, a second
 * checkout, another machine, even a differently-cased path. That id is what the
 * sign-in page has to name to hand a session back (`externally_connectable`
 * only allows the deployed origin, so this cannot be worked around locally),
 * and chasing it through two allowlists on every environment is not a thing
 * anyone should have to do.
 *
 * This is the public half only, which is not a secret: it fixes the id and
 * nothing else. The private half stays out of the repo (see .gitignore) and is
 * needed only to sign a .crx by hand — which this project never does, since the
 * Web Store re-signs with its own key. That is also why the store build must
 * omit this: an upload carrying a key that isn't the listing's is rejected.
 */
/**
 * The local `cloud/` dev server, on both sides of sign-in: the panel fetches
 * the API here, and the page the emailed link opens hands the session back from
 * here. Dropped for the store build, which has no business reaching localhost.
 *
 * Portless on purpose. Match patterns have no concept of a port —
 * `http://localhost:3000/*` is accepted into the manifest and then matches
 * nothing, which is a quiet way to lose an afternoon. `http://localhost/*`
 * covers every port.
 */
const LOCAL_ORIGINS = IS_STORE ? [] : ['http://localhost/*'];

const DEV_KEY =
  process.env.PAGEHAND_DEV_KEY ??
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAr1DzwDFn2vjAPDe9IBla1Y8L9CqLQwm5paARm9UJ7yEGzRaBb3WxnY2OqPHpQ2kTGs59fW+yz29a8+GhZ29hP2GtBlLeGMX1AdeMoMKLMQsIfBbOc921JHE7mwSXz5nz6g05upS4N1fmtv3IYhrnY1sfwaUDssswJaePDCG7bJet4an3efuH1Gt/XTayRgB81oUhX49WQnEHguoyrQxw3qrPvKIosSGC9qLjr906u0WuMOww1JhMZl9rwgP5uJhjaeFBNnixQbx/QerBuNKbKgNg9VMYFAs9qt3BKh0V9zf4L82A9m21V0IY974NShA6XxRN1z0JwoiKceV0ASW4vQIDAQAB';

export default defineManifest({
  manifest_version: 3,
  name: '__MSG_extName__',
  version: pkg.version,
  description: '__MSG_extDescription__',
  default_locale: 'en',
  ...(IS_STORE ? {} : { key: DEV_KEY }),
  icons: {
    16: 'icons/icon16.png',
    32: 'icons/icon32.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png',
  },
  action: {
    default_icon: {
      16: 'icons/icon16.png',
      32: 'icons/icon32.png',
    },
  },
  side_panel: {
    default_path: 'src/sidepanel/index.html',
  },
  // openPanelOnActionClick is set at install, so triggering the action opens the
  // panel — a tool that claims to be at hand shouldn't need the mouse to reach.
  // Remappable at chrome://extensions/shortcuts if this collides with something.
  commands: {
    _execute_action: {
      suggested_key: { default: 'Ctrl+Shift+K', mac: 'Command+Shift+K' },
      description: '__MSG_commandOpenPanel__',
    },
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  permissions: [
    'sidePanel',
    'debugger',
    'tabs',
    'storage',
    'activeTab',
    'contextMenus',
    // No `identity`: it was added for launchWebAuthFlow and never used, because
    // that API cannot see an emailed link land — see lib/auth/signIn.ts. Sign-in
    // rides on `externally_connectable` below instead.
    // Inject the screenshot lightbox onto the page tab (full viewport), not just the side panel.
    'scripting',
  ],
  // In E2E builds the wildcard hosts are pre-granted, because
  // chrome.permissions.request() raises a native dialog that Playwright cannot
  // dismiss. Normal builds keep them optional and ask at runtime.
  ...(IS_E2E
    ? { host_permissions: ['https://*/*', 'http://localhost/*'] }
    : {
        optional_host_permissions: ['https://*/*', 'http://localhost/*'],
        // Mirrored by DEFAULT_HOST_ORIGINS in SettingsPanel.tsx.
        host_permissions: [
          // Hosted mode's own endpoint: the default path must not open a
          // permission dialog on first use. A development build points at a
          // local cloud/ instead, so that has to be granted up front too —
          // otherwise the first thing a developer meets is a blocked fetch.
          ...LOCAL_ORIGINS,
          'https://pagehand.app/*',
          'https://api.deepseek.com/*',
          'https://api.openai.com/*',
          'https://api.anthropic.com/*',
          // web_search, which is not something a user can be asked to approve
          // at the moment it happens: a tool call carries no user gesture, so
          // chrome.permissions.request() would throw rather than prompt. Both
          // Bing hosts are needed — www redirects to the regional host, and a
          // redirect the manifest doesn't cover is blocked like any other
          // request. Firecrawl is only reached when the user configured a key.
          'https://www.bing.com/*',
          'https://cn.bing.com/*',
          'https://api.firecrawl.dev/*',
        ],
      }),
  // The sign-in page posts the finished session here. Chrome enforces this
  // list, and it is the only reason an ordinary tab can talk to the extension
  // at all — which is what lets an emailed sign-in link work, since a link
  // opens in a tab nobody controls rather than a window we opened.
  //
  // localhost is listed too in development, so the whole flow can run against a
  // local cloud/ without deploying. Chrome does accept it — the restriction is
  // that a pattern must carry a second-level domain, which rules out `*.com`
  // and the like but not a bare host.
  externally_connectable: { matches: ['https://pagehand.app/*', ...LOCAL_ORIGINS] },
  minimum_chrome_version: '116',
});
