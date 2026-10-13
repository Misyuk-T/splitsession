import {
  type ContainerId,
  DOMAIN_RULES_KEY,
  type DomainRule,
  isDomainRule,
  pruneRules,
  upsertRule,
  validateRule,
} from "../core";
import type { StorageAreaLike } from "../engine/storage/storage-area";

export class RuleError extends Error {}

/** Domain rules in `chrome.storage.local` (`domainRules`), one per registrable domain, sorted by domain. */
export class RuleStore {
  private rules: DomainRule[] = [];
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly area: StorageAreaLike,
    /** IDs of the containers that exist now (rules naming other containers are rejected / dropped). */
    private readonly knownContainers: () => ReadonlySet<ContainerId>,
  ) {}

  async load(): Promise<void> {
    const stored = (await this.area.get(DOMAIN_RULES_KEY))[DOMAIN_RULES_KEY];
    const list = Array.isArray(stored) ? stored.filter(isDomainRule) : [];
    this.rules = pruneRules(list, this.knownContainers()).sort((a, b) =>
      a.domain.localeCompare(b.domain),
    );
  }

  list(): DomainRule[] {
    return this.rules.map((r) => ({ ...r }));
  }

  /** The live list without copying, for hot paths (every navigation). Do not mutate. */
  all(): readonly DomainRule[] {
    return this.rules;
  }

  /** Validates (domain reduced to its registrable form, container must exist) and inserts or replaces. */
  async set(raw: unknown): Promise<DomainRule> {
    const checked = validateRule(raw, this.knownContainers());
    if (!checked.ok) throw new RuleError(checked.message);
    this.rules = upsertRule(this.rules, checked.rule);
    await this.persist();
    return { ...checked.rule };
  }

  /** Accepts what the user typed ("https://www.github.com/x"), too. False when there was no such rule. */
  async remove(domain: string): Promise<boolean> {
    const before = this.rules.length;
    const key = this.keyFor(domain);
    this.rules = this.rules.filter((r) => r.domain !== key);
    if (this.rules.length === before) return false;
    await this.persist();
    return true;
  }

  /** After a container was deleted: its always-rules can never fire. Returns how many were removed. */
  async pruneDeleted(): Promise<number> {
    const kept = pruneRules(this.rules, this.knownContainers());
    const removed = this.rules.length - kept.length;
    if (removed === 0) return 0;
    this.rules = kept;
    await this.persist();
    return removed;
  }

  /** Replaces the whole list (import). Invalid entries throw before anything changes. */
  async replaceAll(raw: readonly unknown[]): Promise<void> {
    const next: DomainRule[] = [];
    for (const item of raw) {
      const checked = validateRule(item, this.knownContainers());
      if (!checked.ok) throw new RuleError(checked.message);
      next.splice(0, next.length, ...upsertRule(next, checked.rule));
    }
    this.rules = next;
    await this.persist();
  }

  private keyFor(domain: string): string {
    const found = this.rules.find(
      (r) => r.domain === domain.trim().toLowerCase(),
    );
    if (found) return found.domain;
    const checked = validateRule({ domain, action: "ask" }, new Set());
    return checked.ok ? checked.rule.domain : domain;
  }

  private persist(): Promise<void> {
    const snapshot = this.rules.map((r) => ({ ...r }));
    this.writing = this.writing
      .then(() => this.area.set({ [DOMAIN_RULES_KEY]: snapshot }))
      .catch(() => {});
    return this.writing;
  }
}
