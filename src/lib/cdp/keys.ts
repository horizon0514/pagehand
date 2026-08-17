export interface KeyDescriptor {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
}

const NAMED_KEYS: Record<string, KeyDescriptor> = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  ' ': { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
};

const MODIFIER_BITS: Record<string, number> = {
  alt: 1,
  control: 2,
  ctrl: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  shift: 8,
};

export interface ParsedKeyCombo {
  descriptor: KeyDescriptor;
  modifiers: number;
}

function codeForChar(ch: string): string {
  if (/[a-zA-Z]/.test(ch)) return `Key${ch.toUpperCase()}`;
  if (/[0-9]/.test(ch)) return `Digit${ch}`;
  return ch;
}

/** Parses combos like "Control+Shift+R" or a bare "Enter"/"a"/"5". */
export function parseKeyCombo(combo: string): ParsedKeyCombo {
  let keyPart: string;
  let modifierParts: string[];

  // '+' doubles as the separator and a legitimate key ("Control++"), so a
  // naive split on '+' would read the key as an empty modifier.
  // A single character is always the key itself, never a combo. Splitting and
  // trimming first would eat a literal space — which typeText() feeds through
  // here one character at a time, so `type_text` could not type a space at all.
  if (combo.length === 1) {
    keyPart = combo;
    modifierParts = [];
  } else if (combo.endsWith('++')) {
    keyPart = '+';
    modifierParts = combo
      .slice(0, -2)
      .split('+')
      .map((p) => p.trim())
      .filter(Boolean);
  } else {
    const parts = combo.split('+').map((p) => p.trim());
    keyPart = parts[parts.length - 1];
    modifierParts = parts.slice(0, -1);
  }

  let modifiers = 0;
  for (const mod of modifierParts) {
    const bit = MODIFIER_BITS[mod.toLowerCase()];
    if (bit === undefined) throw new Error(`Unknown modifier "${mod}" in key combo "${combo}"`);
    modifiers |= bit;
  }

  const named = NAMED_KEYS[keyPart];
  if (named) return { descriptor: named, modifiers };

  if (keyPart.length === 1) {
    const upper = keyPart.toUpperCase();
    return {
      descriptor: {
        key: keyPart,
        code: codeForChar(keyPart),
        windowsVirtualKeyCode: upper.charCodeAt(0),
        text: modifiers === 0 ? keyPart : undefined,
      },
      modifiers,
    };
  }

  throw new Error(`Unsupported key "${keyPart}"`);
}
