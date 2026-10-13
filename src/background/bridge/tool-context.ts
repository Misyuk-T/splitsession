/* eslint-disable @typescript-eslint/no-explicit-any -- tool arguments are validated by zod at the MCP boundary; the helpers here pass them through untyped */
import type { browser } from "wxt/browser";

import { SWITCHED_OFF, type ToolResult } from "../../bridge/protocol";
import { type Container, sleep } from "../../core";
import { withoutAgentMark } from "../../core/indicators";
import type { Facet } from "../facet";
import type { FullApi } from "../full-api";
import type { AgentActivity } from "./activity";
import {
  CdpError,
  type CdpSessions,
  dialogBlocks,
  refusedUrl,
  type TabSession,
} from "./cdp";
import * as dom from "./dom-tools";
import { ToolError } from "./errors";
import type { PageError, PageRect } from "./inject";
import { type DomCommand, type DomTarget, pageDom } from "./page-dom";
import {
  type ActionMeta,
  type Args,
  hostOf,
  hostTitle,
  json,
  live,
  withTimeout,
} from "./tool-kit";

type Browser = typeof browser;

export interface RouterDeps {
  b: Browser;
  facet: Pick<
    Facet,
    | "ready"
    | "listContainers"
    | "containers"
    | "createContainer"
    | "getTabContainer"
    | "prepareNavigation"
    | "openInContainer"
  >;
  api: Pick<FullApi, "assignTab">;
  /** Pause helper, replaceable in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** The profile label the user set in the options (empty: none), for `bridge_info`. */
  profileLabel?: () => Promise<string>;
  /** Shows the user which tab the agent touches (glow, pill, favicon, badge). Absent: nothing is shown. */
  activity?: Pick<AgentActivity, "touch" | "hide" | "unhide">;
  /**
   * The tabs' DevTools-protocol sessions ("full hands": trusted input, snapshots, background screenshots). Absent (unit
   * tests of the old paths): click, type, scroll and screenshot_tab fall back to injected scripts, and the tools
   * that only exist with CDP (run_js among them) say so.
   */
  cdp?: CdpSessions;
  /** macOS: "ControlOrMeta" means Meta, and editing shortcuts are sent as commands. */
  isMac?: boolean;
}

/** The address a tab shows or is loading. */
export const tabUrl = (tab: {
  url?: string;
  pendingUrl?: string;
}): string | undefined => tab.url ?? tab.pendingUrl;

/** What every tool uses: the extension APIs, the tab and page helpers, the refs `snapshot` handed out. */
export class ToolContext {
  readonly sleep: (ms: number) => Promise<void>;
  /** The refs `snapshot` handed out, per tab (the registry behind them lives in the page: page-dom.ts). */
  readonly refs = new Map<number, dom.DomRefs>();
  /** Screenshots flip the active tab of a window: one at a time. */
  private shotQueue: Promise<unknown> = Promise.resolve();

  constructor(readonly d: RouterDeps) {
    this.sleep = d.sleep ?? sleep;
  }

  get b(): Browser {
    return this.d.b;
  }

  /** Shows the user which tab the agent works on (and where), when activity is on. */
  touch(
    ...args: Parameters<AgentActivity["touch"]>
  ): Promise<void> | undefined {
    return this.d.activity?.touch(...args);
  }

  /** Runs screenshots one after another (each may flip the active tab of a window). */
  oneShotAtATime(work: () => Promise<ToolResult>): Promise<ToolResult> {
    const run = this.shotQueue.then(work);
    this.shotQueue = run.catch(() => {});
    return run;
  }

  // ------------------------------------------------------------------ containers and tabs

  container(
    ref: string,
    createIfMissing: boolean,
  ): Promise<Container> | Container {
    const { facet } = this.d;
    const found = facet.containers.resolve(ref);
    if (found) return found;
    if (!createIfMissing) {
      const names = facet.listContainers().map((c) => `"${c.name}"`);
      throw new ToolError(
        `no container "${ref}"${names.length ? ` (existing: ${names.join(", ")})` : " (none exist yet)"}; pass createIfMissing to create it`,
      );
    }
    return facet.createContainer({ name: ref });
  }

  /** The container of a tab, or undefined. */
  containerOf(tabId: number): Container | undefined {
    const containerId = this.d.facet.getTabContainer(tabId);
    return containerId ? this.d.facet.containers.get(containerId) : undefined;
  }

