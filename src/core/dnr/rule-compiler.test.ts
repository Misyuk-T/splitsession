import { describe, expect, it } from 'vitest';
import { CookieJar } from '../jar/cookie-jar';
import type { BeaconPayload } from '../types';
import {
  ALL_RESOURCE_TYPES,
  BEACON_COOKIE_BYTE_LIMIT,
  BEACON_PRIORITY,
  BEACON_URL_FILTER,
  CATCH_ALL_PRIORITY,
  compileTabRules,
  createSequentialAllocator,
  hostRulePriority,
  isOverSoftLimit,
  SESSION_RULE_HARD_LIMIT,
  SESSION_RULE_SOFT_LIMIT,
  totalRuleCount,
  type DnrRule,
  type RuleIdAllocator,
} from './rule-compiler';

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const TAB = 42;

function jarFrom(entries: [url: string, ...headers: string[]][], topLevelSite?: string): CookieJar {
  const jar = new CookieJar();
  for (const [url, ...headers] of entries) {
    for (const header of headers) {
      const { parsed } = jar.setFromHeader(header, { url, now: NOW, topLevelSite });
      if (!parsed.ok) throw new Error(`"${header}" rejected: ${parsed.reason}`);
    }
  }
  return jar;
}

function compile(jar: CookieJar, extra: { topLevelSite?: string | null; tabId?: number; containerId?: string } = {}) {
  return compileTabRules(
    { tabId: extra.tabId ?? TAB, containerId: extra.containerId ?? 'alt', jar, topLevelSite: extra.topLevelSite, now: NOW },
    createSequentialAllocator(),
  );
}

const requestCookieOp = (rule: DnrRule) =>
  rule.action.type === 'modifyHeaders' ? rule.action.requestHeaders?.find((h) => h.header === 'cookie') : undefined;
const forHost = (rules: DnrRule[], host: string, scheme: 'any' | 'http' = 'any') =>
  rules.find(
    (r) =>
      r.condition.requestDomains?.[0] === host &&
      r.action.type === 'modifyHeaders' &&
      (scheme === 'http' ? r.condition.urlFilter === '|http://' : r.condition.urlFilter === undefined),
  );
const beaconOf = (rules: DnrRule[]) => {
  const rule = rules.find((r) => r.action.type === 'redirect');
  if (!rule || rule.action.type !== 'redirect') throw new Error('no beacon rule');
  const url = rule.action.redirect.url;
  const prefix = 'data:application/json,';
  expect(url.startsWith(prefix)).toBe(true);
  return { rule, payload: JSON.parse(decodeURIComponent(url.slice(prefix.length))) as BeaconPayload };
};

/** Two hosts of the e2e stand: plain http on a trustworthy .localhost origin. */
const localJar = () =>
  jarFrom([
    ['http://a.localhost:3000/', 'sid=aaa; HttpOnly; Path=/', 'theme=dark; Domain=a.localhost'],
    ['http://sso.localhost:3000/', 'sso=zzz; Path=/'],
  ]);

describe('every rule', () => {
  const jars: [string, CookieJar][] = [
    ['an empty jar', new CookieJar()],
    ['a localhost jar', localJar()],
    [
      'an https jar with Secure cookies and a subdomain',
      jarFrom([
        ['https://example.com/', 'sid=1; Secure; HttpOnly; Path=/', 'wide=2; Domain=example.com'],
        ['https://www.example.com/', 'host=3; Secure; Path=/'],
      ]),
    ],
  ];

  it.each(jars)('scopes to the tab and lists every resource type including main_frame (%s)', (_label, jar) => {
    const { addRules } = compile(jar);
    expect(addRules.length).toBeGreaterThanOrEqual(2);
    for (const rule of addRules) {
      expect(rule.condition.tabIds).toEqual([TAB]);
      expect(rule.condition.resourceTypes).toContain('main_frame');
      expect(rule.condition.resourceTypes).toEqual([...ALL_RESOURCE_TYPES]);
    }
  });

  it('lists the resource types from the plan, nothing missing', () => {
    expect([...ALL_RESOURCE_TYPES].sort()).toEqual(
      [
        'main_frame', 'sub_frame', 'xmlhttprequest', 'websocket', 'script', 'stylesheet', 'image', 'font',
        'media', 'ping', 'csp_report', 'object', 'webtransport', 'webbundle', 'other',
      ].sort(),
    );
  });

  it('does not share resourceTypes arrays between rules', () => {
    const { addRules } = compile(localJar());
    addRules[0]!.condition.resourceTypes.pop();
    expect(addRules[1]!.condition.resourceTypes).toHaveLength(ALL_RESOURCE_TYPES.length);
  });

  it('refuses tab IDs that would match requests outside tabs', () => {
    expect(() => compile(localJar(), { tabId: -1 })).toThrow(RangeError);
    expect(() => compile(localJar(), { tabId: 1.5 })).toThrow(RangeError);
    expect(() => compile(localJar(), { tabId: Number.NaN })).toThrow(RangeError);
  });
});

