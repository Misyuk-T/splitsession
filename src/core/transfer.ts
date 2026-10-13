import { CookieJar } from "./jar/cookie-jar";
import { type DomainRule, validateRule } from "./domain-rules";
import { collapseName, MAX_STORED_NAME } from "./names";
import {
  type Container,
  CONTAINER_COLORS,
  type ContainerColor,
  type ContainerId,
  type Cookie,
} from "./types";

/**
 * Export / import file. Containers and domain rules by default; cookie jars only when the user asks for them
 * explicitly (they are live logins). Pure data and validation: applying an import lives in the background.
 */
export const EXPORT_FORMAT = "facet-export";
export const EXPORT_VERSION = 1;
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const MAX_CONTAINERS = 200;
const MAX_RULES = 2000;
const MAX_COOKIES_PER_JAR = 5000;

export interface ExportedContainer {
  id: ContainerId;
  name: string;
  color: ContainerColor;
}

export interface ExportedRule {
  domain: string;
  action: "always" | "ask";
  /** ID of an entry of `containers` (for `always`). */
  containerId?: ContainerId;
}

export interface ExportFile {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exportedAt: number;
  containers: ExportedContainer[];
  rules: ExportedRule[];
  /** Present only when exported with "include cookie jars". Keyed by container ID. */
  jars?: Record<ContainerId, Cookie[]>;
}

export function buildExport(input: {
  containers: readonly Container[];
  rules: readonly DomainRule[];
  jars?: Readonly<Record<ContainerId, readonly Cookie[]>>;
  now?: number;
}): ExportFile {
  const known = new Set(input.containers.map((c) => c.id));
  const file: ExportFile = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: input.now ?? Date.now(),
    containers: input.containers.map((c) => ({
      id: c.id,
      name: c.name,
      color: c.color,
    })),
    rules: input.rules
      .filter(
        (r) =>
          r.action === "ask" ||
          (r.containerId !== undefined && known.has(r.containerId)),
      )
      .map((r) =>
        r.action === "ask"
          ? { domain: r.domain, action: "ask" }
          : { domain: r.domain, action: "always", containerId: r.containerId },
      ),
  };
  if (input.jars) {
    file.jars = {};
    for (const c of input.containers)
      file.jars[c.id] = (input.jars[c.id] ?? []).map((cookie) => ({
        ...cookie,
      }));
  }
  return file;
}

export type ParseOutcome =
  { ok: true; file: ExportFile } | { ok: false; error: string };

const fail = (error: string): ParseOutcome => ({ ok: false, error });

