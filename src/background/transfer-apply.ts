import {
  buildExport,
  type ContainerId,
  type DomainRule,
  type ExportFile,
  mergeTabLists,
  parseExport,
  type SavedTab,
} from "../core";
import type { Facet } from "./facet";
import type { RuleStore } from "./rule-store";

export interface ImportSummary {
  createdContainers: number;
  matchedContainers: number;
  rules: number;
  cookies: number;
  /** Tabs stored as saved tabs (nothing is opened). */
  tabs: number;
}

export interface ExportOptions {
  includeJars: boolean;
  /** Present when the export includes tabs: the container's open tabs, in order (savable ones, titles cleaned). */
  openTabs?: (containerId: ContainerId, name: string) => Promise<SavedTab[]>;
}

/** Containers and rules as an export file; cookie jars only when `includeJars` is true, tabs only with `openTabs`. */
export async function exportData(
  facet: Facet,
  rules: RuleStore,
  options: ExportOptions,
): Promise<ExportFile> {
  await facet.ready;
  const containers = facet.containers.list();
  let tabs: Record<ContainerId, SavedTab[]> | undefined;
  if (options.openTabs) {
    tabs = {};
    for (const c of containers)
      tabs[c.id] = mergeTabLists(
        await options.openTabs(c.id, c.name),
        facet.savedTabs.get(c.id),
      );
  }
  return buildExport({
    containers,
    rules: rules.list(),
    jars: options.includeJars
      ? Object.fromEntries(containers.map((c) => [c.id, facet.getJar(c.id)]))
      : undefined,
    tabs,
  });
}

/**
 * Applies an export file. Validation happens first and rejects the whole file; after that, containers are matched by
 * name (case-insensitively) and created when missing, imported rules replace rules for the same domain, and cookies
 * (when the file has them) are merged into the matching container's jar. Tabs of the file become the container's saved
 * tabs (replacing the ones it has); nothing is opened.
 */
export async function importData(
  facet: Facet,
  rules: RuleStore,
  raw: unknown,
): Promise<ImportSummary> {
  await facet.ready;
  const parsed = parseExport(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  const file = parsed.file;

  const local = new Map<ContainerId, ContainerId>(); // exported id -> id here
  let created = 0;
  let matched = 0;
  for (const c of file.containers) {
    const existing = facet.containers.findByName(c.name);
    if (existing) {
      local.set(c.id, existing.id);
      matched++;
    } else {
      const made = await facet.createContainer({
        name: c.name,
        color: c.color,
      });
      local.set(c.id, made.id);
      created++;
    }
  }

  let cookies = 0;
  for (const [exportedId, list] of Object.entries(file.jars ?? {})) {
    const id = local.get(exportedId);
    if (id === undefined || list.length === 0) continue;
    const jar = facet.containers.jar(id);
    const now = Date.now();
    for (const cookie of list) {
      const outcome = jar.upsert(cookie, { now });
      if (outcome === "added" || outcome === "updated") cookies++;
    }
    facet.containers.touchJar(id);
    if (facet.tabs.tabsOf(id).length > 0) await facet.rules.invalidate(id);
  }

  let tabs = 0;
  for (const [exportedId, list] of Object.entries(file.tabs ?? {})) {
    const id = local.get(exportedId);
    if (id === undefined || list.length === 0) continue;
    await facet.savedTabs.set(id, list);
    tabs += facet.savedTabs.count(id);
  }

  for (const rule of file.rules) {
    const mapped: DomainRule =
      rule.action === "ask"
        ? { domain: rule.domain, action: "ask" }
        : {
            domain: rule.domain,
            action: "always",
            containerId: local.get(rule.containerId!),
          };
    await rules.set(mapped);
  }
  facet.log(
    "info",
    `import: ${created} containers created, ${matched} matched, ${file.rules.length} rules, ${cookies} cookies, ${tabs} tabs`,
  );
  return {
    createdContainers: created,
    matchedContainers: matched,
    rules: file.rules.length,
    cookies,
    tabs,
  };
}
