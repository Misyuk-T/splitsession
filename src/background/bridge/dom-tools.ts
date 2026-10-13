/* eslint-disable @typescript-eslint/no-explicit-any -- results of the injected DOM command depend on the command; callers narrow them */
/**
 * The background side of the DOM tools (page-dom.ts): snapshots with refs, finding an element for a ref or selector,
 * and waiting. Nothing here uses the debugger; every step is a `scripting.executeScript` call into one frame.
 *
 * Refs are handed out per tab and per document: `e12` stands for "element 7 of the registry the frame `5` had when it was
 * snapshotted (token T)". A frame that navigated has a new token, so its old refs are refused, never resolved to
 * whatever now has the same number. Frames of other sites are separate scripting targets: the snapshot reads each one
 * and puts its tree under the <iframe> that holds it; `owners` remembers which iframe element that was, so a point in
 * such a frame can be turned into top-viewport coordinates for trusted input.
 */
import { withoutAgentMark } from "../../core/indicators";
import { ToolError } from "./errors";
import type {
  DomCommand,
  DomRect,
  DomSnapshotResult,
  DomTarget,
} from "./page-dom";
import { type AXNode, renderSnapshot, type SnapshotOutput } from "./snapshot";

export interface DomHost {
  /** Runs one command in a frame; throws ToolError for `{error}` results; `{stale: true}` comes back as data. */
  call(tabId: number, frameId: number, cmd: DomCommand): Promise<any>;
  /** The same, but a frame that cannot be scripted gives null instead of an error. */
  tryCall(tabId: number, frameId: number, cmd: DomCommand): Promise<any | null>;
  frames(
    tabId: number,
  ): Promise<Array<{ frameId: number; parentFrameId: number; url: string }>>;
}

interface RefEntry {
  frameId: number;
  token: string;
  id: number;
}

/** Refs of one document of a tab. */
export interface DomRefs {
  /** The top document's registry token: another one is another page. */
  token: string;
  next: number;
  /** `${frameId}:${token}:${id}` -> ref */
  byKey: Map<string, string>;
  byRef: Map<string, RefEntry>;
  /** A frame of another site: the frame and the <iframe> element (registry id) that holds it. */
  owners: Map<number, { parent: number; id: number; token: string }>;
}

export const freshRefs = (token: string): DomRefs => ({
  token,
  next: 1,
  byKey: new Map(),
  byRef: new Map(),
  owners: new Map(),
});

/** An element the agent named: a ref from the latest snapshot, or a CSS selector of the top frame. */
export interface ElementRef {
  ref?: string;
  selector?: string;
}

const MAX_FRAMES = 20;
const MAX_FRAME_DEPTH = 3;

// ------------------------------------------------------------------ snapshot

interface Pending {
  frameId: number;
  prefix: string;
  depth: number;
  result: DomSnapshotResult;
}

