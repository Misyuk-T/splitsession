import { describe, expect, it, vi } from "vitest";

import {
  handlePermissionRemoved,
  hasNativeMessaging,
  releaseNativeMessaging,
} from "./native-permission";

const manifest = (optional: string[]) => ({
  runtime: {
    getManifest: () => ({ optional_permissions: optional }) as never,
  },
});

describe("hasNativeMessaging", () => {
  it("asks Chrome about nativeMessaging", async () => {
    const contains = vi.fn(async () => true);
    expect(
      await hasNativeMessaging({ permissions: { contains } as never }),
    ).toBe(true);
    expect(contains).toHaveBeenCalledWith({ permissions: ["nativeMessaging"] });
  });

  it("counts a missing or failing permissions API as not granted", async () => {
    expect(await hasNativeMessaging({})).toBe(false);
    expect(
      await hasNativeMessaging({
        permissions: {
          contains: async () => {
            throw new Error("no");
          },
        } as never,
      }),
    ).toBe(false);
  });
});

describe("releaseNativeMessaging", () => {
  it("gives the permission back when the manifest lists it as optional", async () => {
    const remove = vi.fn(async () => true);
    expect(
      await releaseNativeMessaging({
        ...manifest(["nativeMessaging"]),
        permissions: { remove } as never,
      }),
    ).toBe(true);
    expect(remove).toHaveBeenCalledWith({ permissions: ["nativeMessaging"] });
  });

  it("leaves a required permission alone (the unpacked Full cannot give it up)", async () => {
    const remove = vi.fn(async () => true);
    expect(
      await releaseNativeMessaging({
        ...manifest([]),
        permissions: { remove } as never,
      }),
    ).toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });

  it("does not throw when Chrome refuses", async () => {
    expect(
      await releaseNativeMessaging({
        ...manifest(["nativeMessaging"]),
        permissions: {
          remove: async () => {
            throw new Error("required");
          },
        } as never,
      }),
    ).toBe(false);
  });
});

describe("handlePermissionRemoved", () => {
  const deps = (over: { on?: boolean; has?: boolean } = {}) => ({
    bridgeOn: () => over.on ?? true,
    has: async () => over.has ?? false,
    switchOff: vi.fn(async () => {}),
  });

  it("switches the bridge off when nativeMessaging was taken back", async () => {
    const d = deps();
    await handlePermissionRemoved({ permissions: ["nativeMessaging"] }, d);
    expect(d.switchOff).toHaveBeenCalledTimes(1);
  });

  it("does nothing for other permissions, when the bridge is already off, or when the permission was granted again meanwhile", async () => {
    for (const [removed, d] of [
      [{ permissions: ["tabs"] }, deps()],
      [{}, deps()],
      [{ permissions: ["nativeMessaging"] }, deps({ on: false })],
      [{ permissions: ["nativeMessaging"] }, deps({ has: true })],
    ] as Array<[{ permissions?: string[] }, ReturnType<typeof deps>]>) {
      await handlePermissionRemoved(removed, d);
      expect(d.switchOff).not.toHaveBeenCalled();
    }
  });
});
