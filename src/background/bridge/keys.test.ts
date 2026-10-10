import { describe, expect, it } from 'vitest';
import { charEvents, keyDefinition, parseShortcut, shortcutEvents } from './keys';

describe('key parsing', () => {
  it('knows named keys, aliases and single characters', () => {
    expect(keyDefinition('Enter')).toEqual({ key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' });
    expect(keyDefinition('esc')).toMatchObject({ key: 'Escape', keyCode: 27 });
    expect(keyDefinition('arrowdown')).toMatchObject({ key: 'ArrowDown', keyCode: 40 });
    expect(keyDefinition('F5')).toMatchObject({ key: 'F5', keyCode: 116 });
    expect(keyDefinition('a')).toEqual({ key: 'a', code: 'KeyA', keyCode: 65, text: 'a' });
    expect(keyDefinition('7')).toEqual({ key: '7', code: 'Digit7', keyCode: 55, text: '7' });
    expect(keyDefinition('/')).toEqual({ key: '/', code: 'Slash', keyCode: 191, text: '/' });
    expect(keyDefinition('Space')).toMatchObject({ key: ' ', code: 'Space', text: ' ' });
    expect(keyDefinition('é')).toEqual({ key: 'é', code: '', keyCode: 0, text: 'é' });
    expect(keyDefinition('Nope')).toBeNull();
  });

  it('parses shortcuts with modifiers, aliases, ControlOrMeta and the plus key', () => {
    expect(parseShortcut('Meta+A', true)).toEqual({ modifiers: ['Meta'], key: { key: 'a', code: 'KeyA', keyCode: 65, text: 'a' } });
    expect(parseShortcut('ctrl+shift+k', false).modifiers).toEqual(['Control', 'Shift']);
    expect(parseShortcut('Shift+k', false).key).toMatchObject({ key: 'K', text: 'K' });
    expect(parseShortcut('ControlOrMeta+C', true).modifiers).toEqual(['Meta']);
    expect(parseShortcut('ControlOrMeta+C', false).modifiers).toEqual(['Control']);
    expect(parseShortcut('Cmd+Option+I', true).modifiers).toEqual(['Meta', 'Alt']);
    expect(parseShortcut('Shift++', false)).toMatchObject({ modifiers: ['Shift'], key: { key: '+', code: 'Equal' } });
    expect(parseShortcut('+', false).key.key).toBe('+');
    expect(parseShortcut('Enter', false)).toMatchObject({ modifiers: [], key: { key: 'Enter' } });
  });

  it('explains what it cannot parse', () => {
    expect(() => parseShortcut('Hyper+A', false)).toThrow(/"Hyper" is not a modifier/);
    expect(() => parseShortcut('Control+Banana', false)).toThrow(/unknown key "Banana"/);
    expect(() => parseShortcut('Control+', false)).toThrow(/not a shortcut/);
    expect(() => parseShortcut('', false)).toThrow(/give a key name/);
  });

  it('builds the event sequence: modifiers down, key, modifiers up in reverse; text only without Control/Meta/Alt', () => {
    const events = shortcutEvents(parseShortcut('Control+Shift+K', false), false);
    expect(events.map((e) => `${e.type}:${e.key}:${e.modifiers}`)).toEqual([
      'rawKeyDown:Control:2',
      'rawKeyDown:Shift:10',
      'rawKeyDown:K:10',
      'keyUp:K:10',
      'keyUp:Shift:2',
      'keyUp:Control:0',
    ]);
    expect(events[2]!.text).toBeUndefined();
    const enter = shortcutEvents(parseShortcut('Enter', false), false);
    expect(enter[0]).toMatchObject({ type: 'keyDown', key: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
    const shiftA = shortcutEvents(parseShortcut('Shift+a', false), false);
    expect(shiftA[1]).toMatchObject({ type: 'keyDown', key: 'A', text: 'A', modifiers: 8 });
  });

  it('names the editing command of a macOS shortcut (Chrome ignores the bare key event there)', () => {
    const mac = shortcutEvents(parseShortcut('Meta+A', true), true);
    expect(mac[1]).toMatchObject({ type: 'rawKeyDown', key: 'a', modifiers: 4, commands: ['selectAll'] });
    expect(shortcutEvents(parseShortcut('Meta+Shift+Z', true), true)[2]!.commands).toEqual(['redo']);
    expect(shortcutEvents(parseShortcut('Meta+A', false), false)[1]!.commands).toBeUndefined();
  });

  it('types single characters with Shift where a US keyboard needs it', () => {
    expect(charEvents('a')[0]).toMatchObject({ type: 'keyDown', key: 'a', code: 'KeyA', text: 'a', modifiers: 0 });
    expect(charEvents('A')[0]).toMatchObject({ key: 'A', code: 'KeyA', text: 'A', modifiers: 8 });
    expect(charEvents('!')[0]).toMatchObject({ key: '!', code: 'Digit1', modifiers: 8 });
    expect(charEvents('\n')[0]).toMatchObject({ key: 'Enter', text: '\r' });
    expect(charEvents('ж')[0]).toMatchObject({ key: 'ж', code: '', text: 'ж', modifiers: 0 });
    expect(charEvents('x').map((e) => e.type)).toEqual(['keyDown', 'keyUp']);
  });
});
