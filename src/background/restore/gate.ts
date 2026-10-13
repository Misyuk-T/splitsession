import {
  type CompiledRules,
  compileGateOpeners,
  compileGateRules,
  GATE_RULE_ID_BASE,
  gateKey,
  MAX_GATE_RULES,
  persistentGateKeys,
  type RestoreRecord,
  type RuleIdAllocator,
  runtimeGateKeys,
} from "../../core";
import type { Logger } from "../log";
import type { HeldEntry, RestoreBrowser } from "./types";

export interface RestoreGateDeps {
  dnr: RestoreBrowser["declarativeNetRequest"];
  /** Recompiles the session openers (`RESTORE_KEY`); resolves once they are installed. */
  invalidate(): Promise<boolean>;
  log: Logger;
  /** Whether restoring is on (read whenever the gate is computed or synced). */
  enabled(): boolean;
}

const isGateRuleId = (id: number) =>
  id >= GATE_RULE_ID_BASE && id < GATE_RULE_ID_BASE + MAX_GATE_RULES;

/**
 * The gate: which addresses SplitSession may have to restore, as dynamic declarativeNetRequest `block` rules (they
 * survive a browser restart and apply before any extension code runs) and session `allow` rules that open it for the
 * tabs SplitSession knows and for addresses that only matter at the next start.
 */
export class RestoreGate {
  /** Gated addresses: the dynamic block rules. */
  private persistentKeys = new Set<string>();
  /** Of those, the addresses a new tab is held on now; the others are open to everyone until the next start. */
  private runtimeKeys = new Set<string>();
  /** Joined filters of the dynamic gate rules installed now (null: not read yet). */
  private installedGate: string | null = null;
  private installedGateIds: number[] = [];
  private dynamicWork: Promise<void> = Promise.resolve();

  constructor(private readonly d: RestoreGateDeps) {}

  /** The address (gate key) is gated: a tab SplitSession does not know is held on it. */
  gates(key: string): boolean {
    return this.persistentKeys.has(key);
  }

  /** A new tab on this address is matched before it may load (records say it may come back now). */
  holdsNew(key: string): boolean {
    return this.runtimeKeys.has(key);
  }

  /** Recomputes the gated addresses; true when the session openers change. */
  recompute(
    records: RestoreRecord[],
    present: Set<string>,
    startupUntil: number,
    held: Iterable<HeldEntry>,
  ): boolean {
    const enabled = this.d.enabled();
    const now = Date.now();
    const before = this.openKeys().join("\n");
    this.persistentKeys = enabled
      ? new Set(persistentGateKeys(records, present, now, startupUntil))
      : new Set();
    this.runtimeKeys = enabled
      ? runtimeGateKeys(records, present, now, startupUntil)
      : new Set();
    // A waiting tab stays held whatever its records say.
    if (enabled)
      for (const h of held)
        if (gateKey(h.url)) this.runtimeKeys.add(gateKey(h.url)!);
    for (const k of this.runtimeKeys) this.persistentKeys.add(k);
    return before !== this.openKeys().join("\n");
  }

  /** Gated addresses open to everyone (they only matter at the next start). */
  private openKeys(): string[] {
    return [...this.persistentKeys].filter((k) => !this.runtimeKeys.has(k));
  }

  /** Session rules of `RESTORE_KEY`: the gate is open for `cleared` tabs and for the open addresses. */
  openers(
    cleared: ReadonlySet<number>,
    allocator: RuleIdAllocator,
  ): CompiledRules | null {
    const addRules = compileGateOpeners(cleared, this.openKeys(), () =>
      allocator.next(),
    );
    return addRules.length > 0
      ? { addRules, ruleIds: addRules.map((r) => r.id), regexRuleCount: 0 }
      : null;
  }

  /**
   * Makes the dynamic gate rules match the gated addresses. Openers for new addresses are installed first (session
   * rules), so a new block never catches a tab it should not.
   */
  sync(): Promise<void> {
    this.dynamicWork = this.dynamicWork
      .then(async () => {
        const { dnr } = this.d;
        if (this.installedGate === null) {
          const existing = await dnr.getDynamicRules();
          this.installedGateIds = existing
            .map((r) => r.id)
            .filter(isGateRuleId);
          this.installedGate = (
            existing as Array<{
              id: number;
              condition?: { urlFilter?: string };
            }>
          )
            .filter((r) => this.installedGateIds.includes(r.id))
            .map((r) => r.condition?.urlFilter ?? "")
            .sort()
            .join("\n");
        }
        const rules = this.d.enabled()
          ? compileGateRules(this.persistentKeys)
          : [];
        const joined = rules.map((r) => r.condition.urlFilter!).join("\n");
        if (joined === this.installedGate) return;
        if (rules.length > 0) await this.d.invalidate();
        await dnr.updateDynamicRules({
          removeRuleIds: this.installedGateIds,
          addRules: rules,
        });
        this.installedGate = joined;
        this.installedGateIds = rules.map((r) => r.id);
      })
      .catch((error) => {
        this.installedGate = null;
        this.d.log("error", "updating the restore gate failed", String(error));
      });
    return this.dynamicWork;
  }

  /** Resolves once the last `sync` has finished. */
  synced(): Promise<void> {
    return this.dynamicWork;
  }

  /** Diagnostics (e2e). */
  debug(): { gated: string[]; runtime: string[] } {
    return { gated: [...this.persistentKeys], runtime: [...this.runtimeKeys] };
  }
}
