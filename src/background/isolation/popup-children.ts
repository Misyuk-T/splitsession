import type { ContainerId } from "../../core";
import type { StaleNavigationDetector } from "../../engine/capture/stale-detector";
import type { TabRecord } from "../../engine/storage/tab-registry";
import type { TabRestore } from "../restore";
import type { CookieCapture } from "./cookie-capture";
import type { EngineCore } from "./types";

/** `about:blank#facet-<nonce>`: how the shim marks the blank child it opens before navigating it. */
export const CHILD_NONCE = /#facet-([a-z0-9]{6,32})$/;
const AWAIT_CHILD_TIMEOUT_MS = 1_000;
const READY_CHILD_TTL_MS = 2_000;
const BROWSER_PAGE = /^(chrome|chrome-extension|devtools):/i;

interface ChildWaiter {
  parent: number;
  nonce: string;
  resolve: (tabId: number | null) => void;
}

interface ReadyChild {
  parent: number | undefined;
  child: number;
  nonce: string | undefined;
  at: number;
}

export interface PopupChildrenDeps extends EngineCore {
  restore: TabRestore;
  detector: StaleNavigationDetector;
  capture: CookieCapture;
  /** `Facet.assign`; resolves with the time the rules became active. */
  assign(tabId: number, containerId: ContainerId): Promise<number>;
  /** The assignment of this tab under way, if any. */
  assignment(tabId: number): Promise<number> | undefined;
}

/**
 * Tabs a container page opens inherit its container before their first request, and the shim's `window.open` waits
 * for that (`awaitChild`): the child is matched to its opener by the nonce of its `about:blank#facet-<nonce>`, or by
 * the opener alone.
 */
export class PopupChildren {
  private readonly inheriting = new Set<number>();
  private readonly childNonces = new Map<number, string>();
  private readonly childWaiters: ChildWaiter[] = [];
  private readonly readyChildren: ReadyChild[] = [];

  constructor(private readonly d: PopupChildrenDeps) {}

  /** SplitSession is putting this child into its opener's container right now. */
  isInheriting(tabId: number): boolean {
    return this.inheriting.has(tabId);
  }

  forgetTab(tabId: number): void {
    this.childNonces.delete(tabId);
  }

  async inherit(
    child: number,
    parent: number,
    url: string | undefined,
  ): Promise<void> {
    const { tabs } = this.d;
    await this.d.ready();
    const nonce = url ? CHILD_NONCE.exec(url)?.[1] : undefined;
    if (nonce) this.childNonces.set(child, nonce);
    const existing = tabs.get(child);
    if (existing) {
      // Assigned meanwhile by someone else (the group guard: Chrome put the child into its opener's group).
      if (existing.activeSince === null)
        await this.d.assignment(child)?.catch(() => {});
      if (tabs.get(child)?.activeSince != null) this.childReady(parent, child);
      return;
    }
    if (this.inheriting.has(child)) return;
    const parentRec = tabs.get(parent);
    if (!parentRec) {
      // A plain page opened it: not a restored tab, whatever its address.
      this.d.restore.pageOpened(child);
      return;
    }
    if (url && BROWSER_PAGE.test(url)) return;
    this.inheriting.add(child);
    try {
      const containerId = parentRec.containerId;
      const activeAt = await this.d.assign(child, containerId);
      for (const r of this.d.detector.noteAssignment(
        child,
        activeAt,
        (send) => !this.d.capture.headerFromJar(containerId, send.cookie),
      )) {
        this.d.capture.renavigate(r);
      }
      this.childReady(parent, child);
    } catch (error) {
      this.d.log(
        "error",
        `tab ${child} could not inherit ${parentRec.containerId}`,
        String(error),
      );
    } finally {
      this.inheriting.delete(child);
    }
  }

  /** A container tab committed `url`: a named window reused by `window.open` has no new tab, but its waiter has a nonce. */
  committed(tabId: number, url: string, rec: TabRecord): void {
    const nonce = CHILD_NONCE.exec(url)?.[1];
    if (nonce && rec.activeSince !== null) {
      this.childNonces.set(tabId, nonce);
      this.childReady(undefined, tabId);
    }
  }

  private childReady(parent: number | undefined, child: number): void {
    const nonce = this.childNonces.get(child);
    let index = nonce
      ? this.childWaiters.findIndex((w) => w.nonce === nonce)
      : -1;
    if (index === -1 && parent !== undefined)
      index = this.childWaiters.findIndex((w) => w.parent === parent);
    if (index !== -1) {
      const [waiter] = this.childWaiters.splice(index, 1);
      waiter!.resolve(child);
      return;
    }
    const now = Date.now();
    for (let i = this.readyChildren.length - 1; i >= 0; i--)
      if (now - this.readyChildren[i]!.at > READY_CHILD_TTL_MS)
        this.readyChildren.splice(i, 1);
    this.readyChildren.push({ parent, child, nonce, at: now });
  }

  /** The child tab the shim's `window.open` (nonce) in `parent` produced, once it is in the container; null after a timeout. */
  awaitChild(parent: number, nonce: string): Promise<number | null> {
    const now = Date.now();
    let index = this.readyChildren.findIndex(
      (c) => c.nonce === nonce && now - c.at <= READY_CHILD_TTL_MS,
    );
    if (index === -1)
      index = this.readyChildren.findIndex(
        (c) =>
          c.parent === parent &&
          c.nonce === undefined &&
          now - c.at <= READY_CHILD_TTL_MS,
      );
    if (index !== -1) {
      const [ready] = this.readyChildren.splice(index, 1);
      return Promise.resolve(ready!.child);
    }
    return new Promise((resolve) => {
      const waiter: ChildWaiter = { parent, nonce, resolve };
      this.childWaiters.push(waiter);
      setTimeout(() => {
        const i = this.childWaiters.indexOf(waiter);
        if (i !== -1) {
          this.childWaiters.splice(i, 1);
          resolve(null);
        }
      }, AWAIT_CHILD_TIMEOUT_MS);
    });
  }
}
