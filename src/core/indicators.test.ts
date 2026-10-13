import { describe, expect, it } from 'vitest';
import { CONTAINER_COLORS } from './types';
import { containerColorOfGroup, CONTAINER_HEX, GROUP_COLOR, prefixedTitle, readableTextColor, titlePrefixFor, unprefixedTitle, withoutAgentMark } from './indicators';

describe('palette', () => {
  it('has a hex colour and a Chrome group colour for every container colour', () => {
    for (const color of CONTAINER_COLORS) {
      expect(CONTAINER_HEX[color]).toMatch(/^#[0-9a-f]{6}$/);
      expect(['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']).toContain(GROUP_COLOR[color]);
    }
  });
});

describe('readableTextColor', () => {
  it('picks dark text on light colours and white text on dark ones', () => {
    expect(readableTextColor('#ffcb00')).toBe('#000000');
    expect(readableTextColor('#000000')).toBe('#ffffff');
    expect(readableTextColor('#1d4ed8')).toBe('#ffffff');
    expect(readableTextColor('nonsense')).toBe('#000000');
  });
});

describe('title prefix', () => {
  const prefix = titlePrefixFor('Work');

  it('formats as "[name] "', () => {
    expect(prefix).toBe('[Work] ');
  });
  it('adds the prefix once', () => {
    expect(prefixedTitle('Inbox', prefix)).toBe('[Work] Inbox');
    expect(prefixedTitle('[Work] Inbox', prefix)).toBe('[Work] Inbox');
    expect(prefixedTitle(prefixedTitle('Inbox', prefix), prefix)).toBe('[Work] Inbox');
  });
  it('leaves an empty title alone (Chrome then shows the address)', () => {
    expect(prefixedTitle('', prefix)).toBe('');
  });
  it('replaces the previous prefix after a rename instead of stacking', () => {
    expect(prefixedTitle('[Work] Inbox', titlePrefixFor('Job'), prefix)).toBe('[Job] Inbox');
    expect(prefixedTitle('Inbox', titlePrefixFor('Job'), prefix)).toBe('[Job] Inbox');
  });
  it('a page title that merely resembles a prefix of another name is prefixed normally', () => {
    expect(prefixedTitle('[Other] Inbox', prefix)).toBe('[Work] [Other] Inbox');
  });
  it('unprefixedTitle strips exactly one leading prefix', () => {
    expect(unprefixedTitle('[Work] Inbox', prefix)).toBe('Inbox');
    expect(unprefixedTitle('Inbox', prefix)).toBe('Inbox');
    expect(unprefixedTitle('[Work] [Work] x', prefix)).toBe('[Work] x');
  });
});

describe('agent title mark', () => {
  it('is taken off after the container prefix, or from the front', () => {
    expect(withoutAgentMark('[Work] 👁 Inbox')).toBe('[Work] Inbox');
    expect(withoutAgentMark('[Work] 🤖 Inbox')).toBe('[Work] Inbox');
    expect(withoutAgentMark('👁 Inbox')).toBe('Inbox');
    expect(withoutAgentMark('[Work] Inbox')).toBe('[Work] Inbox');
    expect(withoutAgentMark('Inbox 👁 later')).toBe('Inbox 👁 later');
  });
});

describe('containerColorOfGroup', () => {
  it('is the inverse of GROUP_COLOR, keeps the current colour, and refuses grey', () => {
    for (const color of Object.keys(GROUP_COLOR) as Array<keyof typeof GROUP_COLOR>) {
      expect(containerColorOfGroup(GROUP_COLOR[color], 'blue')).toBe(color === 'blue' ? 'blue' : color);
      expect(containerColorOfGroup(GROUP_COLOR[color], color)).toBe(color);
    }
    expect(containerColorOfGroup('cyan', 'red')).toBe('turquoise');
    expect(containerColorOfGroup('grey', 'red')).toBeNull();
  });
});
