import {
  type ContainerId,
  Exemptions,
  type SerializedExemptions,
} from "../core";
import type { StorageAreaLike } from "../engine/storage/storage-area";

/** `chrome.storage.session` key. Survives service-worker restarts, cleared with the browser session (tab IDs too). */
export const EXEMPTIONS_KEY = "ruleExemptions";

/** `Exemptions` (see core) kept in `storage.session`: a placement made a minute ago must still count after a worker restart. */
export class ExemptionManager {
  private book = new Exemptions();
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly area: StorageAreaLike) {}

  async load(): Promise<void> {
    const stored = (await this.area.get(EXEMPTIONS_KEY))[EXEMPTIONS_KEY];
    const fromStorage =
      typeof stored === "object" && stored !== null
        ? (stored as SerializedExemptions)
        : {};
    // Placements made while this was loading are newer than what is stored.
    this.book = new Exemptions({ ...fromStorage, ...this.book.toJSON() });
  }

  /** The tab was deliberately put in `container` (null: taken out of its container): its next navigation is exempt. */
  markPlacement(tabId: number, container: ContainerId | null): void {
    this.book.markNext(tabId, container);
    this.persist();
  }

  markSite(tabId: number, container: ContainerId | null, site: string): void {
    this.book.markSite(tabId, container, site);
    this.persist();
  }

  /** See `Exemptions.check`. Consuming a pending mark is persisted. */
  check(tabId: number, container: ContainerId | null, site: string): boolean {
    const known = this.book.has(tabId);
    const exempt = this.book.check(tabId, container, site);
    if (known) this.persist();
    return exempt;
  }

  move(from: number, to: number): void {
    if (!this.book.has(from)) return;
    this.book.move(from, to);
    this.persist();
  }

  forget(tabId: number): void {
    if (this.book.forget(tabId)) this.persist();
  }

  has(tabId: number): boolean {
    return this.book.has(tabId);
  }

  /** Waits for queued writes (tests). */
  flush(): Promise<void> {
    return this.writing;
  }

  private persist(): void {
    const snapshot = this.book.toJSON();
    this.writing = this.writing
      .then(() => this.area.set({ [EXEMPTIONS_KEY]: snapshot }))
      .catch(() => {});
  }
}
