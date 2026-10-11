/**
 * The agent bridge's Chrome DevTools Protocol sessions (`chrome.debugger`), one per tab, attached on demand.
 *
 * - A tool that needs CDP calls `use(tabId, ...)`: the tab is attached (protocol 1.3) unless it already is, the work
 *   runs, and the session stays for `IDLE_MS` (a minute: a whole burst of actions reuses it, so Chrome's "started debugging
 *   this browser" bar appears once per burst, not once per action) before it is detached again. `watch` and a
 *   viewport override keep it attached longer (30 min at most each), and so does an open JavaScript dialog (10 min at
 *   most): only this session can answer it, so letting go would lose it. When the agent's MCP process is gone, the bridge
 *   calls `release()`: viewport overrides cleared, everything detached.
 * - Never attached: chrome:// and other browser pages, extension pages (SplitSession's own included: the agent does not get to
 *   flip SplitSession's switches) and the Web Store. Chrome refuses most of them anyway; this gives the agent a clear sentence.
 * - The user pressing "Cancel" on Chrome's "started debugging this browser" bar detaches us (`canceled_by_user`): that
 *   tab is not attached again for `REVOKE_MS`, and the agent is told why.
 * - Switching the bridge off detaches everything at once (`detachAll`), and an attach that was under way when it happened
 *   is undone as soon as it completes (generation counter).
 * - Chrome lets several debugger clients share a tab (DevTools, Claude in Chrome, Playwright), so another client is no
 *   reason to fail. Chrome refuses a second attach by the SAME extension; after a service-worker restart that is our own
 *   forgotten session, which is detached and attached again. Only if that fails too is the tab reported busy. Other
 *   clients are never detached (an extension cannot detach them anyway).
 * - Only safe domains are enabled: Page (dialogs, navigations), Network (request list) and Log (browser messages).
 *   Runtime (console) is enabled only while `watch` runs: pages that hunt for debuggers detect it.
 *
 * Nothing here exposes cookies or storage: no Network.getCookies / Storage.* call exists in the bridge.
 */

export interface Debuggee {
  tabId?: number;
  sessionId?: string;
}

export interface DebuggerApi {
  attach(target: { tabId: number }, version: string): Promise<void>;
  detach(target: { tabId: number }): Promise<void>;
  sendCommand(target: Debuggee, method: string, params?: object): Promise<unknown>;
  getTargets?(): Promise<Array<{ tabId?: number; attached: boolean; type: string }>>;
  onEvent: { addListener(cb: (source: Debuggee, method: string, params?: any) => void): void };
  onDetach: { addListener(cb: (source: Debuggee, reason: string) => void): void };
}

export interface CdpDeps {
  dbg: DebuggerApi;
  tabUrl(tabId: number): Promise<string | undefined>;
  log?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  now?: () => number;
  /** Idle window after the last debugger-using tool (default 60 s: one attach, and one bar in Chrome, per burst of actions). */
  idleMs?: number;
  /** How long a session stays attached while a JavaScript dialog is open (default 10 min). */
  dialogMaxMs?: number;
  /** How long a viewport override keeps the session pinned (default 30 min). */
  pinMaxMs?: number;
}

export class CdpError extends Error {}

/**
 * How long a session stays attached after the last tool that needed it. Chrome shows "started debugging this browser" (and
 * shifts the page down) for as long as we are attached, so a burst of actions must be ONE attach: the window is long enough
 * to span an agent's thinking between steps.
 */
export const IDLE_MS = 60_000;
export const REVOKE_MS = 60_000;
/** A session with a JavaScript dialog open stays attached (only SplitSession can answer it) for this long, then lets go. */
export const DIALOG_MAX_MS = 10 * 60_000;
/** A viewport override pins its session for this long at most (like `watch`), unless it is refreshed or cleared. */
export const PIN_MAX_MS = 30 * 60_000;
/** How long a page may take to answer the liveness probe that runs before Page.enable. */
const PROBE_MS = 1_500;
const COMMAND_MS = 10_000;
const BUFFER = 500;

export interface DialogInfo {
  type: string;
  message: string;
  defaultPrompt?: string;
  url?: string;
}

export interface ConsoleEntry {
  seq: number;
  at: number;
  level: 'error' | 'warning' | 'info' | 'log' | 'debug';
  source: 'console' | 'exception' | 'browser';
  text: string;
  url?: string;
  line?: number;
}

