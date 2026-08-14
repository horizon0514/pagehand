import { describe, it, expect } from 'vitest';
import { parseKeyCombo } from './keyTable';

describe('parseKeyCombo', () => {
  it('resolves named keys with their virtual key codes', () => {
    expect(parseKeyCombo('Enter')).toEqual({
      descriptor: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
      modifiers: 0,
    });
    expect(parseKeyCombo('Escape').descriptor.windowsVirtualKeyCode).toBe(27);
    expect(parseKeyCombo('ArrowDown').descriptor.code).toBe('ArrowDown');
  });

  it('maps modifiers to CDP bitflags', () => {
    expect(parseKeyCombo('Alt+Enter').modifiers).toBe(1);
    expect(parseKeyCombo('Control+a').modifiers).toBe(2);
    expect(parseKeyCombo('Meta+a').modifiers).toBe(4);
    expect(parseKeyCombo('Shift+Tab').modifiers).toBe(8);
  });

  it('accepts modifier aliases and combines them', () => {
    expect(parseKeyCombo('Ctrl+a').modifiers).toBe(2);
    expect(parseKeyCombo('Cmd+a').modifiers).toBe(4);
    // Meta(4) | Shift(8)
    expect(parseKeyCombo('Meta+Shift+r').modifiers).toBe(12);
  });

  it('is case-insensitive about modifier names', () => {
    expect(parseKeyCombo('CONTROL+a').modifiers).toBe(2);
    expect(parseKeyCombo('shift+Tab').modifiers).toBe(8);
  });

  it('treats a bare character as itself and gives it insertable text', () => {
    const { descriptor } = parseKeyCombo('a');
    expect(descriptor).toMatchObject({ key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a' });
  });

  it('omits text when a modifier is held, so a shortcut does not type a character', () => {
    // Control+A must fire as a shortcut, not insert the letter "A".
    expect(parseKeyCombo('Control+a').descriptor.text).toBeUndefined();
    expect(parseKeyCombo('a').descriptor.text).toBe('a');
  });

  it('handles non-alphabetic single characters', () => {
    const { descriptor } = parseKeyCombo('+');
    expect(descriptor.code).toBe('+');
    expect(descriptor.text).toBe('+');
  });

  it('treats a literal space as the Space key, not as an empty combo', () => {
    // typeText() parses one character at a time, so trimming a bare " " away
    // made every multi-word type_text fail with `Unsupported key ""`.
    expect(parseKeyCombo(' ').descriptor).toMatchObject({
      key: ' ',
      code: 'Space',
      windowsVirtualKeyCode: 32,
      text: ' ',
    });
  });

  it('maps digits to DigitN codes (not KeyN)', () => {
    expect(parseKeyCombo('5').descriptor).toMatchObject({
      key: '5',
      code: 'Digit5',
      text: '5',
    });
  });

  it('treats a trailing "+" as the key, not a separator (e.g. "Control++" to zoom in)', () => {
    const { descriptor, modifiers } = parseKeyCombo('Control++');
    expect(descriptor.key).toBe('+');
    expect(modifiers).toBe(2);
  });

  it('still rejects a dangling separator with no key', () => {
    expect(() => parseKeyCombo('Control+')).toThrow(/Unsupported key/);
  });

  it('rejects unknown modifiers and unsupported key names', () => {
    expect(() => parseKeyCombo('Hyper+a')).toThrow(/Unknown modifier/);
    expect(() => parseKeyCombo('NotARealKey')).toThrow(/Unsupported key/);
  });
});
