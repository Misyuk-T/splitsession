import { describe, expect, it } from 'vitest';
import { CookieJar, compileGroupRules, type DnrRule } from '../../core';
import { RuleIdPool } from './id-pool';
import { SessionRuleManager, type DnrSessionApi, type KeyCompiler } from './session-rules';

class FakeDnr implements DnrSessionApi {
  rules = new Map<number, DnrRule>();
  calls: Array<{ removeRuleIds: number[]; addRules: DnrRule[] }> = [];
  failNext = false;
  limit = Infinity;

  async updateSessionRules({ removeRuleIds = [], addRules = [] }: { removeRuleIds?: number[]; addRules?: DnrRule[] }) {
    this.calls.push({ removeRuleIds: [...removeRuleIds], addRules: [...addRules] });
    if (this.failNext) {
      this.failNext = false;
      throw new Error('boom');
    }
    const next = new Map(this.rules);
    for (const id of removeRuleIds) next.delete(id);
    for (const rule of addRules) {
      if (next.has(rule.id)) throw new Error(`duplicate rule id ${rule.id}`);
      next.set(rule.id, rule);
    }
    if (next.size > this.limit) throw new Error('over limit');
    this.rules = next;
  }

  async getSessionRules() {
    return [...this.rules.values()];
  }
}

const manual = () => {
  const queue: Array<() => void> = [];
  return { schedule: (fn: () => void) => void queue.push(fn), flush: () => queue.splice(0).forEach((fn) => fn()) };
};

/** Compiler driven by a mutable map key -> tab IDs, one cookie per key so rules are recognisable. */
function setup(options: { regexBudget?: number; hardLimit?: number } = {}) {
  const dnr = new FakeDnr();
  const tabs = new Map<string, number[]>();
  const compile: KeyCompiler = (key, allocator, regexBudget) => {
    const tabIds = tabs.get(key);
    if (!tabIds?.length) return null;
    const jar = new CookieJar();
    jar.setFromHeader(`k=${key}`, { url: `http://${key}.localhost/` });
    return compileGroupRules({ tabIds, containerId: key, jar, regexBudget }, allocator);
  };
  const timer = manual();
  const manager = new SessionRuleManager(dnr, compile, { schedule: timer.schedule, ...options });
  return { dnr, tabs, manager, timer };
}

const tabsCovered = (dnr: FakeDnr) => new Set([...dnr.rules.values()].flatMap((r) => r.condition.tabIds ?? []));

describe('RuleIdPool', () => {
  it('hands out unique IDs and reuses released ones', () => {
    const pool = new RuleIdPool();
    const a = [pool.next(), pool.next(), pool.next()];
    expect(new Set(a).size).toBe(3);
    pool.release([a[1]!]);
    expect(pool.next()).toBe(a[1]);
    expect(pool.size).toBe(3);
  });

  it('reserve keeps IDs (and gaps below them) consistent', () => {
    const pool = new RuleIdPool();
    pool.reserve([5]);
    const issued = [pool.next(), pool.next(), pool.next(), pool.next(), pool.next()];
    expect(issued).not.toContain(5);
    expect(new Set(issued).size).toBe(5);
  });
});