export interface NetworkEntry {
  seq: number;
  at: number;
  requestId: string;
  method: string;
  url: string;
  type: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  fromCache?: boolean;
  failed?: string;
  bytes?: number;
  ms?: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
}

/** What a tab recorded while SplitSession was attached to it; kept across detaches until the tab closes or the bridge goes off. */
export interface TabRecord {
  console: ConsoleEntry[];
  network: NetworkEntry[];
  byRequest: Map<string, NetworkEntry>;
  seq: number;
}

/** Headers that carry credentials are never recorded: they would show a container's (or the profile's) sessions. */
const SECRET_HEADERS = /^(cookie|set-cookie|set-cookie2|authorization|proxy-authorization|x-csrf-token|x-xsrf-token)$/i;
export function redactHeaders(headers: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) out[name] = SECRET_HEADERS.test(name) ? '(hidden by SplitSession)' : String(value).slice(0, 500);
  return out;
}

/** Why SplitSession will not attach to this address, or null when it may. */
export function refusedUrl(url: string | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol === 'chrome-extension:') return 'extension pages (SplitSession\'s own included) are not operated by the agent';
  if (/^(chrome|chrome-untrusted|chrome-search|devtools|view-source|edge|brave|opera|vivaldi):$/.test(u.protocol)) return `${u.protocol}// pages belong to the browser; Chrome does not let extensions debug them`;
  if (u.hostname === 'chromewebstore.google.com' || (u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore'))) return 'Chrome does not let extensions debug the Chrome Web Store';
  return null;
}

/** The error text of a failed CDP call: Chrome wraps the protocol error as JSON in the message. */
export function cdpMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(raw) as { message?: string; data?: string };
    if (parsed && typeof parsed.message === 'string') return parsed.data ? `${parsed.message} (${parsed.data})` : parsed.message;
  } catch {
    /* not JSON */
  }
  return raw;
}

type Waiter = { method: string; sessionId: string | undefined; test: (params: any) => boolean; resolve: (params: any) => void };

/** One attached tab. */
export class TabSession {
  dialog: DialogInfo | null = null;
  /** When the open dialog was seen (ms, the manager's clock). */
  dialogAt = 0;
  consoleOn = false;
  mainLoaderId: string | null = null;
  users = 0;
  detached = false;
  private readonly waiters = new Set<Waiter>();
  private readonly onGone = new Set<() => void>();

  constructor(
    readonly tabId: number,
    private readonly dbg: DebuggerApi,
  ) {}

  /** One CDP command (`sessionId`: a child target). Rejects with the protocol's message, on detach, or after `timeoutMs`. */
  send<T = any>(method: string, params: object = {}, sessionId?: string, timeoutMs = COMMAND_MS): Promise<T> {
    if (this.detached) return Promise.reject(new CdpError('SplitSession is no longer attached to this tab; try again'));
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.onGone.delete(gone);
        fn();
      };
      const gone = () => finish(() => reject(new CdpError('SplitSession was detached from this tab while it worked (the tab closed, navigated to a page it cannot debug, or debugging was cancelled)')));
      const timer = setTimeout(
        () =>
          finish(() =>
            reject(new CdpError(this.dialog ? dialogBlocks(this.dialog) : `the page did not answer ${method} within ${Math.round(timeoutMs / 1000)} s (it may be busy, or a JavaScript dialog may be open)`)),
          ),
        timeoutMs,
      );
      this.onGone.add(gone);
      this.dbg.sendCommand({ tabId: this.tabId, ...(sessionId ? { sessionId } : {}) }, method, params).then(
        (r) => finish(() => resolve(r as T)),
        (e) => finish(() => reject(new CdpError(cdpMessage(e)))),
      );
    });
  }

  /** Waits for the next event `method` (of `sessionId`, top target by default) whose params pass `test`; null after `ms`. */
  waitFor<T = any>(method: string, ms: number, test: (params: T) => boolean = () => true, sessionId?: string, signal?: AbortSignal): Promise<T | null> {
    return new Promise((resolve) => {
      const waiter: Waiter = {
        method,
        sessionId,
        test,
        resolve: (p) => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          signal?.removeEventListener('abort', cancel);
          resolve(p);
        },
      };
      const cancel = () => waiter.resolve(null);
      const timer = setTimeout(cancel, ms);
      this.waiters.add(waiter);
      if (signal?.aborted) cancel();
      else signal?.addEventListener('abort', cancel, { once: true });
    });
  }

  /** @internal Called by the manager for every event of this tab. */
  dispatch(method: string, params: any, sessionId: string | undefined): void {
    for (const w of [...this.waiters]) {
      if (w.method === method && w.sessionId === sessionId && w.test(params)) w.resolve(params);
    }
  }

  /** @internal */
  gone(): void {
    this.detached = true;
    for (const fn of [...this.onGone]) fn();
    for (const w of [...this.waiters]) w.resolve(null);
  }
}

