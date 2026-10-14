/* eslint-disable @typescript-eslint/no-explicit-any -- this is injected, self-contained page code that duck-types page nodes across realms */
/**
 * The page side of "visible agent activity". `pageActivity` is injected into the top frame of a tab the agent works with
 * (`scripting.executeScript`, ISOLATED world), so it must be SELF-CONTAINED like the functions in inject.ts: no imports,
 * nothing outside its own body. Data it needs (the glyph paths of src/ui/agent-glyphs.ts) arrives in the command.
 *
 * Everything is purple (`AGENT_COLOR`), whatever the tab's container: purple means "the agent is here", the container's
 * own colour stays on the container's UI (groups, badge).
 *
 * An "agent session" on a tab lasts while the debugger is attached to it or the agent touched it within the last ~8 s
 * (activity.ts decides and keeps this page informed with `session` commands, each one a lease: if the background stops
 * renewing it, the page lets go by itself). What the page shows:
 *  - the whole session: a soft vignette along the edges of the viewport, made of gradients only (about 24 px from each
 *    edge fading to transparent, low opacity; no border, outline or shadow, so no line anywhere), `pointer-events: none`,
 *    breathing slowly (opacity 35 % to 100 % on an eased sine, 2.8 s per cycle, phase from the wall clock);
 *  - on each action (`show`, ~3.5 s): a stronger, slightly wider vignette layered on top, a pill in the top-right corner
 *    ("Agent: reading") with a glyph (eye for read tools, pointer for actions), and for click/typing a ring that rises
 *    once at the target element;
 *  - in the tab strip: the favicon becomes a ring of 8 purple dots that rotates (48 frames per revolution at 30 frames a
 *    second, so 1.6 s a turn; the angle is continuous, derived from the wall clock), the leading dot opaque and the others
 *    fading into a tail. Drawn at 64 px, which Chrome scales down to 32 and 16 px. The frames are drawn once per document
 *    and cached. A tab in the background (page timers throttled to a few a second) is driven by `tick` messages from the
 *    service worker instead (activity.ts), which are not throttled; the frame always follows the clock, so both drivers agree.
 * Everything lives in a CLOSED shadow root of one `<facet-agent-overlay>` element on `<html>` (not `<body>`): page
 * scripts can see that the element exists, never what is inside, and it takes no part in layout. Styles are set through
 * the CSSOM and animations through the Web Animations API, so a strict page CSP (`style-src`) cannot block them.
 * The breathing of the base glow is ONE Web Animation per document, created once and never restarted: its phase is a
 * function of the wall clock (negative `delay` = -(Date.now() mod period)), so even a glow that is built again (an element
 * the page removed, a new injection after a worker restart) continues in phase. The action layer (bright glow, pill, ring)
 * is a separate set of elements: it fades in and out on its own wrapper and breathes in the same phase, and never touches
 * the base. A screenshot only toggles `visibility` of the host: no animation is cancelled or restarted by it.
 * Session end: everything fades over ~600 ms. `prefers-reduced-motion`: a static vignette, a static ring of dots, no fades.
 *
 * Favicon: Chrome keeps an icon it already loaded (SVG ones always win) against an extra `<link>`, so the frames are
 * written into the `href`/`type` ATTRIBUTES of the page's existing icon links (no node is removed, moved or replaced) and
 * put back at the end, on a switch-off and on `pagehide`. A value the page sets meanwhile becomes the node's new
 * original; nodes the page removes are forgotten; a page with no icon link gets one appended link of ours.
 * `get_tab_html` serialises the page's own values. The title is never touched.
 *
 * State lives on the isolated world's global (`__facetAgentActivity`), shared by every injection into the same document.
 * `hide`/`unhide` take the overlay out of a screenshot.
 */

import { AGENT_COLOR } from "../../core";
import type { GlyphPart } from "../../ui/agent-glyphs";

export interface ActivityRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ActivityCommand {
  /**
   * `show`: an action (brighter glow, pill, pulse) inside the session; `session`: start or renew the session lease;
   * `end`: the session is over (fade out); `stop`: gone at once (setting or bridge switched off).
   */
  op: "show" | "session" | "end" | "hide" | "unhide" | "inspect" | "stop";
  /** "reading", "clicking", ... (shown as "Agent: <label>"). */
  label: string;
  /** What the tool does: reads, or can change the page ('' for the other ops). */
  kind: "read" | "act" | "";
  /** Milliseconds the action's bright layer stays after this action. */
  ttl: number;
  /** Milliseconds the session lives without another command (the lease). */
  lease: number;
  /** Target rectangle in viewport coordinates, for the pulse. */
  rect: ActivityRect | null;
  /** The glyph paths (src/ui/agent-glyphs.ts); needed by `show` and `session`. */
  glyphs?: Record<"read" | "act", GlyphPart[]>;
}

