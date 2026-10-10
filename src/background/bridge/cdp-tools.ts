/**
 * What the agent's "hands" do through CDP: trusted mouse and keyboard input, file inputs, screenshots of background tabs,
 * evaluation under any page CSP. Every function gets an attached `TabSession` from `CdpSessions.use` (the router decides
 * when: the debugger, and with it Chrome's "started debugging this browser" bar, is only used for what a plain script
 * cannot do). Finding elements, focusing, scrolling and waiting are DOM work (page-dom.ts, dom-tools.ts) and need no session.
 *
 * Isolation: nothing here reads or writes cookies or storage, sets headers or intercepts requests, and code from the
 * agent runs only in the page's MAIN world (where Facet's shim answers `document.cookie` with the container's jar). Our
 * own helper functions run in a CDP isolated world: they only look at the DOM.
 */
import { CdpError, type TabSession } from './cdp';
import { charEvents, modifierMask, parseShortcut, shortcutEvents, type KeyEvent, type Modifier } from './keys';

const ISOLATED_WORLD = 'facet-agent';

// ------------------------------------------------------------------ isolated world

interface FrameCache {
  loaderId: string | null;
  frameId: string;
  contextId: number;
}
const isolatedCache = new WeakMap<TabSession, FrameCache>();

/** An execution context of our own in the top frame (the page's scripts cannot interfere with it). */
async function isolatedContext(s: TabSession): Promise<number> {
  const cached = isolatedCache.get(s);
  if (cached && cached.loaderId === s.mainLoaderId) return cached.contextId;
  const tree = await s.send<{ frameTree: { frame: { id: string; loaderId: string } } }>('Page.getFrameTree');
  const frameId = tree.frameTree.frame.id;
  const world = await s.send<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId, worldName: ISOLATED_WORLD, grantUniveralAccess: false });
  s.mainLoaderId = tree.frameTree.frame.loaderId;
  isolatedCache.set(s, { loaderId: s.mainLoaderId, frameId, contextId: world.executionContextId });
  return world.executionContextId;
}

/** Runs `fn(...args)` in our isolated world of the top frame and returns its JSON value. */
async function inIsolated<T>(s: TabSession, fn: string, args: unknown[] = []): Promise<T> {
  let contextId = await isolatedContext(s);
  const call = () =>
    s.send<{ result: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } }>('Runtime.callFunctionOn', {
      functionDeclaration: fn,
      executionContextId: contextId,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
    });
  let r;
  try {
    r = await call();
  } catch (error) {
    // The document changed under the cached context: make a new one, once.
    if (!/context|Cannot find/i.test(String((error as Error).message))) throw error;
    isolatedCache.delete(s);
    contextId = await isolatedContext(s);
    r = await call();
  }
  if (r.exceptionDetails) throw new CdpError(r.exceptionDetails.exception?.description?.split('\n')[0] ?? r.exceptionDetails.text ?? 'script error');
  return r.result.value as T;
}

// ------------------------------------------------------------------ input

/** One input command, or the dialog it opened (the command itself then waits until the dialog is answered). */
async function input(s: TabSession, method: string, params: object): Promise<'ok' | 'dialog'> {
  if (s.dialog) return 'dialog';
  const stop = new AbortController();
  try {
    const dialog = s.waitFor('Page.javascriptDialogOpening', 60_000, undefined, undefined, stop.signal);
    const done = s.send(method, params, undefined, 60_000).then(() => 'ok' as const);
    done.catch(() => {});
    return await Promise.race([done, dialog.then((d) => (d ? ('dialog' as const) : new Promise<never>(() => {})))]);
  } finally {
    stop.abort();
  }
}

export interface Point {
  x: number;
  y: number;
}

export async function mouseClick(s: TabSession, p: Point, button: 'left' | 'right' | 'middle', clickCount: number, modifiers: Modifier[]): Promise<'ok' | 'dialog'> {
  const mods = modifierMask(modifiers);
  if ((await input(s, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, modifiers: mods })) === 'dialog') return 'dialog';
  for (let i = 1; i <= clickCount; i++) {
    if ((await input(s, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button, clickCount: i, modifiers: mods })) === 'dialog') return 'dialog';
    if ((await input(s, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button, clickCount: i, modifiers: mods })) === 'dialog') return 'dialog';
  }
  return 'ok';
}

