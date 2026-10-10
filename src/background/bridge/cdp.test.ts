import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CdpSessions, IDLE_MS, cdpMessage, redactHeaders, refusedUrl, remoteText, type Debuggee, type DebuggerApi } from './cdp';

type EventCb = (source: Debuggee, method: string, params?: any) => void;
type DetachCb = (source: Debuggee, reason: string) => void;

function fakeDebugger(opts: { attachError?: (n: number) => Error | null; hang?: Set<string> } = {}) {
  let onEvent: EventCb = () => {};
  let onDetach: DetachCb = () => {};
  const attached = new Set<number>();
  const calls: string[] = [];
  let attachCount = 0;
  const dbg: DebuggerApi & { calls: string[]; attached: Set<number>; emit: EventCb; detachByChrome: DetachCb } = {
    calls,
    attached,
    attach: vi.fn(async ({ tabId }) => {
      const error = opts.attachError?.(++attachCount) ?? null;
      calls.push(`attach ${tabId}`);
      if (error) throw error;
      attached.add(tabId);
    }),
    detach: vi.fn(async ({ tabId }) => {
      calls.push(`detach ${tabId}`);
      attached.delete(tabId);
    }),
    sendCommand: vi.fn(async (target: Debuggee, method: string) => {
      calls.push(`${method}${target.sessionId ? `@${target.sessionId}` : ''}`);
      if (opts.hang?.has(method)) return new Promise(() => {});
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'F', loaderId: 'L1' } } };
      if (method === 'Runtime.evaluate') return { result: { value: 1 } };
      return {};
    }),
    getTargets: vi.fn(async () => [...attached].map((tabId) => ({ tabId, attached: true, type: 'page' }))),
    onEvent: { addListener: (cb: EventCb) => void (onEvent = cb) },
    onDetach: { addListener: (cb: DetachCb) => void (onDetach = cb) },
    emit: (s, m, p) => onEvent(s, m, p),
    detachByChrome: (s, r) => onDetach(s, r),
  };
  return dbg;
}

const urls = new Map<number, string>();
const setup = (dbg = fakeDebugger(), now = () => Date.now()) => ({
  dbg,
  cdp: new CdpSessions({ dbg, tabUrl: async (id) => urls.get(id) ?? 'https://a.test/', now, idleMs: 5_000 }),
});

