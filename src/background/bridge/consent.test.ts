import { describe, expect, it } from "vitest";

import {
  BRIDGE_CONSENT_KEY,
  BRIDGE_CONSENT_VERSION,
  hasBridgeConsent,
  readBridgeConsent,
} from "../../core/bridge-consent";
import {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  parseExport,
} from "../../core/transfer";
import { MemoryStorageArea } from "../../engine/storage/storage-area";
import { SettingsStore } from "../settings-store";
import { BridgeConsentStore } from "./consent";

const setup = (data: Record<string, unknown> = {}, granted = true) => {
  const area = new MemoryStorageArea();
  for (const [k, v] of Object.entries(data)) area.data.set(k, v);
  const consent = new BridgeConsentStore(area, () => 1234);
  // `permission.granted` stands for Chrome's answer about `nativeMessaging`; the store build has it only after the user said yes.
  const permission = { granted };
  const settings = new SettingsStore(
    area,
    consent.guard(async () => permission.granted),
  );
  return { area, consent, settings, permission };
};

describe("the consent record", () => {
  it("reads only a well-formed record", () => {
    expect(readBridgeConsent({ version: 1, at: 5 })).toEqual({
      version: 1,
      at: 5,
    });
    for (const junk of [
      undefined,
      null,
      true,
      "yes",
      { version: "1", at: 5 },
      { version: 0, at: 5 },
      { version: 1.5, at: 5 },
      { version: 1 },
      { version: 1, at: Number.NaN },
    ])
      expect(readBridgeConsent(junk)).toBeNull();
  });

  it("counts for the current text or a newer one, not for an older one", () => {
    expect(hasBridgeConsent({ version: 1, at: 5 }, 1)).toBe(true);
    expect(hasBridgeConsent({ version: 2, at: 5 }, 1)).toBe(true);
    // Raising BRIDGE_CONSENT_VERSION asks everybody again.
    expect(hasBridgeConsent({ version: 1, at: 5 }, 2)).toBe(false);
    expect(hasBridgeConsent(undefined)).toBe(false);
  });

  it("grant stores the version and the time, and refuses another version", async () => {
    const { area, consent } = setup();
    expect(await consent.has()).toBe(false);
    await expect(consent.grant(BRIDGE_CONSENT_VERSION + 1)).rejects.toThrow(
      /reload the page/,
    );
    await expect(consent.grant("1")).rejects.toThrow();
    expect(area.data.has(BRIDGE_CONSENT_KEY)).toBe(false);
    expect(await consent.grant(BRIDGE_CONSENT_VERSION)).toEqual({
      version: BRIDGE_CONSENT_VERSION,
      at: 1234,
    });
    expect(area.data.get(BRIDGE_CONSENT_KEY)).toEqual({
      version: BRIDGE_CONSENT_VERSION,
      at: 1234,
    });
    expect(await consent.has()).toBe(true);
  });
});

