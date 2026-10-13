/* eslint-disable @typescript-eslint/no-explicit-any -- this is injected, self-contained code that walks page nodes of any realm, so it is duck-typed on purpose (no instanceof, no imports) */
/**
 * The DOM side of the agent's read-only and focus-only tools. `pageDom` is injected with `scripting.executeScript`
 * (ISOLATED world, one frame per call), so it must be SELF-CONTAINED like the functions in inject.ts: no imports, nothing
 * outside its own body, and no `instanceof` on page nodes (an iframe's nodes belong to another realm).
 *
 * Why not the debugger: Chrome shows a "SplitSession started debugging this browser" bar for as long as `chrome.debugger` is
 * attached, and the page content jumps down and up with it. Reading a page (`snapshot`) and locating, focusing, scrolling to or
 * waiting for an element need nothing more than the DOM, so they live here; only trusted input, uploads, `run_js`,
 * background screenshots, dialogs, watch and the viewport override use the debugger (router.ts decides).
 *
 * Refs: `snapshot` gives every element it shows a number in a registry that lives in this frame's isolated world
 * (`__facetAgentRefs`: ids -> WeakRef, so nothing is kept alive, and no attribute, id or class is ever added to the page).
 * The registry belongs to the document: a navigation starts an empty one with a new `token`, and a ref from the old
 * document is refused instead of hitting something else. The background maps ids to the `e12` refs the agent sees
 * (dom-tools.ts).
 *
 * The tree it returns is the shape of Chrome's accessibility tree nodes, so snapshot.ts renders it the same way it
 * rendered the real AX tree: roles from `role` and the tag, names from `aria-labelledby`, `aria-label`, labels, `alt`, the
 * content and `title`; states (checked, expanded, disabled, level ...) from ARIA and the element's properties. It is an
 * approximation of the accessible-name algorithm, not Chrome's: see docs/agents.md.
 */

export type DomTarget = { id: number; token: string } | { selector: string };

export type DomCommand =
  | { op: "snapshot" }
  /** The middle of the element's box in the frame's viewport, after scrolling it into view when it is not (or `scroll` is false). */
  | { op: "locate"; target: DomTarget; scroll: boolean }
  /** Where an <iframe>'s content starts in the frame's viewport. */
  | { op: "owner"; target: DomTarget }
  | { op: "prepareType"; target: DomTarget; append: boolean }
  | { op: "focus"; target: DomTarget }
  | { op: "select"; target: DomTarget; values: string[] }
  | { op: "mark"; target: DomTarget; name: string }
  | { op: "unmark"; name: string }
  | { op: "scrollTo"; target: DomTarget }
  | {
      op: "check";
      text?: string;
      textGone?: string;
      target?: DomTarget;
      state?: "visible" | "hidden";
    }
  | { op: "at"; x: number; y: number };

export interface DomRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A node in the accessibility-tree shape snapshot.ts renders. */
export interface DomAxNode {
  nodeId: string;
  parentId?: string;
  role: { value: string };
  name?: { value: string };
  value?: { value: string };
  properties?: Array<{ name: string; value: { value: unknown } }>;
  childIds: string[];
  backendDOMNodeId?: number;
}

export interface DomSnapshotResult {
  token: string;
  url: string;
  title: string;
  /** Node lists by local frame key: 'main' is this frame's document, 'frame:N' a same-origin <iframe> inside it. */
  frames: Record<string, DomAxNode[]>;
  /** The <iframe> nodes: their registry id and the local frame key of their document (null: another origin, read separately). */
  iframes: Array<{
    frame: string;
    id: number;
    child: string | null;
    src: string;
  }>;
  /** Addresses of the same-origin documents read in this call. */
  reachable: string[];
  truncated: boolean;
}

export type DomError = { error: string };
/** The ref belongs to another document than the one in the frame now. */
export type DomStale = { stale: true };

