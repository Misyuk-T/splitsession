import { describe, expect, it } from "vitest";

import { CookieJar, serializeCookieHeader } from "../core/jar/cookie-jar";
import { siteOf } from "../core/site";
import {
  isCrossSite,
  resolveTopLevelSite,
  visibleToScript,
} from "./top-level-site";

const LOGIN = "https://login.microsoftonline.com";
const STALE = "https://azure.com";

/** The content script's `document.cookie` for a document of `origin`, built from the same pieces `startContainer` uses. */
function documentCookie(opts: {
  origin: string;
  isTopDocument: boolean;
  beaconSite: string | null;
  jar?: CookieJar;
  estimate?: string | null;
}) {
  const host = new URL(opts.origin).hostname;
  const { site: tls } = resolveTopLevelSite({
    isTopDocument: opts.isTopDocument,
    origin: opts.origin,
    beaconSite: opts.beaconSite,
    estimate:
      opts.estimate ?? (opts.isTopDocument ? siteOf(opts.origin) : STALE),
  });
  const crossSite = isCrossSite(opts.origin, tls, opts.isTopDocument);
  // The jar the background sent: a partitioned cookie of the site the tab was on, which makes the beacon carry `s`.
  const jar = opts.jar ?? new CookieJar();
  const write = (value: string) =>
    jar.applyDocumentCookieWrite(host, value, {
      secure: true,
      topLevelSite: tls,
    });
  const read = () =>
    serializeCookieHeader(
      jar
        .cookiesForHost(host, { secure: true, topLevelSite: tls })
        .filter((c) => visibleToScript(c, crossSite)),
    );
  return { write, read };
}

describe("a top-level document's own site", () => {
  it("Azure: a stale beacon site does not turn login.microsoftonline.com into a third party of azure.com", () => {
    const doc = documentCookie({
      origin: LOGIN,
      isTopDocument: true,
      beaconSite: STALE,
    });
    // Microsoft's cookie test: no SameSite, no Secure.
    doc.write("CkTst=G1700000000000; domain=login.microsoftonline.com; path=/");
    expect(doc.read()).toBe("CkTst=G1700000000000");
  });

  it("a frame of another site than the top one still sees only SameSite=None cookies", () => {
    const jar = new CookieJar();
    const frame = documentCookie({
      origin: LOGIN,
      isTopDocument: false,
      beaconSite: STALE,
      jar,
    });
    frame.write("lax=1; path=/");
    frame.write("none=1; path=/; SameSite=None; Secure");
    expect(frame.read()).toBe("none=1");
  });

  it("a frame of the top-level site itself sees SameSite=Lax cookies", () => {
    const frame = documentCookie({
      origin: STALE,
      isTopDocument: false,
      beaconSite: STALE,
    });
    frame.write("lax=1; path=/");
    expect(frame.read()).toBe("lax=1");
  });

  it("falls back to the document's own estimate when the beacon has no site", () => {
    expect(
      resolveTopLevelSite({
        isTopDocument: false,
        origin: LOGIN,
        beaconSite: null,
        estimate: STALE,
      }).site,
    ).toBe(STALE);
    expect(
      resolveTopLevelSite({
        isTopDocument: true,
        origin: null,
        beaconSite: undefined,
        estimate: null,
      }).site,
    ).toBeNull();
  });

  it("a fresh beacon site that the lite estimate cannot tell (azurewebsites.net) keys partitioned cookies", () => {
    const origin = "https://my-app.azurewebsites.net";
    const jar = new CookieJar();
    jar.setFromHeader("pk=1; Path=/; Secure; Partitioned", {
      url: `${origin}/`,
      now: Date.now(),
      topLevelSite: origin,
    });
    const doc = documentCookie({
      origin,
      isTopDocument: true,
      beaconSite: origin,
      estimate: "https://azurewebsites.net",
      jar,
    });
    expect(doc.read()).toBe("pk=1");
  });

  it("a stale beacon site of another site: the estimate stands in, the top document is not third-party, a refresh is asked", () => {
    const stale = resolveTopLevelSite({
      isTopDocument: true,
      origin: LOGIN,
      beaconSite: STALE,
      estimate: "https://microsoftonline.com",
    });
    expect(stale).toEqual({
      site: "https://microsoftonline.com",
      stale: true,
    });
    expect(isCrossSite(LOGIN, stale.site, true)).toBe(false);
    const fresh = resolveTopLevelSite({
      isTopDocument: true,
      origin: LOGIN,
      beaconSite: "https://microsoftonline.com",
      estimate: "https://microsoftonline.com",
    });
    expect(fresh.stale).toBe(false);
    // A different scheme is not the same site either.
    expect(
      resolveTopLevelSite({
        isTopDocument: true,
        origin: "http://a.example.com",
        beaconSite: "https://example.com",
        estimate: "http://example.com",
      }).stale,
    ).toBe(true);
  });
});
