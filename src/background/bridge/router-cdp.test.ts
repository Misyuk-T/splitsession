import { describe, expect, it, vi } from 'vitest';
import { CdpSessions, type Debuggee, type DebuggerApi } from './cdp';
import { BridgeRouter, type ActionMeta } from './router';

type Handler = (params: any, target: Debuggee) => unknown;

/** A fake Chrome: tabs plus a debugger whose answers the test sets per CDP method. */
function setup(opts: { url?: string; container?: string | null } = {}) {
  const tab = { id: 1, windowId: 10, index: 0, active: false, pinned: false, title: 'Page', url: opts.url ?? 'https://a.test/page', status: 'complete', groupId: -1 };
  const calls: Array<{ method: string; params: any }> = [];
  let onEvent: (s: Debuggee, m: string, p?: any) => void = () => {};
  const handlers: Record<string, Handler> = {
    'Runtime.evaluate': () => ({ result: { type: 'number', value: 1 } }),
    'Page.getFrameTree': () => ({ frameTree: { frame: { id: 'F', loaderId: 'L1' } } }),
    'Page.createIsolatedWorld': () => ({ executionContextId: 99 }),
  };
  const dbg: DebuggerApi = {
    attach: vi.fn(async () => {}),
    detach: vi.fn(async () => {}),
    sendCommand: vi.fn(async (target: Debuggee, method: string, params?: any) => {
      calls.push({ method, params });
      // Chrome refuses to compile `return (\n<statements>\n)`: a SyntaxError of the code itself (no stack trace), nothing runs.
      const wrapped = method === 'Runtime.evaluate' ? /^\((?:async )?\(\) => \{\nreturn \(\n([\s\S]*)\n\)\n\}\)\(\)$/.exec(String(params?.expression)) : null;
      if (wrapped && /\b(return|throw)\b|;/.test(wrapped[1]!)) {
        return { result: { type: 'object', className: 'SyntaxError' }, exceptionDetails: { text: 'Uncaught', exception: { type: 'object', className: 'SyntaxError', description: "SyntaxError: Unexpected token 'return'" } } };
      }
      const h = handlers[method];
      return h ? h(params ?? {}, target) : {};
    }),
    onEvent: { addListener: (cb) => void (onEvent = cb) },
    onDetach: { addListener: () => {} },
  };
  const cdp = new CdpSessions({ dbg, tabUrl: async () => tab.url, idleMs: 60_000 });
  const b = {
    tabs: {
      get: vi.fn(async () => tab),
      query: vi.fn(async () => [tab]),
      update: vi.fn(async () => tab),
      reload: vi.fn(async () => {}),
      goBack: vi.fn(async () => {}),
      goForward: vi.fn(async () => {}),
      captureVisibleTab: vi.fn(async () => 'data:image/png;base64,AAAA'),
    },
    scripting: { executeScript: vi.fn(async () => [{ result: { ok: true, json: '"via executeScript"', truncated: false } }]) },
    windows: { update: vi.fn(async () => ({})), getAll: vi.fn(async () => []), get: vi.fn(async () => ({ state: 'normal' })) },
    runtime: { getManifest: () => ({ version: '1' }) },
  };
  const facet = {
    ready: Promise.resolve(),
    listContainers: () => [],
    containers: { resolve: () => undefined, get: (id: string) => ({ id, name: 'Work' }) },
    createContainer: vi.fn(),
    getTabContainer: () => opts.container ?? null,
    prepareNavigation: vi.fn(async () => {}),
    openInContainer: vi.fn(async () => 1),
  };
  const router = new BridgeRouter({ b: b as never, facet: facet as never, api: { assignTab: vi.fn() } as never, sleep: async () => {}, cdp, isMac: true });
  const run = async (tool: string, args: unknown, meta: ActionMeta = {}) => (await router.run(tool, args, meta)).content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`));
  const methods = () => calls.map((c) => c.method);
  /** The page side (page-dom.ts): `answer` gets each DOM command and the frame it was sent to, and gives the result the page would. */
  const cmds: Array<{ cmd: any; frameId: number }> = [];
  const dom = (answer: (cmd: any, frameId: number) => unknown) =>
    b.scripting.executeScript.mockImplementation((async (inj: { args: [any]; target: { frameIds: number[] } }) => {
      cmds.push({ cmd: inj.args[0], frameId: inj.target.frameIds[0]! });
      return [{ result: answer(inj.args[0], inj.target.frameIds[0]!) }];
    }) as never);
  return { router, run, handlers, calls, methods, cdp, dbg, b, facet, tab, dom, cmds, emit: (m: string, p: any) => onEvent({ tabId: 1 }, m, p) };
}

describe('bridge router with the debugger', () => {
  it('run_js evaluates in the page through CDP, returns JSON, reports errors as "Name: message"', async () => {
    const t = setup();
    t.handlers['Runtime.evaluate'] = (p) =>
      p.expression === '1' ? { result: { type: 'number', value: 1 } } : { result: { type: 'object', objectId: 'obj1' } };
    t.handlers['Runtime.callFunctionOn'] = () => ({ result: { value: { json: '{"a":[1,2]}', truncated: false } } });
    expect(await t.run('run_js', { tabId: 1, code: 'return {a: [1, 2]}' })).toEqual(['{"a":[1,2]}']);
    const evaluate = t.calls.filter((c) => c.method === 'Runtime.evaluate' && c.params.expression !== '1').at(-1)!; // (the body run follows the failed expression attempt)
    expect(evaluate.params).toMatchObject({ expression: '(async () => {\nreturn {a: [1, 2]}\n})()', awaitPromise: true, returnByValue: false, userGesture: true });
    expect(evaluate.params.contextId).toBeUndefined(); // the page's MAIN world, where the cookie shim lives

    t.handlers['Runtime.evaluate'] = (p) =>
      p.expression === '1' ? { result: { value: 1 } } : { result: { type: 'object' }, exceptionDetails: { exception: { type: 'object', className: 'TypeError', description: 'TypeError: boom\n    at <anonymous>:2:7' } } };
    await expect(t.run('run_js', { tabId: 1, code: 'throw new TypeError("boom")' })).rejects.toThrow(/^TypeError: boom$/);
    t.handlers['Runtime.evaluate'] = (p) => (p.expression === '1' ? { result: { value: 1 } } : { result: { type: 'string', value: 'x'.repeat(50) } });
    expect(await t.run('run_js', { tabId: 1, code: 'return "x"', maxChars: 100 })).toEqual([JSON.stringify('x'.repeat(50))]);
    t.handlers['Runtime.evaluate'] = (p) => (p.expression === '1' ? { result: { value: 1 } } : { result: { type: 'undefined' } });
    expect(await t.run('run_js', { tabId: 1, code: 'void 0' })).toEqual(['undefined']);
  });

  it('run_js returns the value of a bare expression as well as of a function body', async () => {
    const t = setup();
    t.handlers['Runtime.evaluate'] = (p) => (p.expression === '1' ? { result: { value: 1 } } : { result: { type: 'string', value: 'Page' } });
    expect(await t.run('run_js', { tabId: 1, code: 'document.title' })).toEqual(['"Page"']);
    const expressions = () => t.calls.filter((c) => c.method === 'Runtime.evaluate' && c.params.expression !== '1').map((c) => c.params.expression);
    expect(expressions().at(-1)).toBe('(async () => {\nreturn (\ndocument.title\n)\n})()');
    // Trailing semicolons and blank space do not matter.
    await t.run('run_js', { tabId: 1, code: '  ({a: 1});\n' });
    expect(expressions().at(-1)).toBe('(async () => {\nreturn (\n({a: 1})\n)\n})()');
    // A function body (return, statements) is still a function body.
    await t.run('run_js', { tabId: 1, code: 'return 1' });
    expect(expressions().at(-1)).toBe('(async () => {\nreturn 1\n})()');
    await t.run('run_js', { tabId: 1, code: 'const x = 2; return x' });
    expect(expressions().at(-1)).toBe('(async () => {\nconst x = 2; return x\n})()');
    // Without awaiting, the same in a plain function.
    await t.run('run_js', { tabId: 1, code: 'location.href', awaitPromise: false });
    expect(expressions().at(-1)).toBe('(() => {\nreturn (\nlocation.href\n)\n})()');
    // Code that does not compile as an expression is evaluated again as a body (it never ran): two evaluations.
    const before = expressions().length;
    await t.run('run_js', { tabId: 1, code: 'return 3' });
    expect(expressions().length - before).toBe(2);
    // A SyntaxError thrown by RUNNING code (it has a stack trace) is the code's own result: no second evaluation.
    t.handlers['Runtime.evaluate'] = (p) =>
      p.expression === '1'
        ? { result: { value: 1 } }
        : { result: { type: 'object' }, exceptionDetails: { text: 'Uncaught (in promise)', stackTrace: { callFrames: [] }, exception: { type: 'object', className: 'SyntaxError', description: 'SyntaxError: Unexpected token x in JSON\n    at JSON.parse (<anonymous>)' } } };
    const runs = expressions().length;
    await expect(t.run('run_js', { tabId: 1, code: "JSON.parse('x')" })).rejects.toThrow(/^SyntaxError: /);
    expect(expressions().length - runs).toBe(1);
  });

  it('run_js refuses the ISOLATED world (it would see the regular profile\'s cookies of a container site)', async () => {
    const t = setup();
    await expect(t.run('run_js', { tabId: 1, code: 'return 1', world: 'ISOLATED' })).rejects.toThrow(/only in the page's own \(MAIN\) world/);
    expect(t.methods()).not.toContain('Runtime.evaluate');
  });

  it('run_js falls back to an injected script on a page SplitSession may not debug', async () => {
    const t = setup({ url: 'chrome://version/' });
    expect(await t.run('run_js', { tabId: 1, code: 'return 1' })).toEqual(['"via executeScript"']);
    expect(t.methods()).toEqual([]);
  });

  it('click by selector: the page locates the element, the debugger only sends the trusted mouse events at its middle', async () => {
    const t = setup();
    t.dom((cmd) => (cmd.op === 'locate' ? { label: '<button#go>', rect: { x: 10, y: 20, w: 100, h: 40 }, x: 60, y: 40 } : {}));
    expect(JSON.parse((await t.run('click', { tabId: 1, selector: '#go', modifiers: ['Shift'] }))[0]!)).toEqual({ clicked: '<button#go>' });
    expect(t.cmds[0]).toEqual({ cmd: { op: 'locate', target: { selector: '#go' }, scroll: true }, frameId: 0 });
    const mouse = t.calls.filter((c) => c.method === 'Input.dispatchMouseEvent').map((c) => `${c.params.type}@${c.params.x},${c.params.y}/${c.params.modifiers}`);
    expect(mouse).toEqual(['mouseMoved@60,40/8', 'mousePressed@60,40/8', 'mouseReleased@60,40/8']);
    expect(t.methods()).not.toContain('DOM.scrollIntoViewIfNeeded');
  });

  it('a mistake in the target is explained without attaching the debugger at all', async () => {
    const t = setup();
    t.dom((cmd) => (cmd.op === 'locate' ? { error: 'no element matches "#absent"' } : {}));
    await expect(t.run('click', { tabId: 1, selector: '#absent' })).rejects.toThrow(/no element matches "#absent"/);
    await expect(t.run('click', { tabId: 1, ref: 'e3' })).rejects.toThrow(/unknown ref e3: take a snapshot/);
    expect(t.dbg.attach).not.toHaveBeenCalled();
  });

  it('explains wrong targets before touching the page', async () => {
    const t = setup();
    await expect(t.run('click', { tabId: 1, ref: 'e3' })).rejects.toThrow(/unknown ref e3: take a snapshot of this tab first/);
    await expect(t.run('click', { tabId: 1, ref: 'e3', selector: 'a' })).rejects.toThrow(/give ref or selector, not both/);
    await expect(t.run('click', { tabId: 1, selector: 'a', x: 1, y: 2 })).rejects.toThrow(/not several/);
    await expect(t.run('drag', { tabId: 1, x: 1, y: 2 })).rejects.toThrow(/give where to drop/);
    await expect(t.run('wait_for', { tabId: 1, text: 'a', textGone: 'b' })).rejects.toThrow(/give exactly one of/);
    await expect(t.run('type', { tabId: 1, text: 'a' })).rejects.toThrow(/give a ref \(from snapshot\) or a selector/);
    expect(t.methods().filter((m) => m.startsWith('Input.'))).toEqual([]);
  });

  it('an open JavaScript dialog stops page tools with advice, and is answered with handle_dialog', async () => {
    const t = setup();
    await t.run('run_js', { tabId: 1, code: 'return 1' }).catch(() => {});
    t.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'Hi there' });
    await expect(t.run('snapshot', { tabId: 1 })).rejects.toThrow(/a JavaScript alert is open on this tab: "Hi there"\. Answer it with handle_dialog/);
    expect(JSON.parse((await t.run('handle_dialog', { tabId: 1, accept: true }))[0]!)).toEqual({ tabId: 1, answered: 'alert', message: 'Hi there', accepted: true });
    expect(t.calls.find((c) => c.method === 'Page.handleJavaScriptDialog')!.params).toEqual({ accept: true });
    await expect(t.run('handle_dialog', { tabId: 1, accept: true })).rejects.toThrow(/no JavaScript dialog that SplitSession saw/);
  });

  it('snapshot reads the DOM, renders the tree with refs, and click can use them: no debugger for the read', async () => {
    const t = setup();
    t.dom((cmd) =>
      cmd.op === 'snapshot'
        ? {
            token: 'T1',
            url: 'https://a.test/page',
            title: 'Page',
            truncated: false,
            reachable: [],
            iframes: [],
            frames: {
              main: [
                { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Page' }, childIds: ['2'] },
                { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'Join' }, childIds: [], backendDOMNodeId: 7 },
              ],
            },
          }
        : cmd.op === 'locate'
          ? { label: '<button>', rect: { x: 0, y: 0, w: 10, h: 10 }, x: 5, y: 5 }
          : {},
    );
    const [head, body] = await t.run('snapshot', { tabId: 1 });
    expect(JSON.parse(head!)).toMatchObject({ tabId: 1, url: 'https://a.test/page', title: 'Page', refs: 1, truncated: false });
    expect(body).toBe('- button "Join" [ref=e1]');
    expect(t.dbg.attach).not.toHaveBeenCalled();
    await t.run('click', { tabId: 1, ref: 'e1' });
    expect(t.cmds.at(-1)).toEqual({ cmd: { op: 'locate', target: { id: 7, token: 'T1' }, scroll: true }, frameId: 0 });
    expect(t.calls.find((c) => c.method === 'Input.dispatchMouseEvent')!.params).toMatchObject({ x: 5, y: 5 });
    // The next document has another registry: the old ref is refused instead of hitting something else.
    t.dom(() => ({ stale: true }));
    await expect(t.run('click', { tabId: 1, ref: 'e1' })).rejects.toThrow(/unknown ref e1: the page has changed/);
  });

  it('a frame of another site is read on its own and put under its <iframe>; a click in it is shifted by the frame\'s position', async () => {
    const t = setup();
    (t.b as any).webNavigation = { getAllFrames: vi.fn(async () => [{ frameId: 0, parentFrameId: -1, url: 'https://a.test/page' }, { frameId: 5, parentFrameId: 0, url: 'https://b.test/child' }]) };
    const root = (name: string, kids: string[]) => ({ nodeId: '1', role: { value: 'RootWebArea' }, name: { value: name }, childIds: kids });
    t.dom((cmd, frameId) => {
      if (cmd.op === 'snapshot') {
        return frameId === 0
          ? {
              token: 'TOP',
              url: 'x',
              title: 'Page',
              truncated: false,
              reachable: [],
              iframes: [{ frame: 'main', id: 3, child: null, src: 'https://b.test/child' }],
              frames: { main: [root('Page', ['2']), { nodeId: '2', parentId: '1', role: { value: 'Iframe' }, name: { value: 'Other site' }, childIds: [], backendDOMNodeId: 3 }] },
            }
          : { token: 'KID', url: 'y', title: 'Child', truncated: false, reachable: [], iframes: [], frames: { main: [root('Child', ['2']), { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'Inside' }, childIds: [], backendDOMNodeId: 1 }] } };
      }
      if (cmd.op === 'owner') return { x: 40, y: 100 };
      if (cmd.op === 'locate') return { label: '<button>', rect: { x: 10, y: 10, w: 20, h: 20 }, x: 20, y: 20 };
      return {};
    });
    const [, body] = await t.run('snapshot', { tabId: 1 });
    expect(body).toBe('- iframe "Other site" [ref=e1]:\n  - button "Inside" [ref=e2]');
    await t.run('click', { tabId: 1, ref: 'e2' });
    expect(t.cmds.find((c) => c.cmd.op === 'locate')!.frameId).toBe(5);
    expect(t.cmds.find((c) => c.cmd.op === 'owner')).toMatchObject({ frameId: 0, cmd: { target: { id: 3, token: 'TOP' } } });
    expect(t.calls.find((c) => c.method === 'Input.dispatchMouseEvent')!.params).toMatchObject({ x: 60, y: 120 });
  });

  it('only trusted input, uploads, scripts, screenshots and dialogs need the debugger: reading, selecting, scrolling and waiting do not', async () => {
    const t = setup();
    t.dom((cmd) => {
      switch (cmd.op) {
        case 'snapshot':
          return { token: 'T', url: 'u', title: 'P', truncated: false, reachable: [], iframes: [], frames: { main: [{ nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2'] }, { nodeId: '2', parentId: '1', role: { value: 'combobox' }, name: { value: 'Size' }, childIds: [], backendDOMNodeId: 4 }] } };
        case 'select':
          return { selected: ['l'], rect: null };
        case 'scrollTo':
          return { x: 0, y: 120, maxY: 900 };
        case 'check':
          return { ok: true };
        default:
          return { text: 'hello page', total: 10, url: 'https://a.test/page', title: 'P' };
      }
    });
    await t.run('snapshot', { tabId: 1 });
    await t.run('get_tab_text', { tabId: 1 });
    expect(JSON.parse((await t.run('select_option', { tabId: 1, ref: 'e1', values: ['Large'] }))[0]!)).toEqual({ selected: ['l'] });
    expect(JSON.parse((await t.run('scroll', { tabId: 1, ref: 'e1' }))[0]!)).toEqual({ x: 0, y: 120, maxY: 900 });
    expect(JSON.parse((await t.run('wait_for', { tabId: 1, text: 'hello' }))[0]!)).toMatchObject({ ok: true });
    expect(JSON.parse((await t.run('wait_for', { tabId: 1, ref: 'e1' }))[0]!)).toMatchObject({ ok: true });
    expect(t.dbg.attach).not.toHaveBeenCalled();
    expect(t.methods()).toEqual([]);
  });

  it('a burst of actions is one attach: the session stays for a minute after the last debugger-using tool', async () => {
    const t = setup();
    t.dom((cmd) => (cmd.op === 'locate' ? { label: '<button>', rect: { x: 0, y: 0, w: 10, h: 10 }, x: 5, y: 5 } : {}));
    for (let i = 0; i < 5; i++) await t.run('click', { tabId: 1, selector: '#go' });
    await t.run('hover', { tabId: 1, selector: '#go' });
    expect(t.dbg.attach).toHaveBeenCalledTimes(1);
    expect(t.dbg.detach).not.toHaveBeenCalled();
    expect(t.cdp.isAttached(1)).toBe(true);
  });

  it('a screenshot of the tab on show in a window needs no debugger; a background tab, a full page or a minimised window do', async () => {
    const t = setup();
    t.tab.active = true;
    expect(await t.run('screenshot_tab', { tabId: 1 })).toEqual(['[image]', JSON.stringify({ tabId: 1, path: 'visible', fullPage: false })]);
    expect(t.b.tabs.captureVisibleTab).toHaveBeenCalledTimes(1);
    expect(t.dbg.attach).not.toHaveBeenCalled();
    t.handlers['Page.captureScreenshot'] = () => ({ data: 'AAAA' });
    t.handlers['Page.getLayoutMetrics'] = () => ({ cssContentSize: { width: 800, height: 3000 } });
    await t.run('screenshot_tab', { tabId: 1, fullPage: true });
    expect(t.dbg.attach).toHaveBeenCalledTimes(1);
    expect(t.b.tabs.captureVisibleTab).toHaveBeenCalledTimes(1);
    const minimised = setup();
    minimised.tab.active = true;
    minimised.b.windows.get.mockResolvedValue({ state: 'minimized' });
    minimised.handlers['Page.captureScreenshot'] = () => ({ data: 'AAAA' });
    await minimised.run('screenshot_tab', { tabId: 1 });
    expect(minimised.b.tabs.captureVisibleTab).not.toHaveBeenCalled();
    expect(minimised.methods()).toContain('Page.captureScreenshot');
    const background = setup();
    background.handlers['Page.captureScreenshot'] = () => ({ data: 'AAAA' });
    await background.run('screenshot_tab', { tabId: 1 });
    expect(background.b.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });

  it('back and forward go to the exact history entry, after the service-worker check of a container tab', async () => {
    const t = setup({ container: 'c1' });
    t.handlers['Page.getNavigationHistory'] = () => ({ currentIndex: 1, entries: [{ id: 11, url: 'https://a.test/one' }, { id: 12, url: 'https://a.test/two' }] });
    await t.run('navigate_back', { tabId: 1, wait: false });
    expect(t.facet.prepareNavigation).toHaveBeenCalledWith('https://a.test/one');
    expect(t.calls.find((c) => c.method === 'Page.navigateToHistoryEntry')!.params).toEqual({ entryId: 11 });
    await expect(t.run('navigate_forward', { tabId: 1, wait: false })).rejects.toThrow(/no next page/);
    expect(t.b.tabs.goForward).not.toHaveBeenCalled();
  });

  it('reload prepares a container tab like every other navigation', async () => {
    const t = setup({ container: 'c1' });
    await t.run('reload', { tabId: 1, wait: false, bypassCache: true });
    expect(t.facet.prepareNavigation).toHaveBeenCalledWith('https://a.test/page');
    expect(t.b.tabs.reload).toHaveBeenCalledWith(1, { bypassCache: true });
  });

  it('console and network answers: since, filters, and headers only on request', async () => {
    const t = setup();
    await t.run('watch', { tabId: 1, minutes: 1 });
    t.emit('Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'bad' }] });
    t.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'fine' }] });
    t.emit('Network.requestWillBeSent', { requestId: 'r', type: 'Fetch', request: { method: 'GET', url: 'https://a.test/api', headers: { Cookie: 'sid=1' } } });
    const errors = JSON.parse((await t.run('console_messages', { tabId: 1, level: 'error' }))[0]!);
    expect(errors.messages.map((m: { text: string }) => m.text)).toEqual(['bad']);
    expect(errors.watching).toMatch(/^\d{4}-/);
    expect(JSON.parse((await t.run('console_messages', { tabId: 1, since: errors.next }))[0]!).messages).toEqual([]);
    const plain = JSON.parse((await t.run('network_requests', { tabId: 1, filter: '/api' }))[0]!);
    expect(plain.requests[0]).not.toHaveProperty('requestHeaders');
    const withHeaders = JSON.parse((await t.run('network_requests', { tabId: 1, includeHeaders: true }))[0]!);
    expect(withHeaders.requests[0].requestHeaders).toEqual({ Cookie: '(hidden by SplitSession)' });
    expect(JSON.parse((await t.run('watch', { tabId: 1, stop: true }))[0]!)).toEqual({ tabId: 1, watchingUntil: null });
  });

  it('resize_viewport keeps the session until cleared', async () => {
    const t = setup();
    t.handlers['Runtime.evaluate'] = (p) => (p.expression === '1' ? { result: { value: 1 } } : { result: { value: { w: 390, h: 844 } } });
    expect(JSON.parse((await t.run('resize_viewport', { tabId: 1, width: 390, height: 844 }))[0]!)).toEqual({ tabId: 1, width: 390, height: 844 });
    expect(t.cdp.isPinned(1)).toBe(true);
    expect(JSON.parse((await t.run('resize_viewport', { tabId: 1, clear: true }))[0]!)).toEqual({ tabId: 1, cleared: true });
    expect(t.cdp.isPinned(1)).toBe(false);
    expect(t.methods()).toContain('Emulation.clearDeviceMetricsOverride');
    await expect(t.run('resize_viewport', { tabId: 1, width: 300 })).rejects.toThrow(/give width and height, or clear/);
  });

  it('nothing is attached once the switch is off', async () => {
    const t = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(t.run('snapshot', { tabId: 1 }, { signal: controller.signal })).rejects.toThrow(/switched off/);
    expect(t.methods()).toEqual([]);
  });
});