/** What `inspect` reports (used by the tests: the shadow root is closed, so only this world can look inside). */
export interface ActivityInspection {
  present: boolean;
  text: string;
  rings: number;
  pulses: number;
  /** The rectangle of the latest pulse. */
  lastRect: ActivityRect | null;
  hidden: boolean;
  kind: string;
  fading: boolean;
  /** The steady edge glow is part of the page (the session is on). */
  glow: boolean;
  /** The bright action layer is on. */
  boosted: boolean;
  /** Our animated favicon: its current data: URL, or null when the page's own icons are in place. */
  favicon: string | null;
  /** How many of the page's own icon links carry our frame right now. */
  iconNodes: number;
  /** Frames drawn so far (favicon). */
  iconFrames: number;
  /** How many `tick` messages from the worker drove the favicon (a background tab) in this session. */
  iconTicks: number;
  /** How many times the overlay element was built in this document (it must stay 1 for a whole session). */
  builds: number;
  /** The base glow's animation: the same one throughout (startTime does not change), running. */
  base: {
    startTime: number | null;
    currentTime: number | null;
    playState: string;
  } | null;
  /** What the glow layers are made of: gradients only, so the other counts must be 0 (no line anywhere). */
  glowStyle: {
    layers: number;
    gradients: number;
    borders: number;
    outlines: number;
    shadows: number;
    sizePx: number[];
  };
}

export const OVERLAY_TAG = "facet-agent-overlay";
export const OVERLAY_STATE_KEY = "__facetAgentActivity";
/** The colour of every agent indicator (glow, favicon, pill, toolbar badge): "the agent is here". */
export { AGENT_COLOR };