export async function mouseMove(s: TabSession, p: Point): Promise<'ok' | 'dialog'> {
  return input(s, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
}

/** Press at `from`, move in steps to `to`, release; an HTML5 drag that Chrome intercepts is completed with drag events. */
export async function mouseDrag(s: TabSession, from: Point, to: Point): Promise<'ok' | 'dialog'> {
  let intercepting = false;
  try {
    await s.send('Input.setInterceptDrags', { enabled: true });
    intercepting = true;
  } catch {
    /* older Chrome: plain mouse events only */
  }
  try {
    const dragData = intercepting ? s.waitFor<{ data: unknown }>('Input.dragIntercepted', 1_500) : Promise.resolve(null);
    if ((await input(s, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y })) === 'dialog') return 'dialog';
    if ((await input(s, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 })) === 'dialog') return 'dialog';
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      if ((await input(s, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })) === 'dialog') return 'dialog';
      if (i === 1 && intercepting) {
        const got = await Promise.race([dragData, new Promise<null>((r) => setTimeout(() => r(null), 120))]);
        if (got) {
          // A native drag started (draggable element): Chrome hands the data to us; finish it with drag events.
          await s.send('Input.dispatchDragEvent', { type: 'dragEnter', x: to.x, y: to.y, data: got.data });
          await s.send('Input.dispatchDragEvent', { type: 'dragOver', x: to.x, y: to.y, data: got.data });
          await s.send('Input.dispatchDragEvent', { type: 'drop', x: to.x, y: to.y, data: got.data });
          return input(s, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 });
        }
      }
    }
    return input(s, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 });
  } finally {
    if (intercepting) await s.send('Input.setInterceptDrags', { enabled: false }).catch(() => {});
  }
}

export async function keys(s: TabSession, events: KeyEvent[]): Promise<'ok' | 'dialog'> {
  for (const e of events) if ((await input(s, 'Input.dispatchKeyEvent', e)) === 'dialog') return 'dialog';
  return 'ok';
}

export async function pressShortcut(s: TabSession, key: string, isMac: boolean, repeat = 1): Promise<'ok' | 'dialog'> {
  let parsed;
  try {
    parsed = parseShortcut(key, isMac);
  } catch (error) {
    throw new CdpError((error as Error).message);
  }
  const events = shortcutEvents(parsed, isMac);
  for (let i = 0; i < repeat; i++) if ((await keys(s, events)) === 'dialog') return 'dialog';
  return 'ok';
}

/**
 * Types like a user into the field that has the focus (page-dom.ts `prepareType` focused it and selected its content, or put the
 * caret at the end): `Input.insertText` for the whole text, or one key press per character with `slowly`.
 */
export async function typeText(s: TabSession, text: string, state: { empty: boolean }, o: { append: boolean; slowly: boolean; submit: boolean; isMac: boolean }): Promise<'ok' | 'dialog'> {
  if (text === '') {
    if (!o.append && !state.empty && (await pressShortcut(s, 'Backspace', o.isMac)) === 'dialog') return 'dialog';
  } else if (o.slowly) {
    for (const c of text) if ((await keys(s, charEvents(c))) === 'dialog') return 'dialog';
  } else if ((await input(s, 'Input.insertText', { text })) === 'dialog') return 'dialog';
  if (o.submit) return pressShortcut(s, 'Enter', o.isMac);
  return 'ok';
}

/** Finds the element carrying the marker attribute (page-dom.ts `mark`) in the top document or a same-origin frame. */
const findMarkedFn = `function (name) {
  const search = (doc, depth) => {
    const hit = doc.querySelector('[' + name + ']');
    if (hit) return hit;
    if (depth > 4) return null;
    for (const f of doc.querySelectorAll('iframe, frame')) {
      let inner = null;
      try { inner = f.contentDocument; } catch (e) {}
      const found = inner && search(inner, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return search(document, 0);
}`;

/** Hands local files to the <input type="file"> that carries the marker attribute. */
export async function setFilesByMarker(s: TabSession, marker: string, paths: string[]): Promise<void> {
  const contextId = await isolatedContext(s);
  const found = await s.send<{ result: { subtype?: string; objectId?: string } }>('Runtime.callFunctionOn', {
    functionDeclaration: findMarkedFn,
    executionContextId: contextId,
    arguments: [{ value: marker }],
    objectGroup: 'facet-agent',
  });
  const objectId = found.result.subtype === 'null' ? undefined : found.result.objectId;
  if (!objectId) throw new CdpError('that file input is inside a frame of another site, which Facet cannot hand files to; use the frame\'s page directly');
  try {
    await s.send('DOM.setFileInputFiles', { files: paths, objectId });
  } catch (error) {
    const message = (error as Error).message;
    if (/not allowed/i.test(message)) {
      throw new CdpError('Chrome lets an extension hand local files to a page only when "Allow access to file URLs" is on for it: chrome://extensions > Facet > Details. Ask the user to switch it on.');
    }
    throw new CdpError(`could not set the files: ${message}`);
  } finally {
    await s.send('Runtime.releaseObjectGroup', { objectGroup: 'facet-agent' }).catch(() => {});
  }
}

