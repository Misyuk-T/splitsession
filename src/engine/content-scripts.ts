import { isIpHost } from '../core/site';

/**
 * Runtime registration of the two content scripts. They must run in this order at `document_start` in every frame:
 * the ISOLATED beacon learns the frame's container synchronously and hands it to the MAIN-world shim, which patches
 * page APIs before any page script runs. Chrome injects scripts of one registration call in array order.
 *
 * They are registered only while they have work to do (`ContentScriptLifecycle` below, docs/decisions.md "Content
 * scripts only while containers are in use"): every frame they run in pays one synchronous beacon XHR (answered
 * locally by DNR, no network, but visible in DevTools) and parses both scripts.
 */
export interface RegisteredScript {
  id: string;
  js: string[];
  matches: string[];
  runAt: 'document_start';
  allFrames: boolean;
  matchOriginAsFallback: boolean;
  world: 'ISOLATED' | 'MAIN';
  persistAcrossSessions: boolean;
}

export const CONTENT_SCRIPTS: readonly RegisteredScript[] = [
  {
    id: 'facet-beacon',
    js: ['beacon.js'],
    matches: ['<all_urls>'],
    runAt: 'document_start',
    allFrames: true,
    matchOriginAsFallback: true,
    world: 'ISOLATED',
    persistAcrossSessions: true,
  },
  {
    id: 'facet-shim',
    js: ['shim.js'],
    matches: ['<all_urls>'],
    runAt: 'document_start',
    allFrames: true,
    matchOriginAsFallback: true,
    world: 'MAIN',
    persistAcrossSessions: true,
  },
];

const SCRIPT_IDS = CONTENT_SCRIPTS.map((s) => s.id);
/** The manifest's static ruleset with the default beacon answer `{}` (public/rules/defaults.json). */
export const DEFAULT_BEACON_RULESET = 'facet_defaults';

export interface ScriptingApi {
  getRegisteredContentScripts(filter?: { ids?: string[] }): Promise<Array<Partial<RegisteredScript> & { id: string }>>;
  registerContentScripts(scripts: RegisteredScript[]): Promise<void>;
  unregisterContentScripts(filter?: { ids?: string[] }): Promise<void>;
}

function sameScript(a: Partial<RegisteredScript>, b: RegisteredScript): boolean {
  const list = (x: unknown) => JSON.stringify(Array.isArray(x) ? x : []);
  // Chrome reports `matches` in its own order.
  const set = (x: unknown) => JSON.stringify(Array.isArray(x) ? [...x].sort() : []);
  return (
    list(a.js) === list(b.js) &&
    set(a.matches) === set(b.matches) &&
    a.runAt === b.runAt &&
    Boolean(a.allFrames) === b.allFrames &&
    Boolean(a.matchOriginAsFallback) === b.matchOriginAsFallback &&
    (a.world ?? 'ISOLATED') === b.world &&
    (a.persistAcrossSessions ?? true) === b.persistAcrossSessions
  );
}

/** Both scripts with `matches` (the beacon first). */
export function scriptsFor(matches: readonly string[]): RegisteredScript[] {
  return CONTENT_SCRIPTS.map((s) => ({ ...s, js: [...s.js], matches: [...matches] }));
}

/**
 * Idempotent: does nothing when both scripts are registered with `matches` (default `<all_urls>`), else re-registers
 * both in order.
 */
export async function ensureContentScripts(scripting: ScriptingApi, matches: readonly string[] = ['<all_urls>']): Promise<'unchanged' | 'registered'> {
  const wanted = scriptsFor(matches);
  const existing = await scripting.getRegisteredContentScripts({ ids: SCRIPT_IDS });
  const upToDate = existing.length === wanted.length && wanted.every((want) => existing.some((have) => have.id === want.id && sameScript(have, want)));
  if (upToDate) return 'unchanged';
  if (existing.length > 0) await scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
  await scripting.registerContentScripts(wanted);
  return 'registered';
}

/**
 * Match patterns for the frames of "managed" sites (registrable domains containers have used): the site and its
 * subdomains, any scheme and port. Null when a site cannot be written as a pattern (an IPv6 literal): the caller then
 * keeps `<all_urls>`, the safe direction.
 */
