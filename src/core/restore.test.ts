import { describe, expect, it } from "vitest";

import { simulate } from "./dnr/dnr-simulator";
import {
  CATCH_ALL_PRIORITY,
  compileGroupRules,
  createSequentialAllocator,
} from "./dnr/rule-compiler";
import { CookieJar } from "./jar/cookie-jar";
import {
  associateSessions,
  CLOSED_GRACE_MS,
  compileGateOpeners,
  compileGateRules,
  decodeGroupMarker,
  flattenRecentlyClosed,
  GATE_RULE_ID_BASE,
  gateKey,
  gateUrlFilter,
  groupMarker,
  groupNameOf,
  groupTitle,
  groupTitleWithGlyph,
  hasActiveGlyph,
  heldPageTarget,
  heldPageUrl,
  isRestorable,
  layoutWindows,
  type LiveTab,
  type MatchContext,
  matchRestoredTab,
  oneClickPlan,
  parseRestoreState,
  persistentGateKeys,
  pruneRecords,
  type RestoreRecord,
  runtimeGateKeys,
  startsWithGroupGlyph,
  stripGroupMarker,
  windowSignature,
} from "./restore";

const U = (p: string) => `https://mail.example.com/${p}`;

describe("group-title marker", () => {
  it("round-trips container IDs, stays invisible and can be stripped", () => {
    for (const id of ["a", "abc123xyz0", "0123456789abcdefghijklmnopqrstuv"]) {
      const title = groupTitle("Work", id);
      expect(decodeGroupMarker(title)).toBe(id);
      expect(stripGroupMarker(title)).toBe("⧉ Work");
      expect(groupNameOf(title)).toBe("Work");
      // eslint-disable-next-line no-misleading-character-class, no-irregular-whitespace -- the marker alphabet is zero-width code points
      expect(groupMarker(id)).toMatch(/^[⁣​‌‍⁠]+$/);
    }
  });

  it("titles start with the visible glyph; legacy titles (marker only) still name their container; the glyph alone names nothing", () => {
    expect(groupTitle("123", "a1")).toMatch(/^⧉ 123/);
    const legacy = `Work${groupMarker("work")}`;
    expect(decodeGroupMarker(legacy)).toBe("work");
    expect(groupNameOf(legacy)).toBe("Work");
    expect(decodeGroupMarker("⧉ fake")).toBeNull();
    expect(groupNameOf("⧉ fake")).toBe("fake");
    expect(groupNameOf("⧉work")).toBe("work");
    expect(groupNameOf("  ⧉   Two  words ")).toBe("Two words");
    expect(groupNameOf(`⧉ ${groupMarker("work")}`)).toBe("");
    expect(groupNameOf(undefined)).toBe("");
    expect(groupNameOf(groupTitle("⧉ odd", "x"))).toBe("⧉ odd"); // only one glyph is the prefix: the name round-trips
  });

  it("the agent-activity form swaps only the leading glyph: name and invisible marker stay exactly, both ways, idempotently", () => {
    const plain = groupTitle("main", "work");
    const active = groupTitle("main", "work", true);
    expect(active).toBe(plain.replace("⧉", "◉"));
    expect(active.startsWith("◉ main")).toBe(true);
    expect(hasActiveGlyph(active)).toBe(true);
    expect(hasActiveGlyph(plain)).toBe(false);
    expect(hasActiveGlyph(undefined)).toBe(false);
    // The marker and the name survive the swap; the swap is its own inverse and idempotent.
    expect(decodeGroupMarker(active)).toBe("work");
    expect(groupNameOf(active)).toBe("main");
    expect(groupTitleWithGlyph(plain, true)).toBe(active);
    expect(groupTitleWithGlyph(active, true)).toBe(active);
    expect(groupTitleWithGlyph(active, false)).toBe(plain);
    expect(groupTitleWithGlyph(plain, false)).toBe(plain);
    // Without the marker (a retyped title) and without a glyph (an earlier version): the glyph is set, the rest stays.
    expect(groupTitleWithGlyph("◉ main", false)).toBe("⧉ main");
    expect(groupTitleWithGlyph("main", true)).toBe("◉ main");
    expect(decodeGroupMarker(groupTitleWithGlyph("◉ main", false))).toBeNull();
    // A name that itself starts with a glyph keeps it: only one glyph is the prefix.
    expect(groupNameOf(groupTitle("◉ odd", "x", true))).toBe("◉ odd");
  });

  it("a title the user typed with spaces or without the space after the glyph gets its glyph swapped, never a second one; a name never starts with a glyph by this path", () => {
    const marker = groupMarker("work");
    for (const typed of [
      " ◉ Job",
      "◉Job",
      "   ◉   Job",
      "\t◉ Job",
      "⧉ Job",
      "  ⧉Job",
      " Job",
      "Job",
    ]) {
      for (const active of [true, false]) {
        const swapped = groupTitleWithGlyph(typed + marker, active);
        expect(swapped).toBe(
          (active ? "◉ " : "⧉ ") + typed.replace(/^\s*[⧉◉]? ?/, "") + marker,
        );
        expect(decodeGroupMarker(swapped)).toBe("work");
        expect(groupNameOf(swapped)).toBe("Job");
        expect(groupNameOf(typed + marker)).toBe("Job");
      }
      expect(hasActiveGlyph(typed + marker)).toBe(/^\s*◉/.test(typed));
    }
    // A glyph the user typed after the first one is part of the name; the sync refuses such a name (startsWithGroupGlyph).
    expect(groupNameOf("◉ ◉ Job")).toBe("◉ Job");
    for (const name of ["◉ Job", " ⧉ Job", "◉Job", "⧉"])
      expect(startsWithGroupGlyph(name)).toBe(true);
    for (const name of ["Job", "Job ◉", ""])
      expect(startsWithGroupGlyph(name)).toBe(false);
  });

  it("a title without the marker (the user’s own group, or retyped) names no container", () => {
    expect(decodeGroupMarker("Work")).toBeNull();
    expect(decodeGroupMarker("")).toBeNull();
    expect(decodeGroupMarker(undefined)).toBeNull();
    // Damaged: wrong number of digits, missing closing mark, marker not at the end.
    const marker = groupMarker("work");
    expect(decodeGroupMarker(`Work${marker.slice(0, -2)}⁣`)).toBeNull();
    expect(decodeGroupMarker(`Work${marker.slice(0, -1)}`)).toBeNull();
    expect(decodeGroupMarker(`Work${marker} (2)`)).toBeNull();
    expect(groupMarker("Not-An-Id")).toBe("");
  });
});

