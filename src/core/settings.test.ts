import { describe, expect, it } from 'vitest';
import { applySettingsPatch, DEFAULT_SETTINGS, normalizeSettings, SettingsError } from './settings';

describe('settings defaults', () => {
  it('shows tab groups and prefixes titles by default', () => {
    expect(DEFAULT_SETTINGS).toEqual({ tabGroups: true, titlePrefix: true });
  });

  it('normalizeSettings fills gaps from the defaults and ignores junk', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings('x')).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ tabGroups: false })).toEqual({ tabGroups: false, titlePrefix: true });
    expect(normalizeSettings({ titlePrefix: false, tabGroups: 'no', extra: 1 })).toEqual({ tabGroups: true, titlePrefix: false });
  });

  it('the defaults object cannot be mutated through a normalized copy', () => {
    const copy = normalizeSettings({});
    copy.tabGroups = false;
    expect(DEFAULT_SETTINGS.tabGroups).toBe(true);
  });
});

describe('applySettingsPatch', () => {
  it('merges known boolean keys and leaves the rest', () => {
    expect(applySettingsPatch(DEFAULT_SETTINGS, { titlePrefix: false })).toEqual({ tabGroups: true, titlePrefix: false });
  });

  it('does not mutate its input', () => {
    const current = { ...DEFAULT_SETTINGS };
    applySettingsPatch(current, { tabGroups: false });
    expect(current).toEqual(DEFAULT_SETTINGS);
  });

  it.each([null, 'x', 3, [], undefined])('rejects a non-object patch %j', (patch) => {
    expect(() => applySettingsPatch(DEFAULT_SETTINGS, patch)).toThrow(SettingsError);
  });

  it('rejects unknown keys and non-boolean values', () => {
    expect(() => applySettingsPatch(DEFAULT_SETTINGS, { colour: true })).toThrow(/unknown setting/);
    expect(() => applySettingsPatch(DEFAULT_SETTINGS, { tabGroups: 'yes' })).toThrow(/true or false/);
  });
});