export function managedSiteMatches(sites: readonly string[]): string[] | null {
  const out: string[] = [];
  for (const site of [...sites].sort()) {
    if (!/^[a-z0-9_.-]+$/.test(site) || site.startsWith('.') || site.endsWith('.')) return null;
    out.push(`*://${site}/*`);
    if (!isIpHost(site)) out.push(`*://*.${site}/*`);
  }
  return out;
}

/** What is registered: nothing, the managed sites only, or every frame. */
export type ScriptScope = 'off' | 'managed' | 'all';
const RANK: Record<ScriptScope, number> = { off: 0, managed: 1, all: 2 };

/**
 * What makes the scripts "in use" right now. Only things that are present count: a tab in a container, a tab the
 * restore is matching or holds, a move into a container under way. Records of closed tabs and groups (saved groups,
 * recently closed) are not in here: nothing is open for them to protect.
 */
export interface ScriptUsage {
  /** Tabs in a container. */
  tabs: number;
  /** Tabs the restore is deciding about or holds for the user. */
  waiting: number;
  /** The restore's start pass is running (it matches the tabs Chrome brought back with the browser). */
  starting: boolean;
}

/** Why the wanted scope is what it is (the diagnostics line shows it). */
export type ScriptReason =
  | { kind: 'tabs'; count: number }
  | { kind: 'moving'; count: number }
  | { kind: 'waiting'; count: number }
  | { kind: 'starting' }
  | { kind: 'sites'; count: number }
  | { kind: 'none' };

export interface ContentScriptStatus {
  /** Registered now. */
  scope: ScriptScope;
  /** What the current state of tabs and managed sites asks for (a lower scope waits for the grace period). */
  wanted: ScriptScope;
  /** Why `wanted` is what it is. */
  reason: ScriptReason;
  /** Managed sites (registrable domains containers have used). */
  sites: number;
  /** The last registration change that failed (the scope then differs from `wanted`), else null. */
  error: string | null;
  /** The global beacon answers (static `{}` ruleset, dynamic `{m:1}` / `{g:1}`) are installed. */
  beaconRules: boolean;
  /** Match patterns of the `managed` scope (empty otherwise). */
  matches: number;
  /** A lower scope is waiting for the grace period to end. */
  graceUntil: number | null;
}

export interface ContentScriptLifecycleDeps {
  scripting: ScriptingApi & {
    updateContentScripts(scripts: Array<Pick<RegisteredScript, 'id' | 'matches'>>): Promise<void>;
  };
  /** Turns the global beacon answers on or off (static ruleset and the dynamic `{m:1}` / `{g:1}` rules). */
  setBeaconRules(on: boolean): Promise<void>;
  /** What is open right now that needs the scripts (see `ScriptUsage`). */
  usage(): ScriptUsage;
  managedSites(): readonly string[];
  log?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  /** How long the last container tab must have been gone before the scope goes down (default 30 s). */
  graceMs?: number;
  /** After unregistering, the beacon answers stay this long for documents that were still starting (default 2 s). */
  lingerMs?: number;
  now?: () => number;
}

/**
 * Keeps the content scripts registered only while they are needed (docs/decisions.md, "Content scripts only while
 * containers are in use"):
 *  - `all` (`<all_urls>`) while containers are in use: a tab is in a container, the restore is matching or holding
 *    tabs, or SplitSession is about to put a tab into a container (`hold`). `ensure()` is awaited before any such tab
 *    navigates or reloads, so its first document already gets both scripts. Records of closed tabs and groups that
 *    Chrome can reopen (saved groups, recently closed) do NOT count: a tab they bring back is held by the restore gate
 *    (its address is blocked until it is decided), and the decision calls `ensure()` before the tab loads;
 *  - `managed` (only the sites containers have used) otherwise, while such sites exist: plain tabs there still hide the
 *    containers' namespaced storage from the real profile and refuse service workers (the shim's managed mode);
 *  - `off`: nothing registered, and the global beacon answers removed, so no page makes the beacon request at all.
 * Going up is immediate; going down waits `graceMs` (cancelled if containers come back), except at a worker start,
 * where nothing has used the scripts since the worker stopped. Every change runs in one queue.
 */
export class ContentScriptLifecycle {
  private scope: ScriptScope = 'off';
  private matchesKey = '';
  private beaconOn = true;
  private holds = 0;
  private queue: Promise<void> = Promise.resolve();
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private graceUntil: number | null = null;
  private lingerTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastError: string | null = null;
  private loaded = false;
  private readonly graceMs: number;
  private readonly lingerMs: number;
  private readonly now: () => number;
  private readonly log: NonNullable<ContentScriptLifecycleDeps['log']>;