export async function pageActivity(
  cmd: ActivityCommand,
): Promise<ActivityInspection | boolean> {
  const KEY = "__facetAgentActivity";
  const TAG = "facet-agent-overlay";
  const COLOR = "#8b5cf6";
  const root = document.documentElement;
  const holder = globalThis as unknown as Record<string, any>;
  let s = holder[KEY];

  /** The computed look of the glow layers: gradients, and a count of anything that would draw a line. */
  const glowStyle = (): ActivityInspection["glowStyle"] => {
    const out = {
      layers: 0,
      gradients: 0,
      borders: 0,
      outlines: 0,
      shadows: 0,
      sizePx: [] as number[],
    };
    for (const el of [s?.steady, s?.boostGlow] as Array<
      HTMLElement | undefined
    >) {
      if (!el || !el.isConnected) continue;
      const cs = getComputedStyle(el);
      out.layers++;
      if (/linear-gradient/.test(cs.backgroundImage)) out.gradients++;
      if (
        [
          cs.borderTopWidth,
          cs.borderRightWidth,
          cs.borderBottomWidth,
          cs.borderLeftWidth,
        ].some((w) => parseFloat(w) > 0)
      )
        out.borders++;
      if (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0)
        out.outlines++;
      if (cs.boxShadow !== "none") out.shadows++;
      out.sizePx.push(s.glowSize?.get(el) ?? 0);
    }
    return out;
  };
  const inspection = (): ActivityInspection => ({
    present: !!s && !!s.host && s.host.isConnected,
    text: s?.shadow ? (s.shadow.textContent ?? "") : "",
    rings: s?.shadow ? s.shadow.querySelectorAll("[data-ring]").length : 0,
    pulses: s?.pulses ?? 0,
    lastRect: s?.lastRect ?? null,
    hidden:
      !!s?.host && s.host.style.getPropertyValue("visibility") === "hidden",
    kind: s?.kind ?? "",
    fading: !!s?.fading,
    glow: !!s?.steady?.isConnected,
    boosted: !!s?.boosted,
    favicon: s?.icon && !s.icon.gaveUp ? s.icon.frame || null : null,
    iconNodes: s?.icon?.tracked?.size ?? 0,
    iconFrames: s?.icon?.frames ?? s?.iconFramesTotal ?? 0,
    iconTicks: s?.icon?.ticks ?? s?.iconTicksTotal ?? 0,
    builds: s?.builds ?? 0,
    base: s?.base
      ? {
          startTime: s.base.startTime as number | null,
          currentTime: s.base.currentTime as number | null,
          playState: s.base.playState as string,
        }
      : null,
    glowStyle: glowStyle(),
  });
  if (cmd.op === "inspect") return inspection();
  if (!root) return false;

  const reduced =
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;
  /**
   * Favicon: 48 frames per revolution of the dots, 1.6 s a turn = 30 frames a second. Measured (e2e/zz, Chromium 156): Chrome
   * reports a changed icon `href` up to 60 times a second, so the browser is not the limit; the frame follows the wall clock.
   */
  const ICON_STEPS = 48;
  const ICON_REV_MS = 1600;
  /** The page's own timer (a visible tab); a hidden tab's timers are throttled, the worker's `tick` messages cover it. */
  const ICON_POLL_MS = 20;
  const ICON_DOTS = 8;
  /** Breathing of the glow: one full cycle (up and down) in this many ms; the phase is a function of the clock. */
  const BREATH_MS = 2800;
  const ICON_PX = 64;
  /** Easing of every breath: a sine. */
  const SINE = "cubic-bezier(0.37, 0, 0.63, 1)";

  // ---------------------------------------------------------------- hide / unhide (screenshots)
  if (cmd.op === "hide" || cmd.op === "unhide") {
    if (!s || !s.host) return false;
    if (cmd.op === "hide") {
      s.host.style.setProperty("visibility", "hidden", "important");
      // Let the compositor present a frame without the overlay before the caller captures; a tab that is not drawn
      // (hidden window) never fires animation frames, hence the timeout.
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        setTimeout(done, 160);
        requestAnimationFrame(() => requestAnimationFrame(done));
      });
    } else {
      s.host.style.removeProperty("visibility");
    }
    return true;
  }

  // ---------------------------------------------------------------- colours
  const rgb = (hex: string): [number, number, number] => {
    const m =
      /^#?([0-9a-f]{6})$/i.exec(hex) ?? /^#?([0-9a-f]{6})$/i.exec(COLOR)!;
    const n = parseInt(m[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const rgba = (hex: string, a: number): string => {
    const [r, g, b] = rgb(hex);
    return `rgba(${r},${g},${b},${a})`;
  };
  /** A darker shade of the colour (the pill must carry white text and a white glyph). */
  const shade = (hex: string, k: number): string => {
    const [r, g, b] = rgb(hex);
    return `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})`;
  };
  // ---------------------------------------------------------------- favicon
  // The `href` (and `type`) ATTRIBUTE of each existing icon link (`rel` has the `icon` token, `shortcut icon` included,
  // `apple-touch-icon` excluded) is set to the current frame and put back afterwards. The page keeps ownership: a link
  // whose href/type the page changes meanwhile has the page's value as its new "original" (our frame goes on top of it
  // again), a link the page removes or retags is forgotten (after getting its own values back), and at the end each node
  // gets the latest page-owned value. A page with no icon link at all gets one link of ours, appended and removed alone.
  // A final sweep makes sure none of our frames (data: URLs) is left in any link.
  const ICON_ATTR = "data-facet-agent-icon";
  const MAX_CHANGES = 80; // page-side rewrites we answer within 10 s: a page that fights back gets its icons left alone
  const isIconLink = (n: Node): n is HTMLLinkElement =>
    n instanceof HTMLLinkElement &&
    /(^|\s)icon(\s|$)/i.test(n.getAttribute("rel") ?? "");
  const iconLinks = (): HTMLLinkElement[] =>
    Array.from(document.querySelectorAll("link")).filter(
      (l) => isIconLink(l) && !l.hasAttribute(ICON_ATTR),
    );
  const isOurs = (href: string | null): boolean =>
    !!href && !!s.icon && s.icon.recent.has(href);
  const setAttr = (n: Element, name: string, value: string | null): void => {
    if (value === null) n.removeAttribute(name);
    else n.setAttribute(name, value);
  };
  /** Puts a node's attributes back to the page-owned values, except those the page has changed since we wrote ours. */
  const restoreNode = (n: HTMLLinkElement, rec: any): void => {
    if (n.getAttribute("href") === rec.wrote.href)
      setAttr(n, "href", rec.orig.href);
    if (n.getAttribute("type") === rec.wrote.type)
      setAttr(n, "type", rec.orig.type);
  };
  /** Records what the page has now as the node's own values (a value that is one of our frames, copied by the page, is not). */
  const takeOwn = (n: HTMLLinkElement, rec: any): boolean => {
    let changed = false;
    const href = n.getAttribute("href");
    if (href !== rec.wrote.href) {
      rec.orig.href = isOurs(href) ? s.icon.fallback : href;
      changed = true;
    }
    const type = n.getAttribute("type");
    if (type !== rec.wrote.type) {
      rec.orig.type = type;
      changed = true;
    }
    return changed;
  };
  /** The worker's `tick` messages (a background tab's driver) stop with the animation. */
  const dropTickListener = (ic: any): void => {
    if (!ic.onTick) return;
    try {
      (
        globalThis as unknown as {
          chrome?: {
            runtime?: { onMessage?: { removeListener(l: unknown): void } };
          };
        }
      ).chrome?.runtime?.onMessage?.removeListener(ic.onTick);
    } catch {
      // an orphaned world: nothing to remove from
    }
    ic.onTick = null;
  };
  const giveUpIcon = (): void => {
    const ic = s.icon;
    if (!ic || ic.gaveUp) return;
    ic.gaveUp = true;
    clearInterval(ic.timer);
    dropTickListener(ic);
    ic.observer?.disconnect();
    for (const [n, rec] of ic.tracked) restoreNode(n, rec);
    ic.tracked.clear();
    ic.ours.remove();
  };
  /** Brings the document in line with the current frame: adopts the page's changes, forgets nodes it took away, applies the frame. */
  const syncIcon = (): void => {
    const ic = s.icon;
    if (!ic || ic.gaveUp) return;
    let changes = 0;
    for (const [n, rec] of Array.from(ic.tracked) as Array<
      [HTMLLinkElement, any]
    >) {
      if (!n.isConnected || !isIconLink(n)) {
        restoreNode(n, rec); // gone (or no longer an icon): it keeps its own values if the page ever brings it back
        ic.tracked.delete(n);
        changes++;
      } else if (takeOwn(n, rec)) {
        changes++;
      }
    }
    for (const n of iconLinks()) {
      if (ic.tracked.has(n)) continue;
      const href = n.getAttribute("href");
      if (ic.fallback === null && !isOurs(href)) ic.fallback = href;
      ic.tracked.set(n, {
        orig: {
          href: isOurs(href) ? ic.fallback : href,
          type: n.getAttribute("type"),
        },
        wrote: { href: null, type: null },
      });
      changes++;
    }
    const now = Date.now();
    for (let i = 0; i < changes; i++) ic.changeTimes.push(now);
    ic.changeTimes = ic.changeTimes.filter((t: number) => now - t < 10_000);
    if (ic.changeTimes.length > MAX_CHANGES) {
      giveUpIcon();
      return;
    }
    if (!ic.frame) return;
    if (ic.tracked.size === 0) {
      // No icon link of the page's: one of ours (Chrome shows it on a page that has no icon).
      if (!ic.ours.isConnected) (document.head ?? root).appendChild(ic.ours);
    } else if (ic.ours.isConnected) {
      ic.ours.remove();
    }
    if (ic.ours.getAttribute("href") !== ic.frame)
      ic.ours.setAttribute("href", ic.frame); // (a same-value write is still a mutation: the observer would loop)
    for (const [n, rec] of ic.tracked as Map<HTMLLinkElement, any>) {
      if (n.getAttribute("href") !== ic.frame) n.setAttribute("href", ic.frame);
      if (n.getAttribute("type") !== "image/png")
        n.setAttribute("type", "image/png");
      rec.wrote = { href: ic.frame, type: "image/png" };
    }
  };
  /**
   * One frame: a ring of dots, the leading one opaque and the others fading into a tail behind it. The head's angle is
   * continuous (48 steps a turn, 6 per dot spacing), so the ring turns smoothly instead of jumping from slot to slot. With
   * reduced motion there is only the first frame.
   */
  const renderFrame = (ic: any, step: number): string | null => {
    const ctx = (ic.canvas as HTMLCanvasElement).getContext("2d");
    if (!ctx) return null;
    ctx.clearRect(0, 0, ICON_PX, ICON_PX);
    const c = ICON_PX / 2;
    const ring = ICON_PX * 0.345;
    const head = (2 * Math.PI * step) / ICON_STEPS;
    for (let k = ICON_DOTS - 1; k >= 0; k--) {
      const t = k / (ICON_DOTS - 1); // 0: the head, 1: the end of the tail
      const angle = head - (2 * Math.PI * k) / ICON_DOTS;
      ctx.beginPath();
      ctx.arc(
        c + ring * Math.sin(angle),
        c - ring * Math.cos(angle),
        ICON_PX * (0.102 - 0.036 * t),
        0,
        2 * Math.PI,
      );
      ctx.fillStyle = rgba(ic.color, 1 - 0.85 * t);
      ctx.fill();
    }
    try {
      return ic.canvas.toDataURL("image/png");
    } catch {
      return null;
    }
  };
  /** The step of the revolution the wall clock is at: every driver (the page's timer, the worker's ticks) agrees on it. */
  const stepNow = (): number =>
    Math.floor(((Date.now() % ICON_REV_MS) / ICON_REV_MS) * ICON_STEPS) %
    ICON_STEPS;
  const drawIcon = (): void => {
    const ic = s.icon;
    if (!ic || ic.gaveUp) return;
    let href: string | undefined = ic.cache.get(ic.step);
    if (!href) {
      href = renderFrame(ic, ic.step) ?? undefined;
      if (!href) return;
      ic.cache.set(ic.step, href); // drawn once per document and colour: a frame is only a lookup from then on
    }
    ic.frame = href;
    ic.recent.add(href);
    if (ic.recent.size > 128) ic.recent.delete(ic.recent.values().next().value);
    ic.frames += 1;
    syncIcon();
  };
  /** Moves the icon to the frame the clock says (nothing to do while it is already there). */
  const advanceIcon = (): void => {
    const ic = s?.icon;
    if (!ic || ic.gaveUp) return;
    if (orphaned()) {
      teardown();
      return;
    }
    const step = stepNow();
    if (step === ic.step && ic.frame) return;
    ic.step = step;
    drawIcon();
  };
  /** The extension was reloaded or removed: this world is orphaned, so nothing of ours may be left in the page. */
  const orphaned = (): boolean => {
    const rt = (
      globalThis as unknown as { chrome?: { runtime?: { id?: string } } }
    ).chrome?.runtime;
    return !!rt && !rt.id;
  };
  const startIcon = (): void => {
    if (s.icon) {
      syncIcon();
      return;
    }
    const ours = document.createElement("link");
    ours.setAttribute("rel", "icon");
    ours.setAttribute("type", "image/png");
    ours.setAttribute(ICON_ATTR, "");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = ICON_PX;
    const cache =
      (
        (holder.__facetAgentFrames ??= new Map<
          string,
          Map<number, string>
        >()) as Map<string, Map<number, string>>
      ).get(COLOR) ?? new Map<number, string>();
    (holder.__facetAgentFrames as Map<string, Map<number, string>>).set(
      COLOR,
      cache,
    );
    s.icon = {
      ours,
      canvas,
      color: COLOR,
      step: reduced ? 0 : stepNow(),
      frames: 0,
      ticks: 0,
      changeTimes: [],
      timer: 0,
      onTick: null,
      observer: null,
      tracked: new Map(),
      recent: new Set<string>(),
      cache,
      frame: "",
      fallback: null,
      gaveUp: false,
    };
    // The page changes, adds, retags or removes an icon link meanwhile: its value is the new original, ours goes on top.
    // (Our own frame writes are mutation records too; those are not the page's doing and need no second sync.)
    s.icon.observer = new MutationObserver((records) => {
      const ic = s?.icon;
      if (!ic || ic.gaveUp) return;
      const own = records.every((r) => {
        if (
          r.type !== "attributes" ||
          (r.attributeName !== "href" && r.attributeName !== "type")
        )
          return false;
        const t = r.target as HTMLLinkElement;
        if (t === ic.ours) return true;
        const rec = ic.tracked.get(t);
        return (
          !!rec &&
          t.getAttribute(r.attributeName) === rec.wrote[r.attributeName]
        );
      });
      if (!own) syncIcon();
    });
    s.icon.observer.observe(document.head ?? root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["rel", "href", "type"],
    });
    if (document.head && document.head !== root)
      s.icon.observer.observe(root, { childList: true });
    drawIcon();
    if (!reduced) {
      s.icon.timer = setInterval(advanceIcon, ICON_POLL_MS);
      // A tab in the background: its timers run a few times a second, the worker's `tick` messages do not wait for them.
      try {
        const onMessage = (
          globalThis as unknown as {
            chrome?: {
              runtime?: { onMessage?: { addListener(l: unknown): void } };
            };
          }
        ).chrome?.runtime?.onMessage;
        s.icon.onTick = (m: unknown): undefined => {
          if (
            (m as { facetAgentTick?: number } | null)?.facetAgentTick &&
            s?.icon
          ) {
            s.icon.ticks += 1;
            advanceIcon();
          }
          return undefined;
        };
        onMessage?.addListener(s.icon.onTick);
      } catch {
        s.icon.onTick = null;
      }
    }
  };
  /** Gives every icon link its page-owned values back and removes our own link; idempotent. */
  const stopIcon = (): void => {
    const ic = s.icon;
    if (!ic) return;
    clearInterval(ic.timer);
    ic.timer = 0;
    dropTickListener(ic);
    if (!ic.gaveUp) {
      ic.observer?.takeRecords();
      // What the page did in the last instant counts: adopt it, then put every node back to its own latest values.
      for (const [n, rec] of ic.tracked as Map<HTMLLinkElement, any>)
        takeOwn(n, rec);
      for (const [n, rec] of ic.tracked as Map<HTMLLinkElement, any>)
        restoreNode(n, rec);
    }
    ic.observer?.disconnect();
    ic.tracked.clear();
    ic.ours.remove(); // the only node that was ever ours
    // Final sweep: none of our frames may stay in any link (a page that copied one, a node we lost track of).
    for (const l of Array.from(document.querySelectorAll("link"))) {
      const href = l.getAttribute("href");
      if (isOurs(href)) setAttr(l, "href", ic.fallback);
    }
    s.iconFramesTotal = ic.frames;
    s.iconTicksTotal = ic.ticks;
    s.icon = null;
  };

  // ---------------------------------------------------------------- overlay
  const SVG_NS = "http://www.w3.org/2000/svg";
  /** Puts the glyph of `kind` (inline SVG, white) into the pill. */
  const setGlyph = (kind: string): void => {
    const box = s.glyphBox as HTMLElement | null;
    const parts: GlyphPart[] = s.glyphs?.[kind] ?? [];
    if (!box || s.glyphKind === kind) return;
    s.glyphKind = kind;
    box.textContent = "";
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "18");
    svg.setAttribute("height", "18");
    svg.setAttribute("aria-hidden", "true");
    for (const part of parts) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", part.d);
      if (part.mode === "fill") {
        path.setAttribute("fill", "#fff");
      } else {
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", "#fff");
        path.setAttribute("stroke-width", String(part.w ?? 2));
        path.setAttribute("stroke-linecap", "round");
        path.setAttribute("stroke-linejoin", "round");
      }
      svg.appendChild(path);
    }
    box.appendChild(svg);
  };
  /**
   * A vignette along the four edges made of gradients alone: `size` px from each edge, `alpha` at the edge, eased down to
   * nothing (several stops, so it has no visible end). No border, outline or shadow: there is no line anywhere.
   */
  const vignette = (el: HTMLElement, size: number, alpha: number): void => {
    const fade = (to: string): string =>
      `linear-gradient(${to}, ${rgba(COLOR, alpha)} 0%, ${rgba(COLOR, alpha * 0.55)} 22%, ${rgba(COLOR, alpha * 0.25)} 48%, ${rgba(COLOR, alpha * 0.07)} 76%, ${rgba(COLOR, 0)} 100%)`;
    const st = el.style;
    st.backgroundImage = [
      fade("to bottom"),
      fade("to top"),
      fade("to right"),
      fade("to left"),
    ].join(",");
    st.backgroundSize = [
      `100% ${size}px`,
      `100% ${size}px`,
      `${size}px 100%`,
      `${size}px 100%`,
    ].join(",");
    st.backgroundPosition = ["top", "bottom", "left", "right"].join(",");
    st.backgroundRepeat = "no-repeat";
    s.glowSize.set(el, size);
  };
  /** Applies the colour to the glow layers and the pill. */
  const paint = (): void => {
    vignette(s.steady, 26, 0.3);
    vignette(s.boostGlow, 34, 0.55);
    s.pill.style.background = shade(COLOR, 0.8);
  };
  const build = (): void => {
    const host = document.createElement(TAG);
    host.setAttribute("data-facet-agent", "");
    host.setAttribute("aria-hidden", "true"); // not part of the page for screen readers, nor for the agent's snapshot
    host.style.cssText =
      "all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;display:block!important;";
    const shadow = host.attachShadow({ mode: "closed" });

    const steady = document.createElement("div");
    steady.style.cssText = "position:fixed;inset:0;pointer-events:none;";
    const boostWrap = document.createElement("div");
    boostWrap.style.cssText =
      "position:fixed;inset:0;pointer-events:none;opacity:0;";
    const boostGlow = document.createElement("div");
    boostGlow.style.cssText = "position:fixed;inset:0;pointer-events:none;";
    const pill = document.createElement("div");
    // System font on purpose: the page's closed shadow root could only load Inter through chrome.runtime.getURL, which needs
    // web_accessible_resources, and that lets any page probe whether SplitSession is installed. Not worth it for one label.
    pill.style.cssText =
      "position:fixed;top:12px;right:12px;display:flex;align-items:center;gap:8px;padding:6px 12px 6px 10px;border-radius:999px;pointer-events:none;" +
      'color:#fff;font:600 14px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:0;box-shadow:0 2px 10px rgba(0,0,0,.35);white-space:nowrap;';
    const glyphBox = document.createElement("span");
    glyphBox.style.cssText = "display:flex;width:18px;height:18px;";
    const text = document.createElement("span");
    pill.append(glyphBox, text);
    boostWrap.append(boostGlow, pill);
    const layer = document.createElement("div");
    layer.style.cssText = "position:fixed;inset:0;pointer-events:none;";
    shadow.append(steady, boostWrap, layer);
    root.appendChild(host);

    s.host = host;
    s.shadow = shadow;
    s.text = text;
    s.layer = layer;
    s.steady = steady;
    s.boostWrap = boostWrap;
    s.boostGlow = boostGlow;
    s.pill = pill;
    s.glyphBox = glyphBox;
    s.glyphKind = "";
    s.builds += 1;
    paint();
    if (reduced) steady.style.opacity = "0.7";
    ensureBreathing();
    watchHost();
  };
  /**
   * The breathing of the glow: 35 % to 100 % of its (low) intensity, 2.8 s a cycle, on an eased sine; the action layer
   * breathes in the same phase (40 % to 100 %). The phase is the wall clock's (a negative delay), so an animation that has to
   * be created again joins the cycle where it would be instead of starting from zero. It is created once per element and
   * only checked afterwards: nothing in a session restarts it.
   */
  const ensureBreathing = (): void => {
    if (reduced || !s.steady) return;
    const breathe = (
      el: HTMLElement,
      from: number,
      current: Animation | null,
    ): Animation => {
      if (
        current &&
        current.playState === "running" &&
        (current.effect as KeyframeEffect | null)?.target === el
      )
        return current;
      current?.cancel();
      return el.animate([{ opacity: from }, { opacity: 1 }], {
        duration: BREATH_MS / 2,
        direction: "alternate",
        iterations: Infinity,
        easing: SINE,
        delay: -(Date.now() % BREATH_MS),
        fill: "both",
      });
    };
    s.base = breathe(s.steady, 0.35, s.base);
    s.boostBase = breathe(s.boostGlow, 0.4, s.boostBase);
  };
  /** The page took the overlay out of the document (a framework replacing <html>'s children): it goes back at once, same node. */
  const watchHost = (): void => {
    s.guard?.disconnect();
    let moves: number[] = [];
    s.guard = new MutationObserver(() => {
      if (!s.host || s.host.isConnected || s.gone) return;
      const now = Date.now();
      moves = moves.filter((t) => now - t < 10_000);
      if (moves.length >= 20) return; // a page that keeps removing it: not worth a fight
      moves.push(now);
      root.appendChild(s.host);
      ensureBreathing();
    });
    s.guard.observe(root, { childList: true });
  };
  /** Eases an element's opacity to `to` (instantly with reduced motion). */
  const fadeTo = (el: HTMLElement, to: number, ms: number): void => {
    const from = parseFloat(getComputedStyle(el).opacity || "0");
    el.style.opacity = String(to);
    if (!reduced && from !== to)
      el.animate([{ opacity: from }, { opacity: to }], {
        duration: ms,
        easing: SINE,
      });
  };

  const pulse = (r: ActivityRect): void => {
    if (!(r.w > 0 && r.h > 0)) return;
    const ring = document.createElement("div");
    ring.setAttribute("data-ring", "");
    const pad = 6;
    ring.style.cssText = `position:fixed;left:${r.x - pad}px;top:${r.y - pad}px;width:${r.w + pad * 2}px;height:${r.h + pad * 2}px;box-sizing:border-box;border:3px solid ${COLOR};border-radius:10px;pointer-events:none;box-shadow:0 0 12px ${rgba(COLOR, 0.7)};`;
    s.layer.appendChild(ring);
    s.pulses += 1;
    s.lastRect = { x: r.x, y: r.y, w: r.w, h: r.h };
    // A tab that is not drawn (background, hidden window) runs no animations, so a timer removes the ring as well.
    setTimeout(() => ring.remove(), 1700);
    if (!reduced) {
      ring
        .animate(
          [
            { transform: "scale(1)", opacity: 1 },
            { transform: "scale(1.22)", opacity: 0 },
          ],
          { duration: 1600, easing: SINE },
        )
        .finished.then(
          () => ring.remove(),
          () => ring.remove(),
        );
    }
  };

  /** The action layer (bright glow + pill) comes in; it goes out again `ttl` ms after the last action. */
  const boostOn = (ttl: number): void => {
    if (!s.boosted) {
      s.boosted = true;
      fadeTo(s.boostWrap, 1, 250);
    }
    clearTimeout(s.boostTimer);
    s.boostTimer = setTimeout(boostOff, ttl);
  };
  const boostOff = (): void => {
    clearTimeout(s.boostTimer);
    s.boostTimer = 0;
    if (!s.boosted) return;
    s.boosted = false;
    if (s.boostWrap) fadeTo(s.boostWrap, 0, 600);
  };

  const teardown = (): void => {
    s.gone = true;
    s.guard?.disconnect();
    clearTimeout(s.timer);
    clearTimeout(s.boostTimer);
    stopIcon();
    removeEventListener("pagehide", s.onHide);
    s.host?.remove();
    delete holder[KEY];
  };
  /** The session is over: the favicon is back at once, the glow fades over ~600 ms. */
  const fadeOut = (): void => {
    clearTimeout(s.timer);
    clearTimeout(s.boostTimer);
    s.boosted = false;
    stopIcon();
    if (reduced || !s.host) {
      teardown();
      return;
    }
    s.fading = true;
    const animation = s.host.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: 600,
      easing: SINE,
      fill: "forwards",
    });
    s.fadeAnimation = animation;
    const done = (): void => {
      if (s.fadeAnimation === animation) teardown();
    };
    animation.finished.then(done, () => {});
    setTimeout(done, 750); // a tab that is not drawn never finishes the animation
  };

  // ---------------------------------------------------------------- stop / end
  if (cmd.op === "stop") {
    if (s) teardown();
    return true;
  }
  if (cmd.op === "end") {
    if (s && !s.fading) fadeOut();
    return true;
  }

  // ---------------------------------------------------------------- show / session
  if (!s) {
    s = holder[KEY] = {
      host: null,
      shadow: null,
      text: null,
      layer: null,
      steady: null,
      boostWrap: null,
      boostGlow: null,
      pill: null,
      glyphBox: null,
      glyphKind: "",
      glyphs: null,
      glowSize: new WeakMap<HTMLElement, number>(),
      builds: 0,
      base: null,
      boostBase: null,
      guard: null,
      gone: false,
      iconTicksTotal: 0,
      timer: 0,
      boostTimer: 0,
      boosted: false,
      pulses: 0,
      lastRect: null,
      kind: "",
      fading: false,
      fadeAnimation: null,
      icon: null,
      iconFramesTotal: 0,
      onHide: null,
    };
    // The page is going away (or into the back/forward cache): everything of ours is taken out of it first.
    s.onHide = (): void => teardown();
    addEventListener("pagehide", s.onHide);
  }
  if (s.fading) {
    s.fadeAnimation?.cancel();
    s.fadeAnimation = null;
    s.fading = false;
  }
  if (cmd.glyphs) s.glyphs = cmd.glyphs;
  if (!s.host || !s.host.isConnected) {
    s.host?.remove();
    build();
  } else {
    ensureBreathing();
  }
  if (cmd.op === "show") {
    s.kind = cmd.kind;
    s.text.textContent = `Agent: ${cmd.label}`;
    setGlyph(cmd.kind === "read" ? "read" : "act");
  } else if (!s.glyphKind) {
    setGlyph("act");
  }
  startIcon();
  if (cmd.op === "show") {
    boostOn(cmd.ttl);
    if (cmd.rect) pulse(cmd.rect);
  }
  clearTimeout(s.timer);
  s.timer = setTimeout(fadeOut, cmd.lease);
  return true;
}
