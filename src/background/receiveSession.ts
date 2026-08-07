import { saveSession, type Session } from '../lib/auth/session';
import { HOSTED_BASE_URL } from '../lib/storage/schema';

/**
 * Receiving a finished sign-in from the website.
 *
 * The sign-in page runs in an ordinary tab — which is what lets the emailed
 * link work at all, since a link opens wherever the mail client sends it rather
 * than inside a window the extension controls. A tab cannot hand anything back
 * through a redirect, so `externally_connectable` in the manifest lets that one
 * origin call `chrome.runtime.sendMessage` instead.
 *
 * Only the background worker can receive those messages, hence this file rather
 * than the panel.
 */

const SESSION_MESSAGE = 'pagehand:session';

/**
 * The one origin allowed to hand over a session: whichever this build talks to.
 *
 * Derived from HOSTED_BASE_URL rather than written out, because the two answers
 * have to agree and there is no version of "correct" where they don't — a build
 * pointed at a local cloud/ signs in against that, and one pointed at
 * production signs in against production. Hard-coding the deployed origin here
 * meant a development build could send its session and be refused by its own
 * background worker, reported to the user as an extension id problem.
 */
const TRUSTED_ORIGIN = new URL(HOSTED_BASE_URL).origin;

/**
 * `externally_connectable` already restricts senders to the origins listed in
 * the manifest, and Chrome — not the page — fills in `sender.url`. Re-checking
 * it here keeps the guarantee legible at the point where a credential is
 * accepted: that list may hold more origins than this, and only one of them has
 * any business delivering a credential.
 */
export function isTrustedSenderUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).origin === TRUSTED_ORIGIN;
  } catch {
    return false;
  }
}

function fromTrustedOrigin(sender: chrome.runtime.MessageSender): boolean {
  return isTrustedSenderUrl(sender.url);
}

function isSession(value: unknown): value is Session {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.accessToken === 'string' &&
    typeof s.refreshToken === 'string' &&
    typeof s.expiresAt === 'number'
  );
}

export function listenForSession(): void {
  chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    if (typeof message !== 'object' || message === null) return;
    const { type, session } = message as { type?: unknown; session?: unknown };
    if (type !== SESSION_MESSAGE) return;

    if (!fromTrustedOrigin(sender) || !isSession(session)) {
      sendResponse({ ok: false });
      return;
    }

    // The panel notices through chrome.storage.onChanged, so signing in from a
    // tab updates an already-open Settings screen without a reload.
    void saveSession(session).then(() => sendResponse({ ok: true }));
    // Keeps the message channel open across the await.
    return true;
  });
}
