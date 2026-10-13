import type { Browser } from "wxt/browser";

import {
  type ContainerId,
  type CookieSnapshotReply,
  isHttpUrl,
} from "../../core";
import type { TabRecord } from "../../engine/storage/tab-registry";
import type { ContainerRules } from "./container-rules";
import type { CookieCapture } from "./cookie-capture";
import type { PopupChildren } from "./popup-children";
import type { EngineCore } from "./types";
import { senderHost, senderOrigin, siteOfFrameUrl } from "./urls";

type MessageSender = Browser.runtime.MessageSender;

export type ContentMessage = { type: string; [key: string]: unknown };

export interface ContentMessageDeps extends EngineCore {
  capture: CookieCapture;
  children: PopupChildren;
  containerRules: ContainerRules;
  openInContainer(
    url: string,
    containerId: ContainerId,
    options: {
      active?: boolean;
      openerTabId?: number;
      windowId?: number;
      index?: number;
    },
  ): Promise<number>;
}

interface Request {
  message: ContentMessage;
  sender: MessageSender;
  tabId: number;
  /** The sender tab's container record (undefined: not a container tab). */
  rec: TabRecord | undefined;
}

type Handler = (d: ContentMessageDeps, r: Request) => unknown;

/** What the beacon (for the shim) may ask the background, by message type. */
const HANDLERS: Record<string, Handler> = {
  "facet/ping": () => ({ ok: true }),

  "facet/cookie-write": (d, { message, sender, tabId }) =>
    d.capture.cookieWrite(
      tabId,
      sender,
      String(message.value ?? ""),
      String(message.path ?? "/"),
      Number(message.at),
    ),

  "facet/cookie-snapshot": (d, { sender, rec }) => {
    const host = senderHost(sender);
    if (!rec || !host) return { ok: false } satisfies CookieSnapshotReply;
    return {
      ok: true,
      cookies: d.capture.siteSnapshot(rec.containerId, host, rec.topLevelSite),
    } satisfies CookieSnapshotReply;
  },

  "facet/settle": async (d, { message, tabId }) => {
    await d.capture.settle(
      tabId,
      String(message.url ?? ""),
      String(message.method ?? "GET"),
    );
    return { ok: true };
  },

  "facet/await-child": async (d, { message, tabId, rec }) => {
    if (!rec) return { ok: false };
    const nonce = String(message.nonce ?? "");
    if (!/^[a-z0-9]{6,32}$/.test(nonce)) return { ok: false };
    const child = await d.children.awaitChild(tabId, nonce);
    if (child === null) return { ok: false };
    // The shim navigates the child once we answer: no service worker of the target may answer that request.
    if (typeof message.url === "string") await d.prepareNavigation(message.url);
    return { ok: true, tabId: child };
  },

  "facet/need-site": async (d, { sender, tabId, rec }) => {
    // The beacon of a frame got the generic answer: its site has no beacon rule yet. Add it; the beacon polls.
    const site = siteOfFrameUrl(senderOrigin(sender) ?? undefined);
    if (!rec || !site) return { ok: false };
    d.log("info", `beacon answer for ${site} asked by a frame of tab ${tabId}`);
    return {
      ok: await d.containerRules.addFrameSite(
        tabId,
        rec.containerId,
        site,
        false,
        true,
      ),
    };
  },

  "facet/open-tab": async (d, { message, sender, tabId, rec }) => {
    if (!rec) return { ok: false };
    const url = String(message.url ?? "");
    if (!isHttpUrl(url)) return { ok: false };
    const childId = await d.openInContainer(url, rec.containerId, {
      active: message.active !== false,
      openerTabId: tabId,
      windowId: sender.tab?.windowId,
      index: sender.tab?.index !== undefined ? sender.tab.index + 1 : undefined,
    });
    return { ok: true, tabId: childId };
  },
};

/** Answers a `facet/*` message from a content script of a tab (the listener checked that it is not an extension page). */
export async function handleContentMessage(
  d: ContentMessageDeps,
  message: ContentMessage,
  sender: MessageSender,
): Promise<unknown> {
  await d.ready();
  const tabId = sender.tab?.id;
  if (tabId === undefined || tabId < 0) return { ok: false };
  const rec = d.tabs.get(tabId);
  const handler = Object.hasOwn(HANDLERS, message.type)
    ? HANDLERS[message.type]!
    : null;
  return handler ? handler(d, { message, sender, tabId, rec }) : { ok: false };
}
