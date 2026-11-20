/**
 * Session Core — Session Recovery (AEGOX_multisession).
 *
 * Detects storage/API failures, corrupted metadata, and failed restorations.
 * Recovery preserves recoverable information and avoids destructive operations.
 *
 * Pure TypeScript: no `chrome.*` references.
 *
 * Derived from SplitSession's error-handling patterns
 * (https://github.com/Misyuk-T/splitsession, MIT License).
 */

/** Classification of a recovery problem. */
export type RecoveryErrorType =
  | "storage-error"
  | "corrupted-metadata"
  | "api-failure"
  | "missing-context"
  | "restoration-failed"
  | "incompatible-browser";

/** A recovery problem with context. */
export interface RecoveryProblem {
  type: RecoveryErrorType;
  message: string;
  /** Recoverable data, if any. */
  recoverableData?: unknown;
  /** Whether the problem is fatal (no safe recovery possible). */
  fatal: boolean;
  /** Timestamp when detected (epoch ms). */
  detectedAt: number;
}

/** Result of a recovery attempt. */
export interface RecoveryResult {
  /** Whether recovery succeeded. */
  recovered: boolean;
  /** Problems detected during recovery. */
  problems: RecoveryProblem[];
  /** Recovered sessions, if any. */
  recoveredSessions: Array<{ id: string; name: string }>;
  /** Whether user confirmation is required before proceeding. */
  confirmationRequired: boolean;
  /** Human-readable summary for the user. */
  summary: string;
}

/** Options for the recovery manager. */
export interface RecoveryOptions {
  /** Callback to log problems. */
  log?: (problem: RecoveryProblem) => void;
  /** Now function (ms). Default Date.now. */
  now?: () => number;
}

/**
 * Manages error detection and recovery for session data.
 * Never silently deletes user data.
 */
export class SessionRecovery {
  private problems: RecoveryProblem[] = [];
  private readonly now: () => number;

  constructor(private readonly options: RecoveryOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /** Returns all detected problems. */
  getProblems(): RecoveryProblem[] {
    return [...this.problems];
  }

  /** Clears all recorded problems. */
  clearProblems(): void {
    this.problems = [];
  }

  /** Records a storage error. */
  recordStorageError(message: string, recoverableData?: unknown): void {
    this.addProblem("storage-error", message, recoverableData, false);
  }

  /** Records corrupted metadata. */
  recordCorruptedMetadata(message: string, recoverableData?: unknown): void {
    this.addProblem("corrupted-metadata", message, recoverableData, false);
  }

  /** Records a browser API failure. */
  recordApiFailure(message: string, recoverableData?: unknown): void {
    this.addProblem("api-failure", message, recoverableData, false);
  }

  /** Records a missing browser context. */
  recordMissingContext(message: string, recoverableData?: unknown): void {
    this.addProblem("missing-context", message, recoverableData, false);
  }

  /** Records a failed restoration. */
  recordRestorationFailed(message: string, recoverableData?: unknown): void {
    this.addProblem("restoration-failed", message, recoverableData, false);
  }

  /** Records an incompatibility with the current browser. */
  recordIncompatibleBrowser(message: string): void {
    this.addProblem("incompatible-browser", message, undefined, true);
  }

  private addProblem(
    type: RecoveryErrorType,
    message: string,
    recoverableData: unknown | undefined,
    fatal: boolean,
  ): void {
    const problem: RecoveryProblem = {
      type,
      message,
      recoverableData,
      fatal,
      detectedAt: this.now(),
    };
    this.problems.push(problem);
    this.options.log?.(problem);
  }

  /**
   * Attempts recovery from a list of problems.
   * Returns what can be safely recovered and whether confirmation is needed.
   */
  attemptRecovery(
    availableSessions: Array<{ id: string; name: string }>,
  ): RecoveryResult {
    const fatal = this.problems.some((p) => p.fatal);
    const recoverable = this.problems.filter(
      (p) => p.recoverableData !== undefined,
    );
    const confirmationRequired =
      fatal || recoverable.length > 0 || this.problems.length > 0;

    const summary = this.buildSummary(fatal, recoverable.length);

    return {
      recovered: !fatal,
      problems: [...this.problems],
      recoveredSessions: availableSessions,
      confirmationRequired,
      summary,
    };
  }

  /** Checks if there are any problems requiring user attention. */
  hasProblems(): boolean {
    return this.problems.length > 0;
  }

  /** Checks if there is any fatal problem. */
  hasFatalProblem(): boolean {
    return this.problems.some((p) => p.fatal);
  }

  private buildSummary(fatal: boolean, recoverableCount: number): string {
    if (fatal) {
      return "A fatal problem was detected. Some data may not be recoverable. Please review the details.";
    }
    if (this.problems.length === 0) {
      return "No problems detected.";
    }
    if (recoverableCount > 0) {
      return `${this.problems.length} problem(s) detected; ${recoverableCount} have recoverable data. Review before proceeding.`;
    }
    return `${this.problems.length} problem(s) detected. Review before proceeding.`;
  }
}
