import { browser } from "wxt/browser";

import type { StorageAreaLike } from "../../engine/storage/storage-area";
import type { Logger } from "../log";
import { hasNativeMessaging } from "./native-permission";

type Browser = typeof browser;

/**
 * The store build gets `nativeMessaging` at run time, and a service worker that was already running keeps the API object it
 * had before the grant: `permissions.contains` says yes while `runtime.connectNative` stays undefined (Chromium builds the API
 * object once per context and leaves out what was unavailable then). A new worker context fixes it, and the way to get one
 * is to restart the extension, once. This file decides when and does it; nothing else in the extension reloads itself.
 */

/** `storage.local` (not session: the reload clears that): written just before our own reload, consumed by the next start. */
export const RESTART_MARKER_KEY = "bridgeNativeRestart";
/** `storage.local`: a restart did not help. No further reload until the API shows up (Chrome restarted) or the grant goes. */
export const RESTART_FAILED_KEY = "bridgeNativeRestartFailed";
/**
 * An alarm set just before the reload. The restarted extension has no page open (the reload closed them all) and a service
 * worker may stay unstarted until some event reaches it; the alarm is that event, so the reopen does not wait for the user's next tab action.
 */
export const RESTART_WAKE_ALARM = "facet-bridge-restart-wake";
const RESTART_WAKE_DELAY_MIN = 0.1;
/** A marker older than this is not from the reload we asked for (Chrome was closed in between): no reopen. */
export const RESTART_MARKER_MAX_AGE_MS = 2 * 60_000;

/** The status text while the extension is about to restart. */
export const RESTARTING_TEXT =
  "SplitSession restarts once to finish turning on the agent bridge";
export const NOT_GRANTED_TEXT =
  "Chrome has not granted SplitSession the permission to talk to a program on this computer (nativeMessaging)";
export const RESTART_CHROME_TEXT =
  "Chrome has not made the permission available to the running extension, even after SplitSession restarted. Quit and reopen Chrome";

/** What the bridge does when `runtime.connectNative` is missing. */
export type MissingApi = "not-granted" | "restart" | "give-up";

/**
 * Pure decision. Not granted: the user (or Chrome) has not given the permission, nothing to restart for. Granted but the API
 * missing: this worker predates the grant, restart once. Restarted already (this worker is the one our reload made, or an
 * earlier restart failed) and still missing: never again, the user restarts Chrome.
 */
export function decideMissingApi(s: {
  granted: boolean;
  cameBackFromRestart: boolean;
  gaveUp: boolean;
}): MissingApi {
  if (!s.granted) return "not-granted";
  return s.cameBackFromRestart || s.gaveUp ? "give-up" : "restart";
}

export class NativeRestart {
  /** This worker is the one started by our own reload (a fresh marker was found at start). */
  private cameBack = false;

  constructor(
    private readonly b: Pick<
      Browser,
      "runtime" | "tabs" | "windows" | "alarms"
    > & {
      permissions?: Browser["permissions"];
    },
    private readonly area: StorageAreaLike,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
    /** Runs first when the restart is ours: the reload wiped what keeps container tabs isolated. */
    private readonly afterOwnReload: () => Promise<void> = async () => {},
  ) {}

  /**
   * First thing at worker start. A fresh marker means the previous worker restarted the extension for the bridge: the
   * reload closed the options page the user was on, so open it again at "For AI agents". The marker is consumed here,
   * which is what makes the reload one-shot.
   */
  async start(): Promise<void> {
    let at: unknown;
    void this.b.alarms.clear(RESTART_WAKE_ALARM);
    try {
      at = (await this.area.get(RESTART_MARKER_KEY))[RESTART_MARKER_KEY];
      if (at === undefined) return;
      await this.area.remove(RESTART_MARKER_KEY);
    } catch (error) {
      this.log(
        "warn",
        "agent bridge: restart marker unreadable",
        String(error),
      );
      return;
    }
    if (typeof at !== "number" || this.now() - at > RESTART_MARKER_MAX_AGE_MS)
      return;
    this.cameBack = true;
    this.log("info", "agent bridge: restarted to finish turning on");
    // Before the page is reopened and the bridge connects. `onInstalled` is not relied on to do this for a reload.
    await this.afterOwnReload().catch((error) =>
      this.log(
        "warn",
        "agent bridge: could not restore container tabs after the restart",
        String(error),
      ),
    );
    await this.reopenOptions().catch((error) =>
      this.log(
        "warn",
        "agent bridge: could not reopen settings",
        String(error),
      ),
    );
  }

  /** The API is there (or the permission is not): a later missing API is a new situation, so a failed restart is forgotten. */
  async settled(): Promise<void> {
    try {
      if ((await this.area.get(RESTART_FAILED_KEY))[RESTART_FAILED_KEY])
        await this.area.remove(RESTART_FAILED_KEY);
    } catch {
      /* best effort */
    }
  }

  /** Whether a missing `connectNative` means "not granted", "restart once" or "give up". Records a give-up. */
  async decide(): Promise<MissingApi> {
    const granted = await hasNativeMessaging(this.b);
    if (!granted) {
      await this.settled();
      return "not-granted";
    }
    let gaveUp = false;
    try {
      gaveUp = !!(await this.area.get(RESTART_FAILED_KEY))[RESTART_FAILED_KEY];
    } catch {
      /* unreadable: treated as not given up, the marker below still keeps it to one reload per start */
    }
    const outcome = decideMissingApi({
      granted,
      cameBackFromRestart: this.cameBack,
      gaveUp,
    });
    if (outcome === "give-up" && !gaveUp) {
      await this.area.set({ [RESTART_FAILED_KEY]: true }).catch(() => {});
      this.log(
        "error",
        "agent bridge: nativeMessaging is granted but connectNative is still missing after a restart; Chrome has to be restarted",
      );
    }
    return outcome;
  }

  /** Marker first (a failed write means no reload at all), then the reload. The page is gone a moment later. */
  async restart(): Promise<void> {
    await this.area.set({ [RESTART_MARKER_KEY]: this.now() });
    this.log(
      "info",
      "agent bridge: nativeMessaging was granted after this worker started; restarting the extension once",
    );
    await this.b.alarms
      .create(RESTART_WAKE_ALARM, { delayInMinutes: RESTART_WAKE_DELAY_MIN })
      .catch(() => {});
    this.b.runtime.reload();
  }

  /** The options page at "For AI agents": an options tab that is still open is reused, else a new one. */
  private async reopenOptions(): Promise<void> {
    const base = this.b.runtime.getURL("/options.html" as never);
    const url = `${base}#agent`;
    const open = (await this.b.tabs.query({ url: `${base}*` })).find(
      (t) => t.id !== undefined,
    );
    if (open?.id !== undefined) {
      await this.b.tabs.update(open.id, { url, active: true });
      if (open.windowId !== undefined)
        await this.b.windows.update(open.windowId, { focused: true });
    } else {
      await this.b.tabs.create({ url });
    }
  }
}