  async tab(tabId: number, meta?: ActionMeta) {
    let found;
    try {
      const tab = await this.b.tabs.get(tabId);
      if (meta) {
        meta.host = hostOf(tabUrl(tab));
        meta.title = hostTitle(tab.title);
      }
      found = tab;
    } catch {
      throw new ToolError(
        `no tab with id ${tabId} (it may have been closed; call list_tabs)`,
      );
    }
    live(meta); // the lookup can be slow; the action that follows must not run after "off"
    // Show the user which tab this is, before anything is done to it (never fails, never moves focus).
    if (meta?.tool) await this.d.activity?.touch(tabId, meta.tool);
    live(meta);
    return found;
  }

  /** Waits for a navigation that has just been started to finish (or `limitMs`); true when the page finished loading. */
  async waitForLoad(
    tabId: number,
    meta?: ActionMeta,
    limitMs = 10_000,
  ): Promise<boolean> {
    const start = Date.now();
    await this.sleep(150);
    while (Date.now() - start < limitMs) {
      live(meta);
      const tab = await this.b.tabs.get(tabId).catch(() => null);
      if (!tab) return false;
      if (
        tab.status === "complete" &&
        !tab.pendingUrl &&
        tab.url !== "about:blank"
      )
        return true;
      await this.sleep(100);
    }
    return false;
  }

  async summary(tabId: number, extra: Record<string, unknown> = {}) {
    const tab = await this.b.tabs.get(tabId).catch(() => null);
    const container = tab ? this.containerOf(tabId) : undefined;
    return {
      tabId,
      ...(tab
        ? {
            windowId: tab.windowId,
            url: tabUrl(tab) ?? "",
            title: withoutAgentMark(tab.title ?? ""),
            status: tab.status,
          }
        : {}),
      container: container ? { id: container.id, name: container.name } : null,
      ...extra,
    };
  }

  /** The answer of a tool that navigates: the tab's summary, with `loaded` when it waited for the load. */
  async summaryAfterLoad(
    tabId: number,
    loaded: boolean | undefined,
  ): Promise<ToolResult> {
    return json(
      await this.summary(tabId, loaded === undefined ? {} : { loaded }),
    );
  }

