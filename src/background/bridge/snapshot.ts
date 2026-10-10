/**
 * Renders Chrome's accessibility tree (CDP `Accessibility.getFullAXTree`, one node list per frame) as the compact,
 * YAML-like text the `snapshot` tool returns:
 *
 *   - heading "Inbox" [level=1] [ref=e3]
 *   - button "Join" [ref=e12]
 *   - textbox "Search" [ref=e13]: cats
 *   - link "Docs" [ref=e14] /url=/docs
 *   - iframe "Comments" [ref=e15]:
 *     - button "Reply" [ref=e16]
 *
 * Pure: the frames are collected beforehand (cdp-tools.ts), refs come from a callback so they stay the same for the
 * same element across snapshots of one document.
 */

export interface AXValue {
  type?: string;
  value?: unknown;
}

export interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: Array<{ name: string; value: AXValue }>;
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

export interface SnapshotInput {
  /** Node lists per frame key ('main' is the top document). */
  frames: ReadonlyMap<string, readonly AXNode[]>;
  /** `${frameKey}:${backendNodeId of the <iframe>}` -> the frame key of its document, or null when it cannot be reached. */
  children: ReadonlyMap<string, string | null>;
  /** The ref of an element; the same element must get the same ref. */
  refFor(frameKey: string, backendNodeId: number): string;
  maxChars: number;
  /** For links on the page's own origin: shown as a path. */
  origin?: string;
  /** Drops our own activity mark from the document title (`withoutAgentMark`). */
  cleanTitle?: (title: string) => string;
}

export interface SnapshotOutput {
  title: string;
  text: string;
  lines: number;
  refs: number;
  truncated: boolean;
}

/** Wrappers without meaning of their own: their children are shown in their place, unless they have a name. */
const TRANSPARENT = new Set([
  'generic', 'none', 'presentation', 'section', 'genericcontainer', 'ignored', 'div', 'strong', 'emphasis', 'mark', 'time', 'abbr',
  'layouttable', 'layouttablerow', 'layouttablecell', 'subscript', 'superscript', 'ruby', 'span', 'unknown',
]);
/** Never shown. */
const SKIP = new Set(['inlinetextbox', 'listmarker', 'linebreak']);
/** Shown even with no name, no value and no children. */
const ALWAYS = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'switch', 'slider', 'spinbutton', 'tab', 'treeitem', 'img', 'image', 'iframe', 'separator', 'progressbar', 'video', 'audio', 'canvas',
]);
const VALUE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider', 'progressbar', 'scrollbar', 'meter']);

const ROLE_NAMES: Record<string, string> = { statictext: 'text', labeltext: 'label', rootwebarea: 'document', webarea: 'document' };

const str = (v: AXValue | undefined): string => (v && v.value !== undefined && v.value !== null ? String(v.value) : '');
const clean = (s: string, max = 300): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};
const quote = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function prop(node: AXNode, name: string): unknown {
  return node.properties?.find((p) => p.name === name)?.value?.value;
}

function attributes(node: AXNode, role: string): string {
  const out: string[] = [];
  const checked = prop(node, 'checked');
  if (checked === 'true' || checked === true) out.push('[checked]');
  else if (checked === 'mixed') out.push('[checked=mixed]');
  const pressed = prop(node, 'pressed');
  if (pressed === 'true' || pressed === true) out.push('[pressed]');
  else if (pressed === 'mixed') out.push('[pressed=mixed]');
  if (prop(node, 'disabled') === true) out.push('[disabled]');
  const expanded = prop(node, 'expanded');
  if (expanded === true) out.push('[expanded]');
  else if (expanded === false) out.push('[collapsed]');
  if (prop(node, 'selected') === true) out.push('[selected]');
  const level = prop(node, 'level');
  if (typeof level === 'number' && role === 'heading') out.push(`[level=${level}]`);
  if (prop(node, 'focused') === true) out.push('[focused]');
  if (prop(node, 'required') === true) out.push('[required]');
  const invalid = prop(node, 'invalid');
  if (invalid !== undefined && invalid !== 'false' && invalid !== false) out.push('[invalid]');
  if (prop(node, 'readonly') === true && VALUE_ROLES.has(role)) out.push('[readonly]');
  return out.length ? ` ${out.join(' ')}` : '';
}

function linkUrl(node: AXNode, origin: string | undefined): string {
  const url = prop(node, 'url');
  if (typeof url !== 'string' || url === '' || url.startsWith('javascript:')) return '';
  let shown = url;
  if (origin) {
    try {
      const u = new URL(url);
      if (u.origin === origin) shown = u.pathname + u.search + u.hash;
    } catch {
      /* keep it as given */
    }
  }
  return ` /url=${clean(shown, 200)}`;
}