export function pageDom(cmd: DomCommand): any {
  const KEY = "__facetAgentRefs";
  const holder = globalThis as unknown as Record<string, any>;
  const MAX_NODES = 25_000;
  const MAX_FRAMES = 40;

  // ---------------------------------------------------------------- small helpers
  const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
  const label = (el: Element): string =>
    `<${el.localName}${el.id ? `#${el.id}` : ""}>`;
  const winOf = (el: Node): any =>
    (el.ownerDocument ?? (el as Document)).defaultView ?? window;
  const styleOf = (el: Element): CSSStyleDeclaration =>
    winOf(el).getComputedStyle(el);
  const attr = (el: Element, name: string): string =>
    el.getAttribute(name) ?? "";
  const fail = (error: string): DomError => ({ error });

  const registry = (create: boolean): any => {
    let reg = holder[KEY];
    if (!reg && create) {
      reg = holder[KEY] = {
        token: `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`,
        next: 1,
        byEl: new WeakMap<Element, number>(),
        byId: new Map<number, WeakRef<Element>>(),
        marked: null,
      };
    }
    return reg;
  };
  const idOf = (reg: any, el: Element): number => {
    let id = reg.byEl.get(el);
    if (id === undefined) {
      id = reg.next++;
      reg.byEl.set(el, id);
      reg.byId.set(id, new WeakRef(el));
    }
    return id;
  };

  /** The element of a target, or the error / stale marker to hand back. */
  const find = (t: DomTarget): { el: Element } | DomError | DomStale => {
    if ("selector" in t) {
      let el: Element | null;
      try {
        el = document.querySelector(t.selector);
      } catch (e) {
        return fail(`invalid selector: ${(e as Error).message}`);
      }
      return el ? { el } : fail(`no element matches "${t.selector}"`);
    }
    const reg = registry(false);
    if (!reg || reg.token !== t.token) return { stale: true };
    const el: Element | undefined = reg.byId.get(t.id)?.deref();
    if (!el || !el.isConnected)
      return fail("that element is no longer in the page; take a new snapshot");
    return { el };
  };

  // ---------------------------------------------------------------- geometry
  /** Offset of a (same-origin) nested document's viewport in this frame's viewport. */
  const nestedOffset = (el: Element): { x: number; y: number } => {
    let x = 0;
    let y = 0;
    let w: any = winOf(el);
    for (let i = 0; i < 10 && w && w !== window; i++) {
      const fe: Element | null = w.frameElement;
      if (!fe) break;
      const r = fe.getBoundingClientRect();
      const cs = styleOf(fe);
      x +=
        r.left +
        (fe as HTMLElement).clientLeft +
        parseFloat(cs.paddingLeft || "0");
      y +=
        r.top +
        (fe as HTMLElement).clientTop +
        parseFloat(cs.paddingTop || "0");
      w = w.parent;
    }
    return { x, y };
  };
  const bestBox = (
    el: Element,
  ): { l: number; t: number; w: number; h: number } | null => {
    let best: { l: number; t: number; w: number; h: number } | null = null;
    for (const r of Array.from(el.getClientRects())) {
      if (r.width * r.height > (best ? best.w * best.h : 0.5))
        best = { l: r.left, t: r.top, w: r.width, h: r.height };
    }
    return best;
  };
  /** Scrolls the element into view unless its box is inside the viewport already. */
  const reveal = (el: Element): void => {
    const b = bestBox(el);
    const w = winOf(el);
    if (
      b &&
      b.t >= 0 &&
      b.l >= 0 &&
      b.t + b.h <= w.innerHeight &&
      b.l + b.w <= w.innerWidth
    )
      return;
    el.scrollIntoView({
      block: "center",
      inline: "center",
      behavior: "instant",
    } as ScrollIntoViewOptions);
  };
  /** The element's box in this frame's viewport. */
  const boxOf = (
    el: Element,
    scroll: boolean,
  ): { rect: DomRect; x: number; y: number } | DomError => {
    if (scroll) reveal(el);
    const b = bestBox(el);
    if (!b)
      return fail(
        el.getClientRects().length === 0
          ? "the element is not visible (it has no box on the page)"
          : "the element is not visible (its box is empty)",
      );
    const o = nestedOffset(el);
    const rect = { x: b.l + o.x, y: b.t + o.y, w: b.w, h: b.h };
    return { rect, x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
  };

  // ---------------------------------------------------------------- the simple ops
  const withEl = (t: DomTarget, run: (el: Element) => any): any => {
    const f = find(t);
    if ("el" in f) return run(f.el);
    return f;
  };
  const rectOf = (el: Element): DomRect | null => {
    const r = boxOf(el, false);
    return "rect" in r ? r.rect : null;
  };

  if (cmd.op === "locate") {
    return withEl(cmd.target, (el) => {
      const b = boxOf(el, cmd.scroll);
      return "rect" in b
        ? { label: label(el), rect: b.rect, x: b.x, y: b.y }
        : b;
    });
  }
  if (cmd.op === "owner") {
    return withEl(cmd.target, (el) => {
      const r = el.getBoundingClientRect();
      const cs = styleOf(el);
      const o = nestedOffset(el);
      return {
        x:
          r.left +
          (el as HTMLElement).clientLeft +
          parseFloat(cs.paddingLeft || "0") +
          o.x,
        y:
          r.top +
          (el as HTMLElement).clientTop +
          parseFloat(cs.paddingTop || "0") +
          o.y,
      };
    });
  }
  if (cmd.op === "at") {
    if (!(
      cmd.x >= 0 &&
      cmd.y >= 0 &&
      cmd.x < innerWidth &&
      cmd.y < innerHeight
    ))
      return fail(
        `no element at (${cmd.x}, ${cmd.y}); the viewport is ${innerWidth}x${innerHeight}`,
      );
    const el = document.elementFromPoint(cmd.x, cmd.y);
    if (!el) return fail(`no element at (${cmd.x}, ${cmd.y})`);
    const r = el.getBoundingClientRect();
    return {
      label: label(el),
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
    };
  }
  if (cmd.op === "focus") {
    return withEl(cmd.target, (el) => {
      reveal(el);
      try {
        (el as HTMLElement).focus();
      } catch {
        return fail("could not focus that element");
      }
      return { rect: rectOf(el) };
    });
  }
  if (cmd.op === "scrollTo") {
    return withEl(cmd.target, (el) => {
      el.scrollIntoView({
        block: "center",
        inline: "nearest",
        behavior: "instant",
      } as ScrollIntoViewOptions);
      const root = document.scrollingElement ?? document.documentElement;
      return {
        x: Math.round(scrollX),
        y: Math.round(scrollY),
        maxY: Math.max(0, Math.round(root.scrollHeight - innerHeight)),
      };
    });
  }
  if (cmd.op === "prepareType") {
    return withEl(cmd.target, (el: any) => {
      const tag = el.localName;
      const textTypes = [
        "text",
        "search",
        "url",
        "tel",
        "email",
        "password",
        "number",
      ];
      reveal(el);
      if (tag === "input" || tag === "textarea") {
        if (tag === "input" && !textTypes.includes(el.type))
          return fail(`<input type="${el.type}"> is not a text field`);
        if (el.disabled) return fail("the field is disabled");
        if (el.readOnly) return fail("the field is read-only");
        el.focus({ preventScroll: true });
        if (cmd.append) {
          const n = el.value.length;
          try {
            el.setSelectionRange(n, n);
          } catch {
            /* a type without a selection */
          }
        } else {
          el.select();
        }
        return { empty: el.value === "", rect: rectOf(el) };
      }
      if (el.isContentEditable) {
        el.focus({ preventScroll: true });
        const doc = el.ownerDocument;
        const range = doc.createRange();
        range.selectNodeContents(el);
        if (cmd.append) range.collapse(false);
        const sel = winOf(el).getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return { empty: (el.textContent || "") === "", rect: rectOf(el) };
      }
      return fail(
        `<${tag}> is not a text field (input, textarea or contenteditable)`,
      );
    });
  }
  if (cmd.op === "select") {
    return withEl(cmd.target, (el: any) => {
      if (el.localName !== "select")
        return fail(
          `<${el.localName}> is not a <select>; click custom dropdowns instead`,
        );
      if (el.disabled) return fail("the <select> is disabled");
      const options: any[] = Array.from(el.options);
      const pick = (v: string) =>
        options.find((o) => o.value === v) ||
        options.find((o) => o.label === v || o.text.trim() === v);
      const chosen = cmd.values.map(pick);
      const missing = cmd.values.find((_v, i) => !chosen[i]);
      if (missing !== undefined) {
        const list = options
          .slice(0, 20)
          .map(
            (o) =>
              JSON.stringify(o.value) +
              (o.label !== o.value ? ` (${o.label})` : ""),
          )
          .join(", ");
        return fail(
          `no option ${JSON.stringify(missing)}; the options are ${list}${options.length > 20 ? ", ..." : ""}`,
        );
      }
      if (!el.multiple && chosen.length > 1)
        return fail("this <select> takes one value");
      const rect = rectOf(el);
      el.focus();
      for (const o of options) o.selected = chosen.includes(o);
      el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { selected: chosen.map((o) => o.value), rect };
    });
  }
  if (cmd.op === "mark") {
    return withEl(cmd.target, (el: any) => {
      if (el.localName !== "input" || el.type !== "file")
        return fail(
          `<${el.localName}> is not a file input (<input type="file">)`,
        );
      if (el.disabled) return fail("the file input is disabled");
      const reg = registry(true);
      reg.marked = new WeakRef(el);
      el.setAttribute(cmd.name, "");
      return { multiple: !!el.multiple, rect: rectOf(el) };
    });
  }
  if (cmd.op === "unmark") {
    const el: Element | undefined = registry(false)?.marked?.deref();
    if (el) el.removeAttribute(cmd.name);
    return { ok: true };
  }
  if (cmd.op === "check") {
    if (cmd.text !== undefined || cmd.textGone !== undefined) {
      const needle = (cmd.text ?? cmd.textGone)!;
      const found = !!document.body && document.body.innerText.includes(needle);
      return { ok: cmd.text !== undefined ? found : !found };
    }
    let visible = false;
    if (cmd.target) {
      const f = find(cmd.target);
      if ("stale" in f) return f;
      if ("error" in f) {
        if (
          !("selector" in cmd.target) &&
          /no longer in the page/.test(f.error)
        )
          visible = false;
        else if (
          "selector" in cmd.target &&
          /^no element matches/.test(f.error)
        )
          visible = false;
        else return f;
      } else {
        const el: any = f.el;
        const shown =
          typeof el.checkVisibility === "function"
            ? el.checkVisibility({
                checkOpacity: true,
                checkVisibilityCSS: true,
              })
            : true;
        const r = el.getBoundingClientRect();
        visible = el.isConnected && shown && r.width > 0 && r.height > 0;
      }
    }
    return { ok: cmd.state === "hidden" ? !visible : visible };
  }

  // ---------------------------------------------------------------- snapshot
  const reg = registry(true);
  // Dead entries of an earlier snapshot go.
  for (const [id, ref] of Array.from(reg.byId.entries()) as Array<
    [number, WeakRef<Element>]
  >)
    if (!ref.deref()) reg.byId.delete(id);

  const SKIP = new Set([
    "script",
    "style",
    "noscript",
    "template",
    "head",
    "meta",
    "link",
    "title",
    "base",
    "datalist",
    "facet-agent-overlay",
    "wbr",
  ]);
  const INLINE = new Set([
    "a",
    "b",
    "i",
    "u",
    "em",
    "strong",
    "span",
    "code",
    "small",
    "sub",
    "sup",
    "mark",
    "abbr",
    "time",
    "s",
    "q",
    "cite",
    "label",
    "font",
    "bdi",
    "bdo",
    "kbd",
    "samp",
    "var",
    "data",
  ]);
  const FROM_CONTENT = new Set([
    "button",
    "link",
    "heading",
    "columnheader",
    "rowheader",
    "option",
    "tab",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "treeitem",
    "checkbox",
    "radio",
    "switch",
    "tooltip",
  ]);
  const TEXT_INPUTS = new Set([
    "text",
    "search",
    "url",
    "tel",
    "email",
    "password",
    "number",
    "date",
    "datetime-local",
    "month",
    "week",
    "time",
    "",
  ]);

  const childrenOf = (e: any): Node[] => {
    if (e.shadowRoot) return Array.from(e.shadowRoot.childNodes);
    if (e.localName === "slot" && typeof e.assignedNodes === "function") {
      const assigned = e.assignedNodes({ flatten: true });
      if (assigned.length) return assigned;
    }
    return Array.from(e.childNodes);
  };
  const ariaHidden = (e: Element): boolean => attr(e, "aria-hidden") === "true";

  /** Text of a subtree as a name or label: text nodes, alt, aria-label of descendants; no embedded controls. */
  const textOf = (n: any, depth: number, root: Element | null): string => {
    if (depth > 14) return "";
    if (n.nodeType === 3) return n.data;
    if (n.nodeType !== 1) return "";
    const e = n as Element;
    if (SKIP.has(e.localName)) return "";
    if (e !== root) {
      if (ariaHidden(e)) return "";
      const cs = styleOf(e);
      if (cs.display === "none") return "";
      const al = attr(e, "aria-label");
      if (al) return ` ${al} `;
    }
    if (e.localName === "img") return attr(e, "alt");
    if (
      e.localName === "input" ||
      e.localName === "select" ||
      e.localName === "textarea"
    )
      return "";
    const inner = childrenOf(e)
      .map((k) => textOf(k, depth + 1, root))
      .join("");
    return INLINE.has(e.localName) ? inner : ` ${inner} `;
  };
  const referenced = (el: Element, name: string): string => {
    const ids = attr(el, name).trim();
    if (!ids) return "";
    const root: any = el.getRootNode();
    return norm(
      ids
        .split(/\s+/)
        .map((id) => root.getElementById?.(id) ?? document.getElementById(id))
        .filter(Boolean)
        .map((n: Element) => textOf(n, 0, n))
        .join(" "),
    );
  };
  const labelsOf = (el: any): string =>
    norm(
      Array.from((el.labels ?? []) as ArrayLike<Element>)
        .map((l) => textOf(l, 0, l))
        .join(" "),
    );

  const headingLevel = (el: Element): number => {
    const m = /^h([1-6])$/.exec(el.localName);
    const aria = parseInt(attr(el, "aria-level"), 10);
    return m ? parseInt(m[1]!, 10) : aria > 0 ? aria : 2;
  };
  const roleOf = (el: any): string => {
    const tag: string = el.localName;
    const explicit = attr(el, "role").trim().split(/\s+/)[0]!.toLowerCase();
    if (
      explicit &&
      explicit !== "presentation" &&
      explicit !== "none" &&
      explicit !== "generic"
    )
      return explicit;
    if (explicit === "presentation" || explicit === "none") return "";
    switch (tag) {
      case "a":
      case "area":
        return el.hasAttribute("href") ? "link" : "";
      case "button":
      case "summary":
        return "button";
      case "input": {
        const t = (el.type || "text").toLowerCase();
        if (t === "hidden") return "";
        if (["button", "submit", "reset", "image", "file", "color"].includes(t))
          return "button";
        if (t === "checkbox") return "checkbox";
        if (t === "radio") return "radio";
        if (t === "range") return "slider";
        if (t === "number") return "spinbutton";
        if (t === "search") return "searchbox";
        return "textbox";
      }
      case "textarea":
        return "textbox";
      case "select":
        return el.multiple || el.size > 1 ? "listbox" : "combobox";
      case "option":
        return "option";
      case "optgroup":
      case "fieldset":
      case "details":
      case "address":
        return "group";
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        return "heading";
      case "img":
        return el.hasAttribute("alt") &&
          attr(el, "alt") === "" &&
          !attr(el, "aria-label")
          ? ""
          : "img";
      case "svg":
        return attr(el, "aria-label") ||
          attr(el, "aria-labelledby") ||
          el.querySelector?.(":scope > title")
          ? "img"
          : "";
      case "ul":
      case "ol":
      case "menu":
        return "list";
      case "li":
        return "listitem";
      case "dl":
        return "list";
      case "nav":
        return "navigation";
      case "main":
        return "main";
      case "aside":
        return "complementary";
      case "header":
        return el.parentElement === document.body ? "banner" : "";
      case "footer":
        return el.parentElement === document.body ? "contentinfo" : "";
      case "article":
        return "article";
      case "section":
        return attr(el, "aria-label") || attr(el, "aria-labelledby")
          ? "region"
          : "";
      case "form":
        return "form";
      case "table":
        return "table";
      case "thead":
      case "tbody":
      case "tfoot":
        return "rowgroup";
      case "tr":
        return "row";
      case "td":
        return "cell";
      case "th":
        return attr(el, "scope") === "row" ? "rowheader" : "columnheader";
      case "caption":
        return "caption";
      case "label":
        return "labeltext";
      case "p":
        return "paragraph";
      case "blockquote":
        return "blockquote";
      case "code":
        return "code";
      case "hr":
        return "separator";
      case "figure":
        return "figure";
      case "dialog":
        return "dialog";
      case "progress":
        return "progressbar";
      case "meter":
        return "meter";
      case "output":
        return "status";
      case "video":
      case "audio":
      case "canvas":
        return tag;
      case "iframe":
      case "frame":
        return "iframe";
    }
    if (
      el.isContentEditable &&
      el.parentElement &&
      !el.parentElement.isContentEditable
    )
      return "textbox";
    return "";
  };

  const nameOf = (el: any, role: string): string => {
    const tag: string = el.localName;
    const byIds = referenced(el, "aria-labelledby");
    if (byIds) return byIds;
    const aria = norm(attr(el, "aria-label"));
    if (aria) return aria;
    if (tag === "img" || tag === "area")
      return norm(attr(el, "alt")) || norm(attr(el, "title"));
    if (
      tag === "input" ||
      tag === "select" ||
      tag === "textarea" ||
      tag === "meter" ||
      tag === "progress" ||
      tag === "output"
    ) {
      const type = (el.type || "").toLowerCase();
      if (tag === "input" && type === "image")
        return norm(attr(el, "alt")) || norm(attr(el, "title")) || "Submit";
      const labels = labelsOf(el);
      if (labels) return labels;
      if (
        tag === "input" &&
        (type === "button" || type === "submit" || type === "reset")
      )
        return (
          norm(el.value) ||
          (type === "submit" ? "Submit" : type === "reset" ? "Reset" : "")
        );
      return norm(attr(el, "title")) || norm(attr(el, "placeholder"));
    }
    if (tag === "fieldset")
      return (
        norm(
          textOf(
            el.querySelector(":scope > legend") ?? document.createTextNode(""),
            0,
            null,
          ),
        ) || norm(attr(el, "title"))
      );
    if (tag === "table")
      return (
        norm(
          textOf(
            el.querySelector(":scope > caption") ?? document.createTextNode(""),
            0,
            null,
          ),
        ) || norm(attr(el, "title"))
      );
    if (tag === "figure")
      return norm(
        textOf(
          el.querySelector(":scope > figcaption") ??
            document.createTextNode(""),
          0,
          null,
        ),
      );
    if (tag === "svg")
      return norm(
        textOf(
          el.querySelector(":scope > title") ?? document.createTextNode(""),
          0,
          null,
        ),
      );
    if (tag === "iframe" || tag === "frame")
      return norm(attr(el, "title")) || norm(attr(el, "name"));
    if (tag === "details")
      return norm(
        textOf(
          el.querySelector(":scope > summary") ?? document.createTextNode(""),
          0,
          null,
        ),
      );
    if (FROM_CONTENT.has(role)) {
      const content = norm(textOf(el, 0, el));
      if (content) return content;
    }
    return norm(attr(el, "title"));
  };

  // Elements that have the focus now, through shadow roots and same-origin frames.
  const active = new Set<Element>();
  for (let a: any = document.activeElement, i = 0; a && i < 20; i++) {
    active.add(a);
    a =
      a.shadowRoot?.activeElement ??
      (a.localName === "iframe"
        ? (() => {
            try {
              return a.contentDocument?.activeElement;
            } catch {
              return null;
            }
          })()
        : null);
  }

  const frames: Record<string, DomAxNode[]> = {};
  const iframes: DomSnapshotResult["iframes"] = [];
  const reachable: string[] = [];
  let count = 0;
  let frameCount = 0;
  let truncated = false;

  const readDocument = (doc: Document, key: string, depth: number): void => {
    const nodes: DomAxNode[] = [];
    frames[key] = nodes;
    const add = (
      parent: DomAxNode,
      role: string,
      el: Element | null,
      name: string,
    ): DomAxNode => {
      const n: DomAxNode = {
        nodeId: String(nodes.length + 1),
        parentId: parent.nodeId,
        role: { value: role },
        childIds: [],
      };
      if (name !== "") n.name = { value: name };
      if (el) n.backendDOMNodeId = idOf(reg, el);
      nodes.push(n);
      parent.childIds.push(n.nodeId);
      count++;
      return n;
    };
    const root: DomAxNode = {
      nodeId: "1",
      role: { value: "RootWebArea" },
      name: { value: doc.title },
      childIds: [],
    };
    nodes.push(root);

    const walk = (node: any, parent: DomAxNode, visible: boolean): void => {
      if (count > MAX_NODES) {
        truncated = true;
        return;
      }
      if (node.nodeType === 3) {
        const t = norm(node.data);
        if (visible && t !== "") add(parent, "StaticText", null, t);
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node as any;
      const tag: string = el.localName;
      if (SKIP.has(tag) || ariaHidden(el)) return;
      if (tag === "input" && el.type === "hidden") return;
      const cs = styleOf(el);
      if (cs.display === "none") return;
      // `visibility` is inherited and may be switched back on by a child, so each element looks at its own computed value.
      const self = cs.visibility !== "hidden" && cs.visibility !== "collapse";
      const role = self ? roleOf(el) : "";

      if (role === "") {
        if (tag === "details" && !el.open) {
          for (const k of childrenOf(el))
            if ((k as Element).localName === "summary") walk(k, parent, self);
          return;
        }
        for (const k of childrenOf(el)) walk(k, parent, self);
        return;
      }

      const name = nameOf(el, role);
      const n = add(parent, role, el, name);
      const props: Array<{ name: string; value: { value: unknown } }> = [];
      const prop = (p: string, v: unknown): void =>
        void props.push({ name: p, value: { value: v } });

      // States.
      const ariaBool = (a: string): boolean | undefined =>
        attr(el, a) === "true"
          ? true
          : attr(el, a) === "false"
            ? false
            : undefined;
      if (
        role === "checkbox" ||
        role === "radio" ||
        role === "switch" ||
        role === "menuitemcheckbox" ||
        role === "menuitemradio"
      ) {
        if (tag === "input")
          prop(
            "checked",
            el.indeterminate ? "mixed" : el.checked ? "true" : "false",
          );
        else {
          const c = attr(el, "aria-checked");
          prop(
            "checked",
            c === "mixed" ? "mixed" : c === "true" ? "true" : "false",
          );
        }
      }
      const pressed = attr(el, "aria-pressed");
      if (pressed)
        prop(
          "pressed",
          pressed === "mixed" ? "mixed" : pressed === "true" ? "true" : "false",
        );
      let disabled = ariaBool("aria-disabled") === true;
      try {
        if (el.matches?.(":disabled")) disabled = true;
      } catch {
        /* no such pseudo-class */
      }
      if (disabled) prop("disabled", true);
      if (role === "combobox" && tag === "select") prop("expanded", false);
      else if (tag === "summary") prop("expanded", !!el.parentElement?.open);
      else {
        const ex = ariaBool("aria-expanded");
        if (ex !== undefined) prop("expanded", ex);
      }
      if (role === "option")
        prop(
          "selected",
          tag === "option" ? !!el.selected : ariaBool("aria-selected") === true,
        );
      else if (ariaBool("aria-selected") === true) prop("selected", true);
      if (role === "heading") prop("level", headingLevel(el));
      if (active.has(el)) prop("focused", true);
      if (el.required === true || ariaBool("aria-required") === true)
        prop("required", true);
      const invalid = attr(el, "aria-invalid");
      if (invalid && invalid !== "false") prop("invalid", true);
      if (el.readOnly === true || ariaBool("aria-readonly") === true)
        prop("readonly", true);
      if (role === "link" && tag === "a" && typeof el.href === "string")
        prop("url", el.href);
      else if (role === "link" && tag === "area" && typeof el.href === "string")
        prop("url", el.href);
      if (props.length) n.properties = props;

      // Value, and which children are shown.
      if (tag === "input" || tag === "textarea") {
        const type = (el.type || "text").toLowerCase();
        if (
          role === "textbox" ||
          role === "searchbox" ||
          role === "spinbutton" ||
          role === "slider"
        ) {
          if (tag === "textarea" || TEXT_INPUTS.has(type) || type === "range") {
            const v: string =
              type === "password"
                ? el.value
                  ? "••••••••"
                  : ""
                : String(el.value ?? "");
            if (v !== "") n.value = { value: v };
          }
        }
        return;
      }
      if (tag === "select") {
        const chosen: any[] = Array.from(el.selectedOptions ?? []);
        const v = chosen.map((o) => norm(o.label || o.text)).join(", ");
        if (v !== "") n.value = { value: v };
        if (role === "listbox")
          for (const o of Array.from(el.options) as Element[]) walk(o, n, true);
        return;
      }
      if (tag === "option") {
        if (!name) n.name = { value: norm(el.label || el.text) };
        return;
      }
      if (tag === "progress" || tag === "meter") {
        if (el.value !== undefined) n.value = { value: String(el.value) };
        return;
      }
      if (
        tag === "svg" ||
        tag === "canvas" ||
        tag === "video" ||
        tag === "audio" ||
        tag === "img"
      )
        return;
      if (role === "textbox" && el.isContentEditable) {
        const v = norm(el.innerText ?? el.textContent ?? "");
        if (v !== "") n.value = { value: v.slice(0, 200) };
        return;
      }
      if (tag === "iframe" || tag === "frame") {
        let inner: Document | null = null;
        try {
          inner = el.contentDocument;
        } catch {
          inner = null;
        }
        const id = n.backendDOMNodeId!;
        if (
          inner &&
          inner.documentElement &&
          depth < 4 &&
          frameCount < MAX_FRAMES
        ) {
          const child = `frame:${++frameCount}`;
          iframes.push({ frame: key, id, child, src: String(el.src ?? "") });
          try {
            reachable.push(String(inner.location.href));
          } catch {
            /* ignore */
          }
          readDocument(inner, child, depth + 1);
        } else {
          iframes.push({
            frame: key,
            id,
            child: null,
            src: String(el.src ?? ""),
          });
        }
        return;
      }
      for (const k of childrenOf(el)) walk(k, n, self);
    };
    const start = doc.body ?? doc.documentElement;
    if (start) walk(start, root, true);
  };
  readDocument(document, "main", 0);

  const result: DomSnapshotResult = {
    token: reg.token,
    url: location.href,
    title: document.title,
    frames,
    iframes,
    reachable,
    truncated,
  };
  return result;
}