  /** Runs `func` in the top frame of a tab. Page-side `{error}` results become ToolErrors. */
  async inPage<T>(
    tabId: number,
    func: (...args: any[]) => T,
    args: unknown[],
    world: "MAIN" | "ISOLATED" = "ISOLATED",
    meta?: ActionMeta,
    frameId = 0,
  ): Promise<Awaited<T>> {
    let results;
    live(meta);
    try {
      results = await this.b.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        world,
        func: func as never,
        args: args as never,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        /cannot access|extensions gallery|chrome:\/\/|error page|showing error/i.test(
          message,
        )
      ) {
        throw new ToolError(
          `the page cannot be scripted (${message}); chrome:// pages, the Web Store and error pages are off limits to extensions`,
        );
      }
      throw new ToolError(`could not run in the page: ${message}`);
    }
    const result = results?.[0]?.result as Awaited<T> | undefined;
    if (result === undefined || result === null)
      throw new ToolError(
        "the page returned nothing (it may have navigated away); try again",
      );
    const maybeError = (result as unknown as Partial<PageError>).error;
    if (typeof result === "object" && typeof maybeError === "string")
      throw new ToolError(maybeError);
    return result;
  }

  // ------------------------------------------------------------------ DOM tools (no debugger) and CDP ("full hands")

  /** A JavaScript dialog SplitSession saw on the tab freezes the page: a script in it would never answer. */
  noDialog(tabId: number): void {
    const dialog = this.d.cdp?.current(tabId)?.dialog;
    if (dialog) throw new ToolError(dialogBlocks(dialog));
  }

  get cdp(): CdpSessions {
    if (!this.d.cdp)
      throw new ToolError(
        "this tool needs the debugger, which is not available here",
      );
    return this.d.cdp;
  }

  /** The DOM tools' way into a frame (page-dom.ts): `scripting.executeScript`, never the debugger. */
  domHost(meta: ActionMeta): dom.DomHost {
    return {
      call: (tabId, frameId, cmd: DomCommand) =>
        this.inPage(tabId, pageDom, [cmd], "ISOLATED", meta, frameId),
      tryCall: async (tabId, frameId, cmd: DomCommand) => {
        try {
          return await withTimeout(
            this.inPage(tabId, pageDom, [cmd], "ISOLATED", meta, frameId),
            4_000,
            "reading a frame",
            meta.signal,
          );
        } catch (error) {
          if (meta.signal?.aborted) throw error;
          return null; // a frame that cannot be scripted (or is slow) is left out
        }
      },
      frames: async (tabId) =>
        ((await this.b.webNavigation?.getAllFrames({ tabId })) ?? []).map(
          (f) => ({
            frameId: f.frameId,
            parentFrameId: f.parentFrameId,
            url: f.url,
          }),
        ),
    };
  }

  /** Why the agent may not operate this tab (the same pages the debugger refuses), as a ToolError. */
  operable(url: string | undefined): void {
    const refused = refusedUrl(url);
    if (refused)
      throw new ToolError(`SplitSession cannot operate this tab: ${refused}`);
  }

  /**
   * Runs `work` with the tab attached through CDP. A JavaScript dialog that is open stops it (the page cannot answer
   * while one is), and the answer of every page tool mentions a dialog that its action opened.
   */
  async onPage<T>(
    tabId: number,
    meta: ActionMeta,
    work: (s: TabSession) => Promise<T>,
    opts: { dialogOk?: boolean } = {},
  ): Promise<T> {
    live(meta);
    try {
      return await this.cdp.use(
        tabId,
        async (s) => {
          if (s.dialog && !opts.dialogOk)
            throw new ToolError(dialogBlocks(s.dialog));
          live(meta);
          return work(s);
        },
        () => live(meta),
      );
    } catch (error) {
      throw this.cdpFailure(error, meta);
    }
  }

  /** A CDP failure as the agent should see it: "switched off" after an abort, a ToolError for CDP's own errors. */
  cdpFailure(error: unknown, meta: ActionMeta): unknown {
    if (meta.signal?.aborted) return new ToolError(SWITCHED_OFF);
    if (error instanceof CdpError) return new ToolError(error.message);
    return error;
  }

  /** Adds a note about an open dialog to an answer (the agent would otherwise wonder why the page stopped). */
  withDialogNote(tabId: number, result: ToolResult): ToolResult {
    const dialog = this.d.cdp?.current(tabId)?.dialog;
    if (!dialog) return result;
    return {
      content: [
        ...result.content,
        { type: "text", text: `Note: ${dialogBlocks(dialog)}` },
      ],
    };
  }

  /** The element an agent named: `ref` or `selector` (with `prefix`: `toRef` / `toSelector`), or null. */
  target(a: Args, prefix = ""): dom.ElementRef | null {
    const ref = a[prefix ? `${prefix}Ref` : "ref"] as string | undefined;
    const selector = a[prefix ? `${prefix}Selector` : "selector"] as
      string | undefined;
    if (ref !== undefined && selector !== undefined)
      throw new ToolError(
        `give ${prefix ? `${prefix}Ref or ${prefix}Selector` : "ref or selector"}, not both`,
      );
    if (ref !== undefined) return { ref };
    if (selector !== undefined) return { selector };
    return null;
  }

  /** The element of a target in the page, with the DOM command `build` makes of it (answers carry top-viewport coordinates). */
  onElement<T = any>(
    tabId: number,
    meta: ActionMeta,
    t: dom.ElementRef,
    build: (target: DomTarget) => DomCommand,
  ): Promise<T> {
    return dom.onTarget<T>(
      this.domHost(meta),
      tabId,
      this.refs.get(tabId),
      t,
      build,
    );
  }

  /** A point of the page: the middle of an element (scrolled into view), or the given viewport coordinates. */
  async point(
    tabId: number,
    meta: ActionMeta,
    a: Args,
    prefix = "",
  ): Promise<dom.Located> {
    const t = this.target(a, prefix);
    const xKey = prefix ? `${prefix}X` : "x";
    const yKey = prefix ? `${prefix}Y` : "y";
    const hasX = a[xKey] !== undefined;
    const hasY = a[yKey] !== undefined;
    if (t && (hasX || hasY))
      throw new ToolError(
        `give a ref, a selector or ${xKey}+${yKey}, not several`,
      );
    if (t)
      return this.onElement<dom.Located>(tabId, meta, t, (target) => ({
        op: "locate",
        target,
        scroll: true,
      }));
    if (hasX !== hasY) throw new ToolError(`${xKey} and ${yKey} go together`);
    if (!hasX)
      throw new ToolError(
        prefix
          ? `give where to drop: ${prefix}Ref, ${prefix}Selector, or ${xKey}+${yKey}`
          : "give a ref (from snapshot), a selector, or both x and y",
      );
    const at = (await this.domHost(meta).call(tabId, 0, {
      op: "at",
      x: a[xKey],
      y: a[yKey],
    })) as { label: string; rect: PageRect };
    return { x: a[xKey], y: a[yKey], rect: at.rect, label: at.label };
  }
}

/** One tool: runs with validated arguments, reports about itself in `meta`. */
export type ToolHandler = (
  c: ToolContext,
  a: Args,
  meta: ActionMeta,
) => Promise<ToolResult>;
