import { describe, expect, it } from 'vitest';
import { isTrustedSenderUrl } from './receiveSession';
import { HOSTED_BASE_URL } from '../lib/storage/schema';

/**
 * The origin allowed to deliver a session and the origin this build talks to
 * are the same fact, and they were once written down twice. The copy here said
 * `https://pagehand.app` while a development build asked localhost for the
 * sign-in link, so the extension refused its own session — surfaced to the user
 * as an extension id that "isn't one this site knows", which is a long way from
 * the truth. These pin the two together.
 */

const origin = new URL(HOSTED_BASE_URL).origin;

describe('isTrustedSenderUrl', () => {
  it('accepts the origin this build signs in against', () => {
    expect(isTrustedSenderUrl(`${origin}/auth/extension`)).toBe(true);
    expect(isTrustedSenderUrl(`${origin}/auth/extension#access_token=x`)).toBe(true);
  });

  it('rejects any other origin, however close', () => {
    expect(isTrustedSenderUrl('https://pagehand.app.evil.com/auth/extension')).toBe(false);
    expect(isTrustedSenderUrl('https://evil.com/auth/extension')).toBe(false);
    // Same host, different scheme or port is still a different origin.
    expect(isTrustedSenderUrl(origin.replace('https://', 'http://'))).toBe(
      origin.startsWith('http://'),
    );
  });

  it('rejects a missing or unparseable sender url', () => {
    expect(isTrustedSenderUrl(undefined)).toBe(false);
    expect(isTrustedSenderUrl('')).toBe(false);
    expect(isTrustedSenderUrl('not a url')).toBe(false);
  });
});
