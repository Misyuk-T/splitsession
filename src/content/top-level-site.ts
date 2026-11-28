import { domainMatches, hostnameOf, siteOf } from "../core/site";
import type { Cookie } from "../core/types";

/** True when the beacon's site `s` (`scheme://registrable-or-exact-site`) is the site of this document's own origin. */
function isSiteOfOrigin(site: string, origin: string): boolean {
  try {
    const s = new URL(site);
    const o = new URL(origin);
    return (
      s.protocol === o.protocol &&
      domainMatches(hostnameOf(o.hostname), hostnameOf(s.hostname))
    );
  } catch {
    return false;
  }
}

/**
 * The top-level site this document's partitioned cookies are keyed by. The beacon's `s` is exact (full PSL in the
 * background; our own estimate uses a lite PSL), but it is the site the background knew for the tab, which during a
 * cross-site top-level navigation is still the previous page's. A top-level document therefore takes `s` only when
 * its own origin belongs to that site; otherwise `s` is stale and the estimate stands in (`stale`: ask the
 * background for a fresh snapshot). Frames keep `s ?? estimate`.
 */
export function resolveTopLevelSite(input: {
  isTopDocument: boolean;
  origin: string | null;
  /** `s` of the beacon answer. */
  beaconSite: string | null | undefined;
  /** This document's own estimate of the top-level site (null when its origin is opaque). */
  estimate: string | null;
}): { site: string | null; stale: boolean } {
  const { isTopDocument, origin, beaconSite, estimate } = input;
  if (!isTopDocument) return { site: beaconSite ?? estimate, stale: false };
  if (beaconSite == null) return { site: estimate, stale: false };
  if (origin !== null && isSiteOfOrigin(beaconSite, origin))
    return { site: beaconSite, stale: false };
  return { site: estimate, stale: true };
}

/**
 * True when the document's origin is of another site than the top-level one (third-party context). A top-level
 * document is never third-party to itself, whatever site its cookies are keyed by.
 */
export function isCrossSite(
  origin: string | null,
  topSite: string | null,
  isTopDocument: boolean,
) {
  return (
    !isTopDocument &&
    origin !== null &&
    topSite !== null &&
    siteOf(origin) !== topSite
  );
}

/** What `document.cookie` shows: no HttpOnly, and in a third-party context only SameSite=None. */
export const visibleToScript = (c: Cookie, crossSite: boolean): boolean =>
  !c.httpOnly && (!crossSite || c.sameSite === "none");