describe('catch-all rule', () => {
  it('comes first, at priority 1, and strips request cookies and response Set-Cookie', () => {
    const { addRules } = compile(localJar());
    expect(addRules[0]).toEqual({
      id: 1,
      priority: CATCH_ALL_PRIORITY,
      condition: { tabIds: [TAB], resourceTypes: [...ALL_RESOURCE_TYPES] },
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'cookie', operation: 'remove' }],
        responseHeaders: [{ header: 'set-cookie', operation: 'remove' }],
      },
    });
    expect(CATCH_ALL_PRIORITY).toBe(1);
  });

  it('is emitted even for an empty jar, together with the beacon', () => {
    const { addRules } = compile(new CookieJar());
    expect(addRules.map((r) => r.priority)).toEqual([CATCH_ALL_PRIORITY, BEACON_PRIORITY]);
  });
});

describe('per-host rules', () => {
  it('emits one rule per host that has cookies, scoped by requestDomains', () => {
    const { addRules } = compile(localJar());
    const hostRules = addRules.filter((r) => r.condition.requestDomains);
    expect(hostRules.map((r) => r.condition.requestDomains)).toEqual([['a.localhost'], ['sso.localhost']]);
  });

  it('sets the serialized Cookie header, HttpOnly cookies included, and strips Set-Cookie', () => {
    const { addRules } = compile(localJar());
    const rule = forHost(addRules, 'a.localhost')!;
    expect(rule.action).toEqual({
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'cookie', operation: 'set', value: 'sid=aaa; theme=dark' }],
      responseHeaders: [{ header: 'set-cookie', operation: 'remove' }],
    });
    expect(requestCookieOp(forHost(addRules, 'sso.localhost')!)?.value).toBe('sso=zzz');
  });

  it('priority is 10 + number of labels, so the longer host wins', () => {
    expect(hostRulePriority('example.com')).toBe(12);
    expect(hostRulePriority('www.example.com')).toBe(13);
    expect(hostRulePriority('localhost')).toBe(11);

    const jar = jarFrom([
      ['https://example.com/', 'a=1; Domain=example.com'],
      ['https://www.example.com/', 'b=2'],
      ['https://deep.www.example.com/', 'c=3'],
    ]);
    const { addRules } = compile(jar);
    const priority = (host: string) => forHost(addRules, host)!.priority;
    expect(priority('example.com')).toBe(12);
    expect(priority('www.example.com')).toBe(13);
    expect(priority('deep.www.example.com')).toBe(14);
    expect(priority('deep.www.example.com')).toBeGreaterThan(priority('www.example.com'));
    expect(priority('www.example.com')).toBeGreaterThan(priority('example.com'));
    expect(priority('example.com')).toBeGreaterThan(CATCH_ALL_PRIORITY);
  });

  it("a subdomain's rule repeats the parent's domain cookies and adds its own host-only ones", () => {
    const jar = jarFrom([
      ['https://example.com/', 'wide=1; Domain=example.com; Secure'],
      ['https://www.example.com/', 'host=2; Secure'],
    ]);
    const { addRules } = compile(jar);
    expect(requestCookieOp(forHost(addRules, 'example.com')!)?.value).toBe('wide=1');
    expect(requestCookieOp(forHost(addRules, 'www.example.com')!)?.value).toBe('wide=1; host=2');
  });

  it('keeps jars of different containers apart (no cookies from another jar)', () => {
    const alt = compile(jarFrom([['http://a.localhost/', 'who=alt']]), { containerId: 'alt' });
    const work = compile(jarFrom([['http://a.localhost/', 'who=work']]), { containerId: 'work', tabId: 7 });
    expect(requestCookieOp(forHost(alt.addRules, 'a.localhost')!)?.value).toBe('who=alt');
    expect(requestCookieOp(forHost(work.addRules, 'a.localhost')!)?.value).toBe('who=work');
    expect(work.addRules.every((r) => r.condition.tabIds[0] === 7)).toBe(true);
  });

  it('skips hosts whose cookies are all expired and never emits an empty Cookie value', () => {
    const jar = new CookieJar();
    jar.setFromHeader('old=1; Max-Age=60', { url: 'http://a.localhost/', now: NOW - 3600_000 });
    jar.setFromHeader('live=1', { url: 'http://sso.localhost/', now: NOW });
    const { addRules } = compile(jar);
    expect(forHost(addRules, 'a.localhost')).toBeUndefined();
    expect(forHost(addRules, 'sso.localhost')).toBeDefined();
    for (const rule of addRules) expect(requestCookieOp(rule)?.value).not.toBe('');
  });

  it('only includes partitioned cookies of the tab’s top-level site', () => {
    const jar = jarFrom(
      [['https://widget.test/', 'plain=1; Secure', 'chips=2; Secure; Partitioned']],
      'https://news.example',
    );
    const value = (site: string | null) =>
      requestCookieOp(forHost(compile(jar, { topLevelSite: site }).addRules, 'widget.test')!)?.value;
    expect(value('https://news.example')).toBe('plain=1; chips=2');
    expect(value('https://other.example')).toBe('plain=1');
    expect(value(null)).toBe('plain=1');
  });

  it('drops a host entirely when only foreign-partition cookies remain', () => {
    const jar = jarFrom([['https://widget.test/', 'chips=2; Secure; Partitioned']], 'https://news.example');
    const { addRules } = compile(jar, { topLevelSite: 'https://other.example' });
    expect(forHost(addRules, 'widget.test')).toBeUndefined();
  });
});

