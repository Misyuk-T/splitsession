export * from "./async";
export * from "./dnr/rule-compiler";
export * from "./domain-rules";
export * from "./exemptions";
export * from "./group-restore";
export * from "./indicators";
export * from "./jar/cookie-jar";
export * from "./jar/set-cookie-parser";
export * from "./names";
export * from "./page-key";
export * from "./restore";
export * from "./saved-tabs";
export * from "./settings";
export * from "./site";
export * from "./transfer";
export * from "./types";

// --- Session Core (AEGOX_multisession) ---
export * from "./session-manager/session";
export * from "./session-manager/session-manager";
// The lifecycle predicates are exported selectively: `isExpired` and `isClosed`
// already exist in the SplitSession core (`jar/cookie-jar`, `restore`), and a
// wildcard export would make those names ambiguous.
export {
  allowedNextStates,
  attemptTransition,
  evaluatePause,
  evaluateResume,
  isValidTransition,
  isTerminal,
} from "./session-lifecycle/lifecycle";
export type {
  LifecycleState,
  PauseRules,
  TransitionResult,
} from "./session-lifecycle/lifecycle";
export * from "./session-persistence/persistence";
export * from "./session-duplicate/duplicate-detector";
export * from "./session-recovery/recovery";
