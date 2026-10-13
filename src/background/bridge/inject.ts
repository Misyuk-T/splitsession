/**
 * Functions the bridge injects into pages with `scripting.executeScript({func})`. Each one is serialised with
 * `Function.prototype.toString` and runs in the page's process, so they must be SELF-CONTAINED: no imports, no
 * references to anything outside their own body. They return plain data or `{error}`; they never throw for expected
 * problems (a missing element), so the router can report them as tool errors.
 */

export interface PageError {
  error: string;
}

export function pageText(maxChars: number): {
  text: string;
  total: number;
  url: string;
  title: string;
} {
  const text = (document.body?.innerText ??
    document.documentElement?.innerText ??
    "") as string;
  // The title as the page has it: without a mark an older version of the agent-activity display may have left in front of it.
  const title = document.title.replace(
    /^(\[[^\]]*\] )?(?:👁|👀|🤖[◐◓◑◒]?) /u,
    "$1",
  );
  return {
    text: text.slice(0, maxChars),
    total: text.length,
    url: location.href,
    title,
  };
}

export function pageHtml(
  selector: string | null,
  maxChars: number,
): { html: string; total: number; url: string; title: string } | PageError {
  let el: Element | null;
  try {
    el =
      selector === null
        ? document.documentElement
        : document.querySelector(selector);
  } catch (e) {
    return { error: `invalid selector: ${(e as Error).message}` };
  }
  if (!el) return { error: `no element matches "${selector}"` };
  let html = el.outerHTML;
  // The favicon link the agent-activity display may append (a page without an icon) is ours: leave it out.
  const ours = document.querySelector("link[data-facet-agent-icon]");
  if (ours && el.contains(ours)) html = html.replace(ours.outerHTML, "");
  // While the display runs, the page's icon links carry our animation frame in `href`/`type`: serialise the page's own values.
  const tracked = (
    globalThis as unknown as {
      __facetAgentActivity?: {
        icon?: {
          tracked?: Map<
            HTMLLinkElement,
            {
              orig: { href: string | null; type: string | null };
              wrote: { href: string | null; type: string | null };
            }
          >;
        };
      };
    }
  ).__facetAgentActivity?.icon?.tracked;
  if (tracked) {
    for (const [node, rec] of tracked) {
      if (!el.contains(node)) continue;
      const own = node.cloneNode(false) as HTMLLinkElement;
      if (node.getAttribute("href") === rec.wrote.href)
        rec.orig.href === null
          ? own.removeAttribute("href")
          : own.setAttribute("href", rec.orig.href);
      if (node.getAttribute("type") === rec.wrote.type)
        rec.orig.type === null
          ? own.removeAttribute("type")
          : own.setAttribute("type", rec.orig.type);
      html = html.replace(node.outerHTML, () => own.outerHTML);
    }
  }
  // The agent-activity overlay (a closed shadow root on <html>) is ours, not the page's: leave its element out.
  const overlay = document.querySelector(
    "facet-agent-overlay[data-facet-agent]",
  );
  if (overlay && el.contains(overlay))
    html = html.replace(overlay.outerHTML, "");
  // Same for the mark in front of the <title> (it is written into the page's own title element).
  if (el === document.documentElement)
    html = html.replace(
      /(<title[^>]*>)(\[[^\]]*\] )?(?:👁|👀|🤖[◐◓◑◒]?) /u,
      "$1$2",
    );
  const title = document.title.replace(
    /^(\[[^\]]*\] )?(?:👁|👀|🤖[◐◓◑◒]?) /u,
    "$1",
  );
  return {
    html: html.slice(0, maxChars),
    total: html.length,
    url: location.href,
    title,
  };
}

