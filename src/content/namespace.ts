import { NAMESPACE_PREFIX, namespacePrefix } from "../core/types";

/**
 * Name mapping for origin-scoped page state (Web Storage keys, IndexedDB names, Cache Storage names, BroadcastChannel
 * names) shared by the real profile and every container on the same origin.
 *  - container mode: every name lives under `__facet:<page key>:` (per container and site, never the container ID);
 *  - managed mode (no container, origin used by containers): names under `__facet:` are hidden, and a page that
 *    asks for one explicitly is sent to a quarantine namespace, never into a container's data.
 */
export interface Namespace {
  /** Raw name for a page-visible name. */
  toRaw(name: string): string;
  /** Whether a raw name belongs to this view. */
  owns(raw: string): boolean;
  /** Page-visible name of a raw name this view owns. */
  fromRaw(raw: string): string;
}

const QUARANTINE = `${NAMESPACE_PREFIX}_real:`;

export function containerNamespace(pageKey: string): Namespace {
  const prefix = namespacePrefix(pageKey);
  return {
    toRaw: (name) => prefix + name,
    owns: (raw) => raw.startsWith(prefix),
    fromRaw: (raw) => raw.slice(prefix.length),
  };
}

export function realNamespace(): Namespace {
  return {
    toRaw: (name) =>
      name.startsWith(NAMESPACE_PREFIX) ? QUARANTINE + name : name,
    owns: (raw) =>
      !raw.startsWith(NAMESPACE_PREFIX) || raw.startsWith(QUARANTINE),
    fromRaw: (raw) =>
      raw.startsWith(QUARANTINE) ? raw.slice(QUARANTINE.length) : raw,
  };
}

/** Page-visible keys, in raw order. */
export function visibleNames(
  rawNames: Iterable<string>,
  ns: Namespace,
): string[] {
  const out: string[] = [];
  for (const raw of rawNames) if (ns.owns(raw)) out.push(ns.fromRaw(raw));
  return out;
}
