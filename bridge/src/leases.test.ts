import { describe, expect, it } from "vitest";

import { TOOLS } from "../../src/bridge/spec";
import {
  cleanSessionName,
  LEASE_IDLE_MS,
  LEASE_MUTATING,
  LEASE_OPENING,
  Leases,
} from "./leases";

function clock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("tool classes", () => {
  it("only tools that exist, none of them read-only; hover and scroll are free", () => {
    const byName = new Map(TOOLS.map((t) => [t.name, t]));
    for (const name of [...LEASE_MUTATING, ...LEASE_OPENING]) {
      expect(byName.has(name), name).toBe(true);
      expect(byName.get(name)!.readOnly, name).toBe(false);
    }
    for (const name of ["hover", "scroll"])
      expect(LEASE_MUTATING.has(name)).toBe(false);
  });

  it("every mutating tool acts on a tab", () => {
    for (const t of TOOLS.filter((t) => LEASE_MUTATING.has(t.name)))
      expect(t.inputSchema.required, t.name).toContain("tabId");
  });
});

describe("Leases", () => {
  it("a tab nobody holds may be used by anyone; the first grant holds it", () => {
    const c = clock();
    const l = new Leases(c.now);
    expect(l.refusal("a", 1, false)).toBeNull();
    l.grant("a", 1);
    expect(l.refusal("a", 1, false)).toBeNull();
    expect(l.refusal("b", 2, false)).toBeNull();
  });

  it("refuses another session with the holder's name and idle time", () => {
    const c = clock();
    const l = new Leases(c.now);
    l.grant("agent-a1", 5);
    c.advance(12_400);
    expect(l.refusal("agent-b2", 5, false)).toBe(
      "tab 5 is in use by another agent session (agent-a1, last action 12s ago); open your own tab (open_tab / open_in_container) or pass takeOver: true if the user asked you to work in it",
    );
  });

  it("takeOver passes, and the taker holds the tab afterwards", () => {
    const l = new Leases(clock().now);
    l.grant("a", 5);
    expect(l.refusal("b", 5, true)).toBeNull();
    l.grant("b", 5);
    expect(l.refusal("a", 5, false)).toMatch(
      /in use by another agent session \(b,/,
    );
  });

  it("a holder's action renews the lease; it expires after the idle time", () => {
    const c = clock();
    const l = new Leases(c.now);
    l.grant("a", 5);
    c.advance(LEASE_IDLE_MS - 1);
    expect(l.refusal("b", 5, false)).not.toBeNull();
    l.grant("a", 5); // renewed
    c.advance(LEASE_IDLE_MS - 1);
    expect(l.refusal("b", 5, false)).not.toBeNull();
    c.advance(1);
    expect(l.refusal("b", 5, false)).toBeNull();
    expect(l.holder(5)).toBeNull();
  });

  it("release frees one tab; releaseAll frees what a session holds and nothing else", () => {
    const l = new Leases(clock().now);
    l.grant("a", 1);
    l.grant("a", 2);
    l.grant("b", 3);
    l.release(1);
    expect(l.holder(1)).toBeNull();
    l.releaseAll("a");
    expect(l.holder(2)).toBeNull();
    expect(l.holder(3)?.name).toBe("b");
  });

  it("annotates a tab list: inUseBy for another session's tab, yours for the caller's", () => {
    const l = new Leases(clock().now);
    l.grant("a", 1);
    l.grant("b", 2);
    const items = [{ tabId: 1, title: "x" }, { tabId: 2 }, { tabId: 3 }, "odd"];
    expect(l.annotate(items, "a")).toEqual([
      { tabId: 1, title: "x", yours: true },
      { tabId: 2, inUseBy: "b" },
      { tabId: 3 },
      "odd",
    ]);
  });
});

describe("cleanSessionName", () => {
  it("keeps printable names, trims and caps them; refuses non-strings and empties", () => {
    expect(cleanSessionName("  claude-code-1a2b ")).toBe("claude-code-1a2b");
    expect(cleanSessionName("a\u0000b\nc")).toBe("abc");
    expect(cleanSessionName("x".repeat(100))).toHaveLength(64);
    expect(cleanSessionName("")).toBeNull();
    expect(cleanSessionName("  ")).toBeNull();
    expect(cleanSessionName(5)).toBeNull();
    expect(cleanSessionName(undefined)).toBeNull();
  });
});