describe("the agentBridge gate", () => {
  it("refuses to switch the bridge on without consent: nothing stored, nobody notified", async () => {
    const { area, settings } = setup();
    await settings.load();
    const seen: unknown[] = [];
    settings.onChange((next) => seen.push(next));
    await expect(settings.update({ agentBridge: true })).rejects.toThrow(
      /allow agent access/,
    );
    // Also when the patch carries other keys: the whole patch is refused.
    await expect(
      settings.update({ agentBridge: true, tabGroups: false }),
    ).rejects.toThrow(/allow agent access/);
    expect(settings.get().agentBridge).toBe(false);
    expect(settings.get().tabGroups).toBe(true);
    expect(area.data.has("settings")).toBe(false);
    expect(seen).toEqual([]);
  });

  it("lets it on once consent is recorded, and off at any time", async () => {
    const { consent, settings } = setup();
    await settings.load();
    await consent.grant(BRIDGE_CONSENT_VERSION);
    expect((await settings.update({ agentBridge: true })).agentBridge).toBe(
      true,
    );
    expect((await settings.update({ agentBridge: false })).agentBridge).toBe(
      false,
    );
  });

  it("other settings change freely without consent", async () => {
    const { settings } = setup();
    await settings.load();
    expect(
      await settings.update({
        tabGroups: false,
        agentActivity: false,
        agentBridge: false,
      }),
    ).toMatchObject({ tabGroups: false, agentActivity: false });
  });

  it("a stored agentBridge: true without consent loads as off and is written back as the default", async () => {
    // An install from before the gate, a profile copied from elsewhere, or storage written behind the API's back.
    const { area, settings } = setup({
      settings: {
        tabGroups: false,
        strictMode: false,
        agentBridge: true,
        agentActivity: false,
        explicit: ["tabGroups", "agentBridge", "agentActivity"],
      },
    });
    const loaded = await settings.load();
    expect(loaded).toMatchObject({
      agentBridge: false,
      tabGroups: false,
      agentActivity: false,
    });
    expect(area.data.get("settings")).toMatchObject({
      agentBridge: false,
      tabGroups: false,
      explicit: ["tabGroups", "agentActivity"],
    });
    expect(area.data.has(BRIDGE_CONSENT_KEY)).toBe(false);
  });

  it("a stored agentBridge: true with consent stays on, and nothing is rewritten", async () => {
    const stored = {
      tabGroups: true,
      agentBridge: true,
      explicit: ["agentBridge"],
    };
    const { area, settings } = setup({
      settings: stored,
      [BRIDGE_CONSENT_KEY]: { version: BRIDGE_CONSENT_VERSION, at: 1 },
    });
    const writes = area.writes;
    expect((await settings.load()).agentBridge).toBe(true);
    expect(area.writes).toBe(writes);
  });

  it("consent to an older text does not count: the bridge loads as off", async () => {
    const { settings } = setup({
      settings: { agentBridge: true, explicit: ["agentBridge"] },
      [BRIDGE_CONSENT_KEY]: { version: BRIDGE_CONSENT_VERSION - 1, at: 1 },
    });
    expect((await settings.load()).agentBridge).toBe(false);
  });

  it("refuses to switch the bridge on without Chrome's nativeMessaging permission, even with consent", async () => {
    const { area, consent, settings, permission } = setup({}, false);
    await settings.load();
    await consent.grant(BRIDGE_CONSENT_VERSION);
    await expect(settings.update({ agentBridge: true })).rejects.toThrow(
      /permission to talk to a program/,
    );
    expect(settings.get().agentBridge).toBe(false);
    expect(area.data.has("settings")).toBe(false);
    permission.granted = true; // the user said yes in Chrome's prompt
    expect((await settings.update({ agentBridge: true })).agentBridge).toBe(
      true,
    );
    permission.granted = false; // taken back: off still works, and so do other settings
    expect(
      (await settings.update({ agentBridge: false, tabGroups: false }))
        .agentBridge,
    ).toBe(false);
  });

  it("a stored agentBridge: true without the permission loads as off (the store build after the permission was taken back)", async () => {
    const { settings } = setup(
      {
        settings: { agentBridge: true, explicit: ["agentBridge"] },
        [BRIDGE_CONSENT_KEY]: { version: BRIDGE_CONSENT_VERSION, at: 1 },
      },
      false,
    );
    expect((await settings.load()).agentBridge).toBe(false);
  });

  it("a settings store without a guard (Lite) is unaffected", async () => {
    const area = new MemoryStorageArea();
    const plain = new SettingsStore(area);
    await plain.load();
    expect((await plain.update({ agentBridge: true })).agentBridge).toBe(true);
  });

  it("an import file cannot carry the switch or a consent: export files have neither", () => {
    const parsed = parseExport({
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: 1,
      containers: [],
      rules: [],
      settings: { agentBridge: true },
      [BRIDGE_CONSENT_KEY]: { version: BRIDGE_CONSENT_VERSION, at: 1 },
    });
    if (!parsed.ok) throw new Error(parsed.error);
    expect(Object.keys(parsed.file).sort()).toEqual(
      ["containers", "exportedAt", "format", "rules", "version"].sort(),
    );
  });
});
