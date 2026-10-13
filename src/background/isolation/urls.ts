import type { Browser } from "wxt/browser";

import { beaconSiteOf, hostnameOf, isHttpUrl, siteOf } from "../../core";

type MessageSender = Browser.runtime.MessageSender;

export const withoutFragment = (url: string): string => {
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
};

/** Site a frame's beacon answers for (`beaconSiteOf`), or null for a non-http(s) or broken URL. */
export const siteOfFrameUrl = (url: string | undefined): string | null => {
  if (!isHttpUrl(url)) return null;
  try {
    return beaconSiteOf(hostnameOf(new URL(url).hostname));
  } catch {
    return null;
  }
};

/** Top-level site (`siteOf`) of an http(s) URL, or null. */
export const siteOfHttp = (url: string | undefined): string | null => {
  if (!isHttpUrl(url)) return null;
  try {
    return siteOf(url);
  } catch {
    return null;
  }
};

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** The http(s) origin of the frame that sent a message, or null (opaque, extension or broken origins). */
export function senderOrigin(sender: MessageSender): string | null {
  const candidate =
    sender.origin ?? (sender.url ? safeOrigin(sender.url) : null);
  if (!candidate || candidate === "null") return null;
  return /^https?:\/\//.test(candidate) ? candidate : null;
}

export function senderHost(sender: MessageSender): string | null {
  const origin = senderOrigin(sender);
  return origin ? hostnameOf(new URL(origin).hostname) : null;
}