// ------------------------------------------------------------------ run_js

export type EvalOutcome = { ok: true; json: string | null; truncated: boolean } | { ok: false; name: string; message: string };

const serializeFn = `function (maxChars) {
  const seen = new WeakSet();
  let json;
  try {
    json = JSON.stringify(this, (key, v) => {
      if (typeof v === 'bigint') return v + 'n';
      if (typeof v === 'function') return '[Function ' + (v.name || 'anonymous') + ']';
      if (typeof v === 'symbol') return String(v);
      if (typeof Node !== 'undefined' && v instanceof Node) return '[' + v.nodeName + ']';
      if (typeof v === 'object' && v !== null) { if (seen.has(v)) return '[Circular]'; seen.add(v); }
      return v;
    });
  } catch (e) {
    return { error: 'result is not JSON-serialisable: ' + e.message };
  }
  if (json === undefined) json = 'null';
  return json.length > maxChars ? { json: json.slice(0, maxChars), truncated: true } : { json, truncated: false };
}`;

/** `code` without trailing semicolons and blank space, or null when nothing is left: the candidate for "a bare expression". */
export function bareExpression(code: string): string | null {
  const expr = code.trim().replace(/[;\s]+$/, '');
  return expr === '' ? null : expr;
}

type EvalResponse = { result: RemoteObject; exceptionDetails?: { exception?: RemoteObject; text?: string; stackTrace?: unknown } };

/** A syntax error of the code itself (nothing ran), as opposed to a SyntaxError that running code threw (`JSON.parse('x')`). */
function isCompileError(r: EvalResponse): boolean {
  const d = r.exceptionDetails;
  const ex = d?.exception;
  return !!d && !d.stackTrace && ex?.className === 'SyntaxError' && !/\n\s+at /.test(ex.description ?? '');
}

/**
 * Evaluates `code` in the page's MAIN world; CDP evaluation is not subject to the page's CSP. `code` is a bare expression
 * (`document.title`, `({a: 1})`; its value comes back) or a function body (`return` gives the value back). Expression
 * first: when Chrome cannot compile the code as one (a compile error, so nothing has run), it is run as a body.
 */
