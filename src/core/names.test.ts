import { describe, expect, it } from "vitest";

import {
  checkContainerName,
  collapseName,
  MAX_CONTAINER_NAME,
  sanitizeNameInput,
} from "./names";

describe("sanitizeNameInput", () => {
  it("drops control characters and line breaks", () => {
    expect(sanitizeNameInput("Wo\nrk\t\u0000")).toBe("Work");
  });
  it("drops zero-width and bidi override characters", () => {
    const [zeroWidth, bidiOverride, bom] = [0x200b, 0x202e, 0xfeff].map((cp) =>
      String.fromCodePoint(cp),
    );
    expect(sanitizeNameInput(`a${zeroWidth}b${bidiOverride}c${bom}`)).toBe(
      "abc",
    );
  });
  it("drops leading spaces but keeps trailing ones while typing", () => {
    expect(sanitizeNameInput("   Work ")).toBe("Work ");
  });
  it("caps the length by characters, not UTF-16 units", () => {
    const long = "😀".repeat(40);
    expect(Array.from(sanitizeNameInput(long))).toHaveLength(
      MAX_CONTAINER_NAME,
    );
    expect(sanitizeNameInput("x".repeat(100))).toHaveLength(MAX_CONTAINER_NAME);
  });
});

describe("checkContainerName", () => {
  const existing = ["Work", "Personal account"];

  it("accepts and trims", () => {
    expect(checkContainerName("  Side  hustle ", existing)).toEqual({
      ok: true,
      name: "Side hustle",
    });
  });
  it("rejects empty and blank names", () => {
    expect(checkContainerName("", existing).ok).toBe(false);
    expect(checkContainerName("   ", existing).ok).toBe(false);
  });
  it("rejects names over the limit", () => {
    const r = checkContainerName("x".repeat(MAX_CONTAINER_NAME + 1), existing);
    expect(r).toMatchObject({ ok: false });
    expect(
      checkContainerName("x".repeat(MAX_CONTAINER_NAME), existing).ok,
    ).toBe(true);
  });
  it("rejects duplicates case-insensitively and after whitespace collapsing", () => {
    expect(checkContainerName("work", existing)).toMatchObject({
      ok: false,
      message: expect.stringContaining("already exists"),
    });
    expect(checkContainerName("personal   ACCOUNT", existing).ok).toBe(false);
  });
  it("keeping the own name while renaming is fine, a case change too", () => {
    expect(checkContainerName("Work", existing, "Work").ok).toBe(true);
    expect(checkContainerName("WORK", existing, "Work").ok).toBe(true);
    expect(checkContainerName("Personal account", existing, "Work").ok).toBe(
      false,
    );
  });
  it("collapseName squeezes runs of whitespace", () => {
    expect(collapseName(" a \t b\n")).toBe("a b");
  });
});
