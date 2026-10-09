/**
 * Runtime registration of the two content scripts. They must run in this order at `document_start` in every frame:
 * the ISOLATED beacon learns the frame's container synchronously and hands it to the MAIN-world shim, which patches
 * page APIs before any page script runs. Chrome injects scripts of one registration call in array order.
 *
 * v0.1 matches `<all_urls>` (see docs/decisions.md): every frame of every tab pays one synchronous beacon XHR
 * (answered locally by DNR, no network) and parses both scripts; in tabs without a container the shim is a no-op.
 */
export interface RegisteredScript {
  id: string;
  js: string[];
  matches: string[];
  runAt: 'document_start';
  allFrames: boolean;
  matchOriginAsFallback: boolean;
  world: 'ISOLATED' | 'MAIN';
  persistAcrossSessions: boolean;
}

export const CONTENT_SCRIPTS: readonly RegisteredScript[] = [
  {
    id: 'facet-beacon',
    js: ['beacon.js'],
    matches: ['<all_urls>'],
    runAt: 'document_start',
    allFrames: true,
    matchOriginAsFallback: true,
    world: 'ISOLATED',
    persistAcrossSessions: true,
  },
  {
    id: 'facet-shim',
    js: ['shim.js'],
    matches: ['<all_urls>'],
    runAt: 'document_start',
    allFrames: true,
    matchOriginAsFallback: true,
    world: 'MAIN',
    persistAcrossSessions: true,
  },
];

export interface ScriptingApi {
  getRegisteredContentScripts(filter?: { ids?: string[] }): Promise<Array<Partial<RegisteredScript> & { id: string }>>;
  registerContentScripts(scripts: RegisteredScript[]): Promise<void>;
  unregisterContentScripts(filter?: { ids?: string[] }): Promise<void>;
}

function sameScript(a: Partial<RegisteredScript>, b: RegisteredScript): boolean {
  const list = (x: unknown) => JSON.stringify(Array.isArray(x) ? x : []);
  return (
    list(a.js) === list(b.js) &&
    list(a.matches) === list(b.matches) &&
    a.runAt === b.runAt &&
    Boolean(a.allFrames) === b.allFrames &&
    Boolean(a.matchOriginAsFallback) === b.matchOriginAsFallback &&
    (a.world ?? 'ISOLATED') === b.world &&
    (a.persistAcrossSessions ?? true) === b.persistAcrossSessions
  );
}

/** Idempotent: does nothing when both scripts are registered as configured, else re-registers both in order. */
export async function ensureContentScripts(scripting: ScriptingApi): Promise<'unchanged' | 'registered'> {
  const ids = CONTENT_SCRIPTS.map((s) => s.id);
  const existing = await scripting.getRegisteredContentScripts({ ids });
  const upToDate =
    existing.length === CONTENT_SCRIPTS.length &&
    CONTENT_SCRIPTS.every((want) => existing.some((have) => have.id === want.id && sameScript(have, want)));
  if (upToDate) return 'unchanged';
  if (existing.length > 0) await scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
  await scripting.registerContentScripts(CONTENT_SCRIPTS.map((s) => ({ ...s, js: [...s.js], matches: [...s.matches] })));
  return 'registered';
}
