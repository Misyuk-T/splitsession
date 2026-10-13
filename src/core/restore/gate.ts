import type { DnrRule } from "../dnr/rule-compiler";
import { GATE_PRIORITY, GATE_RULE_ID_BASE, MAX_GATE_RULES } from "./constants";

/** The URL as a request carries it (no fragment); null for anything but http(s). */
export function gateKey(url: string | undefined): string | null {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
}

/**
 * `urlFilter` matching exactly `key` (`|…|`). `*`, `^` and `|` have a meaning in a filter and cannot be escaped: such
 * a URL is matched by its prefix up to the first of them (a little wider). Null for URLs a filter cannot hold (non-ASCII,
 * very long).
 */
export function gateUrlFilter(key: string): string | null {
  if (key.length > 2048 || !/^[\x21-\x7e]+$/.test(key)) return null;
  const special = key.search(/[*^|]/);
  if (special === -1) return `|${key}|`;
  const prefix = key.slice(0, special);
  return /^https?:\/\/[^/]+\//i.test(prefix) ? `|${prefix}` : null;
}

/** The dynamic `block` rules of the gate, one per filter (deduplicated, at most MAX_GATE_RULES). */
export function compileGateRules(keys: Iterable<string>): DnrRule[] {
  const filters = new Set<string>();
  for (const key of keys) {
    const filter = gateUrlFilter(key);
    if (filter) filters.add(filter);
    if (filters.size >= MAX_GATE_RULES) break;
  }
  return [...filters].sort().map((urlFilter, i) => ({
    id: GATE_RULE_ID_BASE + i,
    priority: GATE_PRIORITY,
    condition: { urlFilter, resourceTypes: ["main_frame"] },
    action: { type: "block" },
  }));
}

/**
 * Session `allow` rules that open the gate: for every tab SplitSession already knows (`clearedTabs`), and for every tab on
 * the URLs that are gated only for the next browser start (`openKeys`: URLs of container tabs that are open now, not
 * of tabs that could come back from "recently closed"). IDs from `next()`.
 */
export function compileGateOpeners(
  clearedTabs: Iterable<number>,
  openKeys: Iterable<string>,
  next: () => number,
): DnrRule[] {
  const rules: DnrRule[] = [];
  const tabIds = [...new Set(clearedTabs)]
    .filter((id) => Number.isInteger(id) && id >= 0)
    .sort((a, b) => a - b);
  if (tabIds.length > 0) {
    rules.push({
      id: next(),
      priority: GATE_PRIORITY,
      condition: { tabIds, resourceTypes: ["main_frame"] },
      action: { type: "allow" },
    });
  }
  const filters = new Set<string>();
  for (const key of openKeys) {
    const filter = gateUrlFilter(key);
    if (filter) filters.add(filter);
    if (filters.size >= MAX_GATE_RULES) break;
  }
  for (const urlFilter of [...filters].sort()) {
    rules.push({
      id: next(),
      priority: GATE_PRIORITY,
      condition: { urlFilter, resourceTypes: ["main_frame"] },
      action: { type: "allow" },
    });
  }
  return rules;
}