/** Parses and validates an export file. Strict: the first problem rejects the whole file, with a readable message. */
export function parseExport(input: string | unknown): ParseOutcome {
  let data: unknown = input;
  if (typeof input === "string") {
    if (input.length > MAX_IMPORT_BYTES)
      return fail("The file is too large to be a SplitSession export.");
    try {
      data = JSON.parse(input);
    } catch {
      return fail("This is not valid JSON.");
    }
  }
  if (typeof data !== "object" || data === null || Array.isArray(data))
    return fail("Not a SplitSession export file.");
  const d = data as Record<string, unknown>;
  if (d.format !== EXPORT_FORMAT)
    return fail('Not a SplitSession export file (wrong "format").');
  if (d.version !== EXPORT_VERSION)
    return fail(
      `Unsupported export version ${JSON.stringify(d.version)}; this SplitSession reads version ${EXPORT_VERSION}.`,
    );
  if (!Array.isArray(d.containers))
    return fail('The export has no "containers" list.');
  if (!Array.isArray(d.rules)) return fail('The export has no "rules" list.');
  if (d.containers.length > MAX_CONTAINERS)
    return fail(`Too many containers (more than ${MAX_CONTAINERS}).`);
  if (d.rules.length > MAX_RULES)
    return fail(`Too many rules (more than ${MAX_RULES}).`);

  const containers: ExportedContainer[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const [index, raw] of d.containers.entries()) {
    const where = `Container ${index + 1}`;
    if (typeof raw !== "object" || raw === null)
      return fail(`${where} is not an object.`);
    const c = raw as Record<string, unknown>;
    if (typeof c.id !== "string" || !/^[a-z0-9]{1,32}$/.test(c.id))
      return fail(`${where} has an invalid "id".`);
    if (ids.has(c.id)) return fail(`${where} repeats the id “${c.id}”.`);
    if (typeof c.name !== "string") return fail(`${where} has no "name".`);
    const name = collapseName(c.name);
    if (name === "") return fail(`${where} has an empty name.`);
    if (Array.from(name).length > MAX_STORED_NAME)
      return fail(
        `${where} has a name longer than ${MAX_STORED_NAME} characters.`,
      );
    if (names.has(name.toLowerCase()))
      return fail(`Two containers are named “${name}”.`);
    if (
      typeof c.color !== "string" ||
      !(CONTAINER_COLORS as readonly string[]).includes(c.color)
    ) {
      return fail(`${where} (“${name}”) has an unknown colour.`);
    }
    ids.add(c.id);
    names.add(name.toLowerCase());
    containers.push({ id: c.id, name, color: c.color as ContainerColor });
  }

  const rules: ExportedRule[] = [];
  const domains = new Set<string>();
  for (const [index, raw] of d.rules.entries()) {
    const checked = validateRule(raw, ids);
    if (!checked.ok) return fail(`Rule ${index + 1}: ${checked.message}`);
    if (domains.has(checked.rule.domain))
      return fail(
        `Rule ${index + 1}: more than one rule for ${checked.rule.domain}.`,
      );
    domains.add(checked.rule.domain);
    rules.push(
      checked.rule.action === "ask"
        ? { domain: checked.rule.domain, action: "ask" }
        : ({ ...checked.rule } as ExportedRule),
    );
  }

  const file: ExportFile = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt:
      typeof d.exportedAt === "number" && Number.isFinite(d.exportedAt)
        ? d.exportedAt
        : 0,
    containers,
    rules,
  };

  if (d.jars !== undefined) {
    if (typeof d.jars !== "object" || d.jars === null || Array.isArray(d.jars))
      return fail('"jars" must be an object keyed by container id.');
    const jars: Record<ContainerId, Cookie[]> = {};
    for (const [id, list] of Object.entries(
      d.jars as Record<string, unknown>,
    )) {
      if (!ids.has(id))
        return fail(`Cookies are listed for an unknown container “${id}”.`);
      if (!Array.isArray(list))
        return fail(`The cookies of container “${id}” are not a list.`);
      if (list.length > MAX_COOKIES_PER_JAR)
        return fail(`Too many cookies for container “${id}”.`);
      // CookieJar.fromJSON is the loader for stored data: it skips malformed cookies and merges repeated ones. An import
      // must not silently lose any (an export never contains either), so a count mismatch rejects the file.
      const jar = CookieJar.fromJSON({ version: 1, cookies: list });
      if (jar.size !== list.length)
        return fail(`Container “${id}” holds a malformed or repeated cookie.`);
      jars[id] = jar.all();
    }
    file.jars = jars;
  }
  return { ok: true, file };
}

/** What importing a file into the current state would do, for the confirmation shown before anything changes. */
export interface ImportPlan {
  /** Containers that do not exist yet (matched by name, case-insensitively). */
  create: ExportedContainer[];
  /** Containers that already exist: kept as they are (colour unchanged). */
  match: Array<{ exported: ExportedContainer; existingId: ContainerId }>;
  rules: number;
  /** Rules replacing an existing rule for the same domain. */
  replacedRules: number;
  jarContainers: number;
  cookies: number;
}

export function planImport(
  file: ExportFile,
  existing: readonly Pick<Container, "id" | "name">[],
  existingRules: readonly Pick<DomainRule, "domain">[],
): ImportPlan {
  const byName = new Map(
    existing.map((c) => [collapseName(c.name).toLowerCase(), c.id]),
  );
  const create: ExportedContainer[] = [];
  const match: ImportPlan["match"] = [];
  for (const c of file.containers) {
    const hit = byName.get(c.name.toLowerCase());
    if (hit !== undefined) match.push({ exported: c, existingId: hit });
    else create.push(c);
  }
  const taken = new Set(existingRules.map((r) => r.domain));
  const jars = file.jars ?? {};
  return {
    create,
    match,
    rules: file.rules.length,
    replacedRules: file.rules.filter((r) => taken.has(r.domain)).length,
    jarContainers: Object.keys(jars).length,
    cookies: Object.values(jars).reduce((n, list) => n + list.length, 0),
  };
}