describe("gate", () => {
  it("keys are http(s) URLs without fragment", () => {
    expect(gateKey(U("inbox#label/1"))).toBe(U("inbox"));
    expect(gateKey("chrome://newtab/")).toBeNull();
    expect(gateKey(undefined)).toBeNull();
  });

  it("filters match the exact URL; special characters fall back to a prefix; non-ASCII is skipped", () => {
    expect(gateUrlFilter(U("a?b=1"))).toBe(`|${U("a?b=1")}|`);
    expect(gateUrlFilter(U("search?q=a*b"))).toBe(`|${U("search?q=a")}`);
    expect(gateUrlFilter("https://x.com^y")).toBeNull(); // the special character is inside the host part
    expect(gateUrlFilter(U("ü"))).toBeNull();
  });

  it("dynamic block rules are deduplicated and numbered from the base", () => {
    const rules = compileGateRules([U("a"), U("b"), U("a")]);
    expect(rules.map((r) => r.id)).toEqual([
      GATE_RULE_ID_BASE,
      GATE_RULE_ID_BASE + 1,
    ]);
    expect(
      rules.every(
        (r) =>
          r.action.type === "block" &&
          r.priority === 1 &&
          r.condition.resourceTypes.join() === "main_frame",
      ),
    ).toBe(true);
  });

  it("the openers let known tabs and next-start-only addresses through, and never cancel a cookie rule", () => {
    const jar = new CookieJar();
    jar.setFromHeader("sid=work; Path=/", {
      url: U("x"),
      now: 0,
      topLevelSite: null,
    });
    const containerRules = compileGroupRules(
      {
        tabIds: [5],
        containerId: "work",
        jar,
        topLevelSite: null,
        now: 0,
        regexBudget: 100,
        pageKeyOf: () => "k",
        frameSites: new Set(),
      },
      createSequentialAllocator(100),
    ).addRules;
    expect(Math.min(...containerRules.map((r) => r.priority))).toBe(
      CATCH_ALL_PRIORITY,
    );
    const gate = compileGateRules([U("inbox"), U("open")]);
    let id = 1;
    const openers = compileGateOpeners([5, 7], [U("open")], () => id++);
    const all = [...gate, ...openers, ...containerRules];
    // The container tab (known): its cookie rules apply, the gate does not.
    expect(simulate(all, { url: U("inbox"), tabId: 5 })).toMatchObject({
      kind: "cookie",
      value: "sid=work",
    });
    // A known plain tab: untouched.
    expect(simulate(all, { url: U("inbox"), tabId: 7 }).kind).toBe("allow");
    // A tab that just appeared (restored): blocked on a gated address, through on the next-start-only one.
    expect(simulate(all, { url: U("inbox"), tabId: 9 }).kind).toBe("block");
    expect(simulate(all, { url: U("open"), tabId: 9 }).kind).toBe("allow");
    expect(simulate(all, { url: U("other"), tabId: 9 }).kind).toBe("none");
    // Subresources are never gated.
    expect(
      simulate(gate, { url: U("inbox"), tabId: 9, type: "xmlhttprequest" })
        .kind,
    ).toBe("none");
  });

  it("an allow rule cancels modifyHeaders rules of its own priority (why cookie rules start at 2)", () => {
    const rules = [
      {
        id: 1,
        priority: 1,
        condition: { resourceTypes: ["main_frame" as const] },
        action: { type: "allow" as const },
      },
      {
        id: 2,
        priority: 1,
        condition: { resourceTypes: ["main_frame" as const] },
        action: {
          type: "modifyHeaders" as const,
          requestHeaders: [{ header: "cookie", operation: "remove" as const }],
        },
      },
    ];
    expect(simulate(rules, { url: U("a"), tabId: 1 }).kind).toBe("allow");
  });
});

