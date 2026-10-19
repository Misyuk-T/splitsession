import { describe, expect, it } from "vitest";

import {
  applySettingsPatch,
  DEFAULT_SETTINGS,
  normalizeSettings,
  readSettings,
  SettingsError,
  storedSettings,
} from "./settings";

describe("settings defaults", () => {
  it("shows tab groups, prefixes titles, strict mode off, and the container name hidden from pages by default", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      tabGroups: true,
      titlePrefix: true,
      strictMode: false,
      showNameToPages: false,
      agentBridge: false,
      agentActivity: true,
      restoreTabs: true,
      markOutsideGroup: true,
      rememberTabs: true,
    });
  });

  it("normalizeSettings fills gaps from the defaults and ignores junk", () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings("x")).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ tabGroups: false })).toEqual({
      ...DEFAULT_SETTINGS,
      tabGroups: false,
    });
    expect(
      normalizeSettings({ titlePrefix: false, tabGroups: "no", extra: 1 }),
    ).toEqual({ ...DEFAULT_SETTINGS, titlePrefix: false });
  });

  it("keys set explicitly keep their value; the others follow the current default", () => {
    const stored = storedSettings(
      { ...DEFAULT_SETTINGS, showNameToPages: true, tabGroups: true },
      ["showNameToPages"],
    );
    expect(stored.explicit).toEqual(["showNameToPages"]);
    expect(readSettings(stored)).toEqual({
      settings: { ...DEFAULT_SETTINGS, showNameToPages: true },
      explicit: ["showNameToPages"],
      legacy: false,
    });
    // A stored value of a key never set is not a choice: it follows the default.
    expect(
      normalizeSettings({
        ...DEFAULT_SETTINGS,
        tabGroups: false,
        explicit: [],
      }),
    ).toEqual(DEFAULT_SETTINGS);
    expect(
      normalizeSettings({
        explicit: ["tabGroups", "nonsense"],
        tabGroups: false,
      }),
    ).toEqual({ ...DEFAULT_SETTINGS, tabGroups: false });
  });

  it("migrates the format without `explicit`: the old default of showing the name becomes off, choices stay", () => {
    // Untouched install of the previous version (or one where another switch was changed): name hidden now.
    expect(
      readSettings({
        tabGroups: true,
        titlePrefix: true,
        strictMode: true,
        showNameToPages: true,
      }),
    ).toEqual({
      settings: DEFAULT_SETTINGS,
      explicit: [],
      legacy: true,
    });
    expect(
      readSettings({
        tabGroups: false,
        titlePrefix: true,
        strictMode: true,
        showNameToPages: true,
      }),
    ).toEqual({
      settings: { ...DEFAULT_SETTINGS, tabGroups: false },
      explicit: ["tabGroups"],
      legacy: true,
    });
    // An explicit "off" from before stays off (and is remembered as a choice).
    expect(
      readSettings({
        tabGroups: true,
        titlePrefix: true,
        strictMode: false,
        showNameToPages: false,
        agentBridge: false,
        agentActivity: true,
      }),
    ).toEqual({
      settings: { ...DEFAULT_SETTINGS, strictMode: false },
      explicit: ["strictMode", "showNameToPages"],
      legacy: true,
    });
    expect(readSettings(undefined).legacy).toBe(false);
  });

  it("the defaults object cannot be mutated through a normalized copy", () => {
    const copy = normalizeSettings({});
    copy.tabGroups = false;
    expect(DEFAULT_SETTINGS.tabGroups).toBe(true);
  });
});

describe("applySettingsPatch", () => {
  it("merges known boolean keys and leaves the rest", () => {
    expect(
      applySettingsPatch(DEFAULT_SETTINGS, { titlePrefix: false }),
    ).toEqual({ ...DEFAULT_SETTINGS, titlePrefix: false });
  });

  it("does not mutate its input", () => {
    const current = { ...DEFAULT_SETTINGS };
    applySettingsPatch(current, { tabGroups: false });
    expect(current).toEqual(DEFAULT_SETTINGS);
  });

  it.each([null, "x", 3, [], undefined])(
    "rejects a non-object patch %j",
    (patch) => {
      expect(() => applySettingsPatch(DEFAULT_SETTINGS, patch)).toThrow(
        SettingsError,
      );
    },
  );

  it("rejects unknown keys and non-boolean values", () => {
    expect(() =>
      applySettingsPatch(DEFAULT_SETTINGS, { colour: true }),
    ).toThrow(/unknown setting/);
    expect(() =>
      applySettingsPatch(DEFAULT_SETTINGS, { tabGroups: "yes" }),
    ).toThrow(/true or false/);
  });
});

describe("agentBridge setting", () => {
  it("is off by default, can be switched like the others, and an old install without it reads as off", () => {
    expect(DEFAULT_SETTINGS.agentBridge).toBe(false);
    expect(
      applySettingsPatch(DEFAULT_SETTINGS, { agentBridge: true }).agentBridge,
    ).toBe(true);
    expect(() =>
      applySettingsPatch(DEFAULT_SETTINGS, { agentBridge: "yes" }),
    ).toThrow(SettingsError);
    expect(
      normalizeSettings({
        tabGroups: false,
        titlePrefix: true,
        strictMode: true,
        showNameToPages: false,
      }).agentBridge,
    ).toBe(false);
    // Only an explicit choice sticks; a stored `true` that was never set explicitly does not turn the bridge on.
    expect(
      normalizeSettings({
        ...DEFAULT_SETTINGS,
        agentBridge: true,
        explicit: [],
      }).agentBridge,
    ).toBe(false);
    expect(
      normalizeSettings({
        ...DEFAULT_SETTINGS,
        agentBridge: true,
        explicit: ["agentBridge"],
      }).agentBridge,
    ).toBe(true);
  });
});
