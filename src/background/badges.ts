import {
  AGENT_COLOR,
  AGENT_DIM_COLOR,
  type Container,
  CONTAINER_HEX,
  type ContainerId,
  mixHex,
  readableTextColor,
} from "../core";

/** Sum of the channel differences of two `#rrggbb` colours (0 equal, 765 black against white). */
function colorDistance(a: string, b: string): number {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  return [16, 8, 0].reduce(
    (sum, shift) =>
      sum + Math.abs(((pa >> shift) & 255) - ((pb >> shift) & 255)),
    0,
  );
}

export interface ActionApi {
  setBadgeText(details: { tabId?: number; text: string }): Promise<void>;
  setBadgeBackgroundColor(details: {
    tabId?: number;
    color: string;
  }): Promise<void>;
  setBadgeTextColor?(details: { tabId?: number; color: string }): Promise<void>;
  setTitle?(details: { tabId?: number; title: string }): Promise<void>;
}

/** The dot on plain tabs while the agent bridge is on: the agent purple, as everywhere else the agent shows. */
export const BRIDGE_DOT_COLOR = AGENT_COLOR;
/** The badge of a tab that waits for the user to choose its container (restore): bright, on purpose. */
export const HELD_COLOR = "#ef2d2d";

/** One blink step: four steps (bright, half, dim, half) make a cycle of 0.5 s, "about twice a second", and stay smooth. */
export const BLINK_STEP_MS = 125;
/** Per step: how far the dot is toward its other colour. */
const BLINK_STEPS = [0, 0.5, 1, 0.5] as const;

/** How long a notice ("moved to …") replaces the container's colour dot on the badge. */
export const NOTICE_MS = 4_000;

/**
 * Per-tab toolbar badge: a dot in the container's colour (no letters: initials such as "12" for a container named
 * "123" read as a count); cleared for plain tabs. Chrome resets tab-specific action state on navigation, so the
 * background re-applies it after each commit.
 *
 * The dot is a badge whose text is one space: Chrome draws the rounded badge in `setBadgeBackgroundColor` and does not
 * collapse whitespace-only text (only the empty string clears it). A bullet glyph in the same colour as the badge would
 * draw the same pill, and a visible one would be a dot inside a pill, so the space is the simplest option.
 *
 * While the agent bridge is on, plain tabs show the same kind of dot in the agent purple; container tabs keep their
 * container's colour. While the agent works with a tab (`startBlink`/`stopBlink`, driven by the activity display), the
 * dot of that tab blinks: purple and a lighter purple on plain tabs, the container's colour and purple on container tabs,
 * about twice a second. The timer lives only while a tab blinks and goes with `stopBlink`, `forget` or `stopAllBlinks`.
 */
export class BadgeIndicator {
  /** Per tab: a notice shown instead of the usual badge until `until` (survives the re-application after navigation). */
  private readonly notices = new Map<
    number,
    { text: string; title: string; until: number }
  >();

  /** Tabs whose dot blinks now, with the step they are on. */
  private readonly blinks = new Map<
    number,
    { step: number; timer: ReturnType<typeof setInterval> }
  >();

  constructor(
    private readonly action: ActionApi,
    private readonly lookup: {
      containerOf(tabId: number): ContainerId | null;
      container(id: ContainerId): Container | undefined;
      /** The agent bridge switch. */
      bridgeOn?(): boolean;
      /** Tabs waiting for the user to choose a container after a restore. */
      isHeld?(tabId: number): boolean;
      heldCount?(): number;
    },
  ) {}

  /** The default for tabs without their own badge, and the button's tooltip. */
  async applyGlobal(): Promise<void> {
    const on = __FULL__ && (this.lookup.bridgeOn?.() ?? false);
    const held = this.lookup.heldCount?.() ?? 0;
    try {
      const color = on ? BRIDGE_DOT_COLOR : held > 0 ? HELD_COLOR : null;
      await this.action.setBadgeText({ text: on ? " " : held > 0 ? "!" : "" });
      if (color) {
        await this.action.setBadgeBackgroundColor({ color });
        await this.action.setBadgeTextColor?.({
          color: readableTextColor(color),
        });
      }
      await this.action.setTitle?.({ title: this.globalTitle() });
    } catch {
      /* the action API is unavailable (tests) */
    }
  }

  /** The button's tooltip for tabs without their own. */
  private globalTitle(): string {
    const on = __FULL__ && (this.lookup.bridgeOn?.() ?? false);
    const held = this.lookup.heldCount?.() ?? 0;
    const notes = [
      ...(on
        ? [
            "agent bridge ON (purple dot): an agent has full access to your tabs",
          ]
        : []),
      ...(held > 0
        ? [
            `${held === 1 ? "1 tab is" : `${held} tabs are`} waiting for you to choose a container (open SplitSession)`,
          ]
        : []),
    ];
    return notes.length > 0
      ? `SplitSession — ${notes.join("; ")}`
      : "SplitSession";
  }

