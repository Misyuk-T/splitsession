import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContentScriptLifecycle, managedSiteMatches, type ContentScriptLifecycleDeps, type RegisteredScript } from './content-scripts';

/** chrome.scripting stand-in that also records the beacon-rule switches, in one ordered log. */
class World {
  registered: RegisteredScript[] = [];
  beacon = true;
  log: string[] = [];
  tabs = 0;
  waiting = 0;
  starting = false;
  get inUse(): boolean {
    return this.tabs > 0;
  }
  set inUse(on: boolean) {
    this.tabs = on ? 1 : 0;
  }
  sites: string[] = [];

  scripting: ContentScriptLifecycleDeps['scripting'] = {
    getRegisteredContentScripts: async (filter) => this.registered.filter((s) => !filter?.ids || filter.ids.includes(s.id)).map((s) => ({ ...s })),
    registerContentScripts: async (scripts) => {
      this.log.push(`register ${scripts.map((s) => s.id).join(',')} ${scripts[0]!.matches.join(' ')}`);
      for (const s of scripts) {
        if (this.registered.some((r) => r.id === s.id)) throw new Error('duplicate');
        this.registered.push({ ...s });
      }
    },
    unregisterContentScripts: async (filter) => {
      this.log.push('unregister');
      this.registered = this.registered.filter((s) => !filter?.ids?.includes(s.id));
    },
    updateContentScripts: async (scripts) => {
      this.log.push(`update ${scripts[0]!.matches.join(' ')}`);
      for (const u of scripts) {
        const s = this.registered.find((r) => r.id === u.id);
        if (!s) throw new Error(`no script ${u.id}`);
        s.matches = [...u.matches];
      }
    },
  };

  lifecycle(options: Partial<ContentScriptLifecycleDeps> = {}): ContentScriptLifecycle {
    return new ContentScriptLifecycle({
      scripting: this.scripting,
      setBeaconRules: async (on) => {
        this.log.push(`beacon ${on ? 'on' : 'off'}`);
        this.beacon = on;
      },
      usage: () => ({ tabs: this.tabs, waiting: this.waiting, starting: this.starting }),
      managedSites: () => this.sites,
      graceMs: 30_000,
      lingerMs: 2_000,
      ...options,
    });
  }

  matches(): string[] | null {
    return this.registered.length === 2 ? this.registered[0]!.matches : this.registered.length === 0 ? null : ['partial'];
  }
}

/** Lets queued promise chains run (fake timers do not advance microtasks by themselves). */
const drain = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('managedSiteMatches', () => {
  it('covers each site and its subdomains, any scheme and port; IP literals exactly; unwritable hosts give null', () => {
    expect(managedSiteMatches(['b.localhost', 'example.co.uk'])).toEqual(['*://b.localhost/*', '*://*.b.localhost/*', '*://example.co.uk/*', '*://*.example.co.uk/*']);
    expect(managedSiteMatches(['10.0.0.7'])).toEqual(['*://10.0.0.7/*']);
    expect(managedSiteMatches(['[::1]'])).toBeNull();
    expect(managedSiteMatches([])).toEqual([]);
  });
});

