import type { browser } from 'wxt/browser';
import type { Container } from '../../core';
import { SWITCHED_OFF, type ToolResult } from '../../bridge/protocol';
import { toolByName, toolTimeoutMs } from '../../bridge/spec';
import { validateArgs } from '../../bridge/validate';
import type { Facet } from '../facet';
import type { FullApi } from '../full-api';
import { withoutAgentMark } from '../../core/indicators';
import type { AgentActivity } from './activity';
import { CdpError, dialogBlocks, refusedUrl, type CdpSessions, type TabSession } from './cdp';
import * as hands from './cdp-tools';
import * as dom from './dom-tools';
import { ToolError } from './errors';
import { pageClick, pageHtml, pageRun, pageScroll, pageText, pageType, type PageError, type PageRect, type RunResult } from './inject';
import type { Modifier } from './keys';
import { pageDom, type DomCommand } from './page-dom';

type Browser = typeof browser;

export { ToolError };

/** What a tool run reports about itself for the action log (never page content). */
export interface ActionMeta {
  tabId?: number;
  host?: string;
  /** The tool being run, and the title of the tab it works on (without our own marks): for the popup's recent actions. */
  tool?: string;
  title?: string;
  /**
   * Aborted when the bridge is switched off (or its connection drops) while the tool runs. Every step that changes
   * something checks it first, and every wait ends on it: a tool that was already received must not act after "off".
   * (A script already running inside a page cannot be recalled.)
   */
  signal?: AbortSignal;
}

/** Throws the "switched off" error when the run was aborted. */
function live(meta?: ActionMeta): void {
  if (meta?.signal?.aborted) throw new ToolError(SWITCHED_OFF);
}

export interface RouterDeps {
  b: Browser;
  facet: Pick<
    Facet,
    'ready' | 'listContainers' | 'containers' | 'createContainer' | 'getTabContainer' | 'prepareNavigation' | 'openInContainer'
  >;
  api: Pick<FullApi, 'assignTab'>;
  /** Pause helper, replaceable in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** The profile label the user set in the options (empty: none), for `bridge_info`. */
  profileLabel?: () => Promise<string>;
  /** Shows the user which tab the agent touches (glow, pill, favicon, badge). Absent: nothing is shown. */
  activity?: Pick<AgentActivity, 'touch' | 'hide' | 'unhide'>;
  /**
   * The tabs' DevTools-protocol sessions ("full hands": trusted input, snapshots, background screenshots). Absent (unit
   * tests of the old paths): click, type, scroll, run_js and screenshot_tab fall back to injected scripts, and the tools
   * that only exist with CDP say so.
   */
  cdp?: CdpSessions;
  /** macOS: "ControlOrMeta" means Meta, and editing shortcuts are sent as commands. */
  isMac?: boolean;
}

/** Long enough to see "closing" on the tab before it goes. */
const CLOSE_PAUSE_MS = 600;
const hostTitle = (title: string | undefined): string | undefined => (title ? withoutAgentMark(title).slice(0, 80) : undefined);

type Args = Record<string, any>;

const text = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] });
const json = (value: unknown): ToolResult => text(JSON.stringify(value));

const hostOf = (url: string | undefined): string | undefined => {
  try {
    return url ? new URL(url).host || undefined : undefined;
  } catch {
    return undefined;
  }
};

/** Only these schemes are opened for the agent; `javascript:`, `file:`, `data:` and the like are refused. */
export function checkUrl(url: string, allowed: readonly string[]): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ToolError(`"${url.slice(0, 80)}" is not a valid address (include https://)`);
  }
  if (!allowed.includes(parsed.protocol)) throw new ToolError(`addresses of type ${parsed.protocol} are not allowed here; use ${allowed.join(', ')}`);
  return parsed;
}

const OPEN_SCHEMES = ['http:', 'https:', 'about:', 'chrome:', 'chrome-extension:'];

export function withTimeout<T>(work: Promise<T>, ms: number, what: string, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ToolError(`${what} timed out after ${Math.round(ms / 1000)} seconds`)), ms);
    if (signal) {
      onAbort = () => reject(new ToolError(SWITCHED_OFF));
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  return Promise.race([work, deadline]).finally(() => {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  });
}

/** The bridge's command router: validates the arguments of a tool call and runs it with extension APIs. */
export class BridgeRouter {
  private readonly sleep: (ms: number) => Promise<void>;
  /** Screenshots flip the active tab of a window: one at a time. */
  private shotQueue: Promise<unknown> = Promise.resolve();
  /** The refs `snapshot` handed out, per tab (the registry behind them lives in the page: page-dom.ts). */
  private readonly refs = new Map<number, dom.DomRefs>();