export const dialogBlocks = (d: DialogInfo): string =>
  `a JavaScript ${d.type} is open on this tab${d.message ? `: "${d.message.slice(0, 200)}"` : ''}. Answer it with handle_dialog (accept true or false) before doing anything else on this tab.`;

interface Slot {
  session: TabSession | null;
  attaching: Promise<TabSession> | null;
  idle: ReturnType<typeof setTimeout> | null;
  watchUntil: number;
  watchTimer: ReturnType<typeof setTimeout> | null;
  pinned: boolean;
  pinTimer: ReturnType<typeof setTimeout> | null;
}

/** All CDP sessions of the bridge. */
export class CdpSessions {
  private readonly slots = new Map<number, Slot>();
  private readonly revoked = new Map<number, number>();
  private readonly records = new Map<number, TabRecord>();
  /** Dialogs that were still open when their session was let go after `DIALOG_MAX_MS`: the next attach says so. */
  private readonly abandoned = new Map<number, DialogInfo>();
  private generation = 0;
  private readonly now: () => number;
  /** Public for tests (`facetCdp.idleMs` on the worker). */
  idleMs: number;
  private readonly dialogMaxMs: number;
  private readonly pinMaxMs: number;

  constructor(private readonly d: CdpDeps) {
    this.now = d.now ?? Date.now;
    this.idleMs = d.idleMs ?? IDLE_MS;
    this.dialogMaxMs = d.dialogMaxMs ?? DIALOG_MAX_MS;
    this.pinMaxMs = d.pinMaxMs ?? PIN_MAX_MS;
    // Registered synchronously (the service worker's top level calls this constructor).
    d.dbg.onEvent.addListener((source, method, params) => this.onEvent(source, method, params));
    d.dbg.onDetach.addListener((source, reason) => this.onDetach(source, reason));
  }

  /** Changes the idle window (tests: the default is a minute). */
  setIdleMs(ms: number): void {
    this.idleMs = ms;
  }

  isAttached(tabId: number): boolean {
    return !!this.slots.get(tabId)?.session;
  }

  /**
   * Whether something other than the idle window keeps the tab's session: a tool running, a viewport override, a watch or an
   * open dialog. (A session that merely waits out its idle minute does not count: the agent is not working with the tab.)
   */
  isHeld(tabId: number): boolean {
    const slot = this.slots.get(tabId);
    const s = slot?.session;
    return !!s && (s.users > 0 || slot.pinned || slot.watchUntil > this.now() || !!s.dialog);
  }

  /** The tab's session if attached right now (no attach). */
  current(tabId: number): TabSession | null {
    return this.slots.get(tabId)?.session ?? null;
  }

  record(tabId: number): TabRecord {
    let r = this.records.get(tabId);
    if (!r) this.records.set(tabId, (r = { console: [], network: [], byRequest: new Map(), seq: 0 }));
    return r;
  }

  watchingUntil(tabId: number): number {
    const until = this.slots.get(tabId)?.watchUntil ?? 0;
    return until > this.now() ? until : 0;
  }

  /** Runs `work` with the tab attached. `isLive` is checked after the attach (the switch may have gone off meanwhile). */
  async use<T>(tabId: number, work: (s: TabSession) => Promise<T>, isLive: () => void = () => {}): Promise<T> {
    const slot = this.slot(tabId);
    if (slot.idle) clearTimeout(slot.idle);
    slot.idle = null;
    const session = await this.attach(tabId, slot);
    try {
      isLive();
    } catch (error) {
      this.scheduleIdle(tabId); // the connection dropped meanwhile: do nothing, and let the session go as usual
      throw error;
    }
    session.users++;
    try {
      return await work(session);
    } finally {
      session.users--;
      this.scheduleIdle(tabId);
    }
  }