describe('ContentScriptLifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a profile without containers: nothing registered, no beacon answers', async () => {
    const w = new World();
    const life = w.lifecycle();
    expect(await life.readRegistered()).toBe('off');
    expect(life.beaconRules).toBe(false);
    await life.start();
    expect(w.registered).toEqual([]);
    expect(w.beacon).toBe(false);
    expect(life.status()).toMatchObject({ scope: 'off', wanted: 'off', beaconRules: false });
  });

  it('ensure(): the beacon answers first, then both scripts for every frame (beacon before shim); free once registered', async () => {
    const w = new World();
    const life = w.lifecycle();
    await life.readRegistered();
    await life.start();
    w.log = [];
    await life.ensure();
    expect(w.log).toEqual(['beacon on', 'register facet-beacon,facet-shim <all_urls>']);
    expect(w.registered.map((s) => [s.id, s.world, s.runAt, s.allFrames, s.matchOriginAsFallback, s.persistAcrossSessions])).toEqual([
      ['facet-beacon', 'ISOLATED', 'document_start', true, true, true],
      ['facet-shim', 'MAIN', 'document_start', true, true, true],
    ]);
    w.inUse = true;
    await life.ensure();
    await life.ensure();
    expect(w.log).toHaveLength(2);
  });

  it('the last container tab gone: unregistered after the grace period, the answers a moment later', async () => {
    const w = new World();
    const life = w.lifecycle();
    await life.readRegistered();
    await life.start();
    w.inUse = true;
    await life.ensure();
    w.log = [];
    w.inUse = false;
    life.changed();
    expect(life.status().graceUntil).not.toBeNull();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(w.matches()).toEqual(['<all_urls>']);
    await vi.advanceTimersByTimeAsync(1_000);
    await drain();
    expect(w.matches()).toBeNull();
    expect(w.beacon).toBe(true); // a document that started just before may still ask
    await vi.advanceTimersByTimeAsync(2_000);
    await drain();
    expect(w.log).toEqual(['unregister', 'beacon off']);
    expect(life.status()).toMatchObject({ scope: 'off', beaconRules: false, graceUntil: null });
  });

  it('a container tab back within the grace period cancels it (no flapping)', async () => {
    const w = new World();
    const life = w.lifecycle();
    await life.readRegistered();
    await life.start();
    w.inUse = true;
    await life.ensure();
    w.log = [];
    w.inUse = false;
    life.changed();
    await vi.advanceTimersByTimeAsync(10_000);
    w.inUse = true;
    life.changed();
    expect(life.status().graceUntil).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    await drain();
    expect(w.log).toEqual([]);
    // Also through ensure() (a new assignment) while the tab count is still zero.
    w.inUse = false;
    life.changed();
    await vi.advanceTimersByTimeAsync(10_000);
    const release = life.hold();
    await life.ensure();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.matches()).toEqual(['<all_urls>']);
    w.inUse = true;
    release();
    expect(w.log).toEqual([]);
  });

  it('with managed sites, the scope narrows to them instead of going off; their set changing re-registers', async () => {
    const w = new World();
    w.sites = ['a.localhost'];
    const life = w.lifecycle();
    await life.readRegistered();
    await life.start();
    expect(w.log).toEqual(['beacon on', 'register facet-beacon,facet-shim *://a.localhost/* *://*.a.localhost/*', 'beacon on']);
    expect(life.status()).toMatchObject({ scope: 'managed', wanted: 'managed', beaconRules: true, matches: 2 });
    w.log = [];
    await life.ensure();
    expect(w.log).toEqual(['update <all_urls>']);
    w.sites = ['a.localhost', 'b.localhost'];
    life.changed();
    await vi.advanceTimersByTimeAsync(30_000);
    await drain();
    expect(w.log).toEqual(['update <all_urls>', 'update *://a.localhost/* *://*.a.localhost/* *://b.localhost/* *://*.b.localhost/*']);
    expect(w.beacon).toBe(true);
  });

  it('a managed site that cannot be written as a pattern keeps <all_urls> (the safe side)', async () => {
    const w = new World();
    w.sites = ['[::1]'];
    const life = w.lifecycle();
    await life.readRegistered();
    await life.start();
    expect(w.matches()).toEqual(['<all_urls>']);
  });

  it('worker start: a scope nothing needs any more goes down at once; registration left by an older version is redone', async () => {
    const w = new World();
    const first = w.lifecycle();
    await first.readRegistered();
    await first.start();
    await first.ensure();
    expect(w.matches()).toEqual(['<all_urls>']);
    // The worker stops, the last container tab is gone by the next start.
    const second = w.lifecycle();
    expect(await second.readRegistered()).toBe('all');
    expect(second.beaconRules).toBe(true);
    w.log = [];
    await second.start();
    expect(w.log).toEqual(['unregister', 'beacon off', 'beacon off']);
    // An older registration (other matches): registered afresh, exactly as wanted.
    w.registered = [{ ...w.registered[0]!, id: 'facet-beacon', js: ['beacon.js'], matches: ['https://old.example/*'], runAt: 'document_start', allFrames: true, matchOriginAsFallback: true, world: 'ISOLATED', persistAcrossSessions: true }];
    w.sites = ['a.localhost'];
    const third = w.lifecycle();
    expect(await third.readRegistered()).toBe('managed');
    await third.start();
    expect(w.matches()).toEqual(['*://a.localhost/*', '*://*.a.localhost/*']);
  });

  it('restore busy or an assignment under way counts as in use; a pending downgrade never lowers what ensure() asked', async () => {
    const w = new World();
    const life = w.lifecycle({ graceMs: 0 });
    await life.readRegistered();
    await life.start();
    const release = life.hold();
    expect(life.wanted()).toBe('all');
    life.changed();
    await drain();
    expect(w.matches()).toEqual(['<all_urls>']);
    release();
    await vi.advanceTimersByTimeAsync(0);
    await drain();
    expect(w.matches()).toBeNull();
    // A downgrade queued (the grace timer fired), then an assignment right behind it: the downgrade re-reads what is
    // wanted when its turn comes and keeps `all`.
    await life.ensure();
    await drain();
    w.log = [];
    life.changed();
    vi.advanceTimersByTime(0); // fires the grace timer; its work waits in the queue
    const assignment = life.hold();
    await life.ensure();
    await drain();
    expect(w.matches()).toEqual(['<all_urls>']);
    expect(w.log).not.toContain('unregister');
    w.inUse = true; // the tab is in its container now
    assignment();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.matches()).toEqual(['<all_urls>']);
  });

  it('only open things keep `all`: tabs, tabs the restore waits on, a move under way; reasons say which; a waiting tab decided later lets it go down', async () => {
    const w = new World();
    w.sites = ['a.localhost'];
    const life = w.lifecycle();
    await life.readRegistered();
    await life.start();
    expect(life.status()).toMatchObject({ scope: 'managed', wanted: 'managed', reason: { kind: 'sites', count: 1 }, sites: 1 });
    // Records of closed tabs and groups are not part of the usage at all: nothing to hold the scope up.
    w.waiting = 2;
    life.changed();
    await drain();
    expect(life.status()).toMatchObject({ scope: 'all', wanted: 'all', reason: { kind: 'waiting', count: 2 } });
    w.waiting = 0; // decided (the restore calls changed() when it is)
    life.changed();
    expect(life.status()).toMatchObject({ scope: 'all', wanted: 'managed' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(life.status()).toMatchObject({ scope: 'managed', reason: { kind: 'sites', count: 1 } });
    w.tabs = 3;
    life.changed();
    await drain();
    expect(life.status()).toMatchObject({ scope: 'all', reason: { kind: 'tabs', count: 3 } });
    w.tabs = 0;
    w.starting = true;
    expect(life.reason()).toEqual({ kind: 'starting' });
    w.starting = false;
    const release = life.hold();
    expect(life.reason()).toEqual({ kind: 'moving', count: 1 });
    release();
  });

  it('a registration change that failed is tried again, and the status says so', async () => {
    const w = new World();
    const life = w.lifecycle();
    await life.readRegistered();
    await life.start();
    await life.ensure();
    await life.flush();
    expect(w.matches()).toBeNull();
    await life.ensure();
    expect(w.matches()).toEqual(['<all_urls>']);
    const real = w.scripting.unregisterContentScripts;
    w.scripting.unregisterContentScripts = async () => {
      throw new Error('chrome said no');
    };
    life.changed();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(life.status()).toMatchObject({ scope: 'all', wanted: 'off', error: expect.stringContaining('chrome said no') });
    w.scripting.unregisterContentScripts = real;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(life.status()).toMatchObject({ scope: 'off', error: null });
  });

  it('flush() applies the wanted scope without waiting for the grace period, answers included', async () => {
    const w = new World();
    const life = w.lifecycle();
    await life.readRegistered();
    await life.start();
    await life.ensure();
    await life.flush();
    expect(life.status()).toMatchObject({ scope: 'off', beaconRules: false });
    expect(w.beacon).toBe(false);
  });
});
