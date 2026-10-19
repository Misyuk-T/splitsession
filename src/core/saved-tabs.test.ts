import { describe, expect, it } from "vitest";

import {
  BATCH_GAP_MS,
  cleanTabTitle,
  ClosureLog,
  isSavableUrl,
  MAX_SAVED_TABS,
  mergeTabLists,
  normalizeSavedTabs,
  savedTabsOf,
} from "./saved-tabs";

const closed = (
  n: number,
  at: number,
  over: Partial<{ url: string; windowId: number; index: number }> = {},
) => ({
  tab: {
    url: `https://example.com/${n}`,
    title: `Page ${n}`,
    windowId: 1,
    index: n,
    ...over,
  },
  at,
  windowClosing: false,
});

describe("isSavableUrl", () => {
  it("keeps web addresses only", () => {
    expect(isSavableUrl("https://a.com/x")).toBe(true);
    expect(isSavableUrl("http://a.com")).toBe(true);
    for (const url of [
      "chrome://settings",
      "about:blank",
      "chrome-extension://abc/held.html",
      "file:///etc/passwd",
      "",
      undefined,
    ])
      expect(isSavableUrl(url)).toBe(false);
  });
});

describe("ClosureLog: one batch is tabs closed within the gap of each other", () => {
  it("tabs closed at once are one batch", () => {
    const log = new ClosureLog();
    for (let i = 0; i < 5; i++) log.add("c", closed(i, 1000 + i * 20));
    expect(log.last("c").map((c) => c.tab?.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it("tabs closed one by one over time: only the last batch counts", () => {
    const log = new ClosureLog();
    log.add("c", closed(0, 0));
    log.add("c", closed(1, 10_000));
    log.add("c", closed(2, 20_000));
    expect(log.last("c").map((c) => c.tab?.index)).toEqual([2]);
  });

  it("a chain of closures each within the gap of the next is one batch, even if it is long", () => {
    const log = new ClosureLog();
    for (let i = 0; i < 6; i++)
      log.add("c", closed(i, i * (BATCH_GAP_MS - 100)));
    expect(log.last("c")).toHaveLength(6);
  });

  it("an earlier batch is left out when the gap is exceeded", () => {
    const log = new ClosureLog();
    log.add("c", closed(0, 0));
    log.add("c", closed(1, 100));
    log.add("c", closed(2, 100 + BATCH_GAP_MS + 1));
    log.add("c", closed(3, 100 + BATCH_GAP_MS + 50));
    expect(log.last("c").map((c) => c.tab?.index)).toEqual([2, 3]);
  });

  it("keeps containers apart and answers with nothing for an unknown one", () => {
    const log = new ClosureLog();
    log.add("a", closed(0, 0));
    log.add("b", closed(1, 0));
    expect(log.last("a")).toHaveLength(1);
    expect(log.last("x")).toEqual([]);
    log.forget("a");
    expect(log.last("a")).toEqual([]);
  });
});

describe("savedTabsOf", () => {
  it("orders by window, then position, not by closing order", () => {
    const batch = [
      closed(2, 1, { index: 2 }),
      closed(0, 2, { index: 0 }),
      closed(9, 3, { index: 0, windowId: 2 }),
      closed(1, 4, { index: 1 }),
    ];
    expect(savedTabsOf(batch).map((t) => t.url)).toEqual([
      "https://example.com/0",
      "https://example.com/1",
      "https://example.com/2",
      "https://example.com/9",
    ]);
  });

  it("skips what is not a web address and tabs it knew nothing about", () => {
    const batch = [
      closed(0, 1),
      closed(1, 2, { url: "chrome://settings" }),
      closed(2, 3, { url: "about:blank" }),
      closed(3, 4, { url: "chrome-extension://x/open.html" }),
      { tab: null, at: 5, windowClosing: false },
    ];
    expect(savedTabsOf(batch)).toEqual([
      { url: "https://example.com/0", title: "Page 0" },
    ]);
  });

  it("lists an address once, at its first place", () => {
    const batch = [
      closed(1, 1, { index: 1, url: "https://a.com/x" }),
      closed(2, 2, { index: 2, url: "https://a.com/y" }),
      closed(3, 3, { index: 3, url: "https://a.com/x" }),
    ];
    expect(savedTabsOf(batch).map((t) => t.url)).toEqual([
      "https://a.com/x",
      "https://a.com/y",
    ]);
  });

  it("keeps at most 50 tabs, the first ones in order", () => {
    const batch = Array.from({ length: 80 }, (_, i) => closed(i, i));
    const tabs = savedTabsOf(batch);
    expect(tabs).toHaveLength(MAX_SAVED_TABS);
    expect(tabs[0]!.url).toBe("https://example.com/0");
    expect(tabs[49]!.url).toBe("https://example.com/49");
  });
});

describe("titles and stored lists", () => {
  it("takes our marks off a title", () => {
    expect(cleanTabTitle("⧉ [Work] Inbox", "Work")).toBe("Inbox");
    expect(cleanTabTitle("[Work] Inbox", "Work")).toBe("Inbox");
    expect(cleanTabTitle("Inbox", "Work")).toBe("Inbox");
    expect(cleanTabTitle(undefined, "Work")).toBe("");
    expect(cleanTabTitle("x".repeat(1000), "Work")).toHaveLength(300);
  });

  it("normalizeSavedTabs drops malformed entries and caps the list", () => {
    expect(normalizeSavedTabs("nope")).toEqual([]);
    expect(
      normalizeSavedTabs([
        { url: "https://a.com", title: "A" },
        { url: "chrome://x", title: "X" },
        { url: 5 },
        null,
        { url: "https://b.com" },
      ]),
    ).toEqual([
      { url: "https://a.com", title: "A" },
      { url: "https://b.com", title: "" },
    ]);
    const many = Array.from({ length: 70 }, (_, i) => ({
      url: `https://a.com/${i}`,
      title: "",
    }));
    expect(normalizeSavedTabs(many)).toHaveLength(MAX_SAVED_TABS);
  });

  it("mergeTabLists puts open tabs first, drops repeated addresses and caps", () => {
    const open = [{ url: "https://a.com", title: "A" }];
    const saved = [
      { url: "https://b.com", title: "B" },
      { url: "https://a.com", title: "old A" },
    ];
    expect(mergeTabLists(open, saved)).toEqual([
      { url: "https://a.com", title: "A" },
      { url: "https://b.com", title: "B" },
    ]);
    const lots = Array.from({ length: 60 }, (_, i) => ({
      url: `https://a.com/${i}`,
      title: "",
    }));
    expect(mergeTabLists(lots, lots)).toHaveLength(MAX_SAVED_TABS);
  });
});
