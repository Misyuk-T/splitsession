import type { Page } from "@playwright/test";

import { BRIDGE_CONSENT_KEY } from "../src/core/bridge-consent";
import { expect, ext, type Facet, test } from "./fixtures";

/**
 * The disclosure before the agent bridge turns on for the first time (src/core/bridge-consent.ts). The fixture accepts it
 * for every test; these tests remove the record first, as on a fresh install. No host is installed here: whether the bridge
 * connects is agent-bridge.spec.ts's business, this is only about the switch, the dialog and the gate.
 */

async function withoutConsent(facet: Facet): Promise<void> {
  const worker = await facet.sw();
  await worker.evaluate(
    (key) => (globalThis as any).chrome.storage.local.remove(key),
    BRIDGE_CONSENT_KEY,
  );
  expect(await facet.api("getBridgeConsent")).toBeNull();
}

async function openOptions(facet: Facet): Promise<Page> {
  const options = await facet.ctx.newPage();
  await options.goto(ext("options.html"));
  await options.bringToFront(); // keyboard focus: the page must be the active tab
  await expect(
    options.getByRole("heading", { name: "For AI agents" }),
  ).toBeVisible();
  return options;
}

const bridgeSwitch = (page: Page) =>
  page.getByRole("switch", { name: /Agent bridge/ });
const consentDialog = (page: Page) =>
  page.getByRole("dialog", { name: "Allow agent access?" });

async function expectOff(facet: Facet, options: Page): Promise<void> {
  await expect(consentDialog(options)).toHaveCount(0);
  await expect(bridgeSwitch(options)).toHaveAttribute("aria-checked", "false");
  expect(
    await facet.api<{ agentBridge: boolean }>("getSettings"),
  ).toMatchObject({ agentBridge: false });
  expect(await facet.api("getBridgeConsent")).toBeNull();
}

test.describe("agent bridge consent", () => {
  test("the switch opens the disclosure first; Cancel leaves the bridge off and records nothing", async ({
    facet,
  }) => {
    await withoutConsent(facet);
    const options = await openOptions(facet);
    await bridgeSwitch(options).click();
    const dialog = consentDialog(options);
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    for (const text of [
      /read the content of pages in every tab and window, including pages you are signed in to/,
      /take screenshots/,
      /console messages and network activity/,
      /type and click as you, in any tab and any container/,
      /run JavaScript in pages/,
      /Only to that program on this computer, through Chrome’s native messaging/,
      /SplitSession sends nothing to any server/,
      /may send what it reads to its AI provider/,
      /Switch “Agent bridge” off here or in the toolbar popup/,
    ])
      await expect(dialog).toContainText(text);
    // Nothing is on while the question is open.
    expect(
      await facet.api<{ agentBridge: boolean }>("getSettings"),
    ).toMatchObject({ agentBridge: false });

    // The safe answer has focus; Tab stays inside the dialog.
    const cancel = dialog.getByRole("button", { name: "Cancel" });
    const allow = dialog.getByRole("button", { name: "Allow agent access" });
    await expect(cancel).toBeFocused();
    await options.keyboard.press("Tab");
    await expect(allow).toBeFocused();
    await options.keyboard.press("Tab");
    await expect(cancel).toBeFocused();
    await options.keyboard.press("Shift+Tab");
    await expect(allow).toBeFocused();

    await cancel.click();
    await expectOff(facet, options);
    // Focus goes back to the switch.
    await expect(bridgeSwitch(options)).toBeFocused();
    await options.close();
  });

  test("Escape is Cancel", async ({ facet }) => {
    await withoutConsent(facet);
    const options = await openOptions(facet);
    await bridgeSwitch(options).click();
    await expect(consentDialog(options)).toBeVisible();
    await expect(
      consentDialog(options).getByRole("button", { name: "Cancel" }),
    ).toBeFocused();
    await options.keyboard.press("Escape");
    await expectOff(facet, options);
    await options.close();
  });

  test("Allow (by keyboard) records the consent and turns the bridge on; later the switch no longer asks", async ({
    facet,
  }) => {
    await withoutConsent(facet);
    const options = await openOptions(facet);
    await bridgeSwitch(options).focus();
    await options.keyboard.press("Space");
    const dialog = consentDialog(options);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await options.keyboard.press("Tab");
    await expect(
      dialog.getByRole("button", { name: "Allow agent access" }),
    ).toBeFocused();
    const before = Date.now();
    await options.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(bridgeSwitch(options)).toHaveAttribute("aria-checked", "true");
    expect(
      await facet.api<{ agentBridge: boolean }>("getSettings"),
    ).toMatchObject({ agentBridge: true });
    const consent = await facet.api<{ version: number; at: number }>(
      "getBridgeConsent",
    );
    expect(consent.version).toBe(1);
    expect(consent.at).toBeGreaterThanOrEqual(before - 1_000);

    // Off and on again: no second question.
    await bridgeSwitch(options).click();
    await expect(bridgeSwitch(options)).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await bridgeSwitch(options).click();
    await expect(bridgeSwitch(options)).toHaveAttribute("aria-checked", "true");
    await expect(consentDialog(options)).toHaveCount(0);
    await facet.api("updateSettings", { agentBridge: false });
    await options.close();
  });

  test("without consent the API refuses agentBridge: true, whoever asks", async ({
    facet,
  }) => {
    await withoutConsent(facet);
    await expect(
      facet.api("updateSettings", { agentBridge: true }),
    ).rejects.toThrow(/allow agent access/);
    // From an extension page through the message API too (what the options page and the popup use).
    const options = await openOptions(facet);
    const answer = await options.evaluate(async () => {
      const chromeApi = (globalThis as any).chrome;
      return chromeApi.runtime.sendMessage({
        type: "facet/api",
        method: "updateSettings",
        args: [{ agentBridge: true }],
      });
    });
    expect(JSON.stringify(answer)).toMatch(/allow agent access/);
    expect(
      await facet.api<{ agentBridge: boolean }>("getSettings"),
    ).toMatchObject({ agentBridge: false });
    // An outdated text cannot be accepted.
    await expect(facet.api("grantBridgeConsent", 0)).rejects.toThrow(
      /reload the page/,
    );
    expect(await facet.api("getBridgeConsent")).toBeNull();
    await options.close();
  });
});