  /**
   * A short message on the tab's button: an arrow on the container's colour, and "<message>" as the tooltip, for
   * `ms`; then the usual badge comes back. Used when SplitSession moved the tab into a container by itself.
   */
  async notice(tabId: number, message: string, ms = NOTICE_MS): Promise<void> {
    if (tabId < 0) return;
    this.notices.set(tabId, {
      text: "→",
      title: `SplitSession — ${message}`,
      until: Date.now() + ms,
    });
    await this.apply(tabId);
    setTimeout(() => {
      const current = this.notices.get(tabId);
      if (current && current.until <= Date.now()) void this.apply(tabId); // apply() ends the notice and restores the tooltip
    }, ms + 50);
  }

  /**
   * The agent works with this tab: its dot blinks until `stopBlink`. Nothing when the bridge is off (no dot to blink),
   * and a no-op when the tab already blinks (the caller re-arms its own end timer).
   */
  startBlink(tabId: number): void {
    if (!__FULL__ || tabId < 0 || this.blinks.has(tabId)) return;
    if (!(this.lookup.bridgeOn?.() ?? false)) return;
    const timer = setInterval(() => {
      const blink = this.blinks.get(tabId);
      if (!blink) return;
      blink.step = (blink.step + 1) % BLINK_STEPS.length;
      void this.apply(tabId);
    }, BLINK_STEP_MS);
    this.blinks.set(tabId, { step: 0, timer });
    void this.apply(tabId);
  }

  /** The agent is done with the tab (or the tab is gone): the timer stops and the idle dot comes back. */
  async stopBlink(tabId: number): Promise<void> {
    if (!this.endBlink(tabId)) return;
    await this.apply(tabId);
  }

  /** The tab closed: only the timer goes (there is no badge to restore). */
  forget(tabId: number): void {
    this.endBlink(tabId);
    this.notices.delete(tabId);
  }

  /** Every blink ends (the bridge or the setting went off); the idle dots (if any) come back. */
  async stopAllBlinks(): Promise<void> {
    const tabs = [...this.blinks.keys()];
    for (const tabId of tabs) this.endBlink(tabId);
    await this.applyMany(tabs);
  }

  /** Tabs that blink right now (tests). */
  blinkingTabs(): number[] {
    return [...this.blinks.keys()];
  }

  private endBlink(tabId: number): boolean {
    const blink = this.blinks.get(tabId);
    if (!blink) return false;
    clearInterval(blink.timer);
    this.blinks.delete(tabId);
    return true;
  }

  /** Sets or clears the badge of one tab. Never throws (the tab may be gone). */
  async apply(tabId: number): Promise<void> {
    if (tabId < 0) return;
    const id = this.lookup.containerOf(tabId);
    const container = id === null ? undefined : this.lookup.container(id);
    const on = __FULL__ && (this.lookup.bridgeOn?.() ?? false);
    if (!on) this.endBlink(tabId); // the bridge went off: nothing blinks
    const blink = this.blinks.get(tabId);
    const t = blink ? BLINK_STEPS[blink.step]! : 0;
    const notice = this.notices.get(tabId);
    if (notice && notice.until <= Date.now()) this.notices.delete(tabId);
    try {
      if (notice && notice.until > Date.now() && container) {
        const color = CONTAINER_HEX[container.color];
        await this.action.setBadgeText({ tabId, text: notice.text });
        await this.action.setBadgeBackgroundColor({ tabId, color });
        await this.action.setBadgeTextColor?.({
          tabId,
          color: readableTextColor(color),
        });
        await this.action.setTitle?.({ tabId, title: notice.title });
        return;
      }
      if (notice)
        await this.action.setTitle?.({ tabId, title: this.globalTitle() });
      if (!container && this.lookup.isHeld?.(tabId)) {
        await this.action.setBadgeText({ tabId, text: "!" });
        await this.action.setBadgeBackgroundColor({ tabId, color: HELD_COLOR });
        await this.action.setBadgeTextColor?.({
          tabId,
          color: readableTextColor(HELD_COLOR),
        });
        await this.action.setTitle?.({
          tabId,
          title:
            "SplitSession — this tab is waiting for you to choose its container",
        });
        return;
      }
      if (!container) {
        await this.action.setBadgeText({ tabId, text: on ? " " : "" });
        if (on) {
          const color = mixHex(BRIDGE_DOT_COLOR, AGENT_DIM_COLOR, t);
          await this.action.setBadgeBackgroundColor({ tabId, color });
          await this.action.setBadgeTextColor?.({
            tabId,
            color: readableTextColor(color),
          });
        }
        return;
      }
      // A colour, not letters: initials like "12" (container "123") read as a count. The bridge adds nothing here: the
      // container's colour is the dot; only a blink moves it toward purple (or the light purple when the container is purple).
      const own = CONTAINER_HEX[container.color];
      const other =
        colorDistance(own, AGENT_COLOR) < 60 ? AGENT_DIM_COLOR : AGENT_COLOR;
      const color = mixHex(own, other, t);
      await this.action.setBadgeText({ tabId, text: " " });
      await this.action.setBadgeBackgroundColor({ tabId, color });
      await this.action.setBadgeTextColor?.({
        tabId,
        color: readableTextColor(color),
      });
    } catch {
      // the tab closed while we were setting its badge
    }
  }

  async applyMany(tabIds: Iterable<number>): Promise<void> {
    await Promise.all([...tabIds].map((id) => this.apply(id)));
  }
}