export async function domSnapshot(
  host: DomHost,
  tabId: number,
  previous: DomRefs | undefined,
  o: { maxChars: number; origin: string | undefined },
): Promise<{ output: SnapshotOutput; refs: DomRefs }> {
  const top = (await host.call(tabId, 0, {
    op: "snapshot",
  })) as DomSnapshotResult;
  const refs =
    previous && previous.token === top.token ? previous : freshRefs(top.token);

  const frames = new Map<string, readonly AXNode[]>();
  const children = new Map<string, string | null>();
  const runOf = new Map<string, number>();
  const tokenOf = new Map<number, string>();
  const keyIn = (prefix: string, local: string): string =>
    local === "main"
      ? prefix === ""
        ? "main"
        : prefix
      : prefix === ""
        ? local
        : `${prefix}/${local}`;

  const merge = (
    p: Pending,
  ): Array<{ key: string; id: number; src: string }> => {
    tokenOf.set(p.frameId, p.result.token);
    for (const [local, nodes] of Object.entries(p.result.frames)) {
      const key = keyIn(p.prefix, local);
      frames.set(key, nodes as unknown as AXNode[]);
      runOf.set(key, p.frameId);
    }
    const cross: Array<{ key: string; id: number; src: string }> = [];
    for (const f of p.result.iframes) {
      const key = keyIn(p.prefix, f.frame);
      children.set(`${key}:${f.id}`, f.child ? keyIn(p.prefix, f.child) : null);
      if (!f.child) cross.push({ key, id: f.id, src: f.src });
    }
    return cross;
  };

  const queue: Pending[] = [{ frameId: 0, prefix: "", depth: 0, result: top }];
  const visited = new Set<number>([0]);
  let all: Awaited<ReturnType<DomHost["frames"]>> | null = null;
  let read = 1;
  while (queue.length) {
    const p = queue.shift()!;
    const cross = merge(p);
    if (cross.length === 0 || p.depth >= MAX_FRAME_DEPTH) continue;
    all ??= await host.frames(tabId).catch(() => []);
    // The frames below this one that its own script could not read: not the same-origin documents it read itself.
    const own = [...p.result.reachable];
    const candidates = all
      .filter((f) => f.parentFrameId === p.frameId && !visited.has(f.frameId))
      .filter((f) => {
        const i = own.indexOf(f.url);
        if (i < 0) return true;
        own.splice(i, 1);
        return false;
      });
    for (const c of cross) {
      let pick = candidates.findIndex((f) => c.src !== "" && f.url === c.src);
      if (pick < 0)
        pick = candidates.findIndex(
          () => c.src === "" || !candidates.some((g) => g.url === c.src),
        );
      const frame = pick >= 0 ? candidates.splice(pick, 1)[0] : undefined;
      if (!frame || read >= MAX_FRAMES) continue;
      visited.add(frame.frameId);
      const inner = (await host.tryCall(tabId, frame.frameId, {
        op: "snapshot",
      })) as DomSnapshotResult | null;
      if (!inner || !inner.frames?.main) continue;
      read++;
      const prefix = `f${frame.frameId}`;
      children.set(`${c.key}:${c.id}`, prefix);
      refs.owners.set(frame.frameId, {
        parent: p.frameId,
        id: c.id,
        token: p.result.token,
      });
      queue.push({
        frameId: frame.frameId,
        prefix,
        depth: p.depth + 1,
        result: inner,
      });
    }
  }

  const output = renderSnapshot({
    frames,
    children,
    maxChars: o.maxChars,
    ...(o.origin ? { origin: o.origin } : {}),
    cleanTitle: withoutAgentMark,
    refFor: (frameKey, id) => {
      const frameId = runOf.get(frameKey) ?? 0;
      const token = tokenOf.get(frameId) ?? top.token;
      const k = `${frameId}:${token}:${id}`;
      let ref = refs.byKey.get(k);
      if (!ref) {
        ref = `e${refs.next++}`;
        refs.byKey.set(k, ref);
        refs.byRef.set(ref, { frameId, token, id });
      }
      return ref;
    },
  });
  return { output, refs };
}

// ------------------------------------------------------------------ elements

const staleMessage = (ref: string): string =>
  `unknown ref ${ref}: the page has changed since that snapshot (or the ref is from another tab); take a new snapshot`;

/** Where a frame's viewport starts in the top viewport (frames of other sites report their own coordinates). */
async function frameOrigin(
  host: DomHost,
  tabId: number,
  refs: DomRefs,
  frameId: number,
): Promise<{ x: number; y: number }> {
  let x = 0;
  let y = 0;
  for (let i = 0; i < 10 && frameId !== 0; i++) {
    const owner = refs.owners.get(frameId);
    if (!owner) break;
    const r = await host.call(tabId, owner.parent, {
      op: "owner",
      target: { id: owner.id, token: owner.token },
    });
    if (r?.stale || typeof r?.x !== "number")
      throw new ToolError(
        "that element is inside a frame that has changed; take a new snapshot",
      );
    x += r.x;
    y += r.y;
    frameId = owner.parent;
  }
  return { x, y };
}

