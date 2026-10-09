import type { browser } from 'wxt/browser';
import type { Container } from '../../core';
import { SWITCHED_OFF, TOOL_TIMEOUT_MS, type ToolResult } from '../../bridge/protocol';
import { toolByName } from '../../bridge/spec';
import { validateArgs } from '../../bridge/validate';
import type { Facet } from '../facet';
import type { FullApi } from '../full-api';
import { pageClick, pageHtml, pageRun, pageScroll, pageText, pageType, type PageError, type RunResult } from './inject';

type Browser = typeof browser;

export class ToolError extends Error {}

/** What a tool run reports about itself for the action log (never page content). */
export interface ActionMeta {
  tabId?: number;
  host?: string;
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
}

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

  constructor(private readonly d: RouterDeps) {
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Runs one tool. Throws ToolError (or any error) with a message meant for the agent. */
  async run(tool: string, rawArgs: unknown, meta: ActionMeta, timeoutMs: number = TOOL_TIMEOUT_MS): Promise<ToolResult> {
    const spec = toolByName(tool);
    if (!spec) throw new ToolError(`unknown tool "${tool}"`);
    const checked = validateArgs(spec.inputSchema, rawArgs);
    if (!checked.ok) throw new ToolError(`${tool}: ${checked.error}`);
    await this.d.facet.ready;
    live(meta);
    return withTimeout(this.dispatch(tool, checked.value as Args, meta), timeoutMs, tool, meta.signal);
  }

  private dispatch(tool: string, a: Args, meta: ActionMeta): Promise<ToolResult> {
    if (typeof a.tabId === 'number') meta.tabId = a.tabId;
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
      if (meta) meta.host = hostOf(tab.url ?? tab.pendingUrl);
      found = tab;
    } catch {
      throw new ToolError(`no tab with id ${tabId} (it may have been closed; call list_tabs)`);
    }
    live(meta); // the lookup can be slow; the action that follows must not run after "off"
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
      ...(tab ? { windowId: tab.windowId, url: tab.url ?? tab.pendingUrl ?? '', title: tab.title ?? '', status: tab.status } : {}),
      container: container ? { id: container.id, name: container.name } : null,
      ...extra,
    };
  }

  /** Runs `func` in the top frame of a tab. Page-side `{error}` results become ToolErrors. */
  private async inPage<T>(tabId: number, func: (...args: any[]) => T, args: unknown[], world: 'MAIN' | 'ISOLATED' = 'ISOLATED', meta?: ActionMeta): Promise<Awaited<T>> {
    let results;
    live(meta);
    try {
      results = await this.b.scripting.executeScript({ target: { tabId, frameIds: [0] }, world, func: func as never, args: args as never });
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
        title: tab.title ?? '',
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
    const loaded = a.wait ? await this.waitForLoad(tabId, meta) : undefined;
    return json(await this.summary(tabId, loaded === undefined ? {} : { loaded }));
  }

  private async openTab(a: Args, meta: ActionMeta): Promise<ToolResult> {
    const url = checkUrl(a.url, OPEN_SCHEMES);
    meta.host = url.host || undefined;
    const tab = await this.b.tabs.create({ url: url.href, active: a.active, ...(a.windowId !== undefined ? { windowId: a.windowId } : {}) });
    if (tab.id === undefined) throw new ToolError('Chrome did not create the tab');
    meta.tabId = tab.id;
    const loaded = a.wait && url.protocol !== 'about:' ? await this.waitForLoad(tab.id, meta) : undefined;
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
    return json(await this.summary(a.tabId, loaded === undefined ? {} : { loaded }));
  }

  private async closeTab(a: Args, meta: ActionMeta): Promise<ToolResult> {
    await this.tab(a.tabId, meta);
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
    if (a.reload) await this.waitForLoad(a.tabId, meta);
    return json(await this.summary(a.tabId));
  }

  private async getTabText(a: Args, meta: ActionMeta): Promise<ToolResult> {
    await this.tab(a.tabId, meta);
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
    const r = (await this.inPage(a.tabId, pageHtml, [a.selector ?? null, a.maxChars], 'ISOLATED', meta)) as { html: string; total: number; url: string; title: string };
    return {
      content: [
        { type: 'text', text: JSON.stringify({ tabId: a.tabId, url: r.url, title: r.title, selector: a.selector ?? null, length: r.total, truncated: r.total > r.html.length }) },
        { type: 'text', text: r.html },
      ],
    };
  }

  private screenshot(a: Args, meta: ActionMeta): Promise<ToolResult> {
    const run = this.shotQueue.then(() => this.takeScreenshot(a, meta));
    this.shotQueue = run.catch(() => {});
    return run;
  }

  private async takeScreenshot(a: Args, meta: ActionMeta): Promise<ToolResult> {
    const tab = await this.tab(a.tabId, meta);
    const previous = tab.active ? undefined : (await this.b.tabs.query({ active: true, windowId: tab.windowId }))[0];
    if (!tab.active) {
      await this.b.tabs.update(a.tabId, { active: true });
      await this.sleep(250); // let the compositor present the tab before it is captured
    }
    try {
      live(meta); // after the 250 ms pause: nothing is captured once the switch is off
      const format = a.format === 'jpeg' ? 'jpeg' : 'png';
      const dataUrl = await this.b.tabs.captureVisibleTab(tab.windowId, { format, ...(format === 'jpeg' ? { quality: a.quality } : {}) });
      const match = /^data:(image\/[a-z+]+);base64,(.*)$/s.exec(dataUrl);
      if (!match) throw new ToolError('Chrome returned an unexpected screenshot format');
      return { content: [{ type: 'image', data: match[2]!, mimeType: match[1]! }] };
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError(`could not capture the tab: ${error instanceof Error ? error.message : String(error)} (a minimised window cannot be captured)`);
    } finally {
      if (previous?.id !== undefined && previous.id !== a.tabId) await this.b.tabs.update(previous.id, { active: true }).catch(() => {});
    }
  }

  private async click(a: Args, meta: ActionMeta): Promise<ToolResult> {
    await this.tab(a.tabId, meta);
    const hasPoint = a.x !== undefined && a.y !== undefined;
    if (a.selector === undefined && !hasPoint) throw new ToolError('click: give a selector, or both x and y');
    if (a.selector === undefined && (a.x === undefined) !== (a.y === undefined)) throw new ToolError('click: x and y go together');
    return json(await this.inPage(a.tabId, pageClick, [a.selector ?? null, hasPoint ? a.x : null, hasPoint ? a.y : null], 'ISOLATED', meta));
  }

  private async type(a: Args, meta: ActionMeta): Promise<ToolResult> {
    await this.tab(a.tabId, meta);
    return json(await this.inPage(a.tabId, pageType, [a.selector, a.text, a.append, a.submit], 'ISOLATED', meta));
  }

  private async scroll(a: Args, meta: ActionMeta): Promise<ToolResult> {
    await this.tab(a.tabId, meta);
    if (a.selector === undefined && a.to === undefined && a.dx === undefined && a.dy === undefined) throw new ToolError('scroll: give selector, to, or dx/dy');
    return json(await this.inPage(a.tabId, pageScroll, [a.selector ?? null, a.to ?? null, a.dx ?? 0, a.dy ?? 0], 'ISOLATED', meta));
  }

  private async runJs(a: Args, meta: ActionMeta): Promise<ToolResult> {
    await this.tab(a.tabId, meta);
    const world: 'MAIN' | 'ISOLATED' = a.world === 'ISOLATED' ? 'ISOLATED' : 'MAIN';
    let r: RunResult = await this.inPage(a.tabId, pageRun, [a.code, a.maxChars], world, meta);
    if (!r.ok && r.kind === 'csp') {
      const viaUserScripts = await this.runViaUserScripts(a.tabId, a.code, a.maxChars, meta);
      if (viaUserScripts) r = viaUserScripts;
    }
    if (!r.ok) {
      if (r.kind === 'csp') {
        throw new ToolError(
          world === 'MAIN'
            ? 'this page\'s Content-Security-Policy forbids evaluating code strings (no unsafe-eval), so run_js cannot run here. Use get_tab_text, get_tab_html, click and type instead, or ask the user to allow the userScripts fallback in the Facet settings.'
            : 'the ISOLATED world cannot evaluate code strings (the extension\'s own policy). Use world MAIN.',
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