export async function evaluate(s: TabSession, code: string, o: { awaitPromise: boolean; returnByValue: boolean; maxChars: number }): Promise<EvalOutcome> {
  const wrap = (body: string) => (o.awaitPromise ? `(async () => {\n${body}\n})()` : `(() => {\n${body}\n})()`);
  const expr = bareExpression(code);
  const group = 'facet-run';
  try {
    const run = (expression: string) =>
      s.send<EvalResponse>('Runtime.evaluate', { expression, awaitPromise: o.awaitPromise, returnByValue: false, userGesture: true, objectGroup: group, replMode: false }, undefined, 28_000);
    let r = await run(wrap(expr === null ? code : `return (\n${expr}\n)`));
    if (expr !== null && isCompileError(r)) r = await run(wrap(code));
    if (r.exceptionDetails) {
      const ex = r.exceptionDetails.exception;
      const first = (ex?.description ?? r.exceptionDetails.text ?? 'Error').split('\n')[0]!;
      const m = /^([A-Za-z]*Error|[A-Z][A-Za-z]+): (.*)$/s.exec(first);
      if (m) return { ok: false, name: m[1]!, message: m[2]! };
      if (ex && ex.type !== 'object') return { ok: false, name: 'Uncaught', message: remotePreview(ex) };
      return { ok: false, name: ex?.className ?? 'Error', message: first };
    }
    const v = r.result;
    if (v.type === 'undefined') return { ok: true, json: null, truncated: false };
    if (!o.returnByValue) return { ok: true, json: JSON.stringify(remotePreview(v)), truncated: false };
    if (v.objectId) {
      const out = await s.send<{ result: { value: { json?: string; truncated?: boolean; error?: string } } }>('Runtime.callFunctionOn', {
        functionDeclaration: serializeFn,
        objectId: v.objectId,
        arguments: [{ value: o.maxChars }],
        returnByValue: true,
      });
      const value = out.result.value;
      if (value.error) return { ok: false, name: 'SerializeError', message: value.error };
      return { ok: true, json: value.json ?? 'null', truncated: !!value.truncated };
    }
    const json = v.unserializableValue !== undefined ? JSON.stringify(v.unserializableValue) : (JSON.stringify(v.value) ?? 'null');
    return json.length > o.maxChars ? { ok: true, json: json.slice(0, o.maxChars), truncated: true } : { ok: true, json, truncated: false };
  } finally {
    await s.send('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => {});
  }
}

interface RemoteObject {
  type: string;
  subtype?: string;
  className?: string;
  description?: string;
  value?: unknown;
  unserializableValue?: string;
  objectId?: string;
}

function remotePreview(v: RemoteObject): string {
  if (v.value !== undefined) return typeof v.value === 'string' ? v.value : JSON.stringify(v.value);
  if (v.unserializableValue !== undefined) return v.unserializableValue;
  return v.description ?? v.className ?? v.type;
}

// ------------------------------------------------------------------ screenshots

export interface Shot {
  data: string;
  path: 'background' | 'screencast' | 'activated' | 'visible';
  fullPage: boolean;
  clipped?: boolean;
}

const MAX_FULL_PAGE = 16_384;

/** Captures the tab without activating it when Chrome can. `activate` is the last resort (switches tabs for a moment). */
export async function capture(
  s: TabSession,
  o: { format: 'png' | 'jpeg'; quality: number; fullPage: boolean; activate: () => Promise<() => Promise<void>> },
): Promise<Shot> {
  const params: Record<string, unknown> = { format: o.format, ...(o.format === 'jpeg' ? { quality: o.quality } : {}), fromSurface: true };
  let clipped = false;
  if (o.fullPage) {
    const m = await s.send<{ cssContentSize?: { width: number; height: number }; contentSize: { width: number; height: number } }>('Page.getLayoutMetrics');
    const size = m.cssContentSize ?? m.contentSize;
    const height = Math.min(Math.ceil(size.height), MAX_FULL_PAGE);
    clipped = size.height > MAX_FULL_PAGE;
    params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height, scale: 1 };
    params.captureBeyondViewport = true;
  }
  const result = (shot: string, path: Shot['path']): Shot => ({ data: shot, path, fullPage: o.fullPage, ...(clipped ? { clipped } : {}) });

  const direct = await s.send<{ data: string }>('Page.captureScreenshot', params, undefined, 8_000).catch(() => null);
  if (direct && !(await looksBlank(s, direct.data, o.format))) return result(direct.data, 'background');

  if (!o.fullPage) {
    const frame = await screencastFrame(s, o.format, o.quality);
    if (frame && !(await looksBlank(s, frame, o.format))) return result(frame, 'screencast');
  }

  const restore = await o.activate();
  try {
    await new Promise((r) => setTimeout(r, 250));
    const shown = await s.send<{ data: string }>('Page.captureScreenshot', params, undefined, 8_000);
    return result(shown.data, 'activated');
  } finally {
    await restore();
  }
}

async function screencastFrame(s: TabSession, format: 'png' | 'jpeg', quality: number): Promise<string | null> {
  const next = s.waitFor<{ data: string; sessionId: number }>('Page.screencastFrame', 2_500);
  try {
    await s.send('Page.startScreencast', { format, quality, everyNthFrame: 1 });
  } catch {
    return null;
  }
  const frame = await next;
  if (frame) await s.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
  await s.send('Page.stopScreencast').catch(() => {});
  return frame?.data ?? null;
}

/** A picture of one flat colour of a page that does show something: what Chrome hands back for a tab it did not draw. */
async function looksBlank(s: TabSession, base64: string, format: string): Promise<boolean> {
  const g = globalThis as unknown as { createImageBitmap?: (b: Blob) => Promise<ImageBitmap>; OffscreenCanvas?: typeof OffscreenCanvas };
  if (typeof g.createImageBitmap !== 'function' || typeof g.OffscreenCanvas !== 'function') return false;
  try {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const bitmap = await g.createImageBitmap(new Blob([bytes], { type: `image/${format}` }));
    if (bitmap.width === 0 || bitmap.height === 0) return true;
    // Every pixel at full size (a sparse page is mostly one colour: a thumbnail would wash its text out).
    const scale = Math.min(1, Math.sqrt(8_000_000 / (bitmap.width * bitmap.height)));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new g.OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    ctx.drawImage(bitmap, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    let uniform = true;
    for (let i = 4; i < px.length; i += 4) {
      if (px[i] !== px[0] || px[i + 1] !== px[1] || px[i + 2] !== px[2]) {
        uniform = false;
        break;
      }
    }
    if (!uniform) return false;
    // One colour: blank only if the page has something to show.
    return await inIsolated<boolean>(s, `function () { const b = document.body; return !!b && ((b.innerText || '').trim().length > 0 || document.images.length > 0); }`).catch(() => false);
  } catch {
    return false;
  }
}
