import { cdpSend, type CdpConnection } from './connection';
import { parseKeyCombo, type KeyDescriptor } from './keys';

async function dispatchKey(
  cdp: CdpConnection,
  type: 'keyDown' | 'keyUp' | 'rawKeyDown' | 'char',
  descriptor: KeyDescriptor,
  modifiers = 0,
  commands?: string[],
): Promise<void> {
  await cdpSend(cdp, 'Input.dispatchKeyEvent', {
    type,
    key: descriptor.key,
    code: descriptor.code,
    windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode,
    nativeVirtualKeyCode: descriptor.windowsVirtualKeyCode,
    text: type === 'char' ? descriptor.text ?? descriptor.key : undefined,
    unmodifiedText: type === 'char' ? descriptor.text ?? descriptor.key : undefined,
    modifiers,
    commands,
  });
}

export async function pressKeyCombo(cdp: CdpConnection, combo: string): Promise<void> {
  const { descriptor, modifiers } = parseKeyCombo(combo);
  await dispatchKey(cdp, 'rawKeyDown', descriptor, modifiers);
  if (descriptor.text) await dispatchKey(cdp, 'char', descriptor, modifiers);
  await dispatchKey(cdp, 'keyUp', descriptor, modifiers);
}

/**
 * Selects the focused field's content via CDP's editing command.
 * Synthetic Ctrl/Cmd+A is ignored by the renderer for this purpose.
 */
export async function selectAll(cdp: CdpConnection, isMac: boolean): Promise<void> {
  const key: KeyDescriptor = {
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
  };
  const modifiers = isMac ? 4 : 2;
  await dispatchKey(cdp, 'keyDown', key, modifiers, ['selectAll']);
  await dispatchKey(cdp, 'keyUp', key, modifiers);
}

export async function insertText(cdp: CdpConnection, text: string): Promise<void> {
  await cdpSend(cdp, 'Input.insertText', { text });
}

/** Real per-character key events into the focused element. */
export async function typeText(
  cdp: CdpConnection,
  text: string,
  submitKey?: string,
): Promise<void> {
  for (const ch of text) {
    const { descriptor } = parseKeyCombo(ch);
    await dispatchKey(cdp, 'keyDown', descriptor);
    if (descriptor.text) await dispatchKey(cdp, 'char', descriptor);
    await dispatchKey(cdp, 'keyUp', descriptor);
  }
  // Models routinely pass submitKey: "" to mean "don't submit"; treat it as
  // absent rather than letting it reach the parser as an unsupported key.
  if (submitKey !== undefined && submitKey !== '') await pressKeyCombo(cdp, submitKey);
}