  constructor(private readonly deps: ContentScriptLifecycleDeps) {
    this.graceMs = deps.graceMs ?? 30_000;
    this.lingerMs = deps.lingerMs ?? 2_000;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
  }

  /** Reads what Chrome has registered (call before `ServiceWorkerPolicy.load`, which needs `beaconRules`). */
  async readRegistered(): Promise<ScriptScope> {
    try {
      const existing = await this.deps.scripting.getRegisteredContentScripts({ ids: SCRIPT_IDS });
      const all = scriptsFor(['<all_urls>']);
      if (existing.length === all.length && all.every((want) => existing.some((have) => have.id === want.id && sameScript(have, want)))) {
        this.scope = 'all';
      } else if (existing.length > 0) {
        // Managed patterns (checked against the current sites by the first reconcile), or a stale registration: either
        // way there is something to redo, which `managed` with an unknown key makes happen.
        this.scope = 'managed';
        this.matchesKey = '?';
      } else {
        this.scope = 'off';
      }
    } catch (error) {
      this.log('error', 'reading the registered content scripts failed', String(error));
      this.scope = 'all';
      this.matchesKey = '';
    }
    this.beaconOn = this.scope !== 'off';
    return this.scope;
  }

  /** The global beacon answers should be installed (the scripts can run somewhere). */
  get beaconRules(): boolean {
    return this.beaconOn;
  }

  /**
   * Worker start, once the tab registry and the restore state are known: brings the registration in line at once (a
   * lower scope too: nothing used the scripts while the worker was stopped).
   */
  async start(): Promise<void> {
    this.loaded = true;
    await this.enqueue(async () => {
      await this.apply(this.wanted(), { initial: true });
      // The static ruleset's state is not read back (an update may have enabled it again): set both kinds once.
      const on = this.scope !== 'off';
      await this.deps.setBeaconRules(on);
      this.beaconOn = on;
    });
  }

  /** What the tabs and managed sites ask for right now. */
  wanted(): ScriptScope {
    const kind = this.reason().kind;
    return kind === 'sites' ? 'managed' : kind === 'none' ? 'off' : 'all';
  }

  /** Why `wanted()` is what it is. */
  reason(): ScriptReason {
    const usage = this.deps.usage();
    if (usage.tabs > 0) return { kind: 'tabs', count: usage.tabs };
    if (this.holds > 0) return { kind: 'moving', count: this.holds };
    if (usage.waiting > 0) return { kind: 'waiting', count: usage.waiting };
    if (usage.starting) return { kind: 'starting' };
    const sites = this.deps.managedSites().length;
    return sites > 0 ? { kind: 'sites', count: sites } : { kind: 'none' };
  }