  /** Keeps the tab attached for `minutes` and records its console; 0 ends it. Returns the end time (0: not watching). */
  async watch(tabId: number, minutes: number): Promise<number> {
    const slot = this.slot(tabId);
    if (slot.watchTimer) clearTimeout(slot.watchTimer);
    slot.watchTimer = null;
    if (minutes <= 0) {
      slot.watchUntil = 0;
      const s = slot.session;
      if (s && s.consoleOn) {
        s.consoleOn = false;
        await s.send('Runtime.disable').catch(() => {});
      }
      this.scheduleIdle(tabId);
      return 0;
    }
    slot.watchUntil = this.now() + minutes * 60_000;
    slot.watchTimer = setTimeout(() => void this.watch(tabId, 0), minutes * 60_000);
    await this.use(tabId, async (s) => {
      if (!s.consoleOn) {
        s.consoleOn = true;
        await s.send('Runtime.enable');
      }
    });
    return slot.watchUntil;
  }

  /** A viewport override lives only as long as the session: keep it attached until unpinned, for `PIN_MAX_MS` at most. */
  pin(tabId: number, on: boolean): void {
    const slot = this.slot(tabId);
    if (slot.pinTimer) clearTimeout(slot.pinTimer);
    slot.pinTimer = null;
    slot.pinned = on;
    if (!on) {
      this.scheduleIdle(tabId);
      return;
    }
    slot.pinTimer = setTimeout(() => {
      slot.pinTimer = null;
      if (!slot.pinned) return;
      slot.pinned = false;
      this.d.log?.('info', 'agent bridge: a viewport override reached its time limit', { tabId });
      const s = slot.session;
      void (s ? s.send('Emulation.clearDeviceMetricsOverride').catch(() => {}) : Promise.resolve()).then(() => this.scheduleIdle(tabId));
    }, this.pinMaxMs);
  }

  isPinned(tabId: number): boolean {
    return this.slots.get(tabId)?.pinned ?? false;
  }

  /** The bridge was switched off: detach every tab now, forget recordings and revocations. */
  async detachAll(): Promise<void> {
    this.generation++;
    const tabIds = [...this.slots.keys()];
    await Promise.all(tabIds.map((id) => this.detach(id)));
    this.slots.clear();
    this.revoked.clear();
    this.records.clear();
    this.abandoned.clear();
  }

  /**
   * The agent that was using the bridge is gone (its MCP process exited): take back everything it left behind. Viewport
   * overrides are cleared, every session is detached, watches end. What the user decided stays (a cancelled tab is still
   * off limits for its minute) and so do the recordings of tabs that are still open.
   */
  async release(): Promise<void> {
    this.generation++;
    const tabIds = [...this.slots.keys()];
    await Promise.all(
      tabIds.map(async (id) => {
        const slot = this.slots.get(id);
        if (slot?.pinned && slot.session) await slot.session.send('Emulation.clearDeviceMetricsOverride', {}, undefined, 2_000).catch(() => {});
        await this.detach(id);
      }),
    );
    this.slots.clear();
  }

  /**
   * A restarted service worker starts with no sessions, but Chrome may still hold the ones the previous worker opened
   * (its "debugging" bar stays). Detach them: `detach` only ever detaches this extension's own sessions.
   */
  async detachStale(): Promise<void> {
    const targets = await this.d.dbg.getTargets?.().catch(() => []) ?? [];
    await Promise.all(targets.filter((t) => t.attached && t.tabId !== undefined && !this.slots.get(t.tabId)?.session).map((t) => this.d.dbg.detach({ tabId: t.tabId! }).catch(() => {})));
  }

  /** The tab closed. */
  forget(tabId: number): void {
    const slot = this.slots.get(tabId);
    if (slot) this.clearTimers(slot);
    slot?.session?.gone();
    this.slots.delete(tabId);
    this.revoked.delete(tabId);
    this.records.delete(tabId);
    this.abandoned.delete(tabId);
  }

  async detach(tabId: number): Promise<void> {
    const slot = this.slots.get(tabId);
    if (!slot) return;
    this.clearTimers(slot);
    slot.watchUntil = 0;
    slot.pinned = false;
    const s = slot.session;
    slot.session = null;
    slot.attaching = null;
    if (!s) return;
    s.gone();
    await this.d.dbg.detach({ tabId }).catch(() => {});
  }

