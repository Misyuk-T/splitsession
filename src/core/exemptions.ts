import type { ContainerId } from './types';

interface Entry {
  /** Container the tab was in when the placement was made (null: plain). The entry dies when this changes. */
  container: ContainerId | null;
  /** The site (rule key) this placement is for; null until the tab navigates after being placed. */
  site: string | null;
  /** The tab's next main-frame navigation, whatever its site, is part of the placement. */
  next: boolean;
}

export type SerializedExemptions = Record<string, Entry>;

/**
 * Domain rules move a tab only when the navigation was NOT the result of a deliberate placement. A tab put into a
 * container by the user (popup, `open.html`, choose page), by an agent, by `#ctr=`, or inherited from a container
 * page (OAuth popups!) gets one free navigation; the site that navigation goes to stays exempt while the tab stays on
 * it and in the same container. Visiting another site ends the exemption (coming back is a new visit, rules apply
 * again), and so does moving the tab to another container.
 */
export class Exemptions {
  private readonly tabs = new Map<number, Entry>();

  constructor(initial?: SerializedExemptions) {
    if (!initial) return;
    for (const [key, entry] of Object.entries(initial)) {
      const tabId = Number(key);
      if (Number.isInteger(tabId) && isEntry(entry)) this.tabs.set(tabId, { ...entry });
    }
  }

  /** The tab was just placed in `container` (null: taken out of its container): its next navigation is exempt. */
  markNext(tabId: number, container: ContainerId | null): void {
    const entry = this.entryFor(tabId, container);
    entry.next = true;
  }

  /** `site` is the site this placement is for: navigations to it are exempt, a pending "next" mark is spent. */
  markSite(tabId: number, container: ContainerId | null, site: string): void {
    const entry = this.entryFor(tabId, container);
    entry.site = site;
    entry.next = false;
  }

  /** Is a navigation of the tab (now in `container`) to `site` exempt? Updates the entry as described above. */
  check(tabId: number, container: ContainerId | null, site: string): boolean {
    const entry = this.tabs.get(tabId);
    if (!entry) return false;
    if (entry.container !== container || (entry.site !== site && !entry.next)) {
      this.tabs.delete(tabId);
      return false;
    }
    entry.site = site;
    entry.next = false;
    return true;
  }

  /** Tab ID replaced by another (prerender swap). */
  move(from: number, to: number): void {
    const entry = this.tabs.get(from);
    if (!entry) return;
    this.tabs.delete(from);
    this.tabs.set(to, entry);
  }

  forget(tabId: number): boolean {
    return this.tabs.delete(tabId);
  }

  has(tabId: number): boolean {
    return this.tabs.has(tabId);
  }

  toJSON(): SerializedExemptions {
    return Object.fromEntries([...this.tabs].map(([id, e]) => [String(id), { ...e }]));
  }

  private entryFor(tabId: number, container: ContainerId | null): Entry {
    let entry = this.tabs.get(tabId);
    if (!entry || entry.container !== container) {
      entry = { container, site: null, next: false };
      this.tabs.set(tabId, entry);
    }
    return entry;
  }
}

function isEntry(x: unknown): x is Entry {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Record<string, unknown>;
  return (e.container === null || typeof e.container === 'string') && (e.site === null || typeof e.site === 'string') && typeof e.next === 'boolean';
}
