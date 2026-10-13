import {
  type ContainerId,
  ctrMarkerRef,
  deleteWhere,
  isHttpUrl,
  Wakeups,
} from "../../core";
import type { StaleNavigationDetector } from "../../engine/capture/stale-detector";
import type { EngineCore, NavigationDetails, WebRequestDetails } from "./types";
import { withoutFragment } from "./urls";

const CTR_MARKER = /(?:^|&)ctr=([^&]*)/;
/** How long the `#ctr=` check waits for the navigation's request (to learn its initiator). */
const CTR_INITIATOR_WAIT_MS = 2_000;
/** Main-frame requests remembered per tab, and for how long. */
const MAIN_FRAME_STARTS_KEPT = 8;
const MAIN_FRAME_START_TTL_MS = 10_000;
const DECISION_TTL_MS = 10_000;

interface MainFrameStart {
  url: string;
  initiator: string | undefined;
  at: number;
}

export interface CtrMarkerDeps extends EngineCore {
  detector: StaleNavigationDetector;
  /** `Facet.assign`: puts the tab into the container; throws when the rules cannot be installed. */
  assign(tabId: number, containerId: ContainerId): Promise<number>;
}

/**
 * `https://site/#ctr=<name or id>`: a navigation the browser (or an extension) starts may ask for an existing
 * container. Remembers who started each main-frame request, decides once per navigation, and applies the marker.
 */
export class CtrMarkers {
  /** Per tab: recent main-frame requests and their initiators (`#ctr=` is honoured for browser-initiated ones only). */
  private readonly mainFrameStarts = new Map<number, MainFrameStart[]>();
  private readonly mainFrameWakeups = new Wakeups();
  /** One `#ctr=` decision per navigation, shared with the domain-rule engine. */
  private readonly decisions = new Map<
    string,
    { at: number; decision: Promise<ContainerId | null> }
  >();

  constructor(private readonly d: CtrMarkerDeps) {}

  /** `webRequest.onBeforeRequest` of a main frame: who started it. */
  noteMainFrame(details: WebRequestDetails): void {
    const list = (this.mainFrameStarts.get(details.tabId) ?? []).filter(
      (s) => details.timeStamp - s.at < MAIN_FRAME_START_TTL_MS,
    );
    list.push({
      url: withoutFragment(details.url),
      initiator: details.initiator,
      at: details.timeStamp,
    });
    this.mainFrameStarts.set(
      details.tabId,
      list.slice(-MAIN_FRAME_STARTS_KEPT),
    );
    this.mainFrameWakeups.wake();
  }

  forgetTab(tabId: number): void {
    this.mainFrameStarts.delete(tabId);
  }

  /**
   * Which EXISTING container the navigation asks for, or null when it must be ignored. Honoured only for a tab without
   * a container, on a navigation the browser or an extension started (address bar, bookmark, an agent over CDP: no
   * `initiator` in `webRequest`; `tabs.update` from an extension: `initiator` is that extension's `chrome-extension://`
   * origin). A page cannot use it, neither by setting `location.hash` (same-document, no request at all) nor by
   * navigating itself or a child to a marked URL (it would be the initiator). Unknown names are ignored too (creating
   * containers stays with `open.html`, which pages cannot reach). One decision per navigation, shared with the
   * domain-rule engine.
   */
  decision(details: NavigationDetails): Promise<ContainerId | null> {
    const ref =
      details.frameId === 0 && isHttpUrl(details.url)
        ? ctrMarkerRef(details.url)
        : null;
    if (ref === null || details.tabId < 0) return Promise.resolve(null);
    const now = Date.now();
    deleteWhere(this.decisions, (entry) => now - entry.at > DECISION_TTL_MS);
    // Per navigation (both onBeforeNavigate listeners see the same event), never reused by a later navigation.
    const key = `${details.tabId} ${details.timeStamp ?? now} ${details.url}`;
    const cached = this.decisions.get(key);
    if (cached) return cached.decision;
    const decision = this.decide(details, ref, now);
    this.decisions.set(key, { at: now, decision });
    return decision;
  }

  private async decide(
    details: NavigationDetails,
    ref: string,
    now: number,
  ): Promise<ContainerId | null> {
    const { log } = this.d;
    await this.d.ready();
    if (this.d.tabs.get(details.tabId)) {
      log(
        "warn",
        `#ctr marker ignored: tab ${details.tabId} is already in a container`,
      );
      return null;
    }
    const container = this.d.containers.resolve(ref);
    if (!container) {
      log("warn", `#ctr marker names no container: ${ref}`);
      return null;
    }
    const start = await this.mainFrameStart(
      details.tabId,
      details.url,
      details.timeStamp ?? now,
    );
    if (!start) {
      log(
        "warn",
        `#ctr marker ignored: no request seen for the navigation in tab ${details.tabId}`,
      );
      return null;
    }
    // No initiator: the browser itself (address bar, bookmark, CDP). An extension origin: an extension's
    // tabs.update (agents such as Claude in Chrome, SplitSession's own pages); pages cannot borrow that origin.
    if (
      start.initiator !== undefined &&
      !start.initiator.startsWith("chrome-extension://")
    ) {
      log(
        "warn",
        `#ctr marker ignored: the navigation was started by ${start.initiator}, not by the browser`,
      );
      return null;
    }
    return container.id;
  }

  /** The main-frame request of a navigation (same URL without fragment, started at or after `since`). */
  private async mainFrameStart(
    tabId: number,
    url: string,
    since: number,
  ): Promise<MainFrameStart | null> {
    const target = withoutFragment(url);
    const find = () =>
      (this.mainFrameStarts.get(tabId) ?? [])
        .filter((s) => s.url === target && s.at >= since - 50)
        .at(-1) ?? null;
    return this.mainFrameWakeups.until(find, CTR_INITIATOR_WAIT_MS, find);
  }

  /** Assign the tab to the marker's container, drop the marker, navigate again (workers of the origin removed first). */
  async apply(
    tabId: number,
    url: string,
    containerId: ContainerId,
  ): Promise<void> {
    const hashAt = url.indexOf("#");
    const fragment = url.slice(hashAt + 1);
    const rest = fragment.replace(CTR_MARKER, "").replace(/^&/, "");
    const clean = url.slice(0, hashAt) + (rest ? `#${rest}` : "");
    try {
      this.d.detector.suppress(tabId);
      await this.d.assign(tabId, containerId);
      await this.d.prepareNavigation(clean);
      await this.d.b.tabs.update(tabId, { url: clean });
      this.d.log("info", `#ctr marker put tab ${tabId} into ${containerId}`);
    } catch (error) {
      this.d.log("error", "#ctr marker failed", String(error));
    }
  }
}
