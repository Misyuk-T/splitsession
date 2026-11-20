/**
 * Unit tests for `src/profiles/profile-navigation/navigation.ts`.
 * Uses in-memory storage (no chrome.contextMenus required).
 */

import { describe, expect, it } from "vitest";

import { MemoryStorageArea } from "../../engine/storage/storage-area";
import { ProfileManager } from "../profile-manager/profile-manager";
import {
  ACTIVE_PROFILE_KEY,
  PROFILE_MENU_ID_PREFIX,
  PROFILE_MENU_PARENT_ID,
  ProfileNavigation,
} from "./navigation";

const setup = async (now = 1000) => {
  const area = new MemoryStorageArea();
  const pm = new ProfileManager(area, { now: () => now });
  await pm.load();
  const nav = new ProfileNavigation(pm, area, { now: () => now });
  await nav.load();
  return { area, pm, nav };
};

describe("ProfileNavigation — active profile", () => {
  it("starts with no active profile and persists the choice", async () => {
    const { area, pm, nav } = await setup();
    const { profile } = await pm.create({ name: "Work" });

    expect(nav.getActiveProfileId()).toBeNull();
    await nav.setActiveProfile(profile.id);
    expect(nav.getActiveProfile()?.id).toBe(profile.id);
    expect(area.data.get(ACTIVE_PROFILE_KEY)).toBe(profile.id);

    const reloaded = new ProfileNavigation(pm, area);
    await reloaded.load();
    expect(reloaded.getActiveProfileId()).toBe(profile.id);
  });

  it("clears the active profile", async () => {
    const { area, pm, nav } = await setup();
    const { profile } = await pm.create({ name: "Work" });
    await nav.setActiveProfile(profile.id);
    await nav.setActiveProfile(null);

    expect(nav.getActiveProfileId()).toBeNull();
    expect(area.data.has(ACTIVE_PROFILE_KEY)).toBe(false);
  });

  it("drops a stored reference to an archived or missing profile", async () => {
    const { area, pm } = await setup();
    const { profile } = await pm.create({ name: "Work" });
    await pm.archive(profile.id);
    await area.set({ [ACTIVE_PROFILE_KEY]: profile.id });

    const nav = new ProfileNavigation(pm, area);
    await nav.load();
    expect(nav.getActiveProfileId()).toBeNull();

    await area.set({ [ACTIVE_PROFILE_KEY]: "missing" });
    await nav.load();
    expect(nav.getActiveProfileId()).toBeNull();
  });

  it("rejects activating unknown or unavailable profiles", async () => {
    const { pm, nav } = await setup();
    await expect(nav.setActiveProfile("missing")).rejects.toThrow(/not found/);

    const { profile } = await pm.create({ name: "Work" });
    await pm.archive(profile.id);
    await expect(nav.setActiveProfile(profile.id)).rejects.toThrow(/archived/);
  });

  it("switches to a profile and records last use", async () => {
    const { pm, nav } = await setup();
    const { profile } = await pm.create({ name: "Work" });

    const result = await nav.switchTo(profile.id);
    expect(result.ok).toBe(true);
    expect(result.profile?.metadata.lastUsedAt).toBe(1000);
    expect(nav.getActiveProfileId()).toBe(profile.id);

    const missing = await nav.switchTo("missing");
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("not found");
  });
});

describe("ProfileNavigation — models", () => {
  it("builds quick-switch profiles with the active one first", async () => {
    const { pm, nav } = await setup();
    const a = await pm.create({ name: "A" });
    const b = await pm.create({ name: "B" });
    await pm.archive((await pm.create({ name: "Archived" })).profile.id);

    await nav.setActiveProfile(b.profile.id);
    const quick = nav.getQuickSwitchProfiles();
    expect(quick.map((profile) => profile.metadata.name)).toEqual(["B", "A"]);
    expect(quick.some((profile) => profile.id === a.profile.id)).toBe(true);
  });

  it("groups profiles by folder and finds them by tag", async () => {
    const { pm, nav } = await setup();
    const folder = await pm.createFolder("Clients");
    await pm.create({ name: "A", folderId: folder.id, tags: ["work"] });
    await pm.create({ name: "B", tags: ["home"] });

    const groups = nav.getProfilesByFolder();
    expect(groups.get(folder.id)?.map((profile) => profile.metadata.name)).toEqual(["A"]);
    expect(groups.get(null)?.map((profile) => profile.metadata.name)).toEqual(["B"]);

    expect(nav.getProfilesByTag("WORK").map((profile) => profile.metadata.name)).toEqual(["A"]);
    expect(nav.getProfilesByTag("  ")).toEqual([]);
  });

  it("builds a browser-agnostic context-menu tree", async () => {
    const { pm, nav } = await setup();
    const a = await pm.create({ name: "A" });
    await pm.create({ name: "B" });
    await nav.setActiveProfile(a.profile.id);

    const menu = nav.buildContextMenu();
    expect(menu.id).toBe(PROFILE_MENU_PARENT_ID);
    expect(menu.contexts).toEqual(["page", "action"]);
    expect(menu.children).toHaveLength(2);
    expect(menu.children[0]!.id).toBe(`${PROFILE_MENU_ID_PREFIX}${a.profile.id}`);
    expect(menu.children[0]!.checked).toBe(true);
    expect(menu.children.every((item) => item.type === "radio")).toBe(true);
  });

  it("handles only its own context-menu clicks", async () => {
    const { pm, nav } = await setup();
    const { profile } = await pm.create({ name: "Work" });

    expect(nav.ownsMenuId("other:1")).toBe(false);
    expect(await nav.handleContextMenuClick("other:1")).toBeNull();
    expect(await nav.handleContextMenuClick(PROFILE_MENU_ID_PREFIX)).toEqual({
      ok: false,
      error: "Empty profile ID.",
    });

    const result = await nav.handleContextMenuClick(
      `${PROFILE_MENU_ID_PREFIX}${profile.id}`,
    );
    expect(result?.ok).toBe(true);
    expect(nav.getActiveProfileId()).toBe(profile.id);
  });

  it("marks archived profiles as unavailable in the menu", async () => {
    const { pm, nav } = await setup();
    const { profile } = await pm.create({ name: "Old" });
    await pm.archive(profile.id);

    const item = nav.getContextMenuItems().find((entry) => entry.profileId === profile.id);
    expect(item?.available).toBe(false);
  });
});
