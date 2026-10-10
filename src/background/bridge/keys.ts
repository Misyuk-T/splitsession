/**
 * Key names and shortcuts ("Enter", "Meta+A", "Control+Shift+K", "a") -> the parameters of CDP `Input.dispatchKeyEvent`.
 * Pure: no browser APIs, so it is unit-tested directly.
 */

export type Modifier = 'Alt' | 'Control' | 'Meta' | 'Shift';

/** CDP's modifier bit mask. */
export const MODIFIER_BITS: Readonly<Record<Modifier, number>> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

export interface KeyDefinition {
  key: string;
  code: string;
  keyCode: number;
  /** What the key types when no Control/Meta/Alt is held ('' = nothing). */
  text: string;
  /** Its location on the keyboard (1 = left modifier). */
  location?: number;
}

export interface ParsedShortcut {
  modifiers: Modifier[];
  key: KeyDefinition;
}

const named: Record<string, Omit<KeyDefinition, 'key'> & { key?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9, text: '' },
  Escape: { code: 'Escape', keyCode: 27, text: '' },
  Backspace: { code: 'Backspace', keyCode: 8, text: '' },
  Delete: { code: 'Delete', keyCode: 46, text: '' },
  Insert: { code: 'Insert', keyCode: 45, text: '' },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37, text: '' },
  ArrowUp: { code: 'ArrowUp', keyCode: 38, text: '' },
  ArrowRight: { code: 'ArrowRight', keyCode: 39, text: '' },
  ArrowDown: { code: 'ArrowDown', keyCode: 40, text: '' },
  Home: { code: 'Home', keyCode: 36, text: '' },
  End: { code: 'End', keyCode: 35, text: '' },
  PageUp: { code: 'PageUp', keyCode: 33, text: '' },
  PageDown: { code: 'PageDown', keyCode: 34, text: '' },
  CapsLock: { code: 'CapsLock', keyCode: 20, text: '' },
  ContextMenu: { code: 'ContextMenu', keyCode: 93, text: '' },
  Shift: { code: 'ShiftLeft', keyCode: 16, text: '', location: 1 },
  Control: { code: 'ControlLeft', keyCode: 17, text: '', location: 1 },
  Alt: { code: 'AltLeft', keyCode: 18, text: '', location: 1 },
  Meta: { code: 'MetaLeft', keyCode: 91, text: '', location: 1 },
};
for (let i = 1; i <= 12; i++) named[`F${i}`] = { code: `F${i}`, keyCode: 111 + i, text: '' };

/** Lower-case aliases, so "enter", "esc", "ctrl", "cmd" work too. */
const aliases: Record<string, string> = {
  esc: 'Escape',
  return: 'Enter',
  del: 'Delete',
  space: 'Space',
  spacebar: 'Space',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  pgup: 'PageUp',
  pgdn: 'PageDown',
};
const modifierAliases: Record<string, Modifier | 'ControlOrMeta'> = {
  shift: 'Shift',
  control: 'Control',
  ctrl: 'Control',
  alt: 'Alt',
  option: 'Alt',
  opt: 'Alt',
  meta: 'Meta',
  cmd: 'Meta',
  command: 'Meta',
  super: 'Meta',
  win: 'Meta',
  controlormeta: 'ControlOrMeta',
};

/** Unshifted punctuation of a US keyboard: code and Windows key code. Their shifted twins map to the same key. */
const punctuation: Record<string, [string, number]> = {
  ';': ['Semicolon', 186], ':': ['Semicolon', 186],
  '=': ['Equal', 187], '+': ['Equal', 187],
  ',': ['Comma', 188], '<': ['Comma', 188],
  '-': ['Minus', 189], _: ['Minus', 189],
  '.': ['Period', 190], '>': ['Period', 190],
  '/': ['Slash', 191], '?': ['Slash', 191],
  '`': ['Backquote', 192], '~': ['Backquote', 192],
  '[': ['BracketLeft', 219], '{': ['BracketLeft', 219],
  '\\': ['Backslash', 220], '|': ['Backslash', 220],
  ']': ['BracketRight', 221], '}': ['BracketRight', 221],
  "'": ['Quote', 222], '"': ['Quote', 222],
};
const shiftedDigits = ')!@#$%^&*(';