describe('SessionRuleManager', () => {
  it('coalesces invalidations made before the flush into one updateSessionRules call', async () => {
    const { dnr, tabs, manager, timer } = setup();
    tabs.set('a', [1]);
    tabs.set('b', [2, 3]);
    const p1 = manager.invalidate('a');
    const p2 = manager.invalidate('b');
    const p3 = manager.invalidate('a');
    timer.flush();
    expect(await Promise.all([p1, p2, p3])).toEqual([true, true, true]);
    expect(dnr.calls).toHaveLength(1);
    expect(tabsCovered(dnr)).toEqual(new Set([1, 2, 3]));
  });

  it('replaces a key atomically: old IDs removed and new rules added in the same call', async () => {
    const { dnr, tabs, manager, timer } = setup();
    tabs.set('a', [1]);
    const first = manager.invalidate('a');
    timer.flush();
    await first;
    const oldIds = [...dnr.rules.keys()];
    tabs.set('a', [1, 4]);
    const second = manager.invalidate('a');
    timer.flush();
    await second;
    const last = dnr.calls.at(-1)!;
    expect(last.removeRuleIds.sort()).toEqual(oldIds.sort());
    expect(last.addRules.every((r) => r.condition.tabIds?.join() === '1,4')).toBe(true);
    expect(tabsCovered(dnr)).toEqual(new Set([1, 4]));
  });

  it('drops a key whose compiler returns null (no tabs left)', async () => {
    const { dnr, tabs, manager, timer } = setup();
    tabs.set('a', [1]);
    const p = manager.invalidate('a');
    timer.flush();
    await p;
    tabs.delete('a');
    const q = manager.invalidate('a');
    timer.flush();
    await q;
    expect(dnr.rules.size).toBe(0);
    expect(manager.isInstalled('a')).toBe(false);
  });

  it('serialises flushes: invalidations during a flush go into the next call', async () => {
    const { dnr, tabs, manager } = setup();
    // real scheduling here
    const m = new SessionRuleManager(dnr, (key, allocator, budget) => {
      const tabIds = tabs.get(key);
      return tabIds ? compileGroupRules({ tabIds, containerId: key, jar: new CookieJar(), regexBudget: budget }, allocator) : null;
    });
    void manager;
    tabs.set('a', [1]);
    tabs.set('b', [2]);
    const first = m.invalidate('a');
    await Promise.resolve();
    const second = m.invalidate('b');
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(tabsCovered(dnr)).toEqual(new Set([1, 2]));
    expect(await m.sync()).toBe(true);
  });

  it('keeps the old rules and reports failure when Chrome rejects the batch; IDs stay consistent', async () => {
    const { dnr, tabs, manager, timer } = setup();
    tabs.set('a', [1]);
    let p = manager.invalidate('a');
    timer.flush();
    await p;
    const before = new Map(dnr.rules);
    dnr.failNext = true;
    tabs.set('a', [1, 2]);
    p = manager.invalidate('a');
    timer.flush();
    expect(await p).toBe(false);
    expect(dnr.rules).toEqual(before);
    // The next successful flush must not collide with the IDs still installed.
    tabs.set('b', [3]);
    p = manager.invalidate('a', 'b');
    timer.flush();
    expect(await p).toBe(true);
    expect(tabsCovered(dnr)).toEqual(new Set([1, 2, 3]));
  });

  it('refuses batches above the hard limit instead of half-installing them', async () => {
    const { dnr, tabs, manager, timer } = setup({ hardLimit: 5 });
    tabs.set('a', [1]);
    let p = manager.invalidate('a');
    timer.flush();
    expect(await p).toBe(true); // catch-all + exact + beacon + site beacon = 4
    tabs.set('b', [2]);
    p = manager.invalidate('b');
    timer.flush();
    expect(await p).toBe(false);
    expect(manager.isInstalled('b')).toBe(false);
    expect(tabsCovered(dnr)).toEqual(new Set([1]));
  });

  it('shares one regex budget across keys', async () => {
    const { dnr, tabs, manager, timer } = setup({ regexBudget: 1 });
    tabs.set('a', [1]);
    tabs.set('b', [2]);
    const p = manager.invalidate('a', 'b');
    timer.flush();
    await p;
    expect([...dnr.rules.values()].filter((r) => r.condition.regexFilter !== undefined)).toHaveLength(1);
    expect(manager.stats().regexRules).toBe(1);
  });

  it('reset() drops every existing session rule (whoever made it) and installs fresh ones in one call', async () => {
    const { dnr, tabs, manager, timer } = setup();
    await dnr.updateSessionRules({ addRules: [{ id: 1, priority: 1, condition: { resourceTypes: ['main_frame'] }, action: { type: 'modifyHeaders' } }] });
    dnr.calls = [];
    tabs.set('a', [7]);
    const p = manager.reset(['a']);
    await Promise.resolve();
    await Promise.resolve();
    timer.flush();
    expect(await p).toBe(true);
    expect(dnr.calls).toHaveLength(1);
    expect(dnr.calls[0]!.removeRuleIds).toEqual([1]);
    expect(tabsCovered(dnr)).toEqual(new Set([7]));
  });
});
