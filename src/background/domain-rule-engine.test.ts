import { describe, expect, it } from 'vitest';
import type { DomainRule } from '../core';
import { MemoryStorageArea } from '../engine/storage/storage-area';
import { DomainRuleEngine, type NavigationDetails } from './domain-rule-engine';
import { ExemptionManager } from './exemption-manager';

function setup(rules: DomainRule[]) {
  const tabs = new Map<number, string | null>();
  let nextTabId = 100;
  const events: string[] = [];
  const exemptions = new ExemptionManager(new MemoryStorageArea());
  let clock = 1_000;
  const engine = new DomainRuleEngine(exemptions, {
    rules: () => rules,
    containerOf: (tabId) => tabs.get(tabId) ?? null,
    markerContainer: async ({ tabId, url }) => (url.includes('#ctr=work') && tabs.get(tabId) == null ? 'work' : null),
    // What Facet does: a fresh tab, placed in the container (tab-assigned marks the placement), then the callback,
    // then the navigation; the old tab is closed.
    replaceTab: async (tabId, containerId, url, onCreated) => {
      const fresh = nextTabId++;
      events.push(`replace ${tabId} -> ${fresh} ${containerId} ${url}`);
      tabs.delete(tabId);
      tabs.set(fresh, containerId);
      exemptions.markPlacement(fresh, containerId);
      onCreated(fresh);
      return fresh;
    },
    navigate: async (tabId, url) => void events.push(`navigate ${tabId} ${url}`),
    chooseUrl: (url, tabId) => `choose?url=${url}&tab=${tabId}`,
    log: () => {},
    now: () => clock,
  });
  const nav = (tabId: number, url: string, extra: Partial<NavigationDetails> = {}) => engine.handleBeforeNavigate({ tabId, frameId: 0, url, ...extra });
  return { tabs, events, exemptions, engine, nav, tick: (ms: number) => (clock += ms) };
}

const always: DomainRule = { domain: 'github.com', action: 'always', containerId: 'work' };
const ask: DomainRule = { domain: 'reddit.com', action: 'ask' };

