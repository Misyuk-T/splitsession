/**
 * Container tabs that come back: browser restart with session restore, Ctrl/Cmd+Shift+T and History's "Recently
 * closed", a closed (saved) SplitSession tab group opened again. Pure part: what SplitSession remembers about container tabs, how a
 * tab that appears is matched to that memory, the group-title marker, and the declarativeNetRequest gate that keeps
 * such a tab from sending anything before it is matched. The stateful part is `src/background/restore.ts`; the
 * reasoning is in docs/decisions.md ("Container tabs that come back").
 */

export * from "./restore/constants";
export * from "./restore/gate";
export * from "./restore/group-marker";
export * from "./restore/held-page";
export * from "./restore/matching";
export * from "./restore/records";
export * from "./restore/sessions";
export * from "./restore/windows";