describe('Secure cookies on plain http', () => {
  const secureJar = () =>
    jarFrom([
      ['https://example.com/', 'sid=1; Secure; HttpOnly', 'pref=2; Domain=example.com'],
      ['https://www.example.com/', 'host=3'],
    ]);

  it('gives the main rule all cookies and adds an http-only rule without the Secure ones', () => {
    const { addRules } = compile(secureJar());
    expect(requestCookieOp(forHost(addRules, 'example.com')!)?.value).toBe('sid=1; pref=2');
    const http = forHost(addRules, 'example.com', 'http')!;
    expect(http.condition.urlFilter).toBe('|http://');
    expect(http.priority).toBe(102);
    expect(requestCookieOp(http)).toEqual({ header: 'cookie', operation: 'set', value: 'pref=2' });
    expect(http.action).toMatchObject({ responseHeaders: [{ header: 'set-cookie', operation: 'remove' }] });
    expect(http.priority).toBeGreaterThan(forHost(addRules, 'example.com')!.priority);
  });

  it('removes the Cookie header on http when nothing but Secure cookies apply', () => {
    const { addRules } = compile(jarFrom([['https://example.com/', 'sid=1; Secure']]));
    expect(requestCookieOp(forHost(addRules, 'example.com', 'http')!)).toEqual({ header: 'cookie', operation: 'remove' });
  });

  it('gives subdomains of such a host their own http rule so the parent rule cannot shadow them', () => {
    const { addRules } = compile(secureJar());
    const http = forHost(addRules, 'www.example.com', 'http')!;
    expect(requestCookieOp(http)?.value).toBe('pref=2; host=3');
    expect(http.priority).toBe(103);
    expect(http.priority).toBeGreaterThan(forHost(addRules, 'example.com', 'http')!.priority);
  });

  it('adds no http rules when no Secure cookie applies, nor on trustworthy localhost hosts', () => {
    const plain = compile(jarFrom([['https://example.com/', 'a=1']]));
    expect(plain.addRules.filter((r) => r.condition.urlFilter === '|http://')).toHaveLength(0);

    const local = compile(jarFrom([['http://a.localhost/', 'sec=1; Secure']]));
    expect(local.addRules.filter((r) => r.condition.urlFilter === '|http://')).toHaveLength(0);
    expect(requestCookieOp(forHost(local.addRules, 'a.localhost')!)?.value).toBe('sec=1');
  });
});

