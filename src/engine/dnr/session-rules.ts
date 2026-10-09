import {
  REGEX_RULE_BUDGET,
  SESSION_RULE_HARD_LIMIT,
  SESSION_RULE_SOFT_LIMIT,
  type CompiledRules,
  type DnrRule,
  type RuleIdAllocator,
} from '../../core';
import { RuleIdPool } from './id-pool';

/** The two calls of `chrome.declarativeNetRequest` the manager needs. */
export interface DnrSessionApi {
  updateSessionRules(options: { removeRuleIds?: number[]; addRules?: DnrRule[] }): Promise<void>;
  getSessionRules(): Promise<Array<{ id: number }>>;
}

/** Compiles every rule of one key (a container); null when the key has nothing to install (no tabs). */
export type KeyCompiler = (key: string, allocator: RuleIdAllocator, regexBudget: number) => CompiledRules | null;

export type LogFn = (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;

export interface SessionRuleManagerOptions {
  /** How a flush is scheduled after the first invalidation of a batch. Default: `setTimeout(fn, 0)`. */
  schedule?: (fn: () => void) => void;
  log?: LogFn;
  regexBudget?: number;
  softLimit?: number;
  hardLimit?: number;
}

interface Installed {
  ids: number[];
  regex: number;
}

interface Deferred {
  promise: Promise<boolean>;
  resolve: (ok: boolean) => void;
}

function deferred(): Deferred {
  let resolve!: (ok: boolean) => void;
  const promise = new Promise<boolean>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * Owns Facet's declarativeNetRequest session rules.
 *
 * - Callers `invalidate(key)` whenever the inputs of a key change (jar, tab set, top-level site). All invalidations
 *   made before the scheduled flush runs are coalesced into ONE `updateSessionRules` call that atomically removes
 *   the keys' old rules and adds their recompiled ones, so a tab is never left without rules in between.
 * - Flushes are serialised; invalidations made during a flush go into the next one.
 * - The promise returned by `invalidate`/`sync` resolves (true) once rules reflecting the state at call time are
 *   active, or false when Chrome rejected the batch (old rules then stay in place).
 */
export class SessionRuleManager {
  private readonly pool = new RuleIdPool();
  private readonly installed = new Map<string, Installed>();
  private readonly dirty = new Set<string>();
  private pending: Deferred | null = null;
  private current: Promise<boolean> | null = null;
  private running = false;
  /** Session rule IDs to drop on the next flush regardless of owner (startup reset). */
  private orphanIds: number[] = [];
  private readonly schedule: (fn: () => void) => void;
  private readonly log: LogFn;
  private readonly regexBudget: number;
  private readonly softLimit: number;
  private readonly hardLimit: number;
  private lastWarnedTotal = 0;

  constructor(
    private readonly api: DnrSessionApi,
    private readonly compile: KeyCompiler,
    options: SessionRuleManagerOptions = {},
  ) {
    this.schedule = options.schedule ?? ((fn) => void setTimeout(fn, 0));
    this.log = options.log ?? (() => {});
    this.regexBudget = options.regexBudget ?? REGEX_RULE_BUDGET;
    this.softLimit = options.softLimit ?? SESSION_RULE_SOFT_LIMIT;
    this.hardLimit = options.hardLimit ?? SESSION_RULE_HARD_LIMIT;
  }

  invalidate(...keys: string[]): Promise<boolean> {
    for (const key of keys) this.dirty.add(key);
    return this.request();
  }

  /** Resolves once everything invalidated so far is installed (immediately when idle). */
  sync(): Promise<boolean> {
    if (this.pending) return this.pending.promise;
    if (this.current) return this.current;
    return Promise.resolve(true);
  }

  /**
   * Startup after a service-worker restart: drop every session rule that exists (whoever installed it) and install
   * fresh rules for `keys`, in one atomic call. Rules of the previous worker stay active until then.
   */
  async reset(keys: Iterable<string>): Promise<boolean> {
    const existing = await this.api.getSessionRules();
    this.installed.clear();
    this.pool.clear();
    this.orphanIds = existing.map((r) => r.id);
    return this.invalidate(...keys);
  }

  stats(): { rules: number; regexRules: number; keys: number } {
    let rules = 0;
    let regexRules = 0;
    for (const { ids, regex } of this.installed.values()) {
      rules += ids.length;
      regexRules += regex;
    }
    return { rules, regexRules, keys: this.installed.size };
  }

  isInstalled(key: string): boolean {
    return this.installed.has(key);
  }

  private request(): Promise<boolean> {
    if (!this.pending) {
      this.pending = deferred();
      if (!this.running) this.schedule(() => void this.run());
    }
    return this.pending.promise;
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending) {
        const batch = this.pending;
        this.pending = null;
        this.current = batch.promise;
        let ok = false;
        try {
          ok = await this.flushOnce();
        } catch (error) {
          this.log('error', 'session rule flush crashed', String(error));
        }
        batch.resolve(ok);
      }
    } finally {
      this.current = null;
      this.running = false;
    }
  }

  private async flushOnce(): Promise<boolean> {
    const keys = [...this.dirty];
    this.dirty.clear();
    const orphanIds = this.orphanIds;
    this.orphanIds = [];
    if (keys.length === 0 && orphanIds.length === 0) return true;

    const previous = new Map<string, Installed | undefined>(keys.map((k) => [k, this.installed.get(k)]));
    const removeRuleIds = [...orphanIds];
    for (const old of previous.values()) if (old) removeRuleIds.push(...old.ids);
    this.pool.release(removeRuleIds);

    let otherRules = 0;
    let otherRegex = 0;
    for (const [key, inst] of this.installed) {
      if (previous.has(key)) continue;
      otherRules += inst.ids.length;
      otherRegex += inst.regex;
    }

    let regexLeft = Math.max(0, this.regexBudget - otherRegex);
    const addRules: DnrRule[] = [];
    const next = new Map<string, Installed>();
    for (const key of keys) {
      let compiled: CompiledRules | null = null;
      try {
        compiled = this.compile(key, this.pool, regexLeft);
      } catch (error) {
        this.log('error', `compiling rules for ${key} failed`, String(error));
      }
      if (!compiled) continue;
      regexLeft = Math.max(0, regexLeft - compiled.regexRuleCount);
      addRules.push(...compiled.addRules);
      next.set(key, { ids: compiled.ruleIds, regex: compiled.regexRuleCount });
    }

    const total = otherRules + addRules.length;
    if (total > this.softLimit && total !== this.lastWarnedTotal) {
      this.lastWarnedTotal = total;
      this.log('warn', `session rules at ${total}, above the soft limit of ${this.softLimit}`);
    }
    if (total > this.hardLimit) {
      this.log('error', `refusing to install ${total} session rules (Chrome's limit is ${this.hardLimit})`);
      this.rollback(previous, addRules, orphanIds);
      return false;
    }

    try {
      await this.api.updateSessionRules({ removeRuleIds, addRules });
    } catch (error) {
      this.log('error', 'updateSessionRules failed', String(error));
      this.rollback(previous, addRules, orphanIds);
      return false;
    }
    for (const key of keys) {
      const inst = next.get(key);
      if (inst) this.installed.set(key, inst);
      else this.installed.delete(key);
    }
    return true;
  }

  /** Chrome kept the old rules: give their IDs back to their owners and free the ones we tried to use. */
  private rollback(previous: Map<string, Installed | undefined>, attempted: DnrRule[], orphanIds: number[]): void {
    this.pool.release(attempted.map((r) => r.id));
    for (const old of previous.values()) if (old) this.pool.reserve(old.ids);
    // Orphans are still installed: keep their IDs out of the pool and retry removing them next time.
    this.pool.reserve(orphanIds);
    this.orphanIds.unshift(...orphanIds);
  }
}
