import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTitleLayers } from "./title-layers";

/** A document with a title that notifies its observers, just enough for the layers. */
function fakeDom(initial: string) {
  const observers: Array<() => void> = [];
  const doc = {
    _title: initial,
    get title() {
      return this._title;
    },
    set title(value: string) {
      this._title = value;
      for (const notify of observers) notify();
    },
    documentElement: {},
    head: {},
    querySelector: () => ({}),
  };
  class FakeObserver {
    constructor(private readonly callback: () => void) {
      observers.push(() => this.callback());
    }

    observe() {}
    disconnect() {}
  }
  vi.stubGlobal("document", doc);
  vi.stubGlobal("MutationObserver", FakeObserver);
  return {
    /** The page sets its own title (SPA navigation). */
    page(title: string) {
      doc.title = title;
    },
    title: () => doc.title,
  };
}

describe("title layers", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("puts the mark in front once, keeps one mark through page title changes, and restores the title exactly", () => {
    const dom = fakeDom("Inbox");
    const layers = createTitleLayers();
    layers.set("mark", "⧉ ");
    expect(dom.title()).toBe("⧉ Inbox");
    dom.page("Mail (3)");
    expect(dom.title()).toBe("⧉ Mail (3)");
    dom.page("⧉ Mail (3)"); // a title that already carries it is left alone
    expect(dom.title()).toBe("⧉ Mail (3)");
    layers.set("mark", "⧉ "); // no change
    expect(dom.title()).toBe("⧉ Mail (3)");
    layers.set("mark", "");
    expect(dom.title()).toBe("Mail (3)");
    dom.page("Other");
    expect(dom.title()).toBe("Other");
  });

  it("stacks mark and name as '⧉ [name] Title' in any order and takes either off alone", () => {
    const dom = fakeDom("Inbox");
    const layers = createTitleLayers();
    layers.set("name", "[Work] ");
    expect(dom.title()).toBe("[Work] Inbox");
    layers.set("mark", "⧉ ");
    expect(dom.title()).toBe("⧉ [Work] Inbox");
    dom.page("New");
    expect(dom.title()).toBe("⧉ [Work] New");
    layers.set("name", "[Job] "); // renamed
    expect(dom.title()).toBe("⧉ [Job] New");
    layers.set("mark", "");
    expect(dom.title()).toBe("[Job] New");
    layers.set("mark", "⧉ ");
    layers.set("name", "");
    expect(dom.title()).toBe("⧉ New");
    layers.set("mark", "");
    expect(dom.title()).toBe("New");
  });

  it("leaves an empty title empty and writes nothing while no layer has text", () => {
    const dom = fakeDom("");
    const layers = createTitleLayers();
    layers.set("mark", "⧉ ");
    expect(dom.title()).toBe("");
    layers.set("mark", "");
    expect(dom.title()).toBe("");
  });

  it("gives up on a page that keeps undoing the prefix", () => {
    const dom = fakeDom("Inbox");
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const layers = createTitleLayers();
    layers.set("mark", "⧉ ");
    for (let i = 0; i < 60; i++) dom.page(`Fight ${i}`);
    expect(dom.title()).toBe("Fight 59"); // we stopped writing
  });
});
