'use client';

import type { Session } from '@supabase/supabase-js';

/**
 * Handing a finished sign-in to the extension.
 *
 * `chrome.runtime.sendMessage` is available to this page only because the
 * extension's manifest lists this origin under `externally_connectable`; on any
 * other site the API simply isn't there. That is the entire trust model, and it
 * is enforced by Chrome rather than by anything we can get wrong here.
 *
 * Several ids are tried because an unpacked development build and a published
 * one have different ids, and only one of them is installed at a time.
 */

/**
 * Who to hand it to. sendMessage from a web page has to name an extension —
 * Chrome offers no way to broadcast — so this list is addressing, not
 * authorization; `externally_connectable` is what decides who may talk to the
 * extension at all.
 *
 * Hard-coded rather than configured. An extension id is public by construction
 * (the store URL is one of these, chrome://extensions shows the other) so there
 * is nothing to keep out of the bundle, and both are fixed for good: the store
 * assigns the first, and the manifest `key` in manifest.config.ts pins the
 * second. As NEXT_PUBLIC_* these were inlined at build time anyway — identical
 * at runtime to what is written here, but able to ship empty from a
 * misconfigured deploy, with a sign-in that fails at the last step to show for
 * it.
 */
const EXTENSION_IDS = [
  /** Chrome Web Store. */
  'pcecngibbelhajhanohmcidacfmkekbb',
  /** Unpacked development build — see `DEV_KEY` in manifest.config.ts. */
  'mcandaiakmaohgjcfmfihgollgnpghfd',
];

interface ChromeRuntime {
  sendMessage: (
    extensionId: string,
    message: unknown,
    callback: (response?: { ok?: boolean }) => void,
  ) => void;
  lastError?: { message?: string };
}

function runtime(): ChromeRuntime | null {
  const chrome = (globalThis as { chrome?: { runtime?: ChromeRuntime } }).chrome;
  return chrome?.runtime?.sendMessage ? chrome.runtime : null;
}

/**
 * `absent` — nobody is installed under that id.
 * `refused` — an extension answered and declined the session.
 */
type SendOutcome = 'delivered' | 'absent' | 'refused';

function send(rt: ChromeRuntime, id: string, session: Session): Promise<SendOutcome> {
  return new Promise((resolve) => {
    rt.sendMessage(
      id,
      {
        type: 'pagehand:session',
        session: {
          accessToken: session.access_token,
          refreshToken: session.refresh_token,
          expiresAt: session.expires_at,
          ...(session.user?.email ? { email: session.user.email } : {}),
        },
      },
      (response) => {
        // Messaging an extension that isn't installed sets lastError instead of
        // throwing; reading it is also what stops Chrome logging it as unchecked.
        if (rt.lastError) resolve('absent');
        else resolve(response?.ok === true ? 'delivered' : 'refused');
      },
    );
  });
}

/**
 * The failures look identical to a user and have entirely different fixes, so
 * they are kept apart.
 *
 * `unreachable` — the page has no messaging API at all: wrong browser,
 * extension missing, or a manifest change not yet reloaded.
 * `id-mismatch` — messaging works and nobody is home at the ids listed above.
 * `refused` — the extension is right there and turned the session down, which
 * in practice means it is pointed at a different origin than the one that
 * issued it. Collapsing this into `id-mismatch` once sent a developer looking
 * for a wrong id that was never wrong.
 */
export type DeliveryResult = 'delivered' | 'unreachable' | 'id-mismatch' | 'refused';

export async function deliverSession(session: Session): Promise<DeliveryResult> {
  const rt = runtime();
  if (!rt) return 'unreachable';

  let refused = false;
  for (const id of EXTENSION_IDS) {
    const outcome = await send(rt, id, session);
    if (outcome === 'delivered') return 'delivered';
    if (outcome === 'refused') refused = true;
  }
  return refused ? 'refused' : 'id-mismatch';
}
