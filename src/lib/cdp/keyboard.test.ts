import { describe, it, expect, vi } from 'vitest';
import { typeText } from './keyboard';
import type { CdpConnection } from './connection';

function mockCdp() {
  const send = vi.fn(async (_method: string, _params?: object) => ({})) as CdpConnection['send'];
  const cdp: CdpConnection = { send, on: () => () => undefined };
  return { cdp, send: send as unknown as ReturnType<typeof vi.fn> };
}

/** The `text` of every `char` event, i.e. what the page actually receives. */
function typedText(send: ReturnType<typeof vi.fn>): string {
  const calls = send.mock.calls as [string, { type: string; text?: string }][];
  return calls
    .filter(([, params]) => params.type === 'char')
    .map(([, params]) => params.text ?? '')
    .join('');
}

describe('typeText', () => {
  it('types spaces — a multi-word query is the common case', async () => {
    const { cdp, send } = mockCdp();
    await typeText(cdp, 'blue running shoes');
    expect(typedText(send)).toBe('blue running shoes');
  });

  it('treats an empty submitKey as "do not submit" rather than an unsupported key', async () => {
    const { cdp, send } = mockCdp();
    await expect(typeText(cdp, 'abc', '')).resolves.toBeUndefined();

    const keys = (send.mock.calls as [string, { key: string }][]).map(([, p]) => p.key);
    expect(keys).not.toContain('Enter');
    expect(typedText(send)).toBe('abc');
  });

  it('presses a real submitKey after the text', async () => {
    const { cdp, send } = mockCdp();
    await typeText(cdp, 'hi', 'Enter');

    const keys = (send.mock.calls as [string, { key: string }][]).map(([, p]) => p.key);
    expect(keys[keys.length - 1]).toBe('Enter');
  });
});