describe('beacon rule', () => {
  it('redirects the sentinel URL for this tab only, above every other rule', () => {
    const { addRules } = compile(localJar());
    const { rule } = beaconOf(addRules);
    expect(rule.priority).toBe(BEACON_PRIORITY);
    expect(rule.priority).toBeGreaterThan(Math.max(...addRules.filter((r) => r !== rule).map((r) => r.priority)));
    expect(rule.condition).toEqual({
      tabIds: [TAB],
      resourceTypes: [...ALL_RESOURCE_TYPES],
      urlFilter: BEACON_URL_FILTER,
    });
    expect(BEACON_URL_FILTER).toBe('|http://ctr.localhost/whoami^');
    expect(addRules.at(-1)).toBe(rule);
    expect(addRules.filter((r) => r.action.type === 'redirect')).toHaveLength(1);
  });

  it('is per tab, not per host: one rule however many hosts the jar has', () => {
    const many = jarFrom(
      Array.from({ length: 12 }, (_, i): [string, string] => [`http://h${i}.localhost/`, `c${i}=1`]),
    );
    expect(compile(many).addRules.filter((r) => r.action.type === 'redirect')).toHaveLength(1);
  });

  it('answers with a data: URL whose JSON names the container', () => {
    const { rule, payload } = beaconOf(compile(new CookieJar(), { containerId: 'work' }).addRules);
    expect(rule.action).toMatchObject({ type: 'redirect' });
    expect(payload).toEqual({ c: 'work', k: [], s: null });
  });

  it('survives awkward container IDs through URL encoding', () => {
    const id = 'a b"c%d,é#';
    expect(beaconOf(compile(new CookieJar(), { containerId: id }).addRules).payload.c).toBe(id);
  });

  it('carries the non-HttpOnly cookie snapshot, never HttpOnly values', () => {
    const { rule, payload } = beaconOf(compile(localJar()).addRules);
    expect(payload.k?.map((c) => `${c.domain}:${c.name}=${c.value}`).sort()).toEqual([
      'a.localhost:theme=dark',
      'sso.localhost:sso=zzz',
    ]);
    expect(rule.action.type === 'redirect' && rule.action.redirect.url).not.toContain('aaa'); // HttpOnly sid value
  });

  it('lets the shim rebuild document.cookie from the payload with the core jar', () => {
    const { payload } = beaconOf(compile(localJar()).addRules);
    const shimJar = new CookieJar(payload.k);
    expect(shimJar.documentCookieString('a.localhost', { secure: true, now: NOW })).toBe('theme=dark');
    expect(shimJar.documentCookieString('sso.localhost', { secure: true, now: NOW })).toBe('sso=zzz');
  });

  it('snapshots only partitioned cookies of the tab’s top-level site and records that site', () => {
    const jar = jarFrom(
      [['https://widget.test/', 'plain=1; Secure', 'chips=2; Secure; Partitioned']],
      'https://news.example',
    );
    const mine = beaconOf(compile(jar, { topLevelSite: 'https://news.example' }).addRules).payload;
    expect(mine.s).toBe('https://news.example');
    expect(mine.k?.map((c) => c.name).sort()).toEqual(['chips', 'plain']);
    const other = beaconOf(compile(jar, { topLevelSite: 'https://other.example' }).addRules).payload;
    expect(other.k?.map((c) => c.name)).toEqual(['plain']);
  });

  it('drops the snapshot and flags overflow beyond the size cap', () => {
    const jar = new CookieJar();
    const url = 'http://a.localhost/';
    const filler = 'x'.repeat(3000);
    const copies = Math.ceil(BEACON_COOKIE_BYTE_LIMIT / 3000) + 5;
    for (let i = 0; i < copies; i++) jar.setFromHeader(`c${i}=${filler}`, { url, now: NOW });
    expect(beaconOf(compile(jar).addRules).payload).toEqual({ c: 'alt', o: 1 });
  });
});

describe('rule IDs and limits', () => {
  it('draws IDs from the injected allocator, in rule order, and reports them', () => {
    const issued: number[] = [];
    let next = 500;
    const allocator: RuleIdAllocator = {
      next: () => {
        issued.push(next);
        return next++;
      },
    };
    const result = compileTabRules({ tabId: TAB, containerId: 'alt', jar: localJar(), now: NOW }, allocator);
    expect(result.ruleIds).toEqual(issued);
    expect(result.addRules.map((r) => r.id)).toEqual(issued);
    expect(result.ruleIds[0]).toBe(500);
    expect(new Set(result.ruleIds).size).toBe(result.ruleIds.length);
  });

  it('never reuses IDs across tabs sharing one allocator', () => {
    const allocator = createSequentialAllocator(10);
    const jar = localJar();
    const a = compileTabRules({ tabId: 1, containerId: 'alt', jar, now: NOW }, allocator);
    const b = compileTabRules({ tabId: 2, containerId: 'alt', jar, now: NOW }, allocator);
    const all = [...a.ruleIds, ...b.ruleIds];
    expect(new Set(all).size).toBe(all.length);
    expect(Math.min(...b.ruleIds)).toBeGreaterThan(Math.max(...a.ruleIds));
  });

  it('totalRuleCount sums rules over tabs; the soft limit sits below Chrome’s 5000', () => {
    const allocator = createSequentialAllocator();
    const tabs = [1, 2, 3].map((tabId) => compileTabRules({ tabId, containerId: 'alt', jar: localJar(), now: NOW }, allocator));
    // catch-all + 2 hosts + beacon, per tab
    expect(totalRuleCount(tabs)).toBe(12);
    expect(totalRuleCount([])).toBe(0);

    expect(SESSION_RULE_SOFT_LIMIT).toBe(4000);
    expect(SESSION_RULE_SOFT_LIMIT).toBeLessThan(SESSION_RULE_HARD_LIMIT);
    expect(isOverSoftLimit(SESSION_RULE_SOFT_LIMIT)).toBe(false);
    expect(isOverSoftLimit(SESSION_RULE_SOFT_LIMIT + 1)).toBe(true);
  });
});
