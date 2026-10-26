import type { Page } from "@playwright/test";

import {
  hostPids,
  installHost,
  type Mcp,
  openPopup,
  startMcp,
} from "./bridge-helpers";
import { at, expect, ext, type Facet, test } from "./fixtures";

/**
 * Visible agent activity: while the agent works with a tab (a tool touched it within ~8 s, or the debugger is held on it by
 * a viewport override, a watch or a dialog) the tab shows a soft purple vignette along its edges (gradients only, no line)
 * and a favicon of purple dots that rotate; each action adds a stronger layer with a pill, and a blinking purple dot on the toolbar button.
 * Purple is the agent's colour whatever the container. The title is never touched. The overlay lives in a CLOSED shadow
 * root, so these tests look inside it from the extension's own ISOLATED world (the only place that can).
 */

interface Overlay {
  present: boolean;
  text: string;
  rings: number;
  pulses: number;
  lastRect: { x: number; y: number; w: number; h: number } | null;
  hidden: boolean;
  kind: string;
  fading: boolean;
  glow: boolean;
  boosted: boolean;
  /** The glow layers' computed look: what they are painted with, and whether anything could draw a line. */
  layers: GlowLayer[];
  pill: string;
  favicon: string | null;
  builds: number;
  iconTicks: number;
  iconFrames: number;
  /** Identity of the host and of the base glow element (an expando set by the first look), and of its Animation object. */
  hostId: number;
  steadyId: number;
  baseId: number;
  base: {
    startTime: number;
    currentTime: number;
    playState: string;
    delay: number;
    now: number;
    clock: number;
  } | null;
}
interface GlowLayer {
  gradient: boolean;
  purple: boolean;
  border: boolean;
  outline: boolean;
  shadow: boolean;
  size: number;
}

/**
 * The pill's text for `label`: the MCP server names its session after the MCP client plus a random suffix ("facet-e2e-a1b2"),
 * and the page shows "<session>: <label>" (an old host, which names none, shows "Agent: <label>").
 */
const agentText = (label: string) =>
  expect.stringMatching(new RegExp(`^facet-e2e-[0-9a-f]{4}: ${label}$`));

const overlayOf = (facet: Facet, tabId: number): Promise<Overlay> =>
  facet.inWorker(async (id: number) => {
    const c = (globalThis as any).chrome;
    const [r] = await c.scripting.executeScript({
      target: { tabId: id, frameIds: [0] },
      world: "ISOLATED",
      func: () => {
        const s = (globalThis as any).__facetAgentActivity;
        return {
          present: !!s && !!s.host && s.host.isConnected,
          text: s?.shadow ? s.shadow.textContent : "",
          rings: s?.shadow
            ? s.shadow.querySelectorAll("[data-ring]").length
            : 0,
          pulses: s?.pulses ?? 0,
          lastRect: s?.lastRect ?? null,
          hidden:
            !!s?.host &&
            s.host.style.getPropertyValue("visibility") === "hidden",
          kind: s?.kind ?? "",
          fading: !!s?.fading,
          glow: !!s?.steady?.isConnected,
          boosted: !!s?.boosted,
          layers: [s?.steady, s?.boostGlow]
            .filter((el: HTMLElement | undefined) => !!el && el.isConnected)
            .map((el: HTMLElement) => {
              const cs = getComputedStyle(el);
              return {
                gradient: /linear-gradient/.test(cs.backgroundImage),
                purple: cs.backgroundImage.includes("rgba(139, 92, 246"),
                border: [
                  cs.borderTopWidth,
                  cs.borderRightWidth,
                  cs.borderBottomWidth,
                  cs.borderLeftWidth,
                ].some((w) => parseFloat(w) > 0),
                outline:
                  cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0,
                shadow: cs.boxShadow !== "none",
                size: s.glowSize.get(el) ?? 0,
              };
            }),
          pill: s?.pill ? getComputedStyle(s.pill).backgroundColor : "",
          favicon: s?.icon && !s.icon.gaveUp ? s.icon.frame || null : null,
          builds: s?.builds ?? 0,
          iconTicks: s?.icon?.ticks ?? s?.iconTicksTotal ?? 0,
          iconFrames: s?.icon?.frames ?? s?.iconFramesTotal ?? 0,
          ...(() => {
            const g = globalThis as any;
            // eslint-disable-next-line no-return-assign -- hands out a fresh id once per object and remembers it on the object
            const id = (o: any): number =>
              o
                ? (o.__facetProbe ??= g.__facetProbeIds =
                    (g.__facetProbeIds ?? 0) + 1)
                : 0;
            const a = s?.base;
            return {
              hostId: id(s?.host),
              steadyId: id(s?.steady),
              baseId: id(a),
              base: a
                ? {
                    startTime: a.startTime,
                    currentTime: a.currentTime,
                    playState: a.playState,
                    delay: a.effect.getTiming().delay,
                    now: document.timeline.currentTime,
                    clock: Date.now(),
                  }
                : null,
            };
          })(),
        };
      },
    });
    return r.result;
  }, tabId);

/** The page-visible side: is there an overlay element on <html>, and can the page see into it? */
const pageSees = (page: Page) =>
  page.evaluate(() => {
    const host = document.querySelector(
      "facet-agent-overlay",
    ) as HTMLElement | null;
    return {
      element: !!host,
      shadowRoot: host ? host.shadowRoot : null,
      inBody: !!document.body.querySelector("facet-agent-overlay"),
      bodyText: document.body.innerText,
    };
  });

async function turnOn(
  facet: Facet,
): Promise<{ popup: Page; card: ReturnType<Page["getByTestId"]> }> {
  await facet.api("updateSettings", { agentBridge: true }); // the switch lives in Settings; the popup row appears once it is on
  const { page: popup } = await openPopup(facet);
  const card = popup.getByTestId("bridge-card");
  await expect(card).toHaveAttribute("data-status", "connected", {
    timeout: 15_000,
  });
  return { popup, card };
}

/** Group facts for the title mark tests: the title without the invisible marker, the marker, collapsed. */
const groupOfTab = async (facet: Facet, tabId: number): Promise<number> => {
  await expect
    .poll(async () => (await facet.tabInfo(tabId)).groupId)
    .toBeGreaterThanOrEqual(0);
  return (await facet.tabInfo(tabId)).groupId;
};
const groupTitleNow = async (facet: Facet, groupId: number) =>
  (await facet.groupInfo(groupId))?.title ?? null;
const setCollapsed = (facet: Facet, groupId: number, collapsed: boolean) =>
  facet.inWorker(
    async ([id, c]: [number, boolean]) =>
      (globalThis as any).chrome.tabGroups.update(id, { collapsed: c }),
    [groupId, collapsed] as [number, boolean],
  );
const containerNameNow = async (facet: Facet, id: string) =>
  (await facet.api<Array<{ id: string; name: string }>>("listContainers")).find(
    (c) => c.id === id,
  )?.name;
const containerColourNow = async (facet: Facet, id: string) =>
  (
    await facet.api<Array<{ id: string; color: string }>>("listContainers")
  ).find((c) => c.id === id)?.color;
const groupColourNow = async (facet: Facet, groupId: number) =>
  (await facet.groupInfo(groupId))?.color ?? null;
/** A marked group's title leads with one of the two sparkles; the colour is never touched. */
const expectMarked = (facet: Facet, groupId: number, name: string) =>
  expect
    .poll(
      async () => {
        const title = await groupTitleNow(facet, groupId);
        return title === `✦ ${name}` || title === `✧ ${name}`;
      },
      { timeout: 7_000 },
    )
    .toBe(true);
/** Records every state (title without the marker, colour) the group is given from now on (the worker keeps the listener). */
const recordTitles = (facet: Facet, groupId: number) =>
  facet.inWorker(async (id: number) => {
    const g = globalThis as any;
    g.__groupTitles = [];
    g.chrome.tabGroups.onUpdated.addListener((group: any) => {
      // eslint-disable-next-line no-misleading-character-class -- strips the zero-width marker alphabet
      const t = String(group.title ?? "").replace(
        /[\u2060-\u2064\u200b-\u200d]/g,
        "",
      );
      const seen: Array<{ title: string; color: string }> = g.__groupTitles;
      const last = seen.at(-1);
      if (group.id === id && (last?.title !== t || last?.color !== group.color))
        seen.push({ title: t, color: group.color });
    });
  }, groupId);
const titlesSeen = (facet: Facet) =>
  facet.inWorker(
    async () =>
      (globalThis as any).__groupTitles as Array<{
        title: string;
        color: string;
      }>,
    null,
  );

const rgb = (hex: string): number[] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];
const AGENT_RGB = rgb("#8b5cf6");

/** The toolbar dot of a tab, sampled every ~80 ms for `ms`: the distinct colours seen (as "r,g,b") and the texts. */
async function sampleDot(
  facet: Facet,
  tabId: number,
  ms = 1_200,
): Promise<{ colors: string[]; texts: string[] }> {
  const colors = new Set<string>();
  const texts = new Set<string>();
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const info = await facet.tabInfo(tabId);
    texts.add(info.badge);
    colors.add(info.badgeColor.slice(0, 3).join(","));
    await new Promise((r) => setTimeout(r, 80));
  }
  return { colors: [...colors], texts: [...texts] };
}