describe("windows", () => {
  it("signature: http(s) URLs in tab-strip order; positions among them", () => {
    const tabs: LiveTab[] = [
      { id: 3, windowId: 1, index: 2, url: U("b"), groupId: -1 },
      { id: 1, windowId: 1, index: 0, url: "chrome://newtab/", groupId: -1 },
      { id: 2, windowId: 1, index: 1, url: U("a"), groupId: -1 },
    ];
    const layout = layoutWindows(tabs).get(1)!;
    expect(layout.sig).toBe(windowSignature([U("a"), U("b")]));
    expect(layout.count).toBe(2);
    expect([...layout.pos]).toEqual([
      [2, 0],
      [3, 1],
    ]);
    expect(windowSignature([U("a"), U("b")])).not.toBe(
      windowSignature([U("b"), U("a")]),
    );
  });
});

// ---------------------------------------------------------------- matching

const rec = (
  r: Partial<RestoreRecord> & Pick<RestoreRecord, "containerId" | "url">,
): RestoreRecord => ({
  key: `${r.containerId}-${r.url}-${r.pos ?? ""}`,
  at: 1,
  ...r,
});

function ctx(
  tabs: LiveTab[],
  records: RestoreRecord[],
  extra: Partial<MatchContext> = {},
): MatchContext {
  return {
    tabs,
    groupTitles: new Map(),
    records,
    hasContainer: (id) => id !== "gone",
    consumed: new Set(),
    windows: [],
    startup: false,
    ...extra,
  };
}