  // ------------------------------------------------------------------ internals

  private slot(tabId: number): Slot {
    let slot = this.slots.get(tabId);
    if (!slot) this.slots.set(tabId, (slot = { session: null, attaching: null, idle: null, watchUntil: 0, watchTimer: null, pinned: false, pinTimer: null }));
    return slot;
  }

  private clearTimers(slot: Slot): void {
    if (slot.idle) clearTimeout(slot.idle);
    if (slot.watchTimer) clearTimeout(slot.watchTimer);
    if (slot.pinTimer) clearTimeout(slot.pinTimer);
    slot.idle = slot.watchTimer = slot.pinTimer = null;
  }

  private scheduleIdle(tabId: number): void {
    const slot = this.slots.get(tabId);
    if (!slot || !slot.session || slot.session.users > 0 || slot.pinned || slot.watchUntil > this.now()) return;
    if (slot.idle) clearTimeout(slot.idle);
    slot.idle = setTimeout(() => this.idleCheck(tabId), this.idleMs);
  }

  /** The idle window ended: let go of the tab, unless something keeps it (a pin, a watch, an open dialog). */
  private idleCheck(tabId: number): void {
    const slot = this.slots.get(tabId);
    if (!slot) return;
    slot.idle = null;
    const s = slot.session;
    if (!s || s.users > 0 || slot.pinned || slot.watchUntil > this.now()) return;
    if (s.dialog) {
      // A JavaScript dialog can only be answered through this session, and the page is frozen until then: stay attached
      // (up to DIALOG_MAX_MS) so that handle_dialog still works after the agent paused. The closing event re-arms the window.
      const left = s.dialogAt + this.dialogMaxMs - this.now();
      if (left > 0) {
        slot.idle = setTimeout(() => this.idleCheck(tabId), Math.min(left, 60_000));
        return;
      }
      this.abandoned.set(tabId, s.dialog);
      this.d.log?.('warn', 'agent bridge: a JavaScript dialog stayed open; letting go of the tab', { tabId });
    }
    void this.detach(tabId);
  }

  private attach(tabId: number, slot: Slot): Promise<TabSession> {
    if (slot.session && !slot.session.detached) return Promise.resolve(slot.session);
    if (slot.attaching) return slot.attaching;
    const work = this.doAttach(tabId).finally(() => {
      if (slot.attaching === work) slot.attaching = null;
    });
    slot.attaching = work;
    return work;
  }