/** The target of a ref or selector: which frame to ask, and how. */
function targetOf(
  refs: DomRefs | undefined,
  t: ElementRef,
): { frameId: number; target: DomTarget; ref?: string } {
  if (t.ref !== undefined) {
    const entry = refs?.byRef.get(t.ref);
    if (!entry) {
      throw new ToolError(
        refs && refs.next > 1
          ? staleMessage(t.ref)
          : `unknown ref ${t.ref}: take a snapshot of this tab first (refs come from snapshot)`,
      );
    }
    return {
      frameId: entry.frameId,
      target: { id: entry.id, token: entry.token },
      ref: t.ref,
    };
  }
  if (t.selector === undefined)
    throw new ToolError("give a ref (from snapshot) or a selector");
  return { frameId: 0, target: { selector: t.selector } };
}

/**
 * Asks the frame of `t` to run the command built from its target. Rectangles and points in the answer are moved into
 * top-viewport coordinates when the element is in a frame of another site.
 */
export async function onTarget<T = any>(
  host: DomHost,
  tabId: number,
  refs: DomRefs | undefined,
  t: ElementRef,
  build: (target: DomTarget) => DomCommand,
): Promise<T> {
  const w = targetOf(refs, t);
  const r = await host.call(tabId, w.frameId, build(w.target));
  if (r?.stale) throw new ToolError(staleMessage(w.ref ?? ""));
  if (w.frameId !== 0 && refs) {
    const o = await frameOrigin(host, tabId, refs, w.frameId);
    if (r && typeof r === "object") {
      if (r.rect) r.rect = { ...r.rect, x: r.rect.x + o.x, y: r.rect.y + o.y };
      if (typeof r.x === "number") r.x += o.x;
      if (typeof r.y === "number") r.y += o.y;
    }
  }
  return r as T;
}

/** The frame an element is in (0: the top document). */
export function frameOf(refs: DomRefs | undefined, t: ElementRef): number {
  return t.ref !== undefined ? (refs?.byRef.get(t.ref)?.frameId ?? 0) : 0;
}

export interface Located {
  x: number;
  y: number;
  rect: DomRect;
  label: string;
}

// ------------------------------------------------------------------ waiting

export async function waitFor(
  host: DomHost,
  tabId: number,
  refs: DomRefs | undefined,
  c: {
    text?: string;
    textGone?: string;
    target?: ElementRef;
    state: "visible" | "hidden";
    timeout: number;
  },
  hooks: { isLive(): void; blocked(): void; sleep(ms: number): Promise<void> },
): Promise<{ waitedMs: number }> {
  const started = Date.now();
  const check = async (): Promise<boolean> => {
    if (c.text !== undefined || c.textGone !== undefined) {
      const r = await host.call(tabId, 0, {
        op: "check",
        ...(c.text !== undefined
          ? { text: c.text }
          : { textGone: c.textGone! }),
      });
      return !!r.ok;
    }
    const r = await onTarget(host, tabId, refs, c.target!, (target) => ({
      op: "check",
      target,
      state: c.state,
    }));
    return !!r.ok;
  };
  for (;;) {
    hooks.isLive();
    hooks.blocked();
    let ok = false;
    try {
      ok = await Promise.race([
        check(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new ToolError("the page did not answer")),
            5_000,
          ),
        ),
      ]);
    } catch (error) {
      // The page navigated between two looks: look again in the new document. Real errors (a bad selector, an unknown ref) stop.
      if (
        !(error instanceof ToolError) ||
        !/context|Cannot find|navigat|did not answer|frame was removed|No frame/i.test(
          error.message,
        )
      )
        throw error;
    }
    const waited = Date.now() - started;
    if (ok) return { waitedMs: waited };
    if (waited >= c.timeout) {
      const what =
        c.text !== undefined
          ? `the text "${c.text}" did not appear`
          : c.textGone !== undefined
            ? `the text "${c.textGone}" did not go away`
            : `the element did not become ${c.state}`;
      throw new ToolError(
        `${what} within ${Math.round(c.timeout / 100) / 10} s`,
      );
    }
    await hooks.sleep(Math.min(150, c.timeout - waited));
  }
}