describe('CDP sessions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    urls.clear();
  });
  afterEach(() => vi.useRealTimers());

  it('attaches on demand, enables only the quiet domains, reuses the session, and detaches after the idle window', async () => {
    const { dbg, cdp } = setup();
    expect(await cdp.use(1, async () => 'a')).toBe('a');
    expect(dbg.calls).toEqual(['attach 1', 'Runtime.evaluate', 'Page.enable', 'Emulation.setFocusEmulationEnabled', 'Network.enable', 'Log.enable', 'Page.getFrameTree']);
    expect(dbg.calls).not.toContain('Runtime.enable'); // pages that look for debuggers notice the console domain
    await cdp.use(1, async () => 'b');
    expect(dbg.attach).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_000);
    await cdp.use(1, async () => 'c'); // re-arms the window
    await vi.advanceTimersByTimeAsync(4_000);
    expect(cdp.isAttached(1)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(cdp.isAttached(1)).toBe(false);
    expect(dbg.calls.at(-1)).toBe('detach 1');
  });

  it('by default the session outlives an agent\'s pauses: one attach per burst, detached a minute after the last tool', async () => {
    const dbg = fakeDebugger();
    const cdp = new CdpSessions({ dbg, tabUrl: async () => 'https://a.test/' });
    expect(IDLE_MS).toBe(60_000);
    for (let i = 0; i < 5; i++) {
      await cdp.use(1, async () => i);
      await vi.advanceTimersByTimeAsync(3_000);
    }
    expect(dbg.attach).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(56_000);
    expect(cdp.isAttached(1)).toBe(true); // 59 s after the last tool
    await vi.advanceTimersByTimeAsync(2_000);
    expect(cdp.isAttached(1)).toBe(false);
    // The tool that comes next attaches again.
    await cdp.use(1, async () => 0);
    expect(dbg.attach).toHaveBeenCalledTimes(2);
  });

  it('two tools at once share one attach', async () => {
    const { dbg, cdp } = setup();
    await Promise.all([cdp.use(1, async () => 1), cdp.use(1, async () => 2)]);
    expect(dbg.attach).toHaveBeenCalledTimes(1);
  });

  it('refuses browser pages, extension pages and the Web Store before trying', async () => {
    const { dbg, cdp } = setup();
    urls.set(2, 'chrome://settings/');
    await expect(cdp.use(2, async () => 0)).rejects.toThrow(/chrome:\/\/ pages belong to the browser/);
    urls.set(3, 'chrome-extension://abc/options.html');
    await expect(cdp.use(3, async () => 0)).rejects.toThrow(/extension pages \(Facet's own included\)/);
    urls.set(4, 'https://chromewebstore.google.com/detail/x');
    await expect(cdp.use(4, async () => 0)).rejects.toThrow(/Web Store/);
    expect(dbg.attach).not.toHaveBeenCalled();
    expect(refusedUrl('https://example.com/')).toBeNull();
    expect(refusedUrl('about:blank')).toBeNull();
    expect(refusedUrl('view-source:https://a.test/')).toMatch(/view-source/);
  });

  it('takes back its own forgotten session; reports a tab another debugger holds as busy, without touching it', async () => {
    const already = new Error('Another debugger is already attached to the tab with id: 5.');
    // Our own stale session: the first attach fails, a detach of our own and the second attach succeed.
    const own = setup(fakeDebugger({ attachError: (n) => (n === 1 ? already : null) }));
    await own.cdp.use(5, async () => 0);
    expect(own.dbg.calls.slice(0, 3)).toEqual(['attach 5', 'detach 5', 'attach 5']);
    // Refused again: busy.
    const busy = setup(fakeDebugger({ attachError: () => already }));
    await expect(busy.cdp.use(5, async () => 0)).rejects.toThrow(/the tab is busy: another debugger is attached/);
    const odd = setup(fakeDebugger({ attachError: () => new Error('Cannot access a chrome:// URL') }));
    await expect(odd.cdp.use(6, async () => 0)).rejects.toThrow(/Chrome refuses to let extensions debug it/);
  });

  it('a page that does not answer is not Page.enabled (an open dialog plus Page.enable can bring Chrome down)', async () => {
    const { dbg, cdp } = setup(fakeDebugger({ hang: new Set(['Runtime.evaluate']) }));
    const run = cdp.use(7, async () => 0);
    const outcome = expect(run).rejects.toThrow(/does not respond.*dialog/);
    await vi.advanceTimersByTimeAsync(2_000);
    await outcome;
    expect(dbg.calls).not.toContain('Page.enable');
    expect(dbg.calls.at(-1)).toBe('detach 7');
    expect(cdp.isAttached(7)).toBe(false);
  });

  it('"Cancel" on Chrome\'s bar is the user taking it back: no attach to that tab for a minute', async () => {
    let t = 1_000_000;
    const { dbg, cdp } = setup(fakeDebugger(), () => t);
    await cdp.use(8, async () => 0);
    dbg.detachByChrome({ tabId: 8 }, 'canceled_by_user');
    expect(cdp.isAttached(8)).toBe(false);
    await expect(cdp.use(8, async () => 0)).rejects.toThrow(/the user cancelled Facet's debugging of this tab.*60 s/);
    t += 61_000;
    await cdp.use(8, async () => 0);
    expect(dbg.attach).toHaveBeenCalledTimes(2);
  });

  it('switching off detaches every tab at once, and an attach that was under way is undone', async () => {
    let release!: () => void;
    const dbg = fakeDebugger();
    const { cdp } = setup(dbg);
    await cdp.use(1, async () => 0);
    await cdp.watch(2, 5);
    expect(cdp.isAttached(2)).toBe(true);
    (dbg.attach as any).mockImplementationOnce(async ({ tabId }: { tabId: number }) => {
      await new Promise<void>((r) => (release = r));
      dbg.attached.add(tabId);
    });
    const pending = cdp.use(3, async () => 'acted');
    await vi.advanceTimersByTimeAsync(0);
    await cdp.detachAll();
    expect(cdp.isAttached(1)).toBe(false);
    expect(cdp.isAttached(2)).toBe(false);
    release();
    await expect(pending).rejects.toThrow(/switched off/);
    expect(dbg.attached.size).toBe(0);
  });

  it('watch keeps the tab attached and records the console; the console domain is switched off again after', async () => {
    const { dbg, cdp } = setup();
    const until = await cdp.watch(1, 2);
    expect(until).toBeGreaterThan(Date.now());
    expect(dbg.calls).toContain('Runtime.enable');
    dbg.emit({ tabId: 1 }, 'Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'hi' }, { type: 'object', preview: { properties: [{ name: 'a', value: '1' }] } }] });
    dbg.emit({ tabId: 1 }, 'Runtime.exceptionThrown', { exceptionDetails: { exception: { description: 'Error: boom\n at x' } } });
    dbg.emit({ tabId: 1 }, 'Log.entryAdded', { entry: { level: 'error', text: 'Refused to load', url: 'https://a.test/x.js' } });
    expect(cdp.record(1).console.map((e) => `${e.level}/${e.source}/${e.text}`)).toEqual(['log/console/hi {a: 1}', 'error/exception/Error: boom\n at x', 'error/browser/Refused to load']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cdp.isAttached(1)).toBe(true); // still watching
    await vi.advanceTimersByTimeAsync(61_000 + 5_000);
    expect(dbg.calls).toContain('Runtime.disable');
    expect(cdp.isAttached(1)).toBe(false);
  });

  it('records requests without credentials, follows redirects and failures', async () => {
    const { dbg, cdp } = setup();
    await cdp.use(1, async () => 0);
    dbg.emit({ tabId: 1 }, 'Network.requestWillBeSent', { requestId: 'r1', type: 'Document', request: { method: 'GET', url: 'https://a.test/', headers: { Cookie: 'sid=secret', Accept: 'text/html' } } });
    dbg.emit({ tabId: 1 }, 'Network.requestWillBeSent', { requestId: 'r1', type: 'Document', redirectResponse: { status: 302 }, request: { method: 'GET', url: 'https://a.test/home', headers: {} } });
    dbg.emit({ tabId: 1 }, 'Network.responseReceived', { requestId: 'r1', response: { status: 200, mimeType: 'text/html', headers: { 'Set-Cookie': 'sid=new', 'content-type': 'text/html' } } });
    dbg.emit({ tabId: 1 }, 'Network.loadingFinished', { requestId: 'r1', encodedDataLength: 512 });
    dbg.emit({ tabId: 1 }, 'Network.requestWillBeSent', { requestId: 'r2', type: 'Fetch', request: { method: 'POST', url: 'https://a.test/api', headers: { Authorization: 'Bearer x' } } });
    dbg.emit({ tabId: 1 }, 'Network.loadingFailed', { requestId: 'r2', errorText: 'net::ERR_FAILED' });
    const [first, second, third] = cdp.record(1).network;
    expect(first).toMatchObject({ url: 'https://a.test/', status: 302, requestHeaders: { Cookie: '(hidden by Facet)', Accept: 'text/html' } });
    expect(second).toMatchObject({ url: 'https://a.test/home', status: 200, bytes: 512, responseHeaders: { 'Set-Cookie': '(hidden by Facet)', 'content-type': 'text/html' } });
    expect(third).toMatchObject({ method: 'POST', failed: 'net::ERR_FAILED', requestHeaders: { Authorization: '(hidden by Facet)' } });
    expect(JSON.stringify(cdp.record(1))).not.toMatch(/secret|sid=new|Bearer/);
    // Events of a tab that is not attached are ignored.
    dbg.emit({ tabId: 9 }, 'Network.requestWillBeSent', { requestId: 'x', request: { url: 'https://b.test/' } });
    expect(cdp.record(9).network).toEqual([]);
  });

  it('tracks dialogs and awaited events, and a closed tab is forgotten', async () => {
    const { dbg, cdp } = setup();
    await cdp.use(1, async (s) => {
      dbg.emit({ tabId: 1 }, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Sure?' });
      expect(s.dialog).toEqual({ type: 'confirm', message: 'Sure?' });
      dbg.emit({ tabId: 1 }, 'Page.javascriptDialogClosed', {});
      expect(s.dialog).toBeNull();
      const waited = s.waitFor('Page.loadEventFired', 1_000);
      dbg.emit({ tabId: 1 }, 'Page.loadEventFired', { timestamp: 1 });
      expect(await waited).toEqual({ timestamp: 1 });
    });
    cdp.forget(1);
    expect(cdp.isAttached(1)).toBe(false);
  });

  it('an open JavaScript dialog keeps the session past the idle window, up to a cap, and the answer still works', async () => {
    const dbg = fakeDebugger();
    const cdp = new CdpSessions({ dbg, tabUrl: async () => 'https://a.test/', idleMs: 5_000, dialogMaxMs: 60_000 });
    await cdp.use(1, async () => {
      dbg.emit({ tabId: 1 }, 'Page.javascriptDialogOpening', { type: 'alert', message: 'hi' });
    });
    await vi.advanceTimersByTimeAsync(7_000); // the agent paused for longer than the idle window
    expect(cdp.isAttached(1)).toBe(true);
    expect(cdp.current(1)?.dialog).toMatchObject({ type: 'alert', message: 'hi' });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(cdp.isAttached(1)).toBe(true);
    // Answered (by anyone): the normal idle window starts and the session goes.
    dbg.emit({ tabId: 1 }, 'Page.javascriptDialogClosed', {});
    await vi.advanceTimersByTimeAsync(5_500);
    expect(cdp.isAttached(1)).toBe(false);
  });

  it('a dialog nobody answers is let go after the cap, and the next attach says what happened', async () => {
    const dbg = fakeDebugger();
    const cdp = new CdpSessions({ dbg, tabUrl: async () => 'https://a.test/', idleMs: 5_000, dialogMaxMs: 120_000 });
    await cdp.use(1, async () => {
      dbg.emit({ tabId: 1 }, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Sure?' });
    });
    await vi.advanceTimersByTimeAsync(121_000);
    expect(cdp.isAttached(1)).toBe(false);
    dbg.sendCommand = vi.fn(async () => new Promise(() => {})); // the page is frozen behind the dialog
    const run = cdp.use(1, async () => 0);
    const outcome = expect(run).rejects.toThrow(/confirm \("Sure\?"\) has been open on this tab for more than 2 minutes.*let go/);
    await vi.advanceTimersByTimeAsync(2_000);
    await outcome;
  });

  it('a viewport pin ends after its cap (override cleared, session idles out), and release() clears and detaches everything', async () => {
    const dbg = fakeDebugger();
    const cdp = new CdpSessions({ dbg, tabUrl: async () => 'https://a.test/', idleMs: 5_000, pinMaxMs: 60_000 });
    await cdp.use(1, async () => cdp.pin(1, true));
    await vi.advanceTimersByTimeAsync(50_000);
    expect(cdp.isAttached(1)).toBe(true);
    expect(cdp.isPinned(1)).toBe(true);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(cdp.isPinned(1)).toBe(false);
    expect(dbg.calls).toContain('Emulation.clearDeviceMetricsOverride');
    await vi.advanceTimersByTimeAsync(5_500);
    expect(cdp.isAttached(1)).toBe(false);

    await cdp.use(2, async () => cdp.pin(2, true));
    await cdp.use(3, async () => 0);
    dbg.calls.length = 0;
    await cdp.release();
    expect(dbg.calls.filter((c) => c.startsWith('Emulation.clearDeviceMetricsOverride'))).toHaveLength(1); // only the pinned tab
    expect(dbg.calls).toContain('detach 2');
    expect(dbg.calls).toContain('detach 3');
    expect(cdp.isAttached(2)).toBe(false);
    expect(cdp.isPinned(2)).toBe(false);
  });

  it('turns Chrome\'s error JSON into a sentence, and console arguments into text', () => {
    expect(cdpMessage(new Error('{"code":-32000,"message":"No node with given id found"}'))).toBe('No node with given id found');
    expect(cdpMessage(new Error('plain'))).toBe('plain');
    expect(redactHeaders({ 'X-CSRF-Token': 'abc', Accept: '*/*' })).toEqual({ 'X-CSRF-Token': '(hidden by Facet)', Accept: '*/*' });
    expect(remoteText({ type: 'number', value: 3 })).toBe('3');
    expect(remoteText({ type: 'object', subtype: 'array', preview: { properties: [{ name: '0', value: '1' }], overflow: true } })).toBe('[1, …]');
    expect(remoteText({ type: 'function', description: 'function f() {}' })).toBe('function f() {}');
  });

  it('after a worker restart, sessions Chrome still holds for us are detached', async () => {
    const dbg = fakeDebugger();
    dbg.attached.add(4);
    const { cdp } = setup(dbg);
    await cdp.detachStale();
    expect(dbg.calls).toEqual(['detach 4']);
  });
});