  private async doAttach(tabId: number): Promise<TabSession> {
    const until = this.revoked.get(tabId);
    if (until !== undefined) {
      if (until > this.now()) {
        throw new CdpError(
          `the user cancelled SplitSession's debugging of this tab (the "Cancel" button on Chrome's "started debugging this browser" bar); SplitSession will not attach to it again for ${Math.ceil((until - this.now()) / 1000)} s. Ask the user before trying again.`,
        );
      }
      this.revoked.delete(tabId);
    }
    const url = await this.d.tabUrl(tabId);
    const refused = refusedUrl(url);
    if (refused) throw new CdpError(`SplitSession cannot operate this tab: ${refused}`);
    const generation = this.generation;
    try {
      await this.d.dbg.attach({ tabId }, '1.3');
    } catch (error) {
      const message = cdpMessage(error);
      if (/already attached/i.test(message)) {
        // Chrome refuses a second attach by the same extension only: our own session, forgotten by a worker restart.
        await this.d.dbg.detach({ tabId }).catch(() => {});
        try {
          await this.d.dbg.attach({ tabId }, '1.3');
        } catch (again) {
          throw new CdpError(`the tab is busy: another debugger is attached and Chrome refuses a second one (${cdpMessage(again)}). Close DevTools or the other debugging tool on that tab, or use another tab.`);
        }
      } else if (/cannot access|cannot attach|chrome:\/\/|extensions gallery|webstore|not allowed/i.test(message)) {
        throw new CdpError(`SplitSession cannot operate this tab: Chrome refuses to let extensions debug it (${message})`);
      } else if (/no tab with/i.test(message)) {
        throw new CdpError(`no tab with id ${tabId} (it may have been closed; call list_tabs)`);
      } else {
        throw new CdpError(`could not attach to the tab: ${message}`);
      }
    }
    const session = new TabSession(tabId, this.d.dbg);
    if (generation !== this.generation) {
      // Switched off while attaching.
      await this.d.dbg.detach({ tabId }).catch(() => {});
      throw new CdpError('the SplitSession agent bridge was switched off; the action was not performed');
    }
    const slot = this.slot(tabId);
    slot.session = session;
    try {
      // Enabling Page while an alert is already open can take the browser down (seen in Chromium 156). A page that
      // answers this probe has no dialog open.
      const probe = await Promise.race([
        session.send('Runtime.evaluate', { expression: '1', returnByValue: true }, undefined, PROBE_MS + 500).then(() => true, () => false),
        new Promise<boolean>((r) => setTimeout(() => r(false), PROBE_MS)),
      ]);
      if (!probe) {
        const lost = this.abandoned.get(tabId);
        if (lost) {
          throw new CdpError(
            `a JavaScript ${lost.type}${lost.message ? ` ("${lost.message.slice(0, 200)}")` : ''} has been open on this tab for more than ${Math.round(this.dialogMaxMs / 60_000)} minutes, nobody answered it, and SplitSession let go of the tab; SplitSession cannot answer it now. Ask the user to close the dialog, then try again.`,
          );
        }
        throw new CdpError(
          'the page does not respond: it is busy, or a JavaScript dialog (alert / confirm / prompt) opened while SplitSession was not attached, which SplitSession cannot answer. Ask the user to close the dialog, then try again.',
        );
      }
      await session.send('Page.enable');
      // Typing and focus behave as in the front tab even when the tab is in the background (as Playwright does).
      await session.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
      await session.send('Network.enable', { maxTotalBufferSize: 1_000_000, maxResourceBufferSize: 500_000 }).catch(() => {});
      await session.send('Log.enable').catch(() => {});
      if (slot.watchUntil > this.now()) {
        session.consoleOn = true;
        await session.send('Runtime.enable').catch(() => {});
      }
      const tree = await session.send<{ frameTree: { frame: { loaderId: string } } }>('Page.getFrameTree').catch(() => null);
      session.mainLoaderId = tree?.frameTree.frame.loaderId ?? null;
    } catch (error) {
      slot.session = null;
      session.gone();
      await this.d.dbg.detach({ tabId }).catch(() => {});
      throw error;
    }
    this.abandoned.delete(tabId);
    this.d.log?.('info', 'agent bridge: debugger attached', { tabId });
    return session;
  }

  private onDetach(source: Debuggee, reason: string): void {
    const tabId = source.tabId;
    if (tabId === undefined) return;
    const slot = this.slots.get(tabId);
    const s = slot?.session;
    if (slot) {
      this.clearTimers(slot);
      slot.session = null;
      slot.watchUntil = 0;
      slot.pinned = false;
    }
    s?.gone();
    if (reason === 'canceled_by_user') {
      this.revoked.set(tabId, this.now() + REVOKE_MS);
      this.d.log?.('warn', 'agent bridge: the user cancelled debugging', { tabId });
    } else if (reason === 'target_closed') {
      this.records.delete(tabId);
    }
  }

  private onEvent(source: Debuggee, method: string, params: any): void {
    const tabId = source.tabId;
    if (tabId === undefined) return;
    const s = this.slots.get(tabId)?.session;
    if (!s) return;
    const child = source.sessionId;
    if (!child) this.track(tabId, s, method, params ?? {});
    s.dispatch(method, params, child);
  }