/** Color of the pixel (x, y) of a PNG, decoded in a page (no image library needed). */
async function pixel(
  facet: Facet,
  base64: string,
  x: number,
  y: number,
): Promise<[number, number, number]> {
  const page = await facet.ctx.newPage();
  try {
    await page.goto("about:blank");
    return await page.evaluate(
      async ([data, px, py]) => {
        const bitmap = await createImageBitmap(
          await (await fetch(`data:image/png;base64,${data}`)).blob(),
        );
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(bitmap, 0, 0);
        const [r, g, b] = ctx.getImageData(
          px as number,
          py as number,
          1,
          1,
        ).data;
        return [r!, g!, b!] as [number, number, number];
      },
      [base64, x, y] as const,
    );
  } finally {
    await page.close();
  }
}

/** The pill: the agent's purple (#8b5cf6) at 80 %, so that white text and glyph read well on it. */
const PILL = "rgb(111, 74, 197)";

/** The glow is a purple vignette of gradients alone: 2 layers, each 24-34 px wide, and nothing that could draw a line. */
function expectPurpleVignette(o: Overlay): void {
  expect(o.layers).toHaveLength(2);
  for (const l of o.layers) {
    expect(l).toMatchObject({
      gradient: true,
      purple: true,
      border: false,
      outline: false,
      shadow: false,
    });
    expect(l.size).toBeGreaterThanOrEqual(24);
    expect(l.size).toBeLessThanOrEqual(34);
  }
  expect(o.pill).toBe(PILL);
}

/** Hue (degrees) of the opaque pixels of a PNG, how many pixels there are, and how bright the most opaque one is when scaled to `to` px. */
async function inkOf(
  facet: Facet,
  dataUrl: string,
  to?: number,
): Promise<{
  width: number;
  hues: number[];
  opaque: number;
  maxAlpha: number;
}> {
  const page = await facet.ctx.newPage();
  try {
    await page.goto("about:blank");
    return await page.evaluate(
      async ([url, size]) => {
        const bitmap = await createImageBitmap(
          await (await fetch(url as string)).blob(),
        );
        const w = (size as number | null) ?? bitmap.width;
        const canvas = new OffscreenCanvas(w, w);
        const ctx = canvas.getContext("2d")!;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(bitmap, 0, 0, w, w);
        const data = ctx.getImageData(0, 0, w, w).data;
        const hues: number[] = [];
        let maxAlpha = 0;
        let opaque = 0;
        for (let i = 0; i < data.length; i += 4) {
          const a = data[i + 3]!;
          maxAlpha = Math.max(maxAlpha, a);
          if (a < 60) continue;
          opaque++;
          const r = data[i]! / 255;
          const g = data[i + 1]! / 255;
          const b = data[i + 2]! / 255;
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const d = max - min;
          if (d === 0) continue;
          const h =
            max === r
              ? ((g - b) / d) % 6
              : max === g
                ? (b - r) / d + 2
                : (r - g) / d + 4;
          hues.push((h * 60 + 360) % 360);
        }
        return { width: bitmap.width, hues, opaque, maxAlpha };
      },
      [dataUrl, to ?? null] as const,
    );
  } finally {
    await page.close();
  }
}