/** Renders the snapshot. */
export function renderSnapshot(input: SnapshotInput): SnapshotOutput {
  const lines: string[] = [];
  let length = 0;
  let truncated = false;
  let refs = 0;
  const push = (line: string): boolean => {
    if (truncated) return false;
    if (length + line.length + 1 > input.maxChars) {
      truncated = true;
      return false;
    }
    lines.push(line);
    length += line.length + 1;
    return true;
  };

  const byFrame = new Map<string, Map<string, AXNode>>();
  for (const [key, nodes] of input.frames) byFrame.set(key, new Map(nodes.map((n) => [n.nodeId, n])));
  const rootOf = (key: string): AXNode | undefined => {
    const nodes = input.frames.get(key);
    if (!nodes || nodes.length === 0) return undefined;
    const ids = byFrame.get(key)!;
    return nodes.find((n) => !n.parentId || !ids.has(n.parentId)) ?? nodes[0];
  };
  const visitedFrames = new Set<string>();

  const roleOf = (n: AXNode): string => str(n.role).toLowerCase();

  /** The text of a node's subtree as plain words (to know whether children only repeat the name). */
  const textOf = (key: string, n: AXNode, depth = 0): string => {
    if (depth > 30) return '';
    const role = roleOf(n);
    if (role === 'statictext') return str(n.name);
    if (SKIP.has(role)) return '';
    const map = byFrame.get(key)!;
    return (n.childIds ?? []).map((id) => map.get(id)).filter((c): c is AXNode => !!c).map((c) => textOf(key, c, depth + 1)).join(' ');
  };

  /** Renders the children of `n` at `depth`, merging runs of plain text into one line. */
  const renderChildren = (key: string, n: AXNode, depth: number): void => {
    const map = byFrame.get(key)!;
    let textRun: string[] = [];
    const flush = () => {
      const t = clean(textRun.join(' '), 500);
      textRun = [];
      if (t !== '') push(`${'  '.repeat(depth)}- text: ${t}`);
    };
    const walk = (id: string): void => {
      const c = map.get(id);
      if (!c || truncated) return;
      const role = roleOf(c);
      if (role === 'statictext') {
        textRun.push(str(c.name));
        return;
      }
      if (SKIP.has(role)) return;
      if (c.ignored || (TRANSPARENT.has(role) && clean(str(c.name)) === '')) {
        for (const child of c.childIds ?? []) walk(child);
        return;
      }
      flush();
      renderNode(key, c, depth);
    };
    for (const id of n.childIds ?? []) walk(id);
    flush();
  };

  const renderNode = (key: string, n: AXNode, depth: number): void => {
    if (truncated) return;
    const role = roleOf(n);
    const shownRole = ROLE_NAMES[role] ?? role;
    const name = clean(str(n.name));
    const indent = '  '.repeat(depth);
    const map = byFrame.get(key)!;
    const kids = (n.childIds ?? []).map((id) => map.get(id)).filter((c): c is AXNode => !!c);
    // The ref is handed out only for a line that is really shown.
    let head = '';
    const headLine = (): string => {
      if (head !== '') return head;
      const ref = n.backendDOMNodeId !== undefined ? input.refFor(key, n.backendDOMNodeId) : null;
      if (ref) refs++;
      head = `${indent}- ${shownRole}${name ? ` ${quote(name)}` : ''}${attributes(n, role)}${ref ? ` [ref=${ref}]` : ''}${role === 'link' ? linkUrl(n, input.origin) : ''}`;
      return head;
    };
    const hasRef = n.backendDOMNodeId !== undefined;

    if (role === 'iframe') {
      const child = n.backendDOMNodeId !== undefined ? input.children.get(`${key}:${n.backendDOMNodeId}`) : undefined;
      if (child && !visitedFrames.has(child) && byFrame.has(child)) {
        visitedFrames.add(child);
        if (!push(`${headLine()}:`)) return;
        const root = rootOf(child);
        if (root) renderChildren(child, root, depth + 1);
      } else {
        push(`${headLine()}${child === null ? ': (cannot be reached)' : ''}`);
      }
      return;
    }

    let value = VALUE_ROLES.has(role) ? clean(str(n.value), 200) : '';
    if (role === 'slider' && value === '') value = clean(String(prop(n, 'valuetext') ?? ''), 50);
    const subtreeText = clean(kids.map((k) => textOf(key, k)).join(' '), 10_000);
    const onlyRepeatsName = subtreeText === '' || subtreeText === name || (VALUE_ROLES.has(role) && (subtreeText === value || subtreeText === name));
    /** Whether any child would get a line of its own (wrappers count through their children). */
    const showsElements = (list: AXNode[], level = 0): boolean =>
      level < 30 &&
      list.some((k) => {
        const r = roleOf(k);
        if (r === 'statictext' || SKIP.has(r)) return false;
        if (k.ignored || (TRANSPARENT.has(r) && clean(str(k.name)) === '')) {
          return showsElements((k.childIds ?? []).map((id) => map.get(id)).filter((c): c is AXNode => !!c), level + 1);
        }
        return true;
      });
    const hasElementChildren = showsElements(kids);

    if (value !== '') {
      push(`${headLine()}: ${value}`);
      return; // a field's children are its own text
    }
    if (onlyRepeatsName && !hasElementChildren) {
      if (name === '' && !ALWAYS.has(role) && (!hasRef || subtreeText === '')) return;
      push(headLine());
      return;
    }
    if (!hasElementChildren && name === '') {
      // Text only: inline, like "- paragraph [ref=e5]: Hello world".
      push(`${headLine()}: ${clean(subtreeText, 500)}`);
      return;
    }
    if (!push(`${headLine()}:`)) return;
    renderChildren(key, n, depth + 1);
    // Wrapper with nothing inside after all (e.g. only hidden content): drop the dangling header.
    if (!truncated && lines[lines.length - 1] === `${head}:`) {
      lines.pop();
      length -= head.length + 2;
      if (name !== '' || ALWAYS.has(role)) push(head);
    }
  };

  const top = rootOf('main');
  const title = top ? (input.cleanTitle ?? ((t: string) => t))(clean(str(top.name))) : '';
  if (top) {
    visitedFrames.add('main');
    renderChildren('main', top, 0);
  }
  return { title, text: lines.join('\n'), lines: lines.length, refs, truncated };
}
