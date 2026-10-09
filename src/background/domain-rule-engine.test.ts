import { describe, expect, it } from 'vitest';
import type { DomainRule } from '../core';
import { MemoryStorageArea } from '../engine/storage/storage-area';
import { DomainRuleEngine, type NavigationDetails } from './domain-rule-engine';
import { ExemptionManager } from './exemption-manager';

function setup(rules: DomainRule[]) {
  const tabs = new Map<number, string | null>();
  const events: string[] = [];
  const exemptions = new ExemptionManager(new MemoryStorageArea());
  let clock = 1_000;
  const engine = new DomainRuleEngine(exemptions, {
    rules: () => rules,
    containerOf: (tabId) => tabs.get(tabId) ?? null,
    markerContainer: (url) => (url.includes('#ctr=work') ? 'work' : undefined),
    assign: async (tabId, containerId) => {
      events.push(`assign ${tabId} ${containerId}`);
      tabs.set(tabId, containerId);
      exemptions.markPlacement(tabId, containerId); // what Facet's tab-assigned event does
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
    expect(events).toEqual(['assign 1 work', 'navigate 1 https://gist.github.com/x']);
    expect(tabs.get(1)).toBe('work');
  });

  it('does not loop: the repeated navigation, and further ones on the site, are left alone', async () => {
    const { nav, events } = setup([always]);
    await nav(1, 'https://github.com/a');
    events.length = 0;
    expect(await nav(1, 'https://github.com/a')).toBe('skipped');
    expect(await nav(1, 'https://github.com/b')).toBe('skipped');
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
    expect(events[0]).toBe('assign 1 work');
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

  it('an explicit #ctr marker is left to the engine and exempts the repeated navigation', async () => {
    const { nav, events, tabs } = setup([always, ask]);
    tabs.set(1, 'home');
    expect(await nav(1, 'https://www.reddit.com/#ctr=work')).toBe('skipped');
    expect(events).toEqual([]);
    tabs.set(1, 'work'); // Facet assigned it and navigates to the clean URL
    expect(await nav(1, 'https://www.reddit.com/')).toBe('skipped');
    expect(events).toEqual([]);
    // A marker naming no container does nothing special.
    expect(await nav(2, 'https://www.reddit.com/#ctr=ghost')).toBe('skipped');
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