/** The definition of one key: a name ("Enter", "F5") or a single character. Null when unknown. */
export function keyDefinition(name: string): KeyDefinition | null {
  const canonical = named[name] ? name : (aliases[name.toLowerCase()] ?? Object.keys(named).find((k) => k.toLowerCase() === name.toLowerCase()));
  if (canonical && named[canonical]) {
    const d = named[canonical]!;
    return { key: d.key ?? canonical, code: d.code, keyCode: d.keyCode, text: d.text, ...(d.location ? { location: d.location } : {}) };
  }
  const chars = [...name];
  if (chars.length !== 1) return null;
  const c = chars[0]!;
  if (/^[a-z]$/i.test(c)) return { key: c, code: `Key${c.toUpperCase()}`, keyCode: c.toUpperCase().charCodeAt(0), text: c };
  if (/^[0-9]$/.test(c)) return { key: c, code: `Digit${c}`, keyCode: c.charCodeAt(0), text: c };
  const shiftedDigit = shiftedDigits.indexOf(c);
  if (shiftedDigit >= 0) return { key: c, code: `Digit${shiftedDigit}`, keyCode: 48 + shiftedDigit, text: c };
  if (c === ' ') return { key: ' ', code: 'Space', keyCode: 32, text: ' ' };
  if (c === '\n' || c === '\r') return keyDefinition('Enter');
  if (c === '\t') return keyDefinition('Tab');
  const p = punctuation[c];
  if (p) return { key: c, code: p[0], keyCode: p[1], text: c };
  return { key: c, code: '', keyCode: 0, text: c }; // any other character: typed, no physical key
}

/**
 * "Meta+A", "Control+Shift+K", "Shift++" (the plus key), "a". `isMac` decides what ControlOrMeta means.
 * Throws an Error with a message for the agent when the shortcut cannot be understood.
 */
export function parseShortcut(input: string, isMac: boolean): ParsedShortcut {
  const raw = input.trim() === '' ? input : input.trim();
  if (raw === '') throw new Error('key: give a key name such as "Enter" or a character');
  let parts: string[];
  if (raw === '+') parts = ['+'];
  else if (raw.endsWith('++')) parts = [...raw.slice(0, -2).split('+'), '+'];
  else parts = raw.split('+');
  if (parts.some((p) => p === '')) throw new Error(`key: "${input}" is not a shortcut like "Control+Shift+K"`);
  const keyName = parts.pop()!;
  const modifiers: Modifier[] = [];
  for (const part of parts) {
    const m = modifierAliases[part.toLowerCase()];
    if (!m) throw new Error(`key: "${part}" is not a modifier (use Shift, Control, Alt, Meta or ControlOrMeta)`);
    const resolved: Modifier = m === 'ControlOrMeta' ? (isMac ? 'Meta' : 'Control') : m;
    if (!modifiers.includes(resolved)) modifiers.push(resolved);
  }
  // "Meta+A" means the A key: with a command modifier a letter is the lower-case key (Shift makes it a capital below).
  const lettered = /^[A-Z]$/.test(keyName) && modifiers.length > 0 ? keyName.toLowerCase() : keyName;
  const key = keyDefinition(lettered);
  if (!key) throw new Error(`key: unknown key "${keyName}" (use names like Enter, Escape, Tab, ArrowDown, Backspace, F5, or one character)`);
  // Shift with a letter types the capital.
  if (modifiers.includes('Shift') && /^[a-z]$/.test(key.key)) return { modifiers, key: { ...key, key: key.key.toUpperCase(), text: key.text.toUpperCase() } };
  return { modifiers, key };
}

export const modifierMask = (modifiers: readonly Modifier[]): number => modifiers.reduce((mask, m) => mask | MODIFIER_BITS[m], 0);

/** One CDP `Input.dispatchKeyEvent` call. */
export interface KeyEvent {
  type: 'keyDown' | 'rawKeyDown' | 'keyUp';
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  nativeVirtualKeyCode: number;
  modifiers: number;
  text?: string;
  unmodifiedText?: string;
  location?: number;
  /** Editing commands (macOS shortcuts are handled by the browser menu, not the page, so they go along explicitly). */
  commands?: string[];
}