  /** Counts as "in use" until released (an assignment under way). */
  hold(): () => void {
    this.holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
      this.changed();
    };
  }

  /** Resolves once every frame can get both scripts (`<all_urls>`). Await it before a container tab navigates. */
  async ensure(): Promise<void> {
    const release = this.hold();
    try {
      this.cancelGrace();
      if (this.scope === 'all' && this.beaconOn && this.idle) return;
      await this.enqueue(() => this.apply('all'));
    } finally {
      release();
    }
  }

  /** Tabs, the restore or the managed sites changed: go up now, or down after the grace period. */
  changed(): void {
    if (!this.loaded) return;
    const wanted = this.wanted();
    if (RANK[wanted] > RANK[this.scope] || (wanted === 'managed' && this.scope === 'managed' && this.matchesKeyOf() !== this.matchesKey)) {
      this.cancelGrace();
      void this.enqueue(() => this.apply(this.wanted()));
    } else if (RANK[wanted] < RANK[this.scope]) {
      this.startGrace();
    } else {
      this.cancelGrace();
    }
  }

  /** Applies what is wanted now, without the grace period (tests, diagnostics). */
  async flush(): Promise<void> {
    this.cancelGrace();
    await this.enqueue(() => this.apply(this.wanted()));
    if (this.lingerTimer !== null) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
      await this.enqueue(() => this.dropBeaconRules());
    }
  }

  status(): ContentScriptStatus {
    return {
      scope: this.scope,
      wanted: this.wanted(),
      reason: this.reason(),
      sites: this.deps.managedSites().length,
      error: this.lastError,
      beaconRules: this.beaconOn,
      matches: this.scope === 'managed' ? (managedSiteMatches(this.deps.managedSites())?.length ?? 0) : 0,
      graceUntil: this.graceUntil,
    };
  }

  // ---------------------------------------------------------------- internals

  private pending = 0;
  private get idle(): boolean {
    return this.pending === 0;
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    this.pending++;
    const run = this.queue.then(work).finally(() => this.pending--);
    this.queue = run.then(
      () => {
        this.lastError = null;
      },
      (error) => {
        this.lastError = String(error);
        this.log('error', 'content-script registration failed', String(error));
        this.scheduleRetry();
      },
    );
    return run;
  }

  private matchesKeyOf(): string {
    return JSON.stringify(managedSiteMatches(this.deps.managedSites()));
  }

  private startGrace(): void {
    if (this.graceTimer !== null) return;
    this.graceUntil = this.now() + this.graceMs;
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      this.graceUntil = null;
      const wanted = this.wanted();
      if (RANK[wanted] < RANK[this.scope]) void this.enqueue(() => this.apply(this.wanted()));
    }, this.graceMs);
  }

  /** A change that failed is tried again (the scope would otherwise stay wrong until the next event). */
  private scheduleRetry(): void {
    if (this.retryTimer !== null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.scope !== this.wanted()) this.retryNow();
    }, 10_000);
  }

  private retryNow(): void {
    void this.enqueue(() => this.apply(this.wanted())).catch(() => {});
  }

  private cancelGrace(): void {
    if (this.graceTimer !== null) clearTimeout(this.graceTimer);
    this.graceTimer = null;
    this.graceUntil = null;
  }

  private async apply(target: ScriptScope, options: { initial?: boolean } = {}): Promise<void> {
    // Re-read inside the queue: `all` asked by `ensure` must never be lowered by a decision taken before it.
    if (target !== 'all' && RANK[this.wanted()] > RANK[target]) target = this.wanted();
    if (target === 'off') {
      if (this.scope !== 'off') {
        await this.deps.scripting.unregisterContentScripts({ ids: SCRIPT_IDS });
        this.scope = 'off';
        this.matchesKey = '';
        this.log('info', 'content scripts unregistered (no container in use)');
      }
      if (!this.beaconOn) return;
      if (options.initial) return this.dropBeaconRules();
      // A document that started before the unregistration may still ask: its answer stays a moment longer.
      if (this.lingerTimer === null) {
        this.lingerTimer = setTimeout(() => {
          this.lingerTimer = null;
          void this.enqueue(() => this.dropBeaconRules());
        }, this.lingerMs);
      }
      return;
    }
    // Up (or sideways): the answers first, so no frame that gets the scripts ever reaches the network.
    if (this.lingerTimer !== null) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
    if (!this.beaconOn) {
      await this.deps.setBeaconRules(true);
      this.beaconOn = true;
    }
    let matches: string[] = ['<all_urls>'];
    let key = '';
    if (target === 'managed') {
      const managed = managedSiteMatches(this.deps.managedSites());
      if (managed === null || managed.length === 0) target = managed === null ? 'all' : 'off';
      else {
        matches = managed;
        key = JSON.stringify(managed);
      }
      if (target === 'off') return this.apply('off', options);
    }
    if (this.scope === target && this.matchesKey === key) return;
    if (this.scope === 'off' || this.matchesKey === '?') {
      // Nothing, or something unknown found at start (an older registration): register exactly what is wanted.
      await ensureContentScripts(this.deps.scripting, matches);
    } else {
      try {
        await this.deps.scripting.updateContentScripts(SCRIPT_IDS.map((id) => ({ id, matches: [...matches] })));
      } catch {
        await ensureContentScripts(this.deps.scripting, matches); // a script missing (stale state): register afresh
      }
    }
    this.scope = target;
    this.matchesKey = key;
    this.log('info', target === 'all' ? 'content scripts registered for every frame' : `content scripts registered for ${this.deps.managedSites().length} managed sites`);
  }

  private async dropBeaconRules(): Promise<void> {
    if (this.scope !== 'off' || !this.beaconOn) return;
    await this.deps.setBeaconRules(false);
    this.beaconOn = false;
  }
}