  private track(tabId: number, s: TabSession, method: string, p: any): void {
    switch (method) {
      case 'Page.javascriptDialogOpening':
        s.dialogAt = this.now();
        s.dialog = { type: String(p.type ?? 'dialog'), message: String(p.message ?? ''), ...(p.defaultPrompt ? { defaultPrompt: String(p.defaultPrompt) } : {}), ...(p.url ? { url: String(p.url) } : {}) };
        return;
      case 'Page.javascriptDialogClosed':
        s.dialog = null;
        this.scheduleIdle(tabId); // answered by the user or the page: the normal idle window starts again
        return;
      case 'Page.frameNavigated':
        if (!p.frame?.parentId) s.mainLoaderId = p.frame?.loaderId ?? null;
        return;
    }
    const r = this.record(tabId);
    const at = this.now();
    switch (method) {
      case 'Network.requestWillBeSent': {
        const previous = r.byRequest.get(p.requestId);
        if (previous && p.redirectResponse) {
          previous.status = p.redirectResponse.status;
          previous.statusText = p.redirectResponse.statusText;
        }
        const entry: NetworkEntry = {
          seq: ++r.seq,
          at,
          requestId: String(p.requestId),
          method: String(p.request?.method ?? 'GET'),
          url: String(p.request?.url ?? '').slice(0, 2000),
          type: String(p.type ?? 'Other'),
          ...(p.request?.headers ? { requestHeaders: redactHeaders(p.request.headers) } : {}),
        };
        r.byRequest.set(entry.requestId, entry);
        push(r.network, entry);
        return;
      }
      case 'Network.responseReceived': {
        const e = r.byRequest.get(p.requestId);
        if (!e) return;
        e.status = p.response?.status;
        e.statusText = p.response?.statusText;
        e.mimeType = p.response?.mimeType;
        e.fromCache = !!(p.response?.fromDiskCache || p.response?.fromServiceWorker || p.response?.fromPrefetchCache);
        if (p.response?.headers) e.responseHeaders = redactHeaders(p.response.headers);
        return;
      }
      case 'Network.loadingFinished': {
        const e = r.byRequest.get(p.requestId);
        if (!e) return;
        e.bytes = p.encodedDataLength;
        e.ms = at - e.at;
        r.byRequest.delete(p.requestId);
        return;
      }
      case 'Network.loadingFailed': {
        const e = r.byRequest.get(p.requestId);
        if (!e) return;
        e.failed = String(p.blockedReason ? `blocked: ${p.blockedReason}` : (p.errorText ?? 'failed'));
        e.ms = at - e.at;
        r.byRequest.delete(p.requestId);
        return;
      }
      case 'Runtime.consoleAPICalled': {
        const frame = p.stackTrace?.callFrames?.[0];
        push(r.console, {
          seq: ++r.seq,
          at,
          level: consoleLevel(String(p.type)),
          source: 'console',
          text: (p.args ?? []).map(remoteText).join(' ').slice(0, 4000),
          ...(frame?.url ? { url: String(frame.url), line: Number(frame.lineNumber) + 1 } : {}),
        });
        return;
      }
      case 'Runtime.exceptionThrown': {
        const d = p.exceptionDetails ?? {};
        push(r.console, {
          seq: ++r.seq,
          at,
          level: 'error',
          source: 'exception',
          text: String(d.exception?.description ?? d.text ?? 'exception').slice(0, 4000),
          ...(d.url ? { url: String(d.url), line: Number(d.lineNumber) + 1 } : {}),
        });
        return;
      }
      case 'Log.entryAdded': {
        const e = p.entry ?? {};
        push(r.console, {
          seq: ++r.seq,
          at,
          level: e.level === 'verbose' ? 'debug' : e.level === 'warning' ? 'warning' : e.level === 'error' ? 'error' : 'info',
          source: 'browser',
          text: String(e.text ?? '').slice(0, 4000),
          ...(e.url ? { url: String(e.url), ...(typeof e.lineNumber === 'number' ? { line: e.lineNumber + 1 } : {}) } : {}),
        });
        return;
      }
    }
  }
}

function push<T>(list: T[], item: T): void {
  list.push(item);
  if (list.length > BUFFER) list.splice(0, list.length - BUFFER);
}

function consoleLevel(type: string): ConsoleEntry['level'] {
  if (type === 'error' || type === 'assert') return 'error';
  if (type === 'warning') return 'warning';
  if (type === 'info') return 'info';
  if (type === 'debug') return 'debug';
  return 'log';
}

/** A console argument as text: primitives by value, objects by their preview or description. */
export function remoteText(o: any): string {
  if (!o || typeof o !== 'object') return String(o);
  if (o.type === 'string') return String(o.value);
  if ('value' in o) return typeof o.value === 'object' ? JSON.stringify(o.value) : String(o.value);
  if (o.unserializableValue) return String(o.unserializableValue);
  if (o.preview?.properties && o.type === 'object' && o.subtype !== 'error') {
    const inner = o.preview.properties.map((p: { name: string; value?: string }) => (o.subtype === 'array' ? `${p.value}` : `${p.name}: ${p.value}`)).join(', ');
    return o.subtype === 'array' ? `[${inner}${o.preview.overflow ? ', …' : ''}]` : `{${inner}${o.preview.overflow ? ', …' : ''}}`;
  }
  return String(o.description ?? o.type);
}