/** macOS editing shortcuts: Chrome needs the command named, the key event alone does nothing in a text field. */
const MAC_COMMANDS: Record<string, string[]> = {
  'Meta+KeyA': ['selectAll'],
  'Meta+KeyC': ['copy'],
  'Meta+KeyX': ['cut'],
  'Meta+KeyV': ['paste'],
  'Meta+KeyZ': ['undo'],
  'Meta+Shift+KeyZ': ['redo'],
  'Meta+ArrowLeft': ['moveToBeginningOfLine'],
  'Meta+ArrowRight': ['moveToEndOfLine'],
  'Meta+ArrowUp': ['moveToBeginningOfDocument'],
  'Meta+ArrowDown': ['moveToEndOfDocument'],
  'Meta+Shift+ArrowLeft': ['moveToBeginningOfLineAndModifySelection'],
  'Meta+Shift+ArrowRight': ['moveToEndOfLineAndModifySelection'],
  'Alt+ArrowLeft': ['moveWordLeft'],
  'Alt+ArrowRight': ['moveWordRight'],
  'Alt+Backspace': ['deleteWordBackward'],
  'Meta+Backspace': ['deleteToBeginningOfLine'],
};

/** The full key-event sequence of a shortcut: modifiers down, the key down and up, modifiers up (reverse order). */
export function shortcutEvents(shortcut: ParsedShortcut, isMac: boolean): KeyEvent[] {
  const events: KeyEvent[] = [];
  const held: Modifier[] = [];
  const base = (k: KeyDefinition, type: KeyEvent['type'], mask: number): KeyEvent => ({
    type,
    key: k.key,
    code: k.code,
    windowsVirtualKeyCode: k.keyCode,
    nativeVirtualKeyCode: k.keyCode,
    modifiers: mask,
    ...(k.location ? { location: k.location } : {}),
  });
  for (const m of shortcut.modifiers) {
    held.push(m);
    events.push(base(keyDefinition(m)!, 'rawKeyDown', modifierMask(held)));
  }
  const mask = modifierMask(held);
  const k = shortcut.key;
  // Text only when no Control/Meta/Alt is held: Ctrl+A must not type an "a".
  const types = k.text !== '' && !held.some((m) => m !== 'Shift');
  const down = base(k, types ? 'keyDown' : 'rawKeyDown', mask);
  if (types) {
    down.text = k.text;
    down.unmodifiedText = k.text;
  }
  if (isMac) {
    const commands = MAC_COMMANDS[[...[...shortcut.modifiers].sort(modifierOrder), k.code].join('+')];
    if (commands) down.commands = commands;
  }
  events.push(down);
  events.push(base(k, 'keyUp', mask));
  for (let i = held.length - 1; i >= 0; i--) {
    const m = held[i]!;
    held.splice(i, 1);
    events.push(base(keyDefinition(m)!, 'keyUp', modifierMask(held)));
  }
  return events;
}

const ORDER: Modifier[] = ['Meta', 'Control', 'Alt', 'Shift'];
const modifierOrder = (a: Modifier, b: Modifier) => ORDER.indexOf(a) - ORDER.indexOf(b);

/** Events that type one character (for `type` with slowly). */
export function charEvents(c: string): KeyEvent[] {
  const def = keyDefinition(c) ?? { key: c, code: '', keyCode: 0, text: c };
  const shifted = /^[A-Z]$/.test(c) || shiftedDigits.includes(c) || ':+<_>?~{|}"'.includes(c);
  const mask = shifted && def.code !== '' ? MODIFIER_BITS.Shift : 0;
  const text = def.text === '\r' ? '\r' : c;
  return [
    { type: 'keyDown', key: def.key === 'Enter' ? 'Enter' : c, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, modifiers: mask, text, unmodifiedText: text },
    { type: 'keyUp', key: def.key === 'Enter' ? 'Enter' : c, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, modifiers: mask },
  ];
}
