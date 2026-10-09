/**
 * Functions the bridge injects into pages with `scripting.executeScript({func})`. Each one is serialised with
 * `Function.prototype.toString` and runs in the page's process, so they must be SELF-CONTAINED: no imports, no
 * references to anything outside their own body. They return plain data or `{error}`; they never throw for expected
 * problems (a missing element), so the router can report them as tool errors.
 */

export interface PageError {
  error: string;
}

export function pageText(maxChars: number): { text: string; total: number; url: string; title: string } {
  const text = (document.body?.innerText ?? document.documentElement?.innerText ?? '') as string;
  return { text: text.slice(0, maxChars), total: text.length, url: location.href, title: document.title };
}

export function pageHtml(selector: string | null, maxChars: number): { html: string; total: number; url: string; title: string } | PageError {
  let el: Element | null;
  try {
    el = selector === null ? document.documentElement : document.querySelector(selector);
  } catch (e) {
    return { error: `invalid selector: ${(e as Error).message}` };
  }
  if (!el) return { error: `no element matches "${selector}"` };
  const html = el.outerHTML;
  return { html: html.slice(0, maxChars), total: html.length, url: location.href, title: document.title };
}

export function pageClick(selector: string | null, x: number | null, y: number | null): { clicked: string } | PageError {
  let el: Element | null;
  let cx: number;
  let cy: number;
  if (selector !== null) {
    try {
      el = document.querySelector(selector);
    } catch (e) {
      return { error: `invalid selector: ${(e as Error).message}` };
    }
    if (!el) return { error: `no element matches "${selector}"` };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    cx = r.left + r.width / 2;
    cy = r.top + r.height / 2;
  } else if (x !== null && y !== null) {
    el = document.elementFromPoint(x, y);
    if (!el) return { error: `no element at (${x}, ${y}); the viewport is ${innerWidth}x${innerHeight}` };
    cx = x;
    cy = y;
  } else {
    return { error: 'give a selector, or both x and y' };
  }
  const init = { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, button: 0 };
  el.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
  el.dispatchEvent(new MouseEvent('mousedown', init));
  if (el instanceof HTMLElement) el.focus({ preventScroll: true });
  el.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
  el.dispatchEvent(new MouseEvent('mouseup', init));
  if (el instanceof HTMLElement) el.click();
  else el.dispatchEvent(new MouseEvent('click', init));
  const id = el.id ? `#${el.id}` : '';
  return { clicked: `<${el.tagName.toLowerCase()}${id}>` };
}

export function pageType(selector: string, text: string, append: boolean, submit: boolean): { typed: number } | PageError {
  let el: Element | null;
  try {
    el = document.querySelector(selector);
  } catch (e) {
    return { error: `invalid selector: ${(e as Error).message}` };
  }
  if (!el) return { error: `no element matches "${selector}"` };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  if (el instanceof HTMLElement) el.focus({ preventScroll: true });
  const fire = (target: Element) => {
    target.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
  };
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (!setter) return { error: 'this element has no settable value' };
    setter.call(el, append ? el.value + text : text);
    fire(el);
  } else if (el instanceof HTMLElement && el.isContentEditable) {
    el.textContent = append ? (el.textContent ?? '') + text : text;
    fire(el);
  } else {
    return { error: `<${el.tagName.toLowerCase()}> is not a text field (input, textarea or contenteditable)` };
  }
  if (submit) {
    const key = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    const notCancelled = el.dispatchEvent(new KeyboardEvent('keydown', key));
    el.dispatchEvent(new KeyboardEvent('keypress', key));
    const form = (el as HTMLInputElement).form ?? el.closest('form');
    if (notCancelled && form) {
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
    }
    el.dispatchEvent(new KeyboardEvent('keyup', key));
  }
  return { typed: text.length };
}

export function pageScroll(selector: string | null, to: string | null, dx: number, dy: number): { x: number; y: number; maxY: number } | PageError {
  const root = document.scrollingElement ?? document.documentElement;
  if (selector !== null) {
    let el: Element | null;
    try {
      el = document.querySelector(selector);
    } catch (e) {
      return { error: `invalid selector: ${(e as Error).message}` };
    }
    if (!el) return { error: `no element matches "${selector}"` };
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
  } else if (to === 'top') {
    window.scrollTo(window.scrollX, 0);
  } else if (to === 'bottom') {
    window.scrollTo(window.scrollX, root.scrollHeight);
  } else {
    window.scrollBy(dx, dy);
  }
  return { x: Math.round(window.scrollX), y: Math.round(window.scrollY), maxY: Math.max(0, Math.round(root.scrollHeight - innerHeight)) };
}

export type RunResult =
  | { ok: true; json: string | null; truncated: boolean }
  | { ok: false; kind: 'csp' | 'error'; name: string; message: string };

/**
 * `code` is a function body, run as `new Function`. Under a page CSP without 'unsafe-eval' (MAIN world) or under the
 * extension's policy (ISOLATED world) the constructor throws an EvalError, reported as kind 'csp'.
 */
export async function pageRun(code: string, maxChars: number): Promise<RunResult> {
  let value: unknown;
  try {
    const fn = new Function(`return (async () => {\n${code}\n})();`);
    value = await fn();
  } catch (e) {
    const err = e as { name?: string; message?: string };
    const message = String(err?.message ?? e);
    const csp = err?.name === 'EvalError' || /unsafe-eval|Content Security Policy/i.test(message);
    return { ok: false, kind: csp ? 'csp' : 'error', name: String(err?.name ?? 'Error'), message };
  }
  if (value === undefined) return { ok: true, json: null, truncated: false };
  const seen = new WeakSet<object>();
  let json: string;
  try {
    json =
      JSON.stringify(value, (_key, v) => {
        if (typeof v === 'bigint') return `${v}n`;
        if (typeof v === 'function') return `[Function ${v.name || 'anonymous'}]`;
        if (typeof v === 'symbol') return String(v);
        if (typeof Node !== 'undefined' && v instanceof Node) return `[${v.nodeName}]`;
        if (typeof v === 'object' && v !== null) {
          if (seen.has(v)) return '[Circular]';
          seen.add(v);
        }
        return v;
      }) ?? 'null';
  } catch (e) {
    return { ok: false, kind: 'error', name: 'SerializeError', message: `result is not JSON-serialisable: ${(e as Error).message}` };
  }
  return json.length > maxChars ? { ok: true, json: json.slice(0, maxChars), truncated: true } : { ok: true, json, truncated: false };
}
