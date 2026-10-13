import { type ContainerId, isHttpUrl } from "../../core";
import { ContainerError } from "../../engine/storage/container-store";
import type { TabRestore } from "../restore";
import type { OwnTabs } from "./own-tabs";
import type { EngineCore } from "./types";

export interface OpenOptions {
  active?: boolean;
  windowId?: number;
  index?: number;
  openerTabId?: number;
}

/** Options only background code can pass (functions do not travel through the message API). */
export interface InternalOpenOptions extends OpenOptions {
  pinned?: boolean;
  /** Called once the new tab is in the container and has not navigated yet. */
  onAssigned?: (tabId: number) => void;
}

export interface TabOpenerDeps extends EngineCore {
  own: OwnTabs;
  restore: TabRestore;
  /** `Facet.assign`; throws when the container rules cannot be installed. */
  assign(tabId: number, containerId: ContainerId): Promise<number>;
}

const onlyHttp = (url: string): void => {
  if (!isHttpUrl(url))
    throw new ContainerError("only http(s) URLs can be opened in a container");
};

/** Tabs SplitSession opens itself: always at a committed about:blank, put where they belong, then navigated. */
export class TabOpener {
  constructor(private readonly d: TabOpenerDeps) {}

  /** New tab at about:blank (no network), into the container, then navigated: the first request is already isolated. */
  async openInContainer(
    url: string,
    ref: ContainerId,
    options: InternalOpenOptions = {},
  ): Promise<number> {
    const { b } = this.d;
    await this.d.ready();
    onlyHttp(url);
    const container = this.d.containers.resolve(ref);
    if (!container) throw new ContainerError(`no container "${ref}"`);
    const tab = await this.createBlankTab({
      active: options.active ?? true,
      ...(options.windowId !== undefined ? { windowId: options.windowId } : {}),
      ...(options.index !== undefined ? { index: options.index } : {}),
      ...(options.pinned ? { pinned: true } : {}),
    });
    if (tab.id === undefined) throw new ContainerError("tab creation failed");
    try {
      try {
        await this.d.assign(tab.id, container.id);
      } catch (error) {
        await b.tabs.remove(tab.id).catch(() => {});
        throw error;
      }
      options.onAssigned?.(tab.id);
      if (options.openerTabId !== undefined)
        await b.tabs
          .update(tab.id, { openerTabId: options.openerTabId })
          .catch(() => {});
      await this.d.prepareNavigation(url);
      await b.tabs.update(tab.id, { url });
    } finally {
      this.d.own.done(tab.id);
    }
    return tab.id;
  }

  /**
   * Moves a tab to `containerId` (null: a plain tab) by opening `url` in a FRESH tab at the same place and returning
   * its ID; the caller closes `tabId` afterwards. The old document may be scripted by another context (its opener, a
   * popup parent, a frame that kept a reference), and a document that stays alive keeps that link: the opener of a
   * tab that a domain rule moves into a container would read the container's cookies and storage through its
   * `WindowProxy`. The new tab is created with `tabs.create` (no `window.opener`; `openerTabId` is not passed). Done
   * for every such move, whether SplitSession can see an opener or not (a popup's opener is not always visible). Nothing is
   * created when the tab is gone or the container rules cannot be installed.
   */
  async replaceTab(
    tabId: number,
    containerId: ContainerId | null,
    url: string,
    onCreated?: (newTabId: number) => void,
  ): Promise<number> {
    const { b } = this.d;
    await this.d.ready();
    onlyHttp(url);
    const old = await b.tabs.get(tabId);
    const place = {
      active: old.active,
      windowId: old.windowId,
      index: old.index,
      ...(old.pinned ? { pinned: true } : {}),
    };
    if (containerId !== null)
      return this.openInContainer(url, containerId, {
        ...place,
        ...(onCreated ? { onAssigned: onCreated } : {}),
      });
    const tab = await this.createBlankTab(place);
    if (tab.id === undefined) throw new ContainerError("tab creation failed");
    try {
      await this.d.restore.clear(tab.id);
      onCreated?.(tab.id);
      await b.tabs.update(tab.id, { url });
    } finally {
      this.d.own.done(tab.id);
    }
    return tab.id;
  }

  /** A new tab at about:blank, returned once that initial page has committed (`OwnTabs.createBlank`). */
  private createBlankTab(props: {
    active?: boolean;
    windowId?: number;
    index?: number;
    pinned?: boolean;
  }): Promise<{ id?: number }> {
    return this.d.own.createBlank(
      this.d.b.tabs.create({ ...props, url: "about:blank" }),
    );
  }
}