describe("matchRestoredTab", () => {
  const tab = (
    id: number,
    url: string,
    windowId = 1,
    index = 0,
    groupId = -1,
  ): LiveTab => ({ id, windowId, index, url, groupId });

  it("plain when no container tab had the address, or its container is gone", () => {
    expect(
      matchRestoredTab(
        tab(1, U("a")),
        ctx([tab(1, U("a"))], [rec({ containerId: "work", url: U("b") })]),
      ).kind,
    ).toBe("plain");
    expect(
      matchRestoredTab(
        tab(1, U("a")),
        ctx(
          [tab(1, U("a"))],
          [rec({ containerId: "gone", url: U("a"), prev: true })],
          { startup: true },
        ),
      ).kind,
    ).toBe("plain");
  });

  it("same tab and window ID (extension update): that container", () => {
    const t = tab(7, U("a"), 3);
    expect(
      matchRestoredTab(
        t,
        ctx(
          [t],
          [rec({ containerId: "work", url: U("a#x"), tabId: 7, windowId: 3 })],
        ),
      ),
    ).toMatchObject({
      kind: "container",
      containerId: "work",
      evidence: "tab-id",
    });
  });

  it("window: an exact remembered window decides by position, plain positions included, against a misleading group", () => {
    const sig = windowSignature([U("a"), U("a")]);
    const tabs = [tab(1, U("a"), 9, 0), tab(2, U("a"), 9, 1, 50)];
    const records = [
      rec({
        containerId: "work",
        url: U("a"),
        windowSig: sig,
        pos: 0,
        prev: true,
      }),
    ];
    const c = ctx(tabs, records, {
      windows: [{ sig, at: 1 }],
      startup: true,
      groupTitles: new Map([[50, groupTitle("Work", "work")]]),
    });
    expect(matchRestoredTab(tabs[0]!, c)).toMatchObject({
      kind: "container",
      containerId: "work",
      evidence: "window",
    });
    // Position 1 held an ordinary tab, although that tab now sits in Work's group (the user dragged it in).
    expect(matchRestoredTab(tabs[1]!, c)).toMatchObject({ kind: "plain" });
  });

  describe("a window with a single web page is never window evidence (wrong-account probe)", () => {
    // A one-tab container window was closed; its record stays restorable (saved group, recently closed).
    const sig = windowSignature([U("a")]);
    const closed = rec({
      containerId: "work",
      url: U("a"),
      windowSig: sig,
      pos: 0,
      closedAt: 1,
      viaWindow: true,
      savedGroup: true,
      sessionId: "s1",
    });
    const t = tab(4242, U("a"), 777, 0);

    it("a new window with the same address (link from another app, bookmark in a new window) is not assigned", () => {
      const c = ctx([t], [closed], {
        windows: [{ sig, at: 1 }],
        startup: false,
      });
      expect(matchRestoredTab(t, c)).toMatchObject({ kind: "plain" });
      // The same within the 5 minutes after a browser start where nothing was restored.
      expect(matchRestoredTab(t, { ...c, startup: true }).kind).toBe("plain");
    });

    it("at a browser start only a record of the previous session holds it (the user decides), never assigns", () => {
      const prev = rec({
        containerId: "work",
        url: U("a"),
        windowSig: sig,
        pos: 0,
        prev: true,
      });
      const c = ctx([t], [prev], {
        windows: [{ sig, at: 1 }],
        startup: true,
        history: true,
      });
      expect(matchRestoredTab(t, c)).toEqual({
        kind: "ambiguous",
        candidates: ["work"],
      });
    });

    it("the other evidence still works: the restored recently-closed entry, a SplitSession group marker", () => {
      const c = ctx([t], [closed], {
        windows: [{ sig, at: 1 }],
        consumed: new Set(["s1"]),
      });
      expect(matchRestoredTab(t, c)).toMatchObject({
        kind: "container",
        containerId: "work",
        evidence: "session",
      });
      const grouped = tab(4242, U("a"), 777, 0, 40);
      const g = ctx([grouped], [closed], {
        windows: [{ sig, at: 1 }],
        groupTitles: new Map([[40, groupTitle("Work", "work")]]),
      });
      expect(matchRestoredTab(grouped, g)).toMatchObject({
        kind: "container",
        evidence: "group",
      });
    });
  });

  it("window evidence outside a browser start needs the window's recently-closed entry to have been restored just now", () => {
    const sig = windowSignature([U("a"), U("b")]);
    const tabs = [tab(1, U("a"), 9, 0), tab(2, U("b"), 9, 1)];
    const records = [
      rec({
        containerId: "work",
        url: U("a"),
        windowSig: sig,
        pos: 0,
        closedAt: 1,
        viaWindow: true,
        savedGroup: true,
      }),
      rec({
        containerId: "work",
        url: U("b"),
        windowSig: sig,
        pos: 1,
        closedAt: 1,
        viaWindow: true,
        savedGroup: true,
        sessionId: "s2",
      }),
    ];
    const base = ctx(tabs, records, {
      windows: [{ sig, at: 1 }],
      startup: false,
    });
    // Just the same two addresses in a new window: nothing says it is the old window.
    expect(matchRestoredTab(tabs[0]!, base).kind).toBe("plain");
    // The entry of the old window was restored: the window decides (also where the record has no entry of its own).
    expect(
      matchRestoredTab(tabs[0]!, { ...base, consumed: new Set(["s2"]) }),
    ).toMatchObject({
      kind: "container",
      containerId: "work",
      evidence: "window",
    });
    // After a browser start, two or more pages in the same order are enough.
    expect(
      matchRestoredTab(tabs[0]!, { ...base, startup: true }),
    ).toMatchObject({ kind: "container", evidence: "window" });
  });

  it("held page address round-trips; anything else is not one", () => {
    const base = "chrome-extension://abc/held.html";
    const url = heldPageUrl(base, "https://a.example.com/x?y=1&z=%20#f");
    expect(heldPageTarget(url, base)).toBe(
      "https://a.example.com/x?y=1&z=%20#f",
    );
    expect(heldPageTarget(`${base}?u=javascript%3Aalert(1)`, base)).toBeNull();
    expect(heldPageTarget("https://a.example.com/", base)).toBeNull();
    expect(heldPageTarget(undefined, base)).toBeNull();
  });

  it("two remembered windows that look the same give no window evidence: ambiguous at browser start, plain later", () => {
    const sig = windowSignature([U("a")]);
    const t1 = tab(1, U("a"), 8);
    const t2 = tab(2, U("a"), 9);
    const records = [
      rec({
        containerId: "work",
        url: U("a"),
        windowSig: sig,
        pos: 0,
        prev: true,
      }),
    ];
    const windows = [
      { sig, at: 1 },
      { sig, at: 1 },
    ];
    expect(
      matchRestoredTab(t1, ctx([t1, t2], records, { windows, startup: true })),
    ).toEqual({ kind: "ambiguous", candidates: ["work"] });
    expect(
      matchRestoredTab(t1, ctx([t1, t2], records, { windows, startup: false }))
        .kind,
    ).toBe("plain");
  });

  it("a live window is not its own evidence (records of the same window are ignored)", () => {
    const sig = windowSignature([U("a"), U("b")]);
    const t = tab(2, U("b"), 5, 1);
    const records = [
      rec({
        containerId: "work",
        url: U("a"),
        tabId: 1,
        windowId: 5,
        windowSig: sig,
        pos: 0,
      }),
      rec({ containerId: "home", url: U("b"), closedAt: 1, sessionId: "s1" }),
    ];
    const c = ctx([tab(1, U("a"), 5, 0), t], records, {
      windows: [{ sig, windowId: 5, at: 1 }],
      consumed: new Set(["s1"]),
    });
    expect(matchRestoredTab(t, c)).toMatchObject({
      kind: "container",
      containerId: "home",
      evidence: "session",
    });
  });

  it("right after an extension update the tab's own window is the remembered one (same window IDs)", () => {
    const sig = windowSignature([U("a"), U("a")]);
    const tabs = [tab(1, U("a"), 5, 0), tab(2, U("a"), 5, 1)];
    const records = [
      rec({
        containerId: "work",
        url: U("a"),
        tabId: 1,
        windowId: 5,
        windowSig: sig,
        pos: 0,
        prev: true,
      }),
    ];
    const c = ctx(tabs, records, {
      windows: [{ sig, windowId: 5, at: 1 }],
      startup: true,
      history: true,
    });
    expect(matchRestoredTab(tabs[0]!, c)).toMatchObject({
      kind: "container",
      evidence: "tab-id",
    });
    // The ordinary twin in the same window: plain, not "ambiguous".
    expect(matchRestoredTab(tabs[1]!, c)).toMatchObject({ kind: "plain" });
    expect(matchRestoredTab(tabs[1]!, { ...c, history: false })).toEqual({
      kind: "ambiguous",
      candidates: ["work"],
    });
  });

  it("session: the restored recently-closed entry decides; two containers there are ambiguous", () => {
    const t = tab(1, U("a"));
    const one = [
      rec({ containerId: "work", url: U("a"), closedAt: 1, sessionId: "s1" }),
      rec({ containerId: "home", url: U("a"), closedAt: 1, sessionId: "s2" }),
    ];
    expect(
      matchRestoredTab(t, ctx([t], one, { consumed: new Set(["s2"]) })),
    ).toMatchObject({
      kind: "container",
      containerId: "home",
      evidence: "session",
    });
    expect(
      matchRestoredTab(t, ctx([t], one, { consumed: new Set(["s1", "s2"]) })),
    ).toEqual({ kind: "ambiguous", candidates: ["home", "work"] });
    // Not restored (the entry is still there): nothing.
    expect(matchRestoredTab(t, ctx([t], one)).kind).toBe("plain");
  });

  it("group: a SplitSession group of the container with a closed record of the address; a look-alike title is not", () => {
    const t = tab(1, U("a"), 1, 0, 40);
    const records = [
      rec({ containerId: "work", url: U("a"), closedAt: 1, savedGroup: true }),
    ];
    expect(
      matchRestoredTab(
        t,
        ctx([t], records, {
          groupTitles: new Map([[40, groupTitle("Work", "work")]]),
        }),
      ),
    ).toMatchObject({
      kind: "container",
      containerId: "work",
      evidence: "group",
    });
    expect(
      matchRestoredTab(
        t,
        ctx([t], records, { groupTitles: new Map([[40, "Work"]]) }),
      ).kind,
    ).toBe("plain");
    // The marker of another container: no evidence for this one.
    expect(
      matchRestoredTab(
        t,
        ctx([t], records, {
          groupTitles: new Map([[40, groupTitle("Home", "home")]]),
        }),
      ).kind,
    ).toBe("plain");
    // An open record (the tab is still there) is not something a group brings back.
    expect(
      matchRestoredTab(
        t,
        ctx(
          [t],
          [rec({ containerId: "work", url: U("a"), tabId: 99, windowId: 1 })],
          { groupTitles: new Map([[40, groupTitle("Work", "work")]]) },
        ),
      ).kind,
    ).toBe("plain");
  });
});