test.describe("visible agent activity", () => {
  let mcp: Mcp | null = null;

  test.beforeEach(({ facet }) => {
    installHost(facet);
  });
  test.afterEach(async ({ facet }) => {
    await mcp?.close().catch(() => {});
    mcp = null;
    await facet.api("updateSettings", {
      agentBridge: false,
      agentActivity: true,
      agentWindow: false,
    });
    await facet.inWorker(async () => {
      const c = (globalThis as any).chrome;
      const stray: Array<{ id: number; url?: string }> = (
        await c.tabs.query({})
      ).filter((t: { url?: string }) =>
        /^(https?:|chrome-extension:)/.test(t.url ?? ""),
      );
      await c.tabs.remove(stray.map((t) => t.id));
    }, undefined);
    await expect.poll(() => hostPids(facet), { timeout: 10_000 }).toEqual([]);
  });

  test("the pill names the agent session (cleaned, cut to 24 characters) and the action log records it", async ({
    facet,
  }) => {
    await turnOn(facet);
    mcp = await startMcp(facet, facet.profile.nativeHostsDir, {
      CLAUDE_SESSION_NAME: "Night <b>shift</b> agent-with-a-very-long-name",
    });
    const page = await facet.plain(at("a.localhost", "/agent"));
    const tabId = await facet.tabIdOf(page);
    await mcp.call("get_tab_text", { tabId });
    expect(await overlayOf(facet, tabId)).toMatchObject({
      present: true,
      text: "Night bshiftb agent-wit…: reading",
    });
    // The page cannot see the name (the overlay is in a closed shadow root), and nothing but text reaches it.
    expect(await pageSees(page)).toMatchObject({
      bodyText: expect.not.stringContaining("Night"),
    });
    const log =
      await facet.api<
        Array<{ message: string; data?: Record<string, unknown> }>
      >("getLog");
    const mine = log.filter(
      (e) => e.message === "agent action" && e.data!.tool === "get_tab_text",
    );
    expect(mine.at(-1)!.data).toMatchObject({
      session: expect.stringMatching(
        /^Night bshiftb agent-with-a-very-long-nam-[0-9a-f]{4}$/,
      ),
    });
  });

  test("a read shows the glow, the pill and the blinking dot in the target tab, never touches the title, and the glow lasts the session and then fades", async ({
    facet,
  }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    const page = await facet.plain(at("a.localhost", "/agent"));
    const tabId = await facet.tabIdOf(page);
    const quiet = await facet.tabInfo(tabId);
    // The bridge is on: a plain tab has the agent's purple dot (one space, no letters), not blinking.
    expect(quiet).toMatchObject({ title: "Agent page", badge: " " });
    expect(quiet.badgeColor.slice(0, 3)).toEqual(AGENT_RGB);
    expect((await sampleDot(facet, tabId, 500)).colors).toEqual([
      AGENT_RGB.join(","),
    ]);
    expect(await overlayOf(facet, tabId)).toMatchObject({ present: false });
    const layoutBefore = await page.evaluate(() => ({
      w: document.documentElement.scrollWidth,
      h: document.documentElement.scrollHeight,
      body: document.body.getBoundingClientRect().toJSON(),
    }));

    const read = await mcp.call("get_tab_text", { tabId });
    expect(JSON.parse(read.texts[0]!)).toMatchObject({ title: "Agent page" }); // the agent gets the page's own title

    const shown = await overlayOf(facet, tabId);
    expect(shown).toMatchObject({
      present: true,
      text: agentText("reading"),
      kind: "read",
      glow: true,
      boosted: true,
      pulses: 0,
      hidden: false,
    });
    expectPurpleVignette(shown);
    // The title is the page's: no mark, no emoji, at any time.
    for (let i = 0; i < 6; i++) {
      expect(await page.title()).toBe("Agent page");
      await page.waitForTimeout(100);
    }
    expect((await facet.tabInfo(tabId)).title).toBe("Agent page");
    // The dot of this tab blinks: purple and lighter purples, never letters.
    const blinking = await sampleDot(facet, tabId);
    expect(blinking.texts).toEqual([" "]);
    expect(blinking.colors.length).toBeGreaterThanOrEqual(2);
    expect(blinking.colors).toContain(AGENT_RGB.join(","));
    for (const c of blinking.colors) {
      const [r, g, b] = c.split(",").map(Number);
      expect(r).toBeGreaterThanOrEqual(0x8b);
      expect(r).toBeLessThanOrEqual(0xc4);
      expect(b).toBeGreaterThanOrEqual(0xf6);
      expect(g).toBeGreaterThanOrEqual(0x5c);
    }
    expect(
      (
        await mcp.json<Array<{ tabId: number; title: string }>>("list_tabs")
      ).find((t) => t.tabId === tabId)!.title,
    ).toBe("Agent page");
    // No layout change, and the page cannot look inside: the element is on <html>, its shadow root is closed.
    expect(
      await page.evaluate(() => ({
        w: document.documentElement.scrollWidth,
        h: document.documentElement.scrollHeight,
        body: document.body.getBoundingClientRect().toJSON(),
      })),
    ).toEqual(layoutBefore);
    const seen = await pageSees(page);
    expect(seen).toMatchObject({
      element: true,
      shadowRoot: null,
      inBody: false,
    });
    expect(seen.bodyText).not.toMatch(/(Agent|facet-e2e-[0-9a-f]{4}): reading/);
    // Nothing the page can click or hover is covered: the overlay has no pointer events.
    expect(
      await page.evaluate(
        () => document.elementFromPoint(innerWidth - 30, 20)?.tagName,
      ),
    ).not.toBe("FACET-AGENT-OVERLAY");

    // About 2.5 s after the action the bright layer (pill, brighter glow) goes, the session's soft glow stays.
    await expect
      .poll(() => overlayOf(facet, tabId).then((o) => o.boosted), {
        timeout: 6_000,
      })
      .toBe(false);
    expect(await overlayOf(facet, tabId)).toMatchObject({
      present: true,
      glow: true,
    });
    // The session ends ~8 s after the last action: everything fades and is removed.
    await expect
      .poll(() => overlayOf(facet, tabId).then((o) => o.present), {
        timeout: 20_000,
      })
      .toBe(false);
    expect(
      await page.evaluate(
        () => document.querySelector("facet-agent-overlay") === null,
      ),
    ).toBe(true);
    expect(await page.title()).toBe("Agent page");
    // The blink is over: the idle purple dot, steady.
    await expect
      .poll(async () => (await sampleDot(facet, tabId, 400)).colors)
      .toEqual([AGENT_RGB.join(",")]);
    expect((await facet.tabInfo(tabId)).badge).toBe(" ");
  });

  test("the agent is purple on a container tab too (the container's colour stays on its own UI), and the title keeps its [container] prefix exactly (no mark ever)", async ({
    facet,
  }) => {
    const c = await facet.container("Glow");
    await turnOn(facet);
    mcp = await startMcp(facet);
    const page = await facet.openIn(c.name, at("a.localhost", "/agent"));
    const tabId = await facet.tabIdOf(page);
    const prefix = `[${c.name}] `;
    const rewritten = new RegExp(
      `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}Rewritten$`,
    );
    await expect.poll(() => page.title()).toBe(`${prefix}Agent page`);
    const quiet = await facet.tabInfo(tabId);
    expect(quiet.badge).toBe(" "); // the container's colour dot, no "ON"
    expect(quiet.badgeColor.slice(0, 3)).not.toEqual(AGENT_RGB);

    await mcp.call("get_tab_html", { tabId, selector: "#title" });
    const o = await overlayOf(facet, tabId);
    expect(o).toMatchObject({ present: true, glow: true });
    expectPurpleVignette(o); // purple, not the container's colour
    // The container dot blinks between the container's colour and purple.
    const blinkingC = await sampleDot(facet, tabId);
    expect(blinkingC.texts).toEqual([" "]);
    expect(blinkingC.colors).toContain(quiet.badgeColor.slice(0, 3).join(","));
    expect(blinkingC.colors).toContain(AGENT_RGB.join(","));
    await mcp.json("click", { tabId, selector: "#go" });
    // The page rewrites its own title during the session: nothing of ours is in it, before or after.
    await page.evaluate(() => (document.title = "Rewritten"));
    for (let i = 0; i < 6; i++) {
      expect(await page.title()).toMatch(rewritten);
      await page.waitForTimeout(100);
    }
    expect(
      await mcp
        .json<Array<{ tabId: number; title: string }>>("list_tabs")
        .then((l) => l.find((t) => t.tabId === tabId)!.title),
    ).toMatch(rewritten);
    await expect
      .poll(() => overlayOf(facet, tabId).then((x) => x.present), {
        timeout: 20_000,
      })
      .toBe(false);
    expect(await page.title()).toMatch(rewritten);
    // The container's own dot is back, steady.
    await expect
      .poll(async () => (await sampleDot(facet, tabId, 400)).colors)
      .toEqual([quiet.badgeColor.slice(0, 3).join(",")]);

    // Out of its tab group the page title carries "⧉ " (Chrome's own view of the tab too), and the agent never sees it.
    await facet.inWorker(
      async (id: number) => (globalThis as any).chrome.tabs.ungroup(id),
      tabId,
    );
    await expect.poll(() => page.title()).toBe(`⧉ ${prefix}Rewritten`);
    expect((await facet.tabInfo(tabId)).title).toBe(`⧉ ${prefix}Rewritten`);
    expect(
      await mcp
        .json<Array<{ tabId: number; title: string }>>("list_tabs")
        .then((l) => l.find((t) => t.tabId === tabId)!.title),
    ).toMatch(rewritten);
    const read = await mcp.call("get_tab_text", { tabId });
    expect(JSON.parse(read.texts[0]!)).toMatchObject({
      title: `${prefix}Rewritten`,
    });
  });

  test("a click and typing pulse at the element; the answers carry no rectangle", async ({
    facet,
  }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    const page = await facet.plain(at("a.localhost", "/agent"));
    const tabId = await facet.tabIdOf(page);

    const typed = await mcp.json("type", {
      tabId,
      selector: "#name",
      text: "hi",
    });
    expect(typed).toEqual({ typed: 2 });
    const afterType = await overlayOf(facet, tabId);
    expect(afterType).toMatchObject({
      present: true,
      text: agentText("typing"),
      kind: "act",
      pulses: 1,
    });
    const field = await page.locator("#name").boundingBox();
    expect(afterType.lastRect!.x).toBeCloseTo(field!.x, 0);
    expect(afterType.lastRect!.w).toBeCloseTo(field!.width, 0);

    expect(await mcp.json("click", { tabId, selector: "#go" })).toEqual({
      clicked: "<button#go>",
    });
    const afterClick = await overlayOf(facet, tabId);
    expect(afterClick).toMatchObject({
      text: agentText("clicking"),
      pulses: 2,
    });
    const button = await page.locator("#go").boundingBox();
    expect(afterClick.lastRect!.x).toBeCloseTo(button!.x, 0);
    expect(afterClick.lastRect!.h).toBeCloseTo(button!.height, 0);

    // Reads do not pulse; scrolling and scripts say what they do.
    await mcp.call("get_tab_text", { tabId });
    expect(await overlayOf(facet, tabId)).toMatchObject({
      text: agentText("reading"),
      pulses: 2,
      kind: "read",
    });
    await mcp.call("run_js", { tabId, code: "return 1" });
    expect(await overlayOf(facet, tabId)).toMatchObject({
      text: agentText("running script"),
      kind: "act",
    });
    await mcp.call("scroll", { tabId, to: "bottom" });
    expect(await overlayOf(facet, tabId)).toMatchObject({
      text: agentText("scrolling"),
    });
    await expect
      .poll(() => overlayOf(facet, tabId).then((o) => o.present), {
        timeout: 20_000,
      })
      .toBe(false);
  });

  test("the overlay is not in what the agent reads, and not in screenshots", async ({
    facet,
  }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    const page = await facet.plain(at("a.localhost", "/agent"));
    const tabId = await facet.tabIdOf(page);

    await mcp.call("get_tab_text", { tabId });
    expect(await overlayOf(facet, tabId)).toMatchObject({ present: true });
    // Control: a plain browser screenshot DOES show the glow (1-3 px from the left edge, tinted), so the check below can fail.
    await expect
      .poll(async () => {
        const [, g] = await pixel(
          facet,
          (await page.screenshot()).toString("base64"),
          1,
          300,
        );
        return g;
      })
      .toBeLessThan(225);

    const text = await mcp.call("get_tab_text", { tabId });
    expect(text.texts[1]).not.toContain("Agent:");
    expect(text.texts[1]).toContain("Agent page");
    const html = await mcp.call("get_tab_html", { tabId });
    expect(html.texts[1]).not.toMatch(
      /facet-agent|Agent: |facet-e2e-[0-9a-f]{4}: /,
    );
    expect(html.texts[1]).toContain("<title>Agent page</title>");
    expect(JSON.parse(html.texts[0]!).title).toBe("Agent page");

    const shot = await mcp.call("screenshot_tab", { tabId });
    expect(shot.images).toHaveLength(1);
    // The captured frame has the page there, not the glowing border (the bitmap may be scaled: x = 1 is still inside the frame).
    const [r, g, b] = await pixel(facet, shot.images[0]!.data, 1, 300);
    expect(r).toBeGreaterThan(235);
    expect(g).toBeGreaterThan(235);
    expect(b).toBeGreaterThan(235);
    // ... and it is shown again afterwards, while the activity is still on.
    await expect
      .poll(() => overlayOf(facet, tabId).then((o) => o.hidden || !o.present))
      .toBe(false);
  });

  test('"Show agent activity" off: nothing is injected, retitled or badged', async ({
    facet,
  }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    const page = await facet.plain(at("a.localhost", "/agent"));
    const tabId = await facet.tabIdOf(page);
    await facet.api("updateSettings", { agentActivity: false });

    await mcp.call("get_tab_text", { tabId });
    await mcp.json("click", { tabId, selector: "#go" });
    expect(await overlayOf(facet, tabId)).toMatchObject({ present: false });
    expect(await pageSees(page)).toMatchObject({ element: false });
    expect(await page.title()).toBe("Agent page");
    // The bridge is on (idle purple dot), but nothing blinks.
    expect(await facet.tabInfo(tabId)).toMatchObject({
      title: "Agent page",
      badge: " ",
    });
    expect((await sampleDot(facet, tabId, 600)).colors).toEqual([
      AGENT_RGB.join(","),
    ]);

    // On again: back.
    await facet.api("updateSettings", { agentActivity: true });
    await mcp.call("get_tab_text", { tabId });
    expect(await overlayOf(facet, tabId)).toMatchObject({ present: true });
  });

  test("bridge off: no agent dot on a plain tab, the container dot stays; on: the purple dot", async ({
    facet,
  }) => {
    const c = await facet.container("Dot");
    await turnOn(facet);
    const plain = await facet.plain(at("a.localhost", "/agent"));
    const plainId = await facet.tabIdOf(plain);
    const boxed = await facet.openIn(c.name, at("a.localhost", "/agent"));
    const boxedId = await facet.tabIdOf(boxed);
    await expect
      .poll(async () => (await facet.tabInfo(plainId)).badge)
      .toBe(" ");
    const containerDot = (await facet.tabInfo(boxedId)).badgeColor.slice(0, 3);
    await facet.api("updateSettings", { agentBridge: false });
    await expect
      .poll(async () => (await facet.tabInfo(plainId)).badge)
      .toBe("");
    expect(await facet.tabInfo(boxedId)).toMatchObject({ badge: " " });
    expect((await facet.tabInfo(boxedId)).badgeColor.slice(0, 3)).toEqual(
      containerDot,
    );
  });

  test("the setting is in the options page (the popup row has no menu any more)", async ({
    facet,
  }) => {
    const { popup } = await turnOn(facet);
    expect(
      await facet.api<{ agentActivity: boolean }>("getSettings"),
    ).toMatchObject({ agentActivity: true });
    await expect(
      popup.getByRole("button", { name: "Agent bridge options" }),
    ).toHaveCount(0);
    await facet.api("updateSettings", { agentActivity: false });

    const options = await facet.ctx.newPage();
    await options.goto(ext("options.html"));
    const toggle = options.getByRole("switch", { name: /Show agent activity/ });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(
      await facet.api<{ agentActivity: boolean }>("getSettings"),
    ).toMatchObject({ agentActivity: true });
    await options.close();
  });

  test("pages that cannot be scripted still work: the badge alone, no error", async ({
    facet,
  }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    const opened = await mcp.json<{ tabId: number }>("open_tab", {
      url: "chrome://version/",
    });
    const result = await mcp.call("get_tab_text", { tabId: opened.tabId });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/cannot be scripted/);
    // The one signal that needs no page access: the dot blinks, then it is steady again.
    expect(
      (await sampleDot(facet, opened.tabId)).colors.length,
    ).toBeGreaterThanOrEqual(2);
    await expect
      .poll(async () => (await sampleDot(facet, opened.tabId, 400)).colors, {
        timeout: 20_000,
      })
      .toEqual([AGENT_RGB.join(",")]);
    await mcp.call("close_tab", { tabId: opened.tabId });
  });

  test("the popup lists the last five agent actions", async ({ facet }) => {
    const { popup } = await turnOn(facet);
    await expect(popup.getByTestId("bridge-recent")).toHaveCount(0); // folded by default
    await popup.getByRole("button", { name: /^Agent, / }).click();
    await expect(popup.getByTestId("bridge-recent-empty")).toBeVisible();
    mcp = await startMcp(facet);
    const page = await facet.plain(at("a.localhost", "/agent"));
    const tabId = await facet.tabIdOf(page);

    await mcp.json("list_tabs");
    await mcp.call("get_tab_text", { tabId });
    await mcp.json("click", { tabId, selector: "#go" });
    const items = popup.getByTestId("bridge-recent-item");
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toContainText("click");
    await expect(items.nth(0)).toContainText("Agent page"); // the tab's title, without our mark
    await expect(items.nth(0)).not.toContainText("🤖");
    await expect(items.nth(1)).toContainText("get_tab_text");
    await expect(items.nth(2)).toContainText("list_tabs");
    await expect(items.nth(2)).not.toContainText("Agent page"); // no tab for this one
    await expect(items.nth(0).locator("time")).toHaveText(/^\d\d:\d\d:\d\d$/);

    for (const tool of ["list_containers", "list_tabs", "bridge_info"])
      await mcp.call(tool);
    await expect(items).toHaveCount(5);
    await expect(items.nth(0)).toContainText("bridge_info");
    await expect(items.nth(4)).toContainText("get_tab_text"); // list_tabs, the oldest, scrolled off
    await expect(popup.getByTestId("bridge-actions")).toHaveText("6");
    await expect(
      popup.getByTestId("bridge-recent").getByText("__session"),
    ).toHaveCount(0); // internal keepalives are never listed
  });

  test("the popup fits Chrome's 600px cap without scrolling: 6 containers, bridge on, 5 actions", async ({
    facet,
  }) => {
    // A clean slate: exactly six containers.
    for (const c of await facet.api<Array<{ id: string }>>("listContainers"))
      await facet.api("deleteContainer", c.id);
    const made: Array<{ id: string; name: string }> = [];
    for (const label of [
      "Work",
      "Personal",
      "Client A",
      "Side project",
      "Banking",
      "Shop",
    ])
      made.push(await facet.container(label));
    const tab = await facet.openIn(made[0]!.name, at("a.localhost", "/agent"));
    const tabId = await facet.tabIdOf(tab);

    await turnOn(facet); // (opens a first popup page; the one measured is opened below with the web tab as "this tab")
    mcp = await startMcp(facet);
    for (const tool of ["list_containers", "list_tabs", "bridge_info"])
      await mcp.call(tool);
    await mcp.call("get_tab_text", { tabId });
    await mcp.json("click", { tabId, selector: "#go" });

    for (const scheme of ["light", "dark"] as const) {
      const popup = await facet.ctx.newPage();
      await popup.emulateMedia({ colorScheme: scheme });
      await popup.setViewportSize({ width: 420, height: 600 }); // what Chrome gives a popup at most
      await popup.goto(ext(`popup.html?tab=${tabId}`));
      await expect(popup.getByTestId("container-row")).toHaveCount(6);
      await expect(popup.getByTestId("bridge-card")).toHaveAttribute(
        "data-status",
        "connected",
      );
      await popup.getByRole("button", { name: /^Agent, / }).click(); // the worst case: the log unfolded
      await expect(popup.getByTestId("bridge-recent-item")).toHaveCount(5);
      const metrics = await popup.evaluate(() => {
        const list = document.querySelector<HTMLElement>(
          "[data-testid=container-list]",
        )!;
        return {
          page: document.documentElement.scrollHeight,
          content: document
            .querySelector<HTMLElement>("main.popup")!
            .getBoundingClientRect().height,
          listScrolls: list.scrollHeight > list.clientHeight + 1,
          rowHeights: [
            ...document.querySelectorAll<HTMLElement>(
              "[data-testid=container-row]",
            ),
          ].map((r) => r.getBoundingClientRect().height),
          smallest: Math.min(
            ...[...document.querySelectorAll<HTMLElement>("main.popup *")]
              .filter(
                (el) =>
                  el.childNodes.length &&
                  [...el.childNodes].some(
                    (n) => n.nodeType === 3 && n.textContent!.trim() !== "",
                  ),
              )
              .map((el) => parseFloat(getComputedStyle(el).fontSize)),
          ),
        };
      });
      expect(metrics.page, `${scheme}: page height`).toBeLessThanOrEqual(600);
      expect(metrics.content, `${scheme}: popup content`).toBeLessThanOrEqual(
        600,
      );
      expect(
        metrics.listScrolls,
        `${scheme}: the container list must not need its own scrollbar here`,
      ).toBe(false);
      for (const h of metrics.rowHeights) expect(h).toBeGreaterThanOrEqual(36);
      for (const h of metrics.rowHeights) expect(h).toBeLessThanOrEqual(40);
      expect(
        metrics.smallest,
        `${scheme}: smallest text`,
      ).toBeGreaterThanOrEqual(14);
      await popup.close();
    }

    // Many containers: the page stays within 600 and only the list scrolls, inside its own region.
    for (let i = 0; i < 9; i++) await facet.container(`Extra ${i}`);
    const popup = await facet.ctx.newPage();
    await popup.setViewportSize({ width: 420, height: 600 });
    await popup.goto(ext(`popup.html?tab=${tabId}`));
    await expect(popup.getByTestId("container-row")).toHaveCount(15);
    const many = await popup.evaluate(() => {
      const list = document.querySelector<HTMLElement>(
        "[data-testid=container-list]",
      )!;
      return {
        page: document.documentElement.scrollHeight,
        listScrolls: list.scrollHeight > list.clientHeight + 1,
        body: document.body.scrollHeight,
      };
    });
    expect(many.page).toBeLessThanOrEqual(600);
    expect(many.body).toBeLessThanOrEqual(600);
    expect(many.listScrolls).toBe(true);
    await popup.close();
  });

  /** What Chrome reports for the tab's icon (the browser's own view, not the page's). */
  const favOf = (facet: Facet, tabId: number) =>
    facet.inWorker(
      async (id: number) =>
        ((await (globalThis as any).chrome.tabs.get(id)).favIconUrl ??
          "") as string,
      tabId,
    );
  /** Every icon-ish link of the page as `id=href|type`, and whether any data: URL is left anywhere in the document. */
  const iconState = (page: Page) =>
    page.evaluate(() => ({
      links: Array.from(document.querySelectorAll("link")).map(
        (l) =>
          `${l.id || l.rel}=${l.getAttribute("href")}|${l.getAttribute("type")}`,
      ),
      dataLeft: document.documentElement.outerHTML.includes("data:image"),
    }));
  const DATA_PNG = /^data:image\/png;base64,/;

  test("the tab strip shows it too, on a page with an SVG icon: Chrome reports our frames, the icon node is the same one and gets its own value back", async ({
    facet,
  }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    const page = await facet.plain(at("a.localhost", "/icon-page"));
    const tabId = await facet.tabIdOf(page);
    await expect
      .poll(() => favOf(facet, tabId))
      .toBe(at("a.localhost", "/icon.svg"));
    const headBefore = await page.evaluate(() => document.head.innerHTML);
    // The page's own icon node: it must stay the very same node, in place, and never be taken out for a moment.
    await page.evaluate(() => {
      const own = document.getElementById("own-icon")!;
      (window as any).__own = own;
      (window as any).__removed = 0;
      new MutationObserver((records) => {
        for (const r of records)
          for (const n of Array.from(r.removedNodes))
            if (n === own) (window as any).__removed++;
      }).observe(document.head, { childList: true });
    });

    await mcp.json("click", { tabId, selector: "h1" });
    // Chrome itself reports the animation (not just the DOM): the SVG icon is replaced by our PNG frames.
    await expect
      .poll(() => favOf(facet, tabId), { timeout: 2_000 })
      .toMatch(DATA_PNG);
    expect((await iconState(page)).links).toEqual([
      expect.stringMatching(/^own-icon=data:image\/png;base64,.*\|image\/png$/),
    ]); // no extra node: the page's own, changed in place
    const seen = new Set<string>();
    for (let i = 0; i < 10; i++) {
      seen.add(await favOf(facet, tabId));
      expect(await page.title()).toBe("Icon page"); // a click leaves the title alone
      await page.waitForTimeout(110);
    }
    expect(
      [...seen].filter((u) => DATA_PNG.test(u)).length,
    ).toBeGreaterThanOrEqual(4); // the tab strip animates

    // A read keeps the title clean as well.
    await mcp.call("get_tab_text", { tabId });
    for (let i = 0; i < 6; i++) {
      expect(await page.title()).toBe("Icon page");
      await page.waitForTimeout(100);
    }
    // What the agent reads has the page's own icon values, not our frame, and a clean title.
    const html = await mcp.call("get_tab_html", { tabId });
    expect(html.texts[1]).toContain(
      '<link rel="icon" id="own-icon" href="/icon.svg">',
    );
    expect(html.texts[1]).not.toContain("data:image");
    expect(html.texts[1]).not.toContain("data-facet-agent-icon");
    expect(html.texts[1]).toContain("<title>Icon page</title>");

    await expect
      .poll(() => overlayOf(facet, tabId).then((o) => o.present), {
        timeout: 20_000,
      })
      .toBe(false);
    expect(await page.evaluate(() => document.head.innerHTML)).toBe(headBefore); // the very same markup, in place
    expect(
      await page.evaluate(
        () =>
          document.getElementById("own-icon") === (window as any).__own &&
          (window as any).__removed,
      ),
    ).toBe(0); // same node, never removed
    await expect
      .poll(() => favOf(facet, tabId))
      .toBe(at("a.localhost", "/icon.svg")); // Chrome shows the page's icon again
    expect((await iconState(page)).dataLeft).toBe(false);
    expect(await page.title()).toBe("Icon page");
  });

  test("a page with PNG icons: Chrome reports our frames, every icon link (shortcut icon too) is animated, the apple-touch-icon is not touched, all come back", async ({
    facet,
  }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    const page = await facet.plain(at("a.localhost", "/icon-png-page"));
    const tabId = await facet.tabIdOf(page);
    await expect.poll(() => favOf(facet, tabId)).toMatch(/\/icon\.png/);
    const before = await favOf(facet, tabId);
    const headBefore = await page.evaluate(() => document.head.innerHTML);
    await page.evaluate(
      () =>
        ((window as any).__nodes = ["own-icon", "shortcut", "apple"].map((id) =>
          document.getElementById(id),
        )),
    );
    await mcp.json("click", { tabId, selector: "h1" });
    await expect
      .poll(() => favOf(facet, tabId), { timeout: 2_000 })
      .toMatch(DATA_PNG);
    const during = await iconState(page);
    expect(during.links[0]).toMatch(/^own-icon=data:image\/png.*\|image\/png$/);
    expect(during.links[1]).toMatch(/^shortcut=data:image\/png.*\|image\/png$/);
    expect(during.links[2]).toBe("apple=/icon.png?v=3|null"); // not a favicon: untouched
    const seen = new Set<string>();
    for (let i = 0; i < 8; i++) {
      seen.add(await favOf(facet, tabId));
      await page.waitForTimeout(120);
    }
    expect(
      [...seen].filter((u) => DATA_PNG.test(u)).length,
    ).toBeGreaterThanOrEqual(2);
    await expect
      .poll(() => overlayOf(facet, tabId).then((o) => o.present), {
        timeout: 20_000,
      })
      .toBe(false);
    expect(await page.evaluate(() => document.head.innerHTML)).toBe(headBefore);
    expect(
      await page.evaluate(() =>
        ["own-icon", "shortcut", "apple"].every(
          (id, i) => document.getElementById(id) === (window as any).__nodes[i],
        ),
      ),
    ).toBe(true);
    await expect.poll(() => favOf(facet, tabId)).toBe(before);
    expect((await iconState(page)).dataLeft).toBe(false);
  });

  test("a framework-like page that rewrites or replaces its icon link mid-activity ends with its own value, and no data: URL is left", async ({
    facet,
  }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    const page = await facet.plain(at("a.localhost", "/icon-fw-page"));
    const tabId = await facet.tabIdOf(page);
    await mcp.json("click", { tabId, selector: "h1" });
    await expect
      .poll(() => favOf(facet, tabId), { timeout: 2_000 })
      .toMatch(DATA_PNG);
    // 1. The page sets a new href on its node: that value is the page's, ours goes on top of it again...
    await page.evaluate(() => (window as any).setIcon("/icon.png?v=2"));
    await expect
      .poll(async () => (await iconState(page)).links[0])
      .toMatch(/^fw-icon=data:image\/png.*\|image\/png$/);
    await expect
      .poll(() => favOf(facet, tabId), { timeout: 2_000 })
      .toMatch(DATA_PNG);
    // 2. ...then it replaces the whole node (a framework re-rendering <head>): the old node is forgotten, the new one is animated.
    await page.evaluate(() => (window as any).swapIcon("/icon.png?v=3"));
    await expect
      .poll(async () => (await iconState(page)).links[0])
      .toMatch(/^fw-icon=data:image\/png.*\|image\/png$/);
    expect((await iconState(page)).links).toHaveLength(1);
    // 3. A last rewrite right before the end.
    await page.evaluate(() => (window as any).setIcon("/icon.png?v=4"));
    await expect
      .poll(() => overlayOf(facet, tabId).then((o) => o.present), {
        timeout: 20_000,
      })
      .toBe(false);
    const after = await iconState(page);
    expect(after.links).toEqual(["fw-icon=/icon.png?v=4|image/png"]);
    expect(after.dataLeft).toBe(false);
    await expect.poll(() => favOf(facet, tabId)).toMatch(/\/icon\.png\?v=4$/);
  });

  test('the icons come back at once when "Show agent activity" is switched off, when the bridge is switched off, and on pagehide', async ({
    facet,
  }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    const page = await facet.plain(at("a.localhost", "/icon-png-page"));
    const tabId = await facet.tabIdOf(page);
    const own = async () => (await iconState(page)).links[0];
    // The setting off: well before the 2.5 s timer would have fired.
    await mcp.json("click", { tabId, selector: "h1" });
    await expect.poll(own).toMatch(/^own-icon=data:/);
    const started = Date.now();
    await facet.api("updateSettings", { agentActivity: false });
    await expect
      .poll(own, { timeout: 1_500 })
      .toBe("own-icon=/icon.png|image/png");
    expect(Date.now() - started).toBeLessThan(1_500);
    expect((await iconState(page)).dataLeft).toBe(false);
    expect((await overlayOf(facet, tabId)).present).toBe(false);
    await facet.api("updateSettings", { agentActivity: true });

    // pagehide (also what the back/forward cache fires): everything of ours is taken out first.
    await mcp.json("click", { tabId, selector: "h1" });
    await expect.poll(own).toMatch(/^own-icon=data:/);
    await page.evaluate(() =>
      dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })),
    );
    await expect
      .poll(own, { timeout: 1_000 })
      .toBe("own-icon=/icon.png|image/png");
    expect((await overlayOf(facet, tabId)).present).toBe(false);

    // The bridge off.
    await mcp.json("click", { tabId, selector: "h1" });
    await expect.poll(own).toMatch(/^own-icon=data:/);
    await facet.api("updateSettings", { agentBridge: false });
    await expect
      .poll(own, { timeout: 1_500 })
      .toBe("own-icon=/icon.png|image/png");
    expect((await iconState(page)).dataLeft).toBe(false);
  });

  test("a page without an icon gets one link of ours (Chrome shows it) that goes away completely; page-added icons are animated too; reduced motion holds still", async ({
    facet,
  }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    // The page adds a new icon, and rewrites its own icon link, while the agent works.
    const page = await facet.plain(at("a.localhost", "/icon-page"));
    const tabId = await facet.tabIdOf(page);
    await mcp.json("click", { tabId, selector: "h1" });
    await expect
      .poll(async () => (await iconState(page)).links[0])
      .toMatch(/^own-icon=data:/);
    await page.evaluate(() => {
      const extra = document.createElement("link");
      extra.rel = "icon";
      extra.id = "added";
      extra.href = "/icon.svg?v=2";
      document.head.appendChild(extra);
      (document.getElementById("own-icon") as HTMLLinkElement).href =
        "/icon.svg?v=3";
    });
    await expect
      .poll(
        async () =>
          (await iconState(page)).links.filter((l) =>
            /=data:image\/png/.test(l),
          ).length,
      )
      .toBe(2); // the new node is animated as well
    await expect
      .poll(() => overlayOf(facet, tabId).then((o) => o.present), {
        timeout: 20_000,
      })
      .toBe(false);
    // Afterwards the page has exactly its own icons, as it wrote them.
    expect((await iconState(page)).links).toEqual([
      "own-icon=/icon.svg?v=3|null",
      "added=/icon.svg?v=2|null",
    ]);

    // No favicon of its own: one link of ours, then nothing at all.
    const plain = await facet.plain(at("a.localhost", "/agent"));
    const plainId = await facet.tabIdOf(plain);
    await mcp.json("click", { tabId: plainId, selector: "#go" });
    await expect
      .poll(() =>
        plain.evaluate(() => document.querySelectorAll("link").length),
      )
      .toBe(1);
    await expect.poll(() => favOf(facet, plainId)).toMatch(DATA_PNG); // Chrome shows our animated icon in the tab strip
    await expect
      .poll(() => overlayOf(facet, plainId).then((o) => o.present), {
        timeout: 20_000,
      })
      .toBe(false);
    expect(
      await plain.evaluate(() => document.querySelectorAll("link").length),
    ).toBe(0);

    // Reduced motion: one frame each, no animation.
    await plain.emulateMedia({ reducedMotion: "reduce" });
    await mcp.call("get_tab_text", { tabId: plainId });
    const icons = new Set<string>();
    const titles = new Set<string>();
    for (let i = 0; i < 8; i++) {
      icons.add(
        await plain.evaluate(
          () =>
            document
              .querySelector("link[data-facet-agent-icon]")
              ?.getAttribute("href") ?? "",
        ),
      );
      titles.add(await plain.title());
      await plain.waitForTimeout(120);
    }
    expect([...icons].filter((h) => h.startsWith("data:"))).toHaveLength(1);
    expect([...titles]).toEqual(["Agent page"]); // the title is never marked
  });

  test("the favicon is a ring of purple dots that turns smoothly (48 frames a turn, 30 a second, a turn in 1.6 s), crisp at 16 and 32 px, and holds still with reduced motion", async ({
    facet,
  }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    const page = await facet.plain(at("a.localhost", "/icon-png-page"));
    const tabId = await facet.tabIdOf(page);
    await mcp.call("get_tab_text", { tabId });
    await page.waitForTimeout(300);
    // Every write to the page's icon link for 3 s (a MutationObserver sees them all, however fast), and every change Chrome
    // itself reports for the tab's icon (the browser's view: the tab strip follows these).
    await facet.inWorker(async () => {
      const g = globalThis as any;
      g.__favs = [];
      g.chrome.tabs.onUpdated.addListener(
        (_id: number, ch: { favIconUrl?: string }, tab: { id: number }) => {
          if (ch.favIconUrl !== undefined)
            g.__favs.push([tab.id, ch.favIconUrl]);
        },
      );
    }, undefined);
    await page.evaluate(() => {
      const link = document.getElementById("own-icon") as HTMLLinkElement;
      const log: string[] = [];
      (window as any).__log = log;
      new MutationObserver((records) => {
        for (const r of records) log.push(r.oldValue ?? "");
      }).observe(link, {
        attributes: true,
        attributeFilter: ["href"],
        attributeOldValue: true,
      });
    });
    await page.waitForTimeout(3_000);
    const writes: string[] = await page.evaluate(() =>
      (window as any).__log.slice(),
    );
    const chromeSaw: number = await facet.inWorker(
      async (id: number) =>
        (globalThis as any).__favs.filter((f: [number, string]) => f[0] === id)
          .length,
      tabId,
    );
    const frames = [...new Set(writes.filter((v) => v.startsWith("data:")))];
    const perSecond = writes.length / 3;
    test.info().annotations.push({
      type: "measured",
      description: `page writes ${perSecond.toFixed(1)}/s, Chrome reported ${(chromeSaw / 3).toFixed(1)}/s, ${frames.length} distinct frames`,
    });
    expect(frames.length).toBeGreaterThanOrEqual(24); // a revolution is 48 different frames: smooth, not choppy
    expect(frames.length).toBeLessThanOrEqual(48);
    expect(perSecond).toBeGreaterThanOrEqual(24); // ~30 frames a second...
    expect(perSecond).toBeLessThanOrEqual(36); // ...and no more than that
    expect(chromeSaw / 3).toBeGreaterThanOrEqual(24); // Chrome accepts every one of them (it is not the limit)
    // Every frame is a drawn PNG (no emoji, no external file), 64 px square, purple (#8b5cf6: hue 258), and shows a head dot.
    for (const v of frames) expect(v).toMatch(/^data:image\/png;base64,/);
    for (const v of [frames[0]!, frames[7]!, frames[23]!]) {
      const ink = await inkOf(facet, v);
      expect(ink.width).toBe(64);
      expect(ink.opaque).toBeGreaterThan(150);
      const purple = ink.hues.filter((h) => Math.abs(h - 258) <= 6).length;
      expect(purple / ink.hues.length).toBeGreaterThan(0.97);
      for (const px of [32, 16]) {
        const small = await inkOf(facet, v, px); // what the tab strip makes of it
        expect(
          small.maxAlpha,
          `${px} px: the head dot stays solid`,
        ).toBeGreaterThan(px === 16 ? 140 : 200);
        expect(small.opaque, `${px} px: the dots stay visible`).toBeGreaterThan(
          px === 16 ? 4 : 20,
        );
      }
    }
    // Actions do not change the icon (no glyph tile any more): the pill carries the eye and the pointer.
    await mcp.json("click", { tabId, selector: "h1" });
    expect(await overlayOf(facet, tabId)).toMatchObject({
      text: agentText("clicking"),
      kind: "act",
    });
    for (let i = 0; i < 6; i++) {
      expect(frames).toContain(
        await page.evaluate(
          () => document.getElementById("own-icon")!.getAttribute("href") ?? "",
        ),
      );
      await page.waitForTimeout(90);
    }

    // Reduced motion: a still glow and one still ring of dots.
    const calm = await facet.plain(at("a.localhost", "/icon-page"));
    const calmId = await facet.tabIdOf(calm);
    await calm.emulateMedia({ reducedMotion: "reduce" });
    await mcp.call("get_tab_text", { tabId: calmId });
    const still = new Set<string>();
    for (let i = 0; i < 12; i++) {
      still.add(
        await calm.evaluate(
          () => document.getElementById("own-icon")!.getAttribute("href") ?? "",
        ),
      );
      await calm.waitForTimeout(100);
    }
    expect([...still].filter((h) => h.startsWith("data:"))).toHaveLength(1);
    const o = await overlayOf(facet, calmId);
    expect(o).toMatchObject({ present: true, glow: true });
    expectPurpleVignette(o);
  });

  /** Where in its 2.8 s cycle the base glow is (ms), and how far that is from the wall clock's cycle (circular distance, ms). */
  const phaseGap = (o: Overlay): number => {
    const b = o.base!;
    const inCycle = (((b.currentTime - b.delay) % 2800) + 2800) % 2800;
    const clock = b.clock % 2800;
    const d = Math.abs(inCycle - clock);
    return Math.min(d, 2800 - d);
  };

  test("the base glow is one element and one animation for the whole session: watch + a screenshot every few seconds + other tools never rebuild, restart or reset it", async ({
    facet,
  }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    const page = await facet.plain(at("a.localhost", "/agent"));
    const tabId = await facet.tabIdOf(page);
    const m = mcp;
    await m.json("watch", { tabId, minutes: 1 });
    await page.waitForTimeout(300); // (an animation has no start time until its first frame)
    const first = await overlayOf(facet, tabId);
    expect(first).toMatchObject({ present: true, glow: true, builds: 1 });
    expect(first.base).toMatchObject({ playState: "running" });
    const t0 = first.base!;
    let last = first;
    const calls: Array<() => Promise<unknown>> = [
      () => m.call("screenshot_tab", { tabId }),
      () => m.call("get_tab_text", { tabId }),
      () => m.call("screenshot_tab", { tabId }),
      () => m.json("click", { tabId, selector: "#go" }),
      () => m.call("screenshot_tab", { tabId }),
      () => m.call("screenshot_tab", { tabId, fullPage: true }), // the debugger's own capture path
      () => m.call("snapshot", { tabId }),
    ];
    for (const call of calls) {
      await call();
      const now = await overlayOf(facet, tabId);
      // The same overlay element, the same base element, the very same Animation object, never restarted.
      expect(now).toMatchObject({
        present: true,
        glow: true,
        builds: 1,
        hidden: false,
        hostId: first.hostId,
        steadyId: first.steadyId,
        baseId: first.baseId,
      });
      expect(now.base!.playState).toBe("running");
      expect(now.base!.startTime).toBe(t0.startTime);
      expect(now.base!.delay).toBe(t0.delay);
      // It has been running the whole time: its clock advanced exactly as much as the document's did.
      expect(now.base!.currentTime - t0.currentTime).toBeCloseTo(
        now.base!.now - t0.now,
        -1,
      );
      expect(now.base!.currentTime).toBeGreaterThan(last.base!.currentTime);
      expect(phaseGap(now)).toBeLessThan(60); // and it is in the cycle of the wall clock
      last = now;
      await page.waitForTimeout(900);
    }
    // The page takes the overlay out of the document: it goes back at once, the same node, still the same animation.
    await page.evaluate(() =>
      document.querySelector("facet-agent-overlay")!.remove(),
    );
    await expect
      .poll(
        () =>
          page.evaluate(() => !!document.querySelector("facet-agent-overlay")),
        { timeout: 1_000 },
      )
      .toBe(true);
    expect(await overlayOf(facet, tabId)).toMatchObject({
      builds: 1,
      hostId: first.hostId,
      steadyId: first.steadyId,
      baseId: first.baseId,
    });
    expect(phaseGap(await overlayOf(facet, tabId))).toBeLessThan(60);
  });

  test("an overlay that is built again joins the breathing where the cycle is (a phase from the wall clock), not from zero", async ({
    facet,
  }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    const page = await facet.plain(at("a.localhost", "/agent"));
    const tabId = await facet.tabIdOf(page);
    await mcp.call("get_tab_text", { tabId });
    const before = await overlayOf(facet, tabId);
    expect(phaseGap(before)).toBeLessThan(60);
    // Off and on again tears the overlay down; the next tool builds a new one.
    await facet.api("updateSettings", { agentActivity: false });
    await expect
      .poll(() => overlayOf(facet, tabId).then((o) => o.present))
      .toBe(false);
    await facet.api("updateSettings", { agentActivity: true });
    for (const wait of [0, 530, 1170]) {
      await page.waitForTimeout(wait);
      await mcp.call("get_tab_text", { tabId });
      const again = await overlayOf(facet, tabId);
      expect(again.builds).toBe(1);
      expect(again.baseId).not.toBe(before.baseId);
      expect(phaseGap(again)).toBeLessThan(60);
      await facet.api("updateSettings", { agentActivity: false });
      await expect
        .poll(() => overlayOf(facet, tabId).then((o) => o.present))
        .toBe(false);
      await facet.api("updateSettings", { agentActivity: true });
    }
  });

  test("a tab in the background is driven by the worker (page timers are throttled there): the favicon still turns at ~30 frames a second", async ({
    facet,
  }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    const page = await facet.plain(at("a.localhost", "/icon-page"));
    const tabId = await facet.tabIdOf(page);
    await facet.inWorker(async () => {
      const g = globalThis as any;
      g.__bgFavs = [];
      g.chrome.tabs.onUpdated.addListener(
        (_id: number, ch: { favIconUrl?: string }, tab: { id: number }) => {
          if (ch.favIconUrl !== undefined)
            g.__bgFavs.push([tab.id, ch.favIconUrl]);
        },
      );
    }, undefined);
    await mcp.json("watch", { tabId, minutes: 1 });
    await page.waitForTimeout(700);
    // In front: the page's own timer drives it, the worker sends nothing.
    const front = await overlayOf(facet, tabId);
    expect(front.iconTicks).toBe(0);
    // Another tab comes to the front: this one is in the background and gets the worker's ticks.
    const other = await facet.plain(at("a.localhost", "/agent"));
    await other.bringToFront();
    await facet.inWorker(
      async () => ((globalThis as any).__bgFavs.length = 0),
      undefined,
    );
    const framesBefore = (await overlayOf(facet, tabId)).iconFrames;
    await page.waitForTimeout(3_000);
    const bg = await overlayOf(facet, tabId);
    const chromeSaw: number = await facet.inWorker(
      async (id: number) =>
        (globalThis as any).__bgFavs.filter(
          (f: [number, string]) => f[0] === id,
        ).length,
      tabId,
    );
    test.info().annotations.push({
      type: "measured",
      description: `background tab: ${bg.iconTicks} ticks, ${(bg.iconFrames - framesBefore) / 3} frames/s, Chrome reported ${(chromeSaw / 3).toFixed(1)}/s`,
    });
    expect(bg.iconTicks).toBeGreaterThanOrEqual(3 * 20); // the worker's ticks arrive (~30 a second)
    expect((bg.iconFrames - framesBefore) / 3).toBeGreaterThanOrEqual(24);
    expect(chromeSaw / 3).toBeGreaterThanOrEqual(24);
    // Back in front: the ticks stop.
    await page.bringToFront();
    await page.waitForTimeout(600);
    const ticks = (await overlayOf(facet, tabId)).iconTicks;
    await page.waitForTimeout(800);
    expect((await overlayOf(facet, tabId)).iconTicks).toBe(ticks);
  });

  test("the edge glow lasts while the debugger stays attached (a viewport pin), across an in-page navigation and a full page load, and ends with the session", async ({
    facet,
  }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    const page = await facet.plain(at("a.localhost", "/spa-nav"));
    const tabId = await facet.tabIdOf(page);
    await mcp.json("resize_viewport", { tabId, width: 900, height: 600 }); // keeps the debugger attached until cleared
    await expect
      .poll(() => overlayOf(facet, tabId).then((o) => o.glow))
      .toBe(true);
    // Longer than the 8 s that a touch alone would carry: the attached debugger keeps the session.
    await page.waitForTimeout(10_500);
    expect(await overlayOf(facet, tabId)).toMatchObject({
      present: true,
      glow: true,
      boosted: false,
    });

    // An in-page navigation (pushState) keeps the document and so the glow.
    await mcp.json("click", { tabId, selector: "#nav" });
    expect(await page.evaluate(() => location.search)).toBe("?page=2");
    expect(await overlayOf(facet, tabId)).toMatchObject({
      present: true,
      glow: true,
    });

    // A full page load: the new document gets the glow again (within a moment of the commit).
    await page.evaluate(() => ((window as any).__old = true));
    await mcp.json("navigate", { tabId, url: at("a.localhost", "/blank") });
    expect(await page.evaluate(() => (window as any).__old === undefined)).toBe(
      true,
    ); // really a new document
    await expect
      .poll(() => overlayOf(facet, tabId).then((o) => o.present && o.glow), {
        timeout: 4_000,
      })
      .toBe(true);
    expect(await pageSees(page)).toMatchObject({
      element: true,
      shadowRoot: null,
    });

    // The pin ends: the debugger lets go, and 8 s after the last action the session is over.
    await mcp.json("resize_viewport", { tabId, clear: true });
    await expect
      .poll(() => overlayOf(facet, tabId).then((o) => o.present), {
        timeout: 25_000,
      })
      .toBe(false);
    expect(await pageSees(page)).toMatchObject({ element: false });
  });
  test("the glyph of a container tab's group blinks ✦ ✧ while the agent works in it (collapsed too); the group colour and the container stay; ⧉ comes back after the fade", async ({
    facet,
  }) => {
    const c = await facet.container("Grp");
    await turnOn(facet);
    mcp = await startMcp(facet);
    const page = await facet.openIn(c.name, at("a.localhost", "/agent"));
    const tabId = await facet.tabIdOf(page);
    const group = await groupOfTab(facet, tabId);
    const own = (await groupColourNow(facet, group))!;
    expect(await facet.groupInfo(group)).toMatchObject({
      title: `⧉ ${c.name}`,
      marker: c.id,
    });
    const containerColour = await containerColourNow(facet, c.id);
    await setCollapsed(facet, group, true);
    await recordTitles(facet, group);

    // A burst of actions: the glyph goes to ✦ in one change; name and invisible marker untouched; still collapsed.
    for (let i = 0; i < 3; i++) await mcp.call("get_tab_text", { tabId });
    await expectMarked(facet, group, c.name);
    expect(await groupColourNow(facet, group)).toBe(own); // the colour is never touched
    expect(await facet.groupInfo(group)).toMatchObject({ marker: c.id });
    expect(await containerNameNow(facet, c.id)).toBe(c.name);
    expect(await containerColourNow(facet, c.id)).toBe(containerColour);
    const info = await facet.inWorker(
      async (id: number) => (globalThis as any).chrome.tabGroups.get(id),
      group,
    );
    expect(info.collapsed).toBe(true);
    // The page's own title is not part of this.
    expect(await page.title()).not.toMatch(/[✦✧🟣⚪◉◎○]/u);

    // It blinks (every 1.2 s): both sparkles show up within a few seconds.
    await expect
      .poll(
        async () => new Set((await titlesSeen(facet)).map((e) => e.title)).size,
        { timeout: 5_000 },
      )
      .toBeGreaterThanOrEqual(2);

    // It ends with the toolbar dot (about 3.65 s after the last action): ⧉ again, the colour as it was.
    await expect
      .poll(() => groupTitleNow(facet, group), { timeout: 12_000 })
      .toBe(`⧉ ${c.name}`);
    const states = await titlesSeen(facet);
    expect(states[0]).toEqual({ title: `✦ ${c.name}`, color: own });
    expect(states.at(-1)).toEqual({ title: `⧉ ${c.name}`, color: own });
    expect(states.every((e) => e.color === own)).toBe(true); // the colour is constant throughout
    const blink = states.slice(0, -1).map((e) => e.title);
    expect(blink.every((t) => t === `✦ ${c.name}` || t === `✧ ${c.name}`)).toBe(
      true,
    );
    blink.forEach((t, i) => i > 0 && expect(t).not.toBe(blink[i - 1])); // one change per tick
    expect(blink[0]).toBe(`✦ ${c.name}`);
    expect(await containerNameNow(facet, c.id)).toBe(c.name);
    expect(await containerColourNow(facet, c.id)).toBe(containerColour);
    // Nothing comes back later (the echoes were not taken for an edit).
    await page.waitForTimeout(1_500);
    expect(await groupTitleNow(facet, group)).toBe(`⧉ ${c.name}`);
    expect(await groupColourNow(facet, group)).toBe(own);
    expect(await containerNameNow(facet, c.id)).toBe(c.name);
    expect(await containerColourNow(facet, c.id)).toBe(containerColour);
  });

  test("a recolour in Chrome's group editor while the mark is on recolours the container, the group keeps the colour, the blink goes on", async ({
    facet,
  }) => {
    const c = await facet.container("Rec");
    await turnOn(facet);
    mcp = await startMcp(facet);
    const page = await facet.openIn(c.name, at("a.localhost", "/agent"));
    const tabId = await facet.tabIdOf(page);
    const group = await groupOfTab(facet, tabId);
    let busy = true;
    const keepBusy = (async () => {
      while (busy) {
        await mcp!.call("get_tab_text", { tabId }).catch(() => {});
        await new Promise((r) => setTimeout(r, 600));
      }
    })();
    try {
      await expectMarked(facet, group, c.name);
      await facet.inWorker(
        async (id: number) =>
          (globalThis as any).chrome.tabGroups.update(id, { color: "purple" }),
        group,
      );
      await expect
        .poll(() => containerColourNow(facet, c.id), { timeout: 6_000 })
        .toBe("purple");
      await page.waitForTimeout(2_500); // a blink or two later the colour is still the user's
      expect(await groupColourNow(facet, group)).toBe("purple");
      await expectMarked(facet, group, c.name);
    } finally {
      busy = false;
      await keepBusy;
    }
    await expect
      .poll(() => groupTitleNow(facet, group), { timeout: 12_000 })
      .toBe(`⧉ ${c.name}`);
    expect(await groupColourNow(facet, group)).toBe("purple");
    expect(await containerColourNow(facet, c.id)).toBe("purple");
  });

  test("a purple container's group keeps its colour while marked; bridge off restores the glyph at once", async ({
    facet,
  }) => {
    const c = await facet.api<{ id: string; name: string }>("createContainer", {
      name: `Purp-${Date.now().toString(36)}`,
      color: "purple",
    });
    await turnOn(facet);
    mcp = await startMcp(facet);
    const page = await facet.openIn(c.name, at("a.localhost", "/agent"));
    const tabId = await facet.tabIdOf(page);
    const group = await groupOfTab(facet, tabId);
    expect(await groupColourNow(facet, group)).toBe("purple");
    await mcp.call("get_tab_text", { tabId });
    await expectMarked(facet, group, c.name);
    expect(await groupColourNow(facet, group)).toBe("purple");
    expect(await containerColourNow(facet, c.id)).toBe("purple");
    await facet.api("updateSettings", { agentBridge: false });
    await expect
      .poll(() => groupTitleNow(facet, group), { timeout: 2_000 })
      .toBe(`⧉ ${c.name}`);
    expect(await groupColourNow(facet, group)).toBe("purple");
    expect(await containerNameNow(facet, c.id)).toBe(c.name);
    await facet.api("deleteContainer", c.id).catch(() => {});
  });

  test("a rename in Chrome's group editor while the mark is on renames the container, and the blink goes on under the new name", async ({
    facet,
  }) => {
    const c = await facet.container("Ren");
    await turnOn(facet);
    mcp = await startMcp(facet);
    const page = await facet.openIn(c.name, at("a.localhost", "/agent"));
    const tabId = await facet.tabIdOf(page);
    const group = await groupOfTab(facet, tabId);
    const next = `${c.name}-new`;
    const own = await groupColourNow(facet, group);
    // The agent keeps working while the user types.
    let busy = true;
    const keepBusy = (async () => {
      while (busy) {
        await mcp!.call("get_tab_text", { tabId }).catch(() => {});
        await new Promise((r) => setTimeout(r, 600));
      }
    })();
    try {
      await expectMarked(facet, group, c.name);
      await facet.inWorker(
        async ([id, title]: [number, string]) =>
          (globalThis as any).chrome.tabGroups.update(id, { title }),
        [group, `✦ ${next}`] as [number, string],
      );
      await expect
        .poll(() => containerNameNow(facet, c.id), { timeout: 6_000 })
        .toBe(next);
      await expectMarked(facet, group, next); // not reverted to the old name, not to ⧉
      expect(await facet.groupInfo(group)).toMatchObject({ marker: c.id });
    } finally {
      busy = false;
      await keepBusy;
    }
    await expect
      .poll(() => groupTitleNow(facet, group), { timeout: 12_000 })
      .toBe(`⧉ ${next}`);
    expect(await groupColourNow(facet, group)).toBe(own);
    expect(await containerNameNow(facet, c.id)).toBe(next);
  });

  test("switching the bridge or the setting off restores the group glyph at once, and with the setting off there is no mark", async ({
    facet,
  }) => {
    const c = await facet.container("Off");
    await turnOn(facet);
    mcp = await startMcp(facet);
    const page = await facet.openIn(c.name, at("a.localhost", "/agent"));
    const tabId = await facet.tabIdOf(page);
    const group = await groupOfTab(facet, tabId);
    const own = await groupColourNow(facet, group);

    await mcp.call("get_tab_text", { tabId });
    await expectMarked(facet, group, c.name);
    await facet.api("updateSettings", { agentActivity: false });
    await expect
      .poll(() => groupTitleNow(facet, group), { timeout: 2_000 })
      .toBe(`⧉ ${c.name}`); // well before the fade would have ended it

    await mcp.call("get_tab_text", { tabId });
    await page.waitForTimeout(800);
    expect(await groupTitleNow(facet, group)).toBe(`⧉ ${c.name}`); // no mark with the setting off

    await facet.api("updateSettings", { agentActivity: true });
    await mcp.call("get_tab_text", { tabId });
    await expectMarked(facet, group, c.name);
    await facet.api("updateSettings", { agentBridge: false });
    await expect
      .poll(() => groupTitleNow(facet, group), { timeout: 2_000 })
      .toBe(`⧉ ${c.name}`);
    expect(await groupColourNow(facet, group)).toBe(own);
    expect(await containerNameNow(facet, c.id)).toBe(c.name);
  });

  test("a plain group of the user's and an ungrouped plain tab get no mark; a tab leaving the container group takes it off", async ({
    facet,
  }) => {
    const c = await facet.container("Mix");
    await turnOn(facet);
    mcp = await startMcp(facet);
    const plain = await facet.plain(at("a.localhost", "/agent"));
    const plainId = await facet.tabIdOf(plain);
    const userGroup = await facet.inWorker(async (id: number) => {
      const chrome = (globalThis as any).chrome;
      const g = await chrome.tabs.group({ tabIds: [id] });
      await chrome.tabGroups.update(g, { title: "Mine", color: "red" });
      return g as number;
    }, plainId);
    await mcp.call("get_tab_text", { tabId: plainId });
    await mcp.json("click", { tabId: plainId, selector: "#go" });
    await plain.waitForTimeout(800);
    expect(await facet.groupInfo(userGroup)).toMatchObject({
      title: "Mine",
      color: "red",
      marker: null,
    });

    // The container tab of the container group: marked, then it leaves the group while the agent is still on it.
    const boxed = await facet.openIn(c.name, at("a.localhost", "/agent"));
    const boxedId = await facet.tabIdOf(boxed);
    const other = await facet.openIn(c.name, at("a.localhost", "/blank")); // keeps the group alive
    await facet.tabIdOf(other);
    const group = await groupOfTab(facet, boxedId);
    await mcp.call("get_tab_text", { tabId: boxedId });
    await expectMarked(facet, group, c.name);
    await facet.inWorker(
      async (id: number) => (globalThis as any).chrome.tabs.ungroup([id]),
      boxedId,
    );
    await expect
      .poll(() => groupTitleNow(facet, group), { timeout: 2_000 })
      .toBe(`⧉ ${c.name}`);
    expect(await containerNameNow(facet, c.id)).toBe(c.name);
  });

  test("a mark left behind by a worker that died (a sparkle, a legacy 🟣 emoji, 0.1.6's stuck pulse colour) is cleaned up at the next start (by the invisible marker); a user's own group stays", async ({
    facet,
  }) => {
    const c = await facet.container("Left");
    const d = await facet.container("Left2");
    const page = await facet.openIn(c.name, at("a.localhost", "/agent"));
    const tabId = await facet.tabIdOf(page);
    const group = await groupOfTab(facet, tabId);
    const page2 = await facet.openIn(d.name, at("a.localhost", "/blank"));
    const group2 = await groupOfTab(facet, await facet.tabIdOf(page2));
    const mine = await facet.plain(at("a.localhost", "/blank"));
    const mineGroup = await facet.inWorker(
      async (id: number) => {
        const chrome = (globalThis as any).chrome;
        const g = await chrome.tabs.group({ tabIds: [id] });
        await chrome.tabGroups.update(g, { title: "✦ mine", color: "pink" });
        return g as number;
      },
      await facet.tabIdOf(mine),
    );
    const own = await groupColourNow(facet, group);
    const own2 = await groupColourNow(facet, group2);
    // What the dead worker left: a sparkle on one group, a legacy 🟣 and 0.1.6's stuck colour on the other.
    await facet.inWorker(
      async ([a, b]: [number, number]) => {
        const chrome = (globalThis as any).chrome;
        const ga = await chrome.tabGroups.get(a);
        await chrome.tabGroups.update(a, {
          title: String(ga.title).replace(/^⧉/, "✦"),
        });
        const gb = await chrome.tabGroups.get(b);
        await chrome.tabGroups.update(b, {
          title: String(gb.title).replace(/^⧉/, "🟣"),
          color: "pink",
        });
      },
      [group, group2] as [number, number],
    );
    await expect.poll(() => groupTitleNow(facet, group)).toBe(`✦ ${c.name}`);

    await facet.stopServiceWorker(page);
    await openPopup(facet); // wakes the worker, which cleans up at its start
    await expect
      .poll(() => groupTitleNow(facet, group), { timeout: 15_000 })
      .toBe(`⧉ ${c.name}`);
    await expect
      .poll(() => groupTitleNow(facet, group2), { timeout: 15_000 })
      .toBe(`⧉ ${d.name}`);
    expect(await groupColourNow(facet, group)).toBe(own);
    expect(await groupColourNow(facet, group2)).toBe(own2);
    expect(await facet.groupInfo(group)).toMatchObject({ marker: c.id });
    expect(await containerNameNow(facet, c.id)).toBe(c.name);
    expect(await facet.groupInfo(mineGroup)).toMatchObject({
      title: "✦ mine",
      color: "pink",
      marker: null,
    });
  });
});
