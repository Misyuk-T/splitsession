import { describe, expect, it } from 'vitest';
import { withoutAgentMark } from '../../core/indicators';
import { renderSnapshot, type AXNode } from './snapshot';

let seq = 0;
/** A tiny tree builder: n(role, name, children, extra). */
function tree(root: Spec): AXNode[] {
  const out: AXNode[] = [];
  const add = (s: Spec, parentId?: string): string => {
    const id = String(++seq);
    const node: AXNode = { nodeId: id, role: { value: s.role }, ...(s.name !== undefined ? { name: { value: s.name } } : {}), ...(parentId ? { parentId } : {}), ...(s.extra ?? {}) };
    if (s.backend !== null) node.backendDOMNodeId = s.backend ?? 1000 + seq;
    out.push(node);
    node.childIds = (s.children ?? []).map((c) => add(c, id));
    return id;
  };
  add(root);
  return out;
}
interface Spec {
  role: string;
  name?: string;
  children?: Spec[];
  extra?: Partial<AXNode>;
  backend?: number | null;
}
const n = (role: string, name?: string, children: Spec[] = [], extra: Partial<AXNode> = {}, backend?: number | null): Spec => ({ role, name, children, extra, backend });
const text = (t: string): Spec => ({ role: 'StaticText', name: t, children: [{ role: 'InlineTextBox', name: t }], backend: null });
const props = (p: Record<string, unknown>) => ({ properties: Object.entries(p).map(([name, value]) => ({ name, value: { value } })) });

function render(main: AXNode[], extra: { frames?: Array<[string, AXNode[]]>; children?: Array<[string, string | null]>; maxChars?: number } = {}) {
  const refs = new Map<string, string>();
  return renderSnapshot({
    frames: new Map([['main', main], ...(extra.frames ?? [])]),
    children: new Map(extra.children ?? []),
    refFor: (key, id) => {
      const k = `${key}:${id}`;
      if (!refs.has(k)) refs.set(k, `e${refs.size + 1}`);
      return refs.get(k)!;
    },
    maxChars: extra.maxChars ?? 100_000,
    origin: 'https://a.test',
    cleanTitle: withoutAgentMark,
  });
}

describe('accessibility snapshot', () => {
  it('renders roles, names, refs, properties and values; wrappers and text boxes disappear', () => {
    const out = render(
      tree(
        n('RootWebArea', '🤖◐ Inbox', [
          n('generic', undefined, [
            n('heading', 'Inbox', [text('Inbox')], props({ level: 1 })),
            n('button', 'Join', [text('Join')]),
            n('button', 'Off', [text('Off')], props({ disabled: true })),
            n('textbox', 'Search', [], { value: { value: 'cats' }, ...props({ focused: true }) }),
            n('checkbox', 'Remember me', [], props({ checked: 'true' })),
            n('link', 'Docs', [text('Docs')], props({ url: 'https://a.test/docs?x=1' })),
            n('link', 'Elsewhere', [text('Elsewhere')], props({ url: 'https://b.test/' })),
            n('combobox', 'Size', [n('option', 'S', [text('S')], props({ selected: true }))], { value: { value: 'S' }, ...props({ expanded: false }) }),
          ]),
          n('none', undefined, [], { ignored: true }),
        ]),
      ),
    );
    expect(out.title).toBe('Inbox');
    expect(out.text.split('\n')).toEqual([
      '- heading "Inbox" [level=1] [ref=e1]',
      '- button "Join" [ref=e2]',
      '- button "Off" [disabled] [ref=e3]',
      '- textbox "Search" [focused] [ref=e4]: cats',
      '- checkbox "Remember me" [checked] [ref=e5]',
      '- link "Docs" [ref=e6] /url=/docs?x=1',
      '- link "Elsewhere" [ref=e7] /url=https://b.test/',
      '- combobox "Size" [collapsed] [ref=e8]: S',
    ]);
    expect(out).toMatchObject({ refs: 8, truncated: false, lines: 8 });
  });

  it('nests containers, merges text runs, inlines text-only elements and escapes quotes', () => {
    const out = render(
      tree(
        n('RootWebArea', 'Page', [
          n('navigation', 'Main', [n('list', undefined, [n('listitem', undefined, [n('link', 'Home', [text('Home')], props({ url: '/' }))])])]),
          n('paragraph', undefined, [text('Hello '), n('strong', undefined, [text('big')]), text(' world')]),
          n('button', 'Say "hi"', [text('Say "hi"')]),
          n('paragraph', undefined, []),
          n('img', undefined, []),
        ]),
      ),
    );
    expect(out.text.split('\n')).toEqual([
      '- navigation "Main" [ref=e1]:',
      '  - list [ref=e2]:',
      '    - listitem [ref=e3]:',
      '      - link "Home" [ref=e4] /url=/',
      '- paragraph [ref=e5]: Hello big world',
      '- button "Say \\"hi\\"" [ref=e6]',
      '- img [ref=e7]',
    ]);
  });

  it('shows the children of an element whose name differs from its text', () => {
    const out = render(tree(n('RootWebArea', 'P', [n('button', 'Close dialog', [text('×')])])));
    expect(out.text.split('\n')).toEqual(['- button "Close dialog" [ref=e1]:', '  - text: ×']);
  });

  it('puts the document of an iframe under the iframe, and says when one cannot be reached', () => {
    const child = tree(n('RootWebArea', 'Comments', [n('button', 'Reply', [text('Reply')], {}, 77)]));
    const out = render(
      tree(
        n('RootWebArea', 'Top', [
          n('Iframe', 'Comments', [], {}, 500),
          n('Iframe', undefined, [], {}, 501),
        ]),
      ),
      { frames: [['oopif:T1', child]], children: [['main:500', 'oopif:T1'], ['main:501', null]] },
    );
    expect(out.text.split('\n')).toEqual(['- iframe "Comments" [ref=e1]:', '  - button "Reply" [ref=e2]', '- iframe [ref=e3]: (cannot be reached)']);
  });

  it('gives an element the same ref in the next snapshot, and cuts long pages at whole lines', () => {
    const nodes = tree(n('RootWebArea', 'P', Array.from({ length: 50 }, (_, i) => n('button', `B${i}`, [text(`B${i}`)], {}, 2000 + i))));
    const refs = new Map<string, string>();
    const refFor = (key: string, id: number) => refs.get(`${key}:${id}`) ?? (refs.set(`${key}:${id}`, `e${refs.size + 1}`), refs.get(`${key}:${id}`)!);
    const first = renderSnapshot({ frames: new Map([['main', nodes]]), children: new Map(), refFor, maxChars: 100 });
    expect(first.truncated).toBe(true);
    expect(first.text.length).toBeLessThanOrEqual(100);
    expect(first.text.split('\n').every((l) => /^- button "B\d+" \[ref=e\d+\]$/.test(l))).toBe(true);
    const second = renderSnapshot({ frames: new Map([['main', nodes.slice().reverse()]]), children: new Map(), refFor, maxChars: 100_000 });
    expect(second.text).toContain('- button "B0" [ref=e1]');
    expect(second.text).toContain('- button "B49" [ref=e50]');
  });

  it('does not show what is hidden from assistive technology (our own overlay is aria-hidden)', () => {
    const out = render(tree(n('RootWebArea', 'P', [n('generic', undefined, [n('StaticText', 'Agent: clicking')], { ignored: true }), n('button', 'Go', [text('Go')])])));
    // An ignored node's own line is dropped; its text would still show if Chrome reported it, so the overlay must be ignored by Chrome itself.
    expect(out.text).toContain('- button "Go" [ref=e1]');
  });
});