describe("recently closed", () => {
  it("links closed tabs by URL and time, tabs of a closed window by its signature and position", () => {
    const list = [
      { lastModified: 1000, tab: { sessionId: "t1", url: U("a") } },
      {
        lastModified: 1000,
        window: {
          sessionId: "w1",
          tabs: [
            { sessionId: "w1a", url: U("x") },
            { sessionId: "nt", url: "chrome://newtab/" },
            { sessionId: "w1b", url: U("y") },
          ],
        },
      },
    ];
    const entries = flattenRecentlyClosed(list);
    expect(entries.map((e) => e.sessionId)).toEqual(["t1", "w1a", "w1b"]);
    const sig = windowSignature([U("x"), U("y")]);
    const records = [
      rec({ containerId: "work", url: U("a"), closedAt: 1_000_000 + 3_000 }),
      rec({
        containerId: "work",
        url: U("a"),
        closedAt: 1_000_000 + 60_000,
        key: "late",
      }), // too far from the entry's time
      rec({
        containerId: "home",
        url: U("y"),
        closedAt: 2_000_000,
        viaWindow: true,
        windowSig: sig,
        pos: 1,
      }),
    ];
    associateSessions(records, entries);
    expect(records.map((r) => r.sessionId)).toEqual(["t1", undefined, "w1b"]);
    // The entry is gone (restored): the link stays only while asked to keep it.
    associateSessions(records, [], new Set(["t1"]));
    expect(records.map((r) => r.sessionId)).toEqual([
      "t1",
      undefined,
      undefined,
    ]);
  });

  it("restorable: in the list, a saved group, closed moments ago, or the previous session while it is restored", () => {
    const now = 10_000_000;
    expect(
      isRestorable(rec({ containerId: "w", url: U("a") }), new Set(), now, 0),
    ).toBe(false); // open
    expect(
      isRestorable(
        rec({
          containerId: "w",
          url: U("a"),
          closedAt: now - 5_000_000,
          sessionId: "s",
        }),
        new Set(["s"]),
        now,
        0,
      ),
    ).toBe(true);
    expect(
      isRestorable(
        rec({
          containerId: "w",
          url: U("a"),
          closedAt: now - 5_000_000,
          sessionId: "s",
        }),
        new Set(),
        now,
        0,
      ),
    ).toBe(false);
    expect(
      isRestorable(
        rec({
          containerId: "w",
          url: U("a"),
          closedAt: now - 5_000_000,
          savedGroup: true,
        }),
        new Set(),
        now,
        0,
      ),
    ).toBe(true);
    expect(
      isRestorable(
        rec({
          containerId: "w",
          url: U("a"),
          closedAt: now - CLOSED_GRACE_MS + 1,
        }),
        new Set(),
        now,
        0,
      ),
    ).toBe(true);
    expect(
      isRestorable(
        rec({ containerId: "w", url: U("a"), prev: true }),
        new Set(),
        now,
        now + 1,
      ),
    ).toBe(true);
  });

  it("gated addresses: open ones only at the next start, restorable closed ones now as well; the rest is pruned", () => {
    const now = 10_000_000;
    const records = [
      rec({ containerId: "w", url: U("open"), tabId: 1, windowId: 1 }),
      rec({ containerId: "w", url: U("closed"), closedAt: now - 1_000 }),
      rec({ containerId: "w", url: U("old"), closedAt: now - 10_000_000 }),
      rec({ containerId: "gone", url: U("gone"), tabId: 2, windowId: 1 }),
    ];
    expect(persistentGateKeys(records, new Set(), now, 0).sort()).toEqual([
      U("closed"),
      U("gone"),
      U("open"),
    ]);
    expect([...runtimeGateKeys(records, new Set(), now, 0)]).toEqual([
      U("closed"),
    ]);
    expect(
      pruneRecords(records, new Set(), now, 0, (id) => id !== "gone").map(
        (r) => r.url,
      ),
    ).toEqual([U("closed"), U("open")]);
  });
});