  constructor(private readonly d: RouterDeps) {
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** The tab closed. */
  forgetTab(tabId: number): void {
    this.refs.delete(tabId);
  }

  /** The agent's MCP process is gone (and no other one is connected): take back viewport overrides and debugger sessions. */
  async release(): Promise<void> {
    await this.d.cdp?.release();
  }

  /** Runs one tool. Throws ToolError (or any error) with a message meant for the agent. */
  async run(tool: string, rawArgs: unknown, meta: ActionMeta, timeoutMs?: number): Promise<ToolResult> {
    const spec = toolByName(tool);
    if (!spec) throw new ToolError(`unknown tool "${tool}"`);
    const checked = validateArgs(spec.inputSchema, rawArgs);
    if (!checked.ok) throw new ToolError(`${tool}: ${checked.error}`);
    await this.d.facet.ready;
    live(meta);
    return withTimeout(this.dispatch(tool, checked.value as Args, meta), timeoutMs ?? toolTimeoutMs(tool), tool, meta.signal);
  }

  private dispatch(tool: string, a: Args, meta: ActionMeta): Promise<ToolResult> {
    if (typeof a.tabId === 'number') meta.tabId = a.tabId;
    meta.tool = tool;
    switch (tool) {
      case 'bridge_info':
        return this.bridgeInfo();
      case 'list_containers':
        return this.listContainers();
      case 'list_tabs':
        return this.listTabs(a);
      case 'open_in_container':
        return this.openInContainer(a, meta);
      case 'open_tab':
        return this.openTab(a, meta);
      case 'navigate':
        return this.navigate(a, meta);
      case 'close_tab':
        return this.closeTab(a, meta);
      case 'activate_tab':
        return this.activateTab(a, meta);
      case 'assign_tab':
        return this.assignTab(a, meta);
      case 'get_tab_text':
        return this.getTabText(a, meta);
      case 'get_tab_html':
        return this.getTabHtml(a, meta);
      case 'screenshot_tab':
        return this.screenshot(a, meta);
      case 'click':
        return this.click(a, meta);
      case 'type':
        return this.type(a, meta);
      case 'scroll':
        return this.scroll(a, meta);
      case 'run_js':
        return this.runJs(a, meta);
      case 'snapshot':
        return this.snapshot(a, meta);
      case 'hover':
        return this.hover(a, meta);
      case 'drag':
        return this.drag(a, meta);
      case 'press_key':
        return this.pressKey(a, meta);
      case 'select_option':
        return this.selectOption(a, meta);
      case 'upload_file':
        return this.uploadFile(a, meta);
      case 'wait_for':
        return this.waitFor(a, meta);
      case 'navigate_back':
      case 'navigate_forward':
        return this.history(a, meta, tool === 'navigate_back' ? -1 : 1);
      case 'reload':
        return this.reload(a, meta);
      case 'handle_dialog':
        return this.handleDialog(a, meta);
      case 'console_messages':
        return this.consoleMessages(a, meta);
      case 'network_requests':
        return this.networkRequests(a, meta);
      case 'watch':
        return this.watch(a, meta);
      case 'resize_viewport':
        return this.resizeViewport(a, meta);
      default:
        throw new ToolError(`unknown tool "${tool}"`);
    }
  }

  // ------------------------------------------------------------------ helpers

  private get b(): Browser {
    return this.d.b;
  }

  private container(ref: string, createIfMissing: boolean): Promise<Container> | Container {
    const found = this.d.facet.containers.resolve(ref);
    if (found) return found;
    if (!createIfMissing) {
      const names = this.d.facet.listContainers().map((c) => `"${c.name}"`);
      throw new ToolError(`no container "${ref}"${names.length ? ` (existing: ${names.join(', ')})` : ' (none exist yet)'}; pass createIfMissing to create it`);
    }
    return this.d.facet.createContainer({ name: ref });
  }

  private async tab(tabId: number, meta?: ActionMeta) {
    let found;
    try {
      const tab = await this.b.tabs.get(tabId);
      if (meta) {
        meta.host = hostOf(tab.url ?? tab.pendingUrl);
        meta.title = hostTitle(tab.title);
      }
      found = tab;
    } catch {
      throw new ToolError(`no tab with id ${tabId} (it may have been closed; call list_tabs)`);
    }
    live(meta); // the lookup can be slow; the action that follows must not run after "off"
    // Show the user which tab this is, before anything is done to it (never fails, never moves focus).
    if (meta?.tool) await this.d.activity?.touch(tabId, meta.tool);
    live(meta);
    return found;
  }

  /** Waits for a navigation that has just been started to finish (or `limitMs`); true when the page finished loading. */
  private async waitForLoad(tabId: number, meta?: ActionMeta, limitMs = 10_000): Promise<boolean> {
    const start = Date.now();
    await this.sleep(150);
    while (Date.now() - start < limitMs) {
      live(meta);
      const tab = await this.b.tabs.get(tabId).catch(() => null);
      if (!tab) return false;
      if (tab.status === 'complete' && !tab.pendingUrl && tab.url !== 'about:blank') return true;
      await this.sleep(100);
    }
    return false;
  }

  private async summary(tabId: number, extra: Record<string, unknown> = {}) {
    const tab = await this.b.tabs.get(tabId).catch(() => null);
    const containerId = tab ? this.d.facet.getTabContainer(tabId) : null;
    const container = containerId ? this.d.facet.containers.get(containerId) : undefined;
    return {
      tabId,
      ...(tab ? { windowId: tab.windowId, url: tab.url ?? tab.pendingUrl ?? '', title: withoutAgentMark(tab.title ?? ''), status: tab.status } : {}),
      container: container ? { id: container.id, name: container.name } : null,
      ...extra,
    };
  }

  /** Runs `func` in the top frame of a tab. Page-side `{error}` results become ToolErrors. */
  private async inPage<T>(tabId: number, func: (...args: any[]) => T, args: unknown[], world: 'MAIN' | 'ISOLATED' = 'ISOLATED', meta?: ActionMeta, frameId = 0): Promise<Awaited<T>> {
    let results;
    live(meta);
    try {
      results = await this.b.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, world, func: func as never, args: args as never });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/cannot access|extensions gallery|chrome:\/\/|error page|showing error/i.test(message)) {
        throw new ToolError(`the page cannot be scripted (${message}); chrome:// pages, the Web Store and error pages are off limits to extensions`);
      }
      throw new ToolError(`could not run in the page: ${message}`);
    }
    const result = results?.[0]?.result as Awaited<T> | undefined;
    if (result === undefined || result === null) throw new ToolError('the page returned nothing (it may have navigated away); try again');
    const maybeError = (result as unknown as Partial<PageError>).error;
    if (typeof result === 'object' && typeof maybeError === 'string') throw new ToolError(maybeError);
    return result;
  }

  // ------------------------------------------------------------------ tools

  /** Which Chrome profile the agent is talking to: the user's label plus the size of the profile. */
  private async bridgeInfo(): Promise<ToolResult> {
    const label = ((await this.d.profileLabel?.()) ?? '').trim();
    const [windows, tabs] = await Promise.all([this.b.windows.getAll(), this.b.tabs.query({})]);
    return json({
      profileLabel: label === '' ? null : label,
      windows: windows.length,
      tabs: tabs.length,
      containers: this.d.facet.listContainers().length,
      extensionVersion: this.b.runtime.getManifest().version,
    });
  }

  private async listContainers(): Promise<ToolResult> {
    return json(this.d.facet.listContainers().map((c) => ({ id: c.id, name: c.name, color: c.color, tabCount: c.tabCount })));
  }

  private async listTabs(a: Args): Promise<ToolResult> {
    const query: { windowId?: number } = {};
    if (a.windowId !== undefined) query.windowId = a.windowId;
    let only: string | undefined;
    if (a.containerId !== undefined) {
      const found = this.d.facet.containers.resolve(a.containerId);
      if (!found) throw new ToolError(`no container "${a.containerId}"`);
      only = found.id;
    }
    const tabs = await this.b.tabs.query(query);
    const out = [];
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      const containerId = this.d.facet.getTabContainer(tab.id);
      if (only !== undefined && containerId !== only) continue;
      const c = containerId ? this.d.facet.containers.get(containerId) : undefined;
      out.push({
        tabId: tab.id,
        windowId: tab.windowId,
        index: tab.index,
        active: tab.active,
        pinned: tab.pinned,
        title: withoutAgentMark(tab.title ?? ''),
        url: tab.url ?? tab.pendingUrl ?? '',
        status: tab.status,
        groupId: tab.groupId ?? -1,
        container: c ? { id: c.id, name: c.name } : null,
      });
    }
    return json(out);
  }

  private async openInContainer(a: Args, meta: ActionMeta): Promise<ToolResult> {
    const url = checkUrl(a.url, ['http:', 'https:']);
    meta.host = url.host;
    const container = await this.container(a.container, a.createIfMissing);
    live(meta);
    const tabId = await this.d.facet.openInContainer(url.href, container.id, { active: a.active, ...(a.windowId !== undefined ? { windowId: a.windowId } : {}) });
    meta.tabId = tabId;
    await this.d.activity?.touch(tabId, 'open_in_container');
    const loaded = a.wait ? await this.waitForLoad(tabId, meta) : undefined;
    if (loaded) await this.d.activity?.touch(tabId, 'open_in_container');
    return json(await this.summary(tabId, loaded === undefined ? {} : { loaded }));
  }

  private async openTab(a: Args, meta: ActionMeta): Promise<ToolResult> {
    const url = checkUrl(a.url, OPEN_SCHEMES);
    meta.host = url.host || undefined;
    const tab = await this.b.tabs.create({ url: url.href, active: a.active, ...(a.windowId !== undefined ? { windowId: a.windowId } : {}) });
    if (tab.id === undefined) throw new ToolError('Chrome did not create the tab');
    meta.tabId = tab.id;
    await this.d.activity?.touch(tab.id, 'open_tab');
    const loaded = a.wait && url.protocol !== 'about:' ? await this.waitForLoad(tab.id, meta) : undefined;
    if (loaded) await this.d.activity?.touch(tab.id, 'open_tab');
    return json(await this.summary(tab.id, loaded === undefined ? {} : { loaded }));
  }

  private async navigate(a: Args, meta: ActionMeta): Promise<ToolResult> {
    const url = checkUrl(a.url, OPEN_SCHEMES);
    await this.tab(a.tabId, meta);
    meta.host = url.host || undefined;
    // Same as every navigation Facet starts itself: no service worker of the target may answer a container's request.
    if (this.d.facet.getTabContainer(a.tabId) !== null && (url.protocol === 'http:' || url.protocol === 'https:')) await this.d.facet.prepareNavigation(url.href);
    live(meta);
    await this.b.tabs.update(a.tabId, { url: url.href });
    const loaded = a.wait ? await this.waitForLoad(a.tabId, meta) : undefined;
    if (loaded) await this.d.activity?.touch(a.tabId, 'navigate'); // the new page has none of the old page's overlay
    return json(await this.summary(a.tabId, loaded === undefined ? {} : { loaded }));
  }

  private async closeTab(a: Args, meta: ActionMeta): Promise<ToolResult> {
    await this.tab(a.tabId, meta);
    if (this.d.activity) await this.sleep(CLOSE_PAUSE_MS); // the user sees which tab is going
    live(meta);
    await this.b.tabs.remove(a.tabId);
    return json({ tabId: a.tabId, closed: true });
  }

  private async activateTab(a: Args, meta: ActionMeta): Promise<ToolResult> {
    const tab = await this.tab(a.tabId, meta);
    await this.b.tabs.update(a.tabId, { active: true });
    await this.b.windows.update(tab.windowId, { focused: true }).catch(() => {});
    return json(await this.summary(a.tabId));
  }

  private async assignTab(a: Args, meta: ActionMeta): Promise<ToolResult> {
    await this.tab(a.tabId, meta);
    let containerId: string | null = null;
    if (a.container !== null) {
      if (a.container.trim() === '') throw new ToolError('container must be a name or ID, or null to leave the container');
      containerId = (await this.container(a.container, a.createIfMissing)).id;
    }
    live(meta);
    await this.d.api.assignTab(a.tabId, containerId, { reload: a.reload });
    if (a.reload && (await this.waitForLoad(a.tabId, meta))) await this.d.activity?.touch(a.tabId, 'assign_tab'); // the reloaded page starts clean
    return json(await this.summary(a.tabId));
  }

  /** A JavaScript dialog Facet saw on the tab freezes the page: a script in it would never answer. */
  private noDialog(tabId: number): void {
    const dialog = this.d.cdp?.current(tabId)?.dialog;
    if (dialog) throw new ToolError(dialogBlocks(dialog));
  }

  private async getTabText(a: Args, meta: ActionMeta): Promise<ToolResult> {
    await this.tab(a.tabId, meta);
    this.noDialog(a.tabId);
    const r = await this.inPage(a.tabId, pageText, [a.maxChars], 'ISOLATED', meta);
    return {
      content: [
        { type: 'text', text: JSON.stringify({ tabId: a.tabId, url: r.url, title: r.title, length: r.total, truncated: r.total > r.text.length }) },
        { type: 'text', text: r.text },
      ],
    };
  }

  private async getTabHtml(a: Args, meta: ActionMeta): Promise<ToolResult> {
    await this.tab(a.tabId, meta);
    this.noDialog(a.tabId);
    const r = (await this.inPage(a.tabId, pageHtml, [a.selector ?? null, a.maxChars], 'ISOLATED', meta)) as { html: string; total: number; url: string; title: string };
    return {
      content: [
        { type: 'text', text: JSON.stringify({ tabId: a.tabId, url: r.url, title: r.title, selector: a.selector ?? null, length: r.total, truncated: r.total > r.html.length }) },
        { type: 'text', text: r.html },
      ],
    };
  }

  // ------------------------------------------------------------------ DOM tools (no debugger) and CDP ("full hands")

  private get cdp(): CdpSessions {
    if (!this.d.cdp) throw new ToolError('this tool needs the debugger, which is not available here');
    return this.d.cdp;
  }

  /** The DOM tools' way into a frame (page-dom.ts): `scripting.executeScript`, never the debugger. */
  private domHost(meta: ActionMeta): dom.DomHost {
    return {
      call: (tabId, frameId, cmd: DomCommand) => this.inPage(tabId, pageDom, [cmd], 'ISOLATED', meta, frameId),
      tryCall: async (tabId, frameId, cmd: DomCommand) => {
        try {
          return await withTimeout(this.inPage(tabId, pageDom, [cmd], 'ISOLATED', meta, frameId), 4_000, 'reading a frame', meta.signal);
        } catch (error) {
          if (meta.signal?.aborted) throw error;
          return null; // a frame that cannot be scripted (or is slow) is left out
        }
      },
      frames: async (tabId) =>
        ((await this.b.webNavigation?.getAllFrames({ tabId })) ?? []).map((f) => ({ frameId: f.frameId, parentFrameId: f.parentFrameId, url: f.url })),
    };
  }

  /** Why the agent may not operate this tab (the same pages the debugger refuses), as a ToolError. */
  private operable(url: string | undefined): void {
    const refused = refusedUrl(url);
    if (refused) throw new ToolError(`Facet cannot operate this tab: ${refused}`);
  }

  /**
   * Runs `work` with the tab attached through CDP. A JavaScript dialog that is open stops it (the page cannot answer
   * while one is), and the answer of every page tool mentions a dialog that its action opened.
   */
  private async onPage<T>(tabId: number, meta: ActionMeta, work: (s: TabSession) => Promise<T>, opts: { dialogOk?: boolean } = {}): Promise<T> {
    live(meta);
    try {
      return await this.cdp.use(
        tabId,
        async (s) => {
          if (s.dialog && !opts.dialogOk) throw new ToolError(dialogBlocks(s.dialog));
          live(meta);
          return work(s);
        },
        () => live(meta),
      );
    } catch (error) {
      if (meta.signal?.aborted) throw new ToolError(SWITCHED_OFF);
      if (error instanceof CdpError) throw new ToolError(error.message);
      throw error;
    }
  }

  /** Adds a note about an open dialog to an answer (the agent would otherwise wonder why the page stopped). */
  private withDialogNote(tabId: number, result: ToolResult): ToolResult {
    const dialog = this.d.cdp?.current(tabId)?.dialog;
    if (!dialog) return result;
    return { content: [...result.content, { type: 'text', text: `Note: ${dialogBlocks(dialog)}` }] };
  }

  private target(a: Args, prefix = ''): dom.ElementRef | null {
    const ref = a[prefix ? `${prefix}Ref` : 'ref'] as string | undefined;
    const selector = a[prefix ? `${prefix}Selector` : 'selector'] as string | undefined;
    if (ref !== undefined && selector !== undefined) throw new ToolError(`give ${prefix ? `${prefix}Ref or ${prefix}Selector` : 'ref or selector'}, not both`);
    if (ref !== undefined) return { ref };
    if (selector !== undefined) return { selector };
    return null;
  }

  /** The element of a target in the page, with the DOM command `build` makes of it (answers carry top-viewport coordinates). */
  private onElement<T = any>(tabId: number, meta: ActionMeta, t: dom.ElementRef, build: (target: import('./page-dom').DomTarget) => DomCommand): Promise<T> {
    return dom.onTarget<T>(this.domHost(meta), tabId, this.refs.get(tabId), t, build);
  }

  /** A point of the page: the middle of an element (scrolled into view), or the given viewport coordinates. */
  private async point(tabId: number, meta: ActionMeta, a: Args, prefix = ''): Promise<dom.Located> {
    const t = this.target(a, prefix);
    const xKey = prefix ? `${prefix}X` : 'x';
    const yKey = prefix ? `${prefix}Y` : 'y';
    const hasX = a[xKey] !== undefined;
    const hasY = a[yKey] !== undefined;
    if (t && (hasX || hasY)) throw new ToolError(`give a ref, a selector or ${xKey}+${yKey}, not several`);
    if (t) return this.onElement<dom.Located>(tabId, meta, t, (target) => ({ op: 'locate', target, scroll: true }));
    if (hasX !== hasY) throw new ToolError(`${xKey} and ${yKey} go together`);
    if (!hasX) throw new ToolError(prefix ? `give where to drop: ${prefix}Ref, ${prefix}Selector, or ${xKey}+${yKey}` : 'give a ref (from snapshot), a selector, or both x and y');
    const at = (await this.domHost(meta).call(tabId, 0, { op: 'at', x: a[xKey], y: a[yKey] })) as { label: string; rect: PageRect };
    return { x: a[xKey], y: a[yKey], rect: at.rect, label: at.label };
  }

  private async snapshot(a: Args, meta: ActionMeta): Promise<ToolResult> {
    const tab = await this.tab(a.tabId, meta);
    const url = tab.url ?? tab.pendingUrl ?? '';
    this.operable(url);
    this.noDialog(a.tabId);
    let origin: string | undefined;
    try {
      origin = new URL(url).origin;
    } catch {
      origin = undefined;
    }
    const { output: out, refs } = await dom.domSnapshot(this.domHost(meta), a.tabId, this.refs.get(a.tabId), { maxChars: a.maxChars, origin });
    live(meta);
    this.refs.set(a.tabId, refs);
    const head = { tabId: a.tabId, url, title: out.title || withoutAgentMark(tab.title ?? ''), refs: out.refs, truncated: out.truncated };
    return this.withDialogNote(a.tabId, {
      content: [
        { type: 'text', text: JSON.stringify(head) },
        { type: 'text', text: out.text === '' ? '(the page shows nothing that the accessibility tree reports)' : out.text },
      ],
    });
  }

  private screenshot(a: Args, meta: ActionMeta): Promise<ToolResult> {
    const run = this.shotQueue.then(() => (this.d.cdp ? this.cdpScreenshot(a, meta) : this.takeScreenshot(a, meta)));
    this.shotQueue = run.catch(() => {});
    return run;
  }

  /** The tab is the one on show in a window that is not minimised: Chrome can capture it as it is, with no debugger and no tab switch. */
  private async onShow(a: Args, tab: { active: boolean; windowId: number }): Promise<boolean> {
    if (a.fullPage || !tab.active) return false;
    if (this.d.cdp?.isPinned(a.tabId) || this.d.cdp?.current(a.tabId)?.dialog) return false; // a viewport override or a dialog: the debugger sees what the page does
    try {
      const w = await this.b.windows.get(tab.windowId);
      return !!w && w.state !== 'minimized';
    } catch {
      return false;
    }
  }

  private async cdpScreenshot(a: Args, meta: ActionMeta): Promise<ToolResult> {
    const tab = await this.tab(a.tabId, meta);
    if (await this.onShow(a, tab)) {
      try {
        return await this.takeScreenshot(a, meta, tab);
      } catch (error) {
        if (meta.signal?.aborted) throw error;
        // Chrome would not capture it (a window that is not drawn): the debugger can.
      }
    }
    const format: 'png' | 'jpeg' = a.format === 'jpeg' ? 'jpeg' : 'png';
    let shot: hands.Shot;
    await this.d.activity?.hide(a.tabId); // the picture shows the page, not our frame and pill
    try {
      shot = await this.onPage(a.tabId, meta, (s) =>
        hands.capture(s, {
          format,
          quality: a.quality,
          fullPage: a.fullPage,
          activate: async () => {
            live(meta);
            const previous = tab.active ? undefined : (await this.b.tabs.query({ active: true, windowId: tab.windowId }))[0];
            if (!tab.active) await this.b.tabs.update(a.tabId, { active: true });
            return async () => {
              if (previous?.id !== undefined && previous.id !== a.tabId) await this.b.tabs.update(previous.id, { active: true }).catch(() => {});
            };
          },
        }),
      );
    } catch (error) {
      if (error instanceof ToolError && /cannot operate this tab|busy/.test(error.message) && !meta.signal?.aborted) {
        await this.d.activity?.unhide(a.tabId);
        return this.takeScreenshot(a, meta, tab); // a page Facet may not debug: the old way (activates the tab for a moment)
      }
      throw error;
    } finally {
      await this.d.activity?.unhide(a.tabId);
    }
    return this.withDialogNote(a.tabId, {
      content: [
        { type: 'image', data: shot.data, mimeType: `image/${format}` },
        { type: 'text', text: JSON.stringify({ tabId: a.tabId, path: shot.path, fullPage: shot.fullPage, ...(shot.clipped ? { clipped: true } : {}) }) },
      ],
    });
  }

  private async takeScreenshot(a: Args, meta: ActionMeta, known?: { id?: number; active: boolean; windowId: number }): Promise<ToolResult> {
    const tab = known ?? (await this.tab(a.tabId, meta));
    const previous = tab.active ? undefined : (await this.b.tabs.query({ active: true, windowId: tab.windowId }))[0];
    if (!tab.active) {
      await this.b.tabs.update(a.tabId, { active: true });
      await this.sleep(250); // let the compositor present the tab before it is captured
    }
    try {
      live(meta); // after the 250 ms pause: nothing is captured once the switch is off
      const format = a.format === 'jpeg' ? 'jpeg' : 'png';
      await this.d.activity?.hide(a.tabId); // the picture shows the page, not our frame and pill
      let dataUrl: string;
      try {
        dataUrl = await this.b.tabs.captureVisibleTab(tab.windowId, { format, ...(format === 'jpeg' ? { quality: a.quality } : {}) });
      } finally {
        await this.d.activity?.unhide(a.tabId);
      }
      const match = /^data:(image\/[a-z+]+);base64,(.*)$/s.exec(dataUrl);
      if (!match) throw new ToolError('Chrome returned an unexpected screenshot format');
      return { content: [{ type: 'image', data: match[2]!, mimeType: match[1]! }, ...(this.d.cdp ? [{ type: 'text' as const, text: JSON.stringify({ tabId: a.tabId, path: known?.active ? 'visible' : 'activated', fullPage: false }) }] : [])] };
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError(`could not capture the tab: ${error instanceof Error ? error.message : String(error)} (a minimised window cannot be captured)`);
    } finally {
      if (previous?.id !== undefined && previous.id !== a.tabId) await this.b.tabs.update(previous.id, { active: true }).catch(() => {});
    }
  }

  private async click(a: Args, meta: ActionMeta): Promise<ToolResult> {
    const tab = await this.tab(a.tabId, meta);
    if (!this.d.cdp) return this.legacyClick(a, meta);
    this.operable(tab.url ?? tab.pendingUrl);
    // Where to click is the page's own DOM work; the debugger is attached only for the click itself (and not at all for a mistake).
    this.noDialog(a.tabId);
    const p = await this.point(a.tabId, meta, a);
    await this.onPage(a.tabId, meta, async (s) => {
      live(meta);
      await hands.mouseClick(s, p, a.button, a.clickCount, (a.modifiers ?? []) as Modifier[]);
    });
    await this.d.activity?.touch(a.tabId, 'click', p.rect); // the ring at the spot that was clicked
    return this.withDialogNote(a.tabId, json({ clicked: p.label }));
  }

  private async legacyClick(a: Args, meta: ActionMeta): Promise<ToolResult> {
    const hasPoint = a.x !== undefined && a.y !== undefined;
    if (a.selector === undefined && !hasPoint) throw new ToolError('click: give a selector, or both x and y');
    if (a.selector === undefined && (a.x === undefined) !== (a.y === undefined)) throw new ToolError('click: x and y go together');
    const { rect, ...result } = (await this.inPage(a.tabId, pageClick, [a.selector ?? null, hasPoint ? a.x : null, hasPoint ? a.y : null], 'ISOLATED', meta)) as { clicked: string; rect: PageRect | null };
    await this.d.activity?.touch(a.tabId, 'click', rect);
    return json(result);
  }

  private async hover(a: Args, meta: ActionMeta): Promise<ToolResult> {
    const tab = await this.tab(a.tabId, meta);
    this.operable(tab.url ?? tab.pendingUrl);
    this.noDialog(a.tabId);
    const p = await this.point(a.tabId, meta, a);
    await this.onPage(a.tabId, meta, async (s) => {
      live(meta);
      await hands.mouseMove(s, p);
    });
    await this.d.activity?.touch(a.tabId, 'hover', p.rect);
    return this.withDialogNote(a.tabId, json({ hovered: p.label }));
  }

  private async drag(a: Args, meta: ActionMeta): Promise<ToolResult> {
    const tab = await this.tab(a.tabId, meta);
    this.operable(tab.url ?? tab.pendingUrl);
    if (!this.target(a, 'to') && (a.toX === undefined || a.toY === undefined)) throw new ToolError('drag: give where to drop: toRef, toSelector, or toX+toY');
    this.noDialog(a.tabId);
    const from = await this.point(a.tabId, meta, a);
    const to = await this.point(a.tabId, meta, a, 'to');
    await this.onPage(a.tabId, meta, async (s) => {
      live(meta);
      await hands.mouseDrag(s, from, to);
    });
    await this.d.activity?.touch(a.tabId, 'drag', to.rect);
    return this.withDialogNote(a.tabId, json({ dragged: from.label, to: to.label }));
  }

  private async type(a: Args, meta: ActionMeta): Promise<ToolResult> {
    await this.tab(a.tabId, meta);
    if (!this.d.cdp) {
      if (a.selector === undefined) throw new ToolError('type: give a selector');
      const { rect, ...result } = (await this.inPage(a.tabId, pageType, [a.selector, a.text, a.append, a.submit], 'ISOLATED', meta)) as { typed: number; rect: PageRect | null };
      await this.d.activity?.touch(a.tabId, 'type', rect);
      return json(result);
    }
    const t = this.target(a);
    if (!t) throw new ToolError('type: give a ref (from snapshot) or a selector of the field');
    if (a.slowly && a.text.length > 2000) throw new ToolError('slowly types at most 2000 characters; send longer text without slowly');
    const rect = await this.onPage(a.tabId, meta, async (s) => {
      // The field gets the focus (and its text is selected) from the page's own side; the keys are the debugger's.
      const prepared = await this.onElement<{ empty: boolean; rect: PageRect | null }>(a.tabId, meta, t, (target) => ({ op: 'prepareType', target, append: a.append }));
      live(meta);
      await hands.typeText(s, a.text, prepared, { append: a.append, slowly: a.slowly, submit: a.submit, isMac: !!this.d.isMac });
      return prepared.rect;
    });
    await this.d.activity?.touch(a.tabId, 'type', rect);
    return this.withDialogNote(a.tabId, json({ typed: a.text.length }));
  }

  private async pressKey(a: Args, meta: ActionMeta): Promise<ToolResult> {
    await this.tab(a.tabId, meta);
    const t = this.target(a);
    const rect = await this.onPage(a.tabId, meta, async (s) => {
      let rect: PageRect | null = null;
      if (t) rect = (await this.onElement<{ rect: PageRect | null }>(a.tabId, meta, t, (target) => ({ op: 'focus', target }))).rect;
      live(meta);
      await hands.pressShortcut(s, a.key, !!this.d.isMac, a.repeat);
      return rect;
    });
    await this.d.activity?.touch(a.tabId, 'press_key', rect);
    return this.withDialogNote(a.tabId, json({ pressed: a.key, times: a.repeat }));
  }

  /** Choosing an option is the page's own DOM work (the same events a script would send); no debugger. */
  private async selectOption(a: Args, meta: ActionMeta): Promise<ToolResult> {
    const tab = await this.tab(a.tabId, meta);
    this.operable(tab.url ?? tab.pendingUrl);
    this.noDialog(a.tabId);
    const t = this.target(a);
    if (!t) throw new ToolError('select_option: give a ref (from snapshot) or a selector of the <select>');
    const r = await this.onElement<{ selected: string[]; rect: PageRect | null }>(a.tabId, meta, t, (target) => ({ op: 'select', target, values: a.values }));
    await this.d.activity?.touch(a.tabId, 'select_option', r.rect);
    return json({ selected: r.selected });
  }

  private async uploadFile(a: Args, meta: ActionMeta): Promise<ToolResult> {
    await this.tab(a.tabId, meta);
    const t = this.target(a);
    if (!t) throw new ToolError('upload_file: give a ref (from snapshot) or a selector of the <input type="file">');
    const marker = `data-facet-up-${Math.random().toString(36).slice(2)}`;
    const rect = await this.onPage(a.tabId, meta, async (s) => {
      // The input is marked for a moment (an attribute no page has a reason to look for) so the debugger can take hold of it.
      const marked = await this.onElement<{ multiple: boolean; rect: PageRect | null }>(a.tabId, meta, t, (target) => ({ op: 'mark', target, name: marker }));
      try {
        if ((a.paths as string[]).length > 1 && !marked.multiple) throw new ToolError('this file input takes one file (it has no "multiple")');
        live(meta);
        await hands.setFilesByMarker(s, marker, a.paths);
      } finally {
        await this.domHost(meta).tryCall(a.tabId, dom.frameOf(this.refs.get(a.tabId), t), { op: 'unmark', name: marker });
      }
      return marked.rect;
    });
    await this.d.activity?.touch(a.tabId, 'upload_file', rect);
    return this.withDialogNote(a.tabId, json({ uploaded: (a.paths as string[]).map((p) => p.split('/').pop()) }));
  }

  private async scroll(a: Args, meta: ActionMeta): Promise<ToolResult> {
    const tab = await this.tab(a.tabId, meta);
    const t = this.target(a);
    if (t?.ref !== undefined) {
      if (a.to !== undefined || a.dx !== undefined || a.dy !== undefined) throw new ToolError('scroll: give ref, selector, to, or dx/dy, not several');
      this.operable(tab.url ?? tab.pendingUrl);
      this.noDialog(a.tabId);
      return json(await this.onElement(a.tabId, meta, t, (target) => ({ op: 'scrollTo', target })));
    }
    if (a.selector === undefined && a.to === undefined && a.dx === undefined && a.dy === undefined) throw new ToolError('scroll: give ref, selector, to, or dx/dy');
    return json(await this.inPage(a.tabId, pageScroll, [a.selector ?? null, a.to ?? null, a.dx ?? 0, a.dy ?? 0], 'ISOLATED', meta));
  }

  private async waitFor(a: Args, meta: ActionMeta): Promise<ToolResult> {
    const tab = await this.tab(a.tabId, meta);
    const t = this.target(a);
    const given = [a.text !== undefined, a.textGone !== undefined, t !== null].filter(Boolean).length;
    if (given !== 1) throw new ToolError('wait_for: give exactly one of text, textGone, or an element (ref or selector)');
    this.operable(tab.url ?? tab.pendingUrl);
    const r = await dom.waitFor(
      this.domHost(meta),
      a.tabId,
      this.refs.get(a.tabId),
      { ...(a.text !== undefined ? { text: a.text } : {}), ...(a.textGone !== undefined ? { textGone: a.textGone } : {}), ...(t ? { target: t } : {}), state: a.state, timeout: a.timeout },
      { isLive: () => live(meta), blocked: () => this.noDialog(a.tabId), sleep: (ms) => this.sleep(ms) },
    );
    return json({ ok: true, waitedMs: r.waitedMs });
  }

  private async runJs(a: Args, meta: ActionMeta): Promise<ToolResult> {
    await this.tab(a.tabId, meta);
    if (a.world === 'ISOLATED') {
      throw new ToolError(
        'run_js runs only in the page\'s own (MAIN) world. An isolated world would read the regular profile\'s cookies of a container tab\'s site (Facet\'s cookie shim lives in the MAIN world), so Facet does not offer it.',
      );
    }
    if (this.d.cdp) {
      let outcome: hands.EvalOutcome | null = null;
      try {
        outcome = await this.onPage(a.tabId, meta, (s) => hands.evaluate(s, a.code, { awaitPromise: a.awaitPromise, returnByValue: a.returnByValue, maxChars: a.maxChars }));
      } catch (error) {
        // A tab Facet may not debug, or one that is busy: the injected-script way (needs eval in the page) is next.
        if (!(error instanceof ToolError) || !/cannot operate this tab|busy|could not attach/.test(error.message) || meta.signal?.aborted) throw error;
      }
      if (outcome) {
        if (!outcome.ok) throw new ToolError(`${outcome.name}: ${outcome.message}`);
        return this.withDialogNote(a.tabId, {
          content: [
            { type: 'text', text: outcome.json === null ? 'undefined' : outcome.json },
            ...(outcome.truncated ? [{ type: 'text' as const, text: `(result truncated to ${a.maxChars} characters)` }] : []),
          ],
        });
      }
    }
    let r: RunResult = await this.inPage(a.tabId, pageRun, [a.code, a.maxChars], 'MAIN', meta);
    if (!r.ok && r.kind === 'csp') {
      const viaUserScripts = await this.runViaUserScripts(a.tabId, a.code, a.maxChars, meta);
      if (viaUserScripts) r = viaUserScripts;
    }
    if (!r.ok) {
      if (r.kind === 'csp') {
        throw new ToolError(
          'this page\'s Content-Security-Policy forbids evaluating code strings (no unsafe-eval), and Facet could not use the debugger here, so run_js cannot run. Use get_tab_text, get_tab_html, click and type instead, or ask the user to allow the userScripts fallback in the Facet settings.',
        );
      }
      throw new ToolError(`${r.name}: ${r.message}`);
    }
    return {
      content: [
        { type: 'text', text: r.json === null ? 'undefined' : r.json },
        ...(r.truncated ? [{ type: 'text' as const, text: `(result truncated to ${a.maxChars} characters)` }] : []),
      ],
    };
  }

  private async history(a: Args, meta: ActionMeta, step: -1 | 1): Promise<ToolResult> {
    await this.tab(a.tabId, meta);
    const inContainer = this.d.facet.getTabContainer(a.tabId) !== null;
    const where = step < 0 ? 'back' : 'forward';
    type History = { currentIndex: number; entries: Array<{ id: number; url: string }> };
    const go = async (s: TabSession) => {
      const h = await s.send<History>('Page.getNavigationHistory');
      const entry = h.entries[h.currentIndex + step];
      if (!entry) throw new ToolError(step < 0 ? 'there is no previous page in this tab\'s history' : 'there is no next page in this tab\'s history');
      meta.host = hostOf(entry.url) ?? meta.host;
      // Same as every navigation Facet starts: no service worker of the target may answer a container's request.
      if (inContainer && /^https?:/.test(entry.url)) await this.d.facet.prepareNavigation(entry.url);
      live(meta);
      // The exact entry (the Back button would skip pages the user never interacted with).
      await s.send('Page.navigateToHistoryEntry', { entryId: entry.id });
    };
    // The exact history entry needs the debugger (`Page.getNavigationHistory`): Chrome's own Back skips pages nobody interacted
    // with, which is every page an agent has just opened, so `tabs.goBack` would often find "no previous page" where there is one.
    try {
      if (!this.d.cdp) throw new ToolError('no debugger');
      await this.onPage(a.tabId, meta, go, { dialogOk: true });
    } catch (error) {
      // Without the debugger (a page Facet may not debug): Chrome's own Back/Forward, never for a container tab.
      if (inContainer || meta.signal?.aborted || !(error instanceof ToolError) || /no (previous|next) page/.test(error.message)) throw error;
      const tabs = this.b.tabs as unknown as { goBack(id: number): Promise<void>; goForward(id: number): Promise<void> };
      live(meta);
      try {
        await (step < 0 ? tabs.goBack(a.tabId) : tabs.goForward(a.tabId));
      } catch (e) {
        throw new ToolError(`could not go ${where}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const loaded = a.wait ? await this.waitForLoad(a.tabId, meta) : undefined;
    if (loaded) await this.d.activity?.touch(a.tabId, step < 0 ? 'navigate_back' : 'navigate_forward');
    return json(await this.summary(a.tabId, loaded === undefined ? {} : { loaded }));
  }

  private async reload(a: Args, meta: ActionMeta): Promise<ToolResult> {
    const tab = await this.tab(a.tabId, meta);
    const url = tab.url ?? tab.pendingUrl;
    if (this.d.facet.getTabContainer(a.tabId) !== null && url && /^https?:/.test(url)) await this.d.facet.prepareNavigation(url);
    live(meta);
    await this.b.tabs.reload(a.tabId, { bypassCache: a.bypassCache });
    const loaded = a.wait ? await this.waitForLoad(a.tabId, meta) : undefined;
    if (loaded) await this.d.activity?.touch(a.tabId, 'reload');
    return json(await this.summary(a.tabId, loaded === undefined ? {} : { loaded }));
  }

  private async handleDialog(a: Args, meta: ActionMeta): Promise<ToolResult> {
    await this.tab(a.tabId, meta);
    const session = this.cdp.current(a.tabId);
    const dialog = session?.dialog;
    if (!session || !dialog) {
      throw new ToolError('no JavaScript dialog that Facet saw is open on this tab (Facet sees dialogs that open while it works on the tab; one that was already open must be answered by the user)');
    }
    live(meta);
    try {
      await session.send('Page.handleJavaScriptDialog', { accept: a.accept, ...(a.promptText !== undefined ? { promptText: a.promptText } : {}) });
    } catch (error) {
      throw new ToolError(`could not answer the dialog: ${error instanceof Error ? error.message : String(error)}`);
    }
    session.dialog = null;
    return json({ tabId: a.tabId, answered: dialog.type, message: dialog.message, accepted: a.accept });
  }

  private async consoleMessages(a: Args, meta: ActionMeta): Promise<ToolResult> {
    await this.tab(a.tabId, meta);
    const record = this.cdp.record(a.tabId);
    const entries = record.console.filter((e) => e.seq > a.since && (a.level === 'all' || e.level === a.level));
    const shown = entries.slice(-a.limit);
    return json({
      tabId: a.tabId,
      watching: this.watchInfo(a.tabId),
      next: record.seq,
      ...(entries.length > shown.length ? { omitted: entries.length - shown.length } : {}),
      ...(this.cdp.watchingUntil(a.tabId) ? {} : { note: 'console.log output is recorded only while watch runs on this tab; browser messages are recorded whenever Facet is attached' }),
      messages: shown.map((e) => ({ ...e, at: new Date(e.at).toISOString() })),
    });
  }

  private async networkRequests(a: Args, meta: ActionMeta): Promise<ToolResult> {
    await this.tab(a.tabId, meta);
    const record = this.cdp.record(a.tabId);
    const entries = record.network.filter((e) => e.seq > a.since && (a.filter === undefined || e.url.includes(a.filter)));
    const shown = entries.slice(-a.limit);
    return json({
      tabId: a.tabId,
      watching: this.watchInfo(a.tabId),
      next: record.seq,
      ...(entries.length > shown.length ? { omitted: entries.length - shown.length } : {}),
      requests: shown.map(({ requestHeaders, responseHeaders, ...e }) => ({
        ...e,
        at: new Date(e.at).toISOString(),
        ...(a.includeHeaders ? { requestHeaders: requestHeaders ?? {}, responseHeaders: responseHeaders ?? {} } : {}),
      })),
    });
  }

  private watchInfo(tabId: number): string | false {
    const until = this.cdp.watchingUntil(tabId);
    return until ? new Date(until).toISOString() : false;
  }

  private async watch(a: Args, meta: ActionMeta): Promise<ToolResult> {
    await this.tab(a.tabId, meta);
    live(meta);
    try {
      const until = await this.cdp.watch(a.tabId, a.stop ? 0 : a.minutes);
      live(meta);
      return json({ tabId: a.tabId, watchingUntil: until ? new Date(until).toISOString() : null });
    } catch (error) {
      if (meta.signal?.aborted) throw new ToolError(SWITCHED_OFF);
      if (error instanceof CdpError) throw new ToolError(error.message);
      throw error;
    }
  }

  private async resizeViewport(a: Args, meta: ActionMeta): Promise<ToolResult> {
    await this.tab(a.tabId, meta);
    if (a.clear) {
      const s = this.cdp.current(a.tabId);
      if (s) await s.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
      this.cdp.pin(a.tabId, false);
      return json({ tabId: a.tabId, cleared: true });
    }
    if (a.width === undefined || a.height === undefined) throw new ToolError('resize_viewport: give width and height, or clear: true');
    const size = await this.onPage(a.tabId, meta, async (s) => {
      await s.send('Emulation.setDeviceMetricsOverride', { width: a.width, height: a.height, deviceScaleFactor: 0, mobile: false });
      this.cdp.pin(a.tabId, true); // the override lives as long as the session
      const r = await s.send<{ result: { value: { w: number; h: number } } }>('Runtime.evaluate', { expression: '({ w: innerWidth, h: innerHeight })', returnByValue: true });
      return r.result.value;
    });
    return json({ tabId: a.tabId, width: size.w, height: size.h });
  }

  /**
   * Fallback for pages that forbid eval: `chrome.userScripts.execute` evaluates source the page's CSP does not govern.
   * Only when the user granted the optional `userScripts` permission (and the "Allow user scripts" switch in Chrome).
   * Null when unavailable.
   */
  private async runViaUserScripts(tabId: number, code: string, maxChars: number, meta: ActionMeta): Promise<RunResult | null> {
    const c = this.b as unknown as {
      userScripts?: { execute?: (injection: unknown) => Promise<Array<{ result?: unknown; error?: string }>> };
      permissions?: { contains(p: unknown): Promise<boolean> };
    };
    try {
      if (typeof c.userScripts?.execute !== 'function') return null;
      if (!(await c.permissions?.contains({ permissions: ['userScripts'] }))) return null;
      live(meta);
      const slot = `__facetRun_${Math.random().toString(36).slice(2)}`;
      // The body becomes a function LITERAL in the source (no eval); the outcome lands in a window property.
      const source = `(()=>{const s=${JSON.stringify(slot)};window[s]={state:'running'};(async()=>{\n${code}\n})().then(v=>{window[s]={state:'done',value:v}},e=>{window[s]={state:'error',name:String(e&&e.name),message:String(e&&e.message)}})})()`;
      const run = await c.userScripts.execute({ target: { tabId, frameIds: [0] }, world: 'MAIN', injectImmediately: true, js: [{ code: source }] });
      if (run?.[0]?.error) return { ok: false, kind: 'error', name: 'Error', message: run[0].error };
      for (let i = 0; i < 40; i++) {
        await this.sleep(100);
        const got = await this.inPage(tabId, pageTakeSlot, [slot, maxChars], 'MAIN', meta);
        if (got.state === 'running') continue;
        if (got.state === 'error') return { ok: false, kind: 'error', name: got.name, message: got.message };
        return { ok: true, json: got.json, truncated: got.truncated };
      }
      return { ok: false, kind: 'error', name: 'Timeout', message: 'the script did not finish in time' };
    } catch (error) {
      if (meta.signal?.aborted) throw error; // switched off while polling: no result to report
      return { ok: false, kind: 'error', name: 'UserScriptsError', message: error instanceof Error ? error.message : String(error) };
    }
  }
}

/** Reads (and clears) the result slot of the userScripts fallback; self-contained like the other page functions. */
export function pageTakeSlot(
  slot: string,
  maxChars: number,
): { state: 'running' } | { state: 'error'; name: string; message: string } | { state: 'done'; json: string | null; truncated: boolean } {
  const holder = window as unknown as Record<string, any>;
  const r = holder[slot];
  if (!r || r.state === 'running') return { state: 'running' };
  delete holder[slot];
  if (r.state === 'error') return { state: 'error', name: r.name, message: r.message };
  if (r.value === undefined) return { state: 'done', json: null, truncated: false };
  let json: string;
  try {
    json = JSON.stringify(r.value) ?? 'null';
  } catch (e) {
    return { state: 'error', name: 'SerializeError', message: String((e as Error).message) };
  }
  return json.length > maxChars ? { state: 'done', json: json.slice(0, maxChars), truncated: true } : { state: 'done', json, truncated: false };
}
