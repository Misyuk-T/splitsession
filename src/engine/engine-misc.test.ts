import { describe, expect, it } from 'vitest';
import { MANAGED_BEACON_PRIORITY } from '../core';
import { networkOrigin, setCookieHeaders } from './capture/headers';
import { CONTENT_SCRIPTS, ensureContentScripts, type RegisteredScript, type ScriptingApi } from './content-scripts';
import { MemoryStorageArea } from './storage/storage-area';
import { MANAGED_BEACON_RULE_ID, MANAGED_SITES_KEY, ServiceWorkerPolicy } from './sw-policy';

describe('setCookieHeaders', () => {
  it('collects every Set-Cookie (case-insensitive), decodes binary values, never splits on commas', () => {
    expect(
      setCookieHeaders([
        { name: 'Set-Cookie', value: 'a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT' },
        { name: 'content-type', value: 'text/html' },
        { name: 'set-cookie', binaryValue: [98, 61, 233] },
        { name: 'SET-COOKIE', value: 'c=3\nd=4' },
        { name: 'set-cookie', value: '   ' },
      ]),
    ).toEqual(['a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT', 'b=é', 'c=3', 'd=4']);
    expect(setCookieHeaders(undefined)).toEqual([]);
  });

  it('networkOrigin only accepts http(s)', () => {
    expect(networkOrigin('http://a.localhost:3000/x?y')).toBe('http://a.localhost:3000');
    expect(networkOrigin('about:blank')).toBeNull();
    expect(networkOrigin('chrome-extension://abc/open.html')).toBeNull();
    expect(networkOrigin(undefined)).toBeNull();
  });
});

class FakeScripting implements ScriptingApi {
  registered: RegisteredScript[] = [];
  calls: string[] = [];
  async getRegisteredContentScripts(filter?: { ids?: string[] }) {
    return this.registered.filter((s) => !filter?.ids || filter.ids.includes(s.id));
  }
  async registerContentScripts(scripts: RegisteredScript[]) {
    this.calls.push(`register ${scripts.map((s) => s.id).join(',')}`);
    for (const s of scripts) {
      if (this.registered.some((r) => r.id === s.id)) throw new Error('duplicate');
      this.registered.push(s);
    }
  }
  async unregisterContentScripts(filter?: { ids?: string[] }) {
    this.calls.push(`unregister ${filter?.ids?.join(',')}`);
    this.registered = this.registered.filter((s) => !filter?.ids?.includes(s.id));
  }
}

describe('ensureContentScripts', () => {
  it('registers the ISOLATED beacon before the MAIN shim, at document_start in every frame', async () => {
    const scripting = new FakeScripting();
    expect(await ensureContentScripts(scripting)).toBe('registered');
    expect(scripting.registered.map((s) => [s.id, s.world, s.runAt, s.allFrames, s.matchOriginAsFallback])).toEqual([
      ['facet-beacon', 'ISOLATED', 'document_start', true, true],
      ['facet-shim', 'MAIN', 'document_start', true, true],
    ]);
  });

  it('is idempotent and repairs a stale registration', async () => {
    const scripting = new FakeScripting();
    await ensureContentScripts(scripting);
    expect(await ensureContentScripts(scripting)).toBe('unchanged');
    scripting.registered[1] = { ...scripting.registered[1]!, matches: ['https://example.com/*'] };
    expect(await ensureContentScripts(scripting)).toBe('registered');
    expect(scripting.registered.map((s) => s.matches)).toEqual(CONTENT_SCRIPTS.map((s) => s.matches));
    expect(scripting.calls.at(-2)).toBe('unregister facet-beacon,facet-shim');
  });
});

describe('ServiceWorkerPolicy', () => {
  const setup = () => {
    const area = new MemoryStorageArea();
    const dynamic: Array<{ removeRuleIds?: number[]; addRules?: unknown[] }> = [];
    const removals: string[] = [];
    let now = 1_000;
    const policy = new ServiceWorkerPolicy(
      area,
      { updateDynamicRules: async (o) => void dynamic.push(o) },
      { remove: async ({ origins }) => void removals.push(...origins) },
      { now: () => now, removalThrottleMs: 30_000 },
    );
    return { area, dynamic, removals, policy, tick: (ms: number) => (now += ms) };
  };

  it('marks sites managed, removes their service workers (throttled) and publishes the {m:1} rule', async () => {
    const { area, dynamic, removals, policy, tick } = setup();
    await policy.load();
    expect(dynamic.at(-1)).toEqual({ removeRuleIds: [MANAGED_BEACON_RULE_ID], addRules: [] });
    await policy.noteContainerOrigin('http://sub.a.localhost:3000');
    await policy.noteContainerOrigin('http://sub.a.localhost:3000');
    await policy.noteContainerOrigin('https://www.example.com');
    await policy.noteContainerOrigin('chrome-extension://x');
    expect(removals).toEqual(['http://sub.a.localhost:3000', 'https://www.example.com']);
    tick(31_000);
    await policy.noteContainerOrigin('http://sub.a.localhost:3000');
    expect(removals).toHaveLength(3);
    await policy.settle();
    const rule = dynamic.at(-1)!.addRules![0] as { priority: number; condition: { initiatorDomains: string[] } };
    expect(rule.priority).toBe(MANAGED_BEACON_PRIORITY);
    expect(rule.condition.initiatorDomains).toEqual(['a.localhost', 'example.com']);
    expect(area.data.get(MANAGED_SITES_KEY)).toEqual(['a.localhost', 'example.com']);
    expect(policy.isManaged('x.example.com')).toBe(true);
    expect(policy.isManaged('other.test')).toBe(false);
  });
});