describe('DomainRuleEngine', () => {
  it('moves a plain tab into the rule\'s container and repeats the navigation there', async () => {
    const { nav, events, tabs } = setup([always]);
    expect(await nav(1, 'https://gist.github.com/x')).toBe('moved');
    // A fresh tab (no window.opener), not the old document navigated again.
    expect(events).toEqual(['replace 1 -> 100 work https://gist.github.com/x']);
    expect(tabs.get(100)).toBe('work');
    expect(tabs.has(1)).toBe(false);
  });

  it('never re-navigates the old tab into the container: every move is a fresh tab, even from another container', async () => {
    const { nav, events, tabs } = setup([always]);
    tabs.set(1, 'home');
    await nav(1, 'https://github.com/');
    expect(events.some((e) => e.startsWith('navigate'))).toBe(false);
    expect(events).toEqual(['replace 1 -> 100 work https://github.com/']);
    expect(tabs.get(100)).toBe('work');
  });

  it('the fresh tab inherits the exemption and the action history, so the loop guard still holds across replacements', async () => {
    const { nav, events, tabs } = setup([always, { domain: 'gitlab.com', action: 'always', containerId: 'home' }]);
    // The new tab's own navigation is not judged...
    await nav(1, 'https://github.com/a');
    events.length = 0;
    expect(await nav(100, 'https://github.com/a')).toBe('skipped');
    expect(events).toEqual([]);
    // ...but a chain of client-side redirects between ruled sites ends: each hop is a new tab with the history so far.
    let tab = 100;
    const hops: string[] = [];
    for (let i = 0; i < 8; i++) {
      tabs.set(tab, i % 2 === 0 ? 'work' : 'home');
      const result = await nav(tab, i % 2 === 0 ? 'https://gitlab.com/' : 'https://github.com/');
      hops.push(result);
      if (result === 'moved') tab = [...tabs.keys()].at(-1)!;
    }
    expect(hops.filter((h) => h === 'moved').length).toBeLessThanOrEqual(3); // 1 above + at most 3 = the limit of 4
    expect(hops.at(-1)).toBe('skipped');
  });

  it('does not loop: the repeated navigation, and further ones on the site, are left alone', async () => {
    const { nav, events } = setup([always]);
    await nav(1, 'https://github.com/a'); // moved into a fresh tab, 100
    events.length = 0;
    expect(await nav(100, 'https://github.com/a')).toBe('skipped');
    expect(await nav(100, 'https://github.com/b')).toBe('skipped');
    expect(events).toEqual([]);
  });

  it('leaves tabs already in the right container alone', async () => {
    const { nav, events, tabs } = setup([always]);
    tabs.set(1, 'work');
    expect(await nav(1, 'https://github.com/')).toBe('skipped');
    expect(events).toEqual([]);
  });

  it('moves a tab from another container', async () => {
    const { nav, events, tabs } = setup([always]);
    tabs.set(1, 'home');
    expect(await nav(1, 'https://github.com/')).toBe('moved');
    expect(events[0]).toBe('replace 1 -> 100 work https://github.com/');
  });

  it('"ask" sends the tab to the choose page, with its address and tab id', async () => {
    const { nav, events } = setup([ask]);
    expect(await nav(7, 'https://www.reddit.com/r/x?y=1')).toBe('asked');
    expect(events).toEqual(['navigate 7 choose?url=https://www.reddit.com/r/x?y=1&tab=7']);
  });

  it('a deliberate placement exempts the next navigation only, and its site while the tab stays on it', async () => {
    const { nav, events, exemptions, tabs } = setup([always, ask]);
    tabs.set(1, 'home');
    exemptions.markPlacement(1, 'home'); // e.g. open.html put it there
    expect(await nav(1, 'https://github.com/')).toBe('skipped');
    expect(await nav(1, 'https://github.com/other')).toBe('skipped');
    expect(events).toEqual([]);
    expect(await nav(1, 'https://www.reddit.com/')).toBe('asked'); // another site: judged again
    events.length = 0;
    expect(await nav(1, 'https://github.com/')).toBe('moved'); // and github is a new visit now
  });

  it('a tab placed in a container stays exempt only while it is in that container', async () => {
    const { nav, tabs, exemptions } = setup([always]);
    tabs.set(1, 'home');
    exemptions.markPlacement(1, 'home');
    tabs.set(1, 'other'); // moved elsewhere by something else
    expect(await nav(1, 'https://github.com/')).toBe('moved');
  });

  it('an explicit #ctr marker Facet honours is left to the engine and exempts the repeated navigation', async () => {
    const { nav, events, tabs } = setup([always, ask]);
    expect(await nav(1, 'https://www.reddit.com/#ctr=work')).toBe('skipped');
    expect(events).toEqual([]);
    tabs.set(1, 'work'); // Facet assigned it and navigates to the clean URL
    expect(await nav(1, 'https://www.reddit.com/')).toBe('skipped');
    expect(events).toEqual([]);
  });

  it('a #ctr marker Facet ignores (unknown name, tab already in a container, started by a page) is judged like any URL', async () => {
    const { nav, events, tabs } = setup([always, ask]);
    expect(await nav(2, 'https://www.reddit.com/#ctr=ghost')).toBe('asked');
    tabs.set(3, 'home');
    expect(await nav(3, 'https://github.com/#ctr=work')).toBe('moved');
    expect(events.find((e) => e.startsWith('replace'))).toMatch(/^replace 3 -> \d+ work /);
  });

  it('a child of a container page is not judged while it is being assigned, nor shortly after', async () => {
    const { nav, events, tabs, engine, tick } = setup([always]);
    tabs.set(1, 'home');
    engine.noteChildOfContainerTab(2, 1);
    // The child exists but is not assigned yet.
    expect(await nav(2, 'https://github.com/login/oauth')).toBe('skipped');
    // Assigned (the registry says so before Facet's event fires): still not judged, and so are its next hops.
    tabs.set(2, 'home');
    expect(await nav(2, 'https://github.com/login/oauth')).toBe('skipped');
    expect(await nav(2, 'https://github.com/callback')).toBe('skipped');
    expect(events).toEqual([]);
    // Moved to another container by something else: a tab like any other.
    tabs.set(2, 'elsewhere');
    expect(await nav(2, 'https://github.com/')).toBe('moved');
    // The grace period is short: later on a child is subject to rules like any other tab.
    tabs.set(3, 'home');
    engine.noteChildOfContainerTab(3, 1);
    tick(6_000);
    expect(await nav(3, 'https://github.com/')).toBe('moved');
  });

  it('children of plain tabs are judged normally', async () => {
    const { nav, engine } = setup([always]);
    engine.noteChildOfContainerTab(2, 1); // parent 1 is plain: nothing recorded
    expect(await nav(2, 'https://github.com/')).toBe('moved');
  });

  it('ignores subframes, prerenders, non-web addresses and tabs without an id', async () => {
    const { nav, events, engine } = setup([always]);
    expect(await engine.handleBeforeNavigate({ tabId: 1, frameId: 3, url: 'https://github.com/' })).toBe('skipped');
    expect(await nav(1, 'https://github.com/', { documentLifecycle: 'prerender' })).toBe('skipped');
    expect(await nav(1, 'chrome://settings')).toBe('skipped');
    expect(await nav(1, 'about:blank')).toBe('skipped');
    expect(await nav(1, 'chrome-extension://abc/open.html?url=https://github.com/')).toBe('skipped');
    expect(await nav(-1, 'https://github.com/')).toBe('skipped');
    expect(events).toEqual([]);
  });

  it('stops after a few actions on one tab (loop guard of last resort)', async () => {
    const { nav, events, tabs } = setup([ask]);
    const results: string[] = [];
    for (let i = 0; i < 6; i++) {
      tabs.set(1, null);
      results.push(await nav(1, `https://reddit.com/${i}`));
    }
    expect(results).toEqual(['asked', 'asked', 'asked', 'asked', 'skipped', 'skipped']);
    expect(events).toHaveLength(4);
  });

  it('unrelated sites are untouched', async () => {
    const { nav, events } = setup([always, ask]);
    expect(await nav(1, 'https://example.com/')).toBe('skipped');
    expect(await nav(1, 'https://notgithub.com/')).toBe('skipped');
    expect(events).toEqual([]);
  });
});