/** Where the agent acted, in viewport coordinates (the router turns it into a pulse and leaves it out of the result). */
export interface PageRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function pageClick(
  selector: string | null,
  x: number | null,
  y: number | null,
): { clicked: string; rect: PageRect | null } | PageError {
  let el: Element | null;
  let cx: number;
  let cy: number;
  let rect: PageRect | null = null;
  if (selector !== null) {
    try {
      el = document.querySelector(selector);
    } catch (e) {
      return { error: `invalid selector: ${(e as Error).message}` };
    }
    if (!el) return { error: `no element matches "${selector}"` };
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    cx = r.left + r.width / 2;
    cy = r.top + r.height / 2;
    rect = { x: r.left, y: r.top, w: r.width, h: r.height };
  } else if (x !== null && y !== null) {
    el = document.elementFromPoint(x, y);
    if (!el)
      return {
        error: `no element at (${x}, ${y}); the viewport is ${innerWidth}x${innerHeight}`,
      };
    cx = x;
    cy = y;
    const r = el.getBoundingClientRect();
    rect = { x: r.left, y: r.top, w: r.width, h: r.height };
  } else {
    return { error: "give a selector, or both x and y" };
  }
  const init = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: cx,
    clientY: cy,
    button: 0,
  };
  el.dispatchEvent(
    new PointerEvent("pointerdown", {
      ...init,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
    }),
  );
  el.dispatchEvent(new MouseEvent("mousedown", init));
  if (el instanceof HTMLElement) el.focus({ preventScroll: true });
  el.dispatchEvent(
    new PointerEvent("pointerup", {
      ...init,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
    }),
  );
  el.dispatchEvent(new MouseEvent("mouseup", init));
  if (el instanceof HTMLElement) el.click();
  else el.dispatchEvent(new MouseEvent("click", init));
  const id = el.id ? `#${el.id}` : "";
  return { clicked: `<${el.tagName.toLowerCase()}${id}>`, rect };
}

export function pageType(
  selector: string,
  text: string,
  append: boolean,
  submit: boolean,
): { typed: number; rect: PageRect | null } | PageError {
  let el: Element | null;
  try {
    el = document.querySelector(selector);
  } catch (e) {
    return { error: `invalid selector: ${(e as Error).message}` };
  }
  if (!el) return { error: `no element matches "${selector}"` };
  el.scrollIntoView({ block: "center", inline: "center" });
  const box = el.getBoundingClientRect();
  const rect: PageRect = {
    x: box.left,
    y: box.top,
    w: box.width,
    h: box.height,
  };
  if (el instanceof HTMLElement) el.focus({ preventScroll: true });
  const fire = (target: Element) => {
    target.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "insertText",
        data: text,
      }),
    );
    target.dispatchEvent(new Event("change", { bubbles: true }));
  };
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const proto =
      el instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (!setter) return { error: "this element has no settable value" };
    setter.call(el, append ? el.value + text : text);
    fire(el);
  } else if (el instanceof HTMLElement && el.isContentEditable) {
    el.textContent = append ? (el.textContent ?? "") + text : text;
    fire(el);
  } else {
    return {
      error: `<${el.tagName.toLowerCase()}> is not a text field (input, textarea or contenteditable)`,
    };
  }
  if (submit) {
    const key = {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    };
    const notCancelled = el.dispatchEvent(new KeyboardEvent("keydown", key));
    el.dispatchEvent(new KeyboardEvent("keypress", key));
    const form = (el as HTMLInputElement).form ?? el.closest("form");
    if (notCancelled && form) {
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.submit();
    }
    el.dispatchEvent(new KeyboardEvent("keyup", key));
  }
  return { typed: text.length, rect };
}

export function pageScroll(
  selector: string | null,
  to: string | null,
  dx: number,
  dy: number,
): { x: number; y: number; maxY: number } | PageError {
  const root = document.scrollingElement ?? document.documentElement;
  if (selector !== null) {
    let el: Element | null;
    try {
      el = document.querySelector(selector);
    } catch (e) {
      return { error: `invalid selector: ${(e as Error).message}` };
    }
    if (!el) return { error: `no element matches "${selector}"` };
    el.scrollIntoView({ block: "center", inline: "nearest" });
  } else if (to === "top") {
    window.scrollTo(window.scrollX, 0);
  } else if (to === "bottom") {
    window.scrollTo(window.scrollX, root.scrollHeight);
  } else {
    window.scrollBy(dx, dy);
  }
  return {
    x: Math.round(window.scrollX),
    y: Math.round(window.scrollY),
    maxY: Math.max(0, Math.round(root.scrollHeight - innerHeight)),
  };
}