describe("oneClickPlan", () => {
  it("restores only tabs with one candidate and enough records of that container and address", () => {
    const records = [
      rec({ containerId: "b", url: U("y"), prev: true, pos: 0 }),
      rec({ containerId: "b", url: U("y"), prev: true, pos: 1 }),
      rec({ containerId: "a", url: U("x"), prev: true }),
    ];
    const plan = oneClickPlan(
      [
        { tabId: 1, url: U("y"), candidates: ["b"] },
        { tabId: 2, url: U("y"), candidates: ["b"] },
        { tabId: 3, url: U("x"), candidates: ["a"] },
        { tabId: 4, url: U("x"), candidates: ["a"] }, // two tabs, one record: one of them was something else
        { tabId: 5, url: U("z"), candidates: ["a", "b"] },
      ],
      records,
    );
    expect([...plan]).toEqual([
      [1, "b"],
      [2, "b"],
    ]);
  });
});

describe("parseRestoreState", () => {
  it("keeps valid records and windows, drops the rest", () => {
    const state = parseRestoreState({
      records: [
        rec({ containerId: "w", url: U("a") }),
        { containerId: "w", url: "chrome://x", key: "k", at: 1 },
        null,
        { key: 1 },
      ],
      windows: [{ sig: "s", at: 1 }, { sig: 2 }],
    });
    expect(state.records.map((r) => r.url)).toEqual([U("a")]);
    expect(state.windows).toEqual([{ sig: "s", at: 1 }]);
    expect(parseRestoreState(undefined)).toEqual({ records: [], windows: [] });
  });
});
