import type { RuleIdAllocator } from "../../core";

/**
 * Session-rule ID pool. IDs released by a batch may be handed out again in the same batch: Chrome applies
 * `removeRuleIds` before `addRules` within one `updateSessionRules` call.
 */
export class RuleIdPool implements RuleIdAllocator {
  private readonly used = new Set<number>();
  private free: number[] = [];
  private fresh = 1;

  next(): number {
    let id = this.free.pop();
    while (id !== undefined && this.used.has(id)) id = this.free.pop();
    if (id === undefined) id = this.fresh++;
    this.used.add(id);
    return id;
  }

  release(ids: Iterable<number>): void {
    for (const id of ids) if (this.used.delete(id)) this.free.push(id);
  }

  /** Marks IDs as taken (used when rolling back a failed batch). */
  reserve(ids: Iterable<number>): void {
    for (const id of ids) {
      this.used.add(id);
      if (id >= this.fresh) {
        for (let gap = this.fresh; gap < id; gap++) this.free.push(gap);
        this.fresh = id + 1;
      }
    }
    this.free = this.free.filter((id) => !this.used.has(id));
  }

  get size(): number {
    return this.used.size;
  }

  clear(): void {
    this.used.clear();
    this.free = [];
    this.fresh = 1;
  }
}
