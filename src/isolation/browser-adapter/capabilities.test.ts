/**
 * Unit tests for `src/isolation/browser-adapter/capabilities.ts`.
 * Pure TypeScript: no browser APIs required.
 */

import { describe, expect, it } from "vitest";

import {
  detectBrowserFamily,
  capabilitiesToGuarantees,
  describeLimitations,
  DEFAULT_CAPABILITIES,
} from "./capabilities";

describe("detectBrowserFamily", () => {
  it("detects Firefox", () => {
    expect(detectBrowserFamily("Mozilla/5.0 Firefox/120.0")).toBe("firefox");
  });

  it("detects Chromium", () => {
    expect(detectBrowserFamily("Mozilla/5.0 Chrome/120.0 Safari/537.36")).toBe("chromium");
    expect(detectBrowserFamily("Mozilla/5.0 Chromium/120.0 Safari/537.36")).toBe("chromium");
  });

  it("returns unknown for unrecognized", () => {
    expect(detectBrowserFamily("SomethingElse/1.0")).toBe("unknown");
  });
});

describe("capabilitiesToGuarantees", () => {
  it("claims nothing for unknown browser", () => {
    const g = capabilitiesToGuarantees(DEFAULT_CAPABILITIES);
    expect(g.cookies).toBe(false);
    expect(g.localStorage).toBe(false);
    expect(g.indexedDB).toBe(false);
  });

  it("claims cookie isolation when DNR and header modification available", () => {
    const caps = { ...DEFAULT_CAPABILITIES, hasDnrSessionRules: true, hasHeaderModification: true };
    const g = capabilitiesToGuarantees(caps);
    expect(g.cookies).toBe(true);
  });

  it("claims storage isolation when content scripts and storage API available", () => {
    const caps = { ...DEFAULT_CAPABILITIES, hasContentScripts: true, hasStorageApi: true };
    const g = capabilitiesToGuarantees(caps);
    expect(g.localStorage).toBe(true);
    expect(g.indexedDB).toBe(true);
    expect(g.cacheStorage).toBe(true);
  });

  it("claims service worker removal when browsingData available", () => {
    const caps = { ...DEFAULT_CAPABILITIES, hasBrowsingData: true };
    const g = capabilitiesToGuarantees(caps);
    expect(g.serviceWorkers).toBe(true);
  });

  it("Firefox containers claim broad isolation", () => {
    const caps = { ...DEFAULT_CAPABILITIES, hasContainerTabs: true };
    const g = capabilitiesToGuarantees(caps);
    expect(g.cookies).toBe(true);
    expect(g.localStorage).toBe(true);
    expect(g.indexedDB).toBe(true);
    expect(g.cacheStorage).toBe(true);
    expect(g.broadcastChannel).toBe(true);
  });
});

describe("describeLimitations", () => {
  it("lists limitations for unknown browser", () => {
    const limits = describeLimitations(DEFAULT_CAPABILITIES);
    expect(limits.length).toBeGreaterThan(0);
    expect(limits.some((l) => l.includes("Could not be detected"))).toBe(true);
    expect(limits.some((l) => l.includes("Session Storage"))).toBe(true);
  });

  it("lists no content script limitation", () => {
    const caps = { ...DEFAULT_CAPABILITIES, hasContentScripts: false, hasContainerTabs: false };
    const limits = describeLimitations(caps);
    expect(limits.some((l) => l.includes("content script"))).toBe(true);
  });

  it("lists fewer limitations for capable browser", () => {
    const caps = {
      ...DEFAULT_CAPABILITIES,
      family: "chromium" as const,
      name: "Chrome",
      version: "120.0",
      hasContentScripts: true,
      hasStorageApi: true,
      hasDnrSessionRules: true,
      hasHeaderModification: true,
      hasBrowsingData: true,
    };
    const limits = describeLimitations(caps);
    // Session Storage limitation always present.
    expect(limits.some((l) => l.includes("Session Storage"))).toBe(true);
    // But no content script or cookie limitation.
    expect(limits.some((l) => l.includes("content script"))).toBe(false);
    expect(limits.some((l) => l.includes("Cookie header rewriting"))).toBe(false);
  });
});
