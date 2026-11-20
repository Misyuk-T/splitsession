/**
 * Unit tests for `src/core/session-recovery/recovery.ts`.
 * Pure TypeScript: no browser APIs required.
 */

import { describe, expect, it } from "vitest";

import { SessionRecovery } from "./recovery";
import type { RecoveryProblem } from "./recovery";

describe("SessionRecovery", () => {
  it("starts with no problems", () => {
    const rec = new SessionRecovery();
    expect(rec.hasProblems()).toBe(false);
    expect(rec.hasFatalProblem()).toBe(false);
    expect(rec.getProblems()).toEqual([]);
  });

  it("records storage errors", () => {
    const rec = new SessionRecovery();
    rec.recordStorageError("write failed", { sessions: 5 });
    const problems = rec.getProblems();
    expect(problems.length).toBe(1);
    expect(problems[0]!.type).toBe("storage-error");
    expect(problems[0]!.message).toBe("write failed");
    expect(problems[0]!.recoverableData).toEqual({ sessions: 5 });
    expect(problems[0]!.fatal).toBe(false);
    expect(typeof problems[0]!.detectedAt).toBe("number");
  });

  it("records corrupted metadata", () => {
    const rec = new SessionRecovery();
    rec.recordCorruptedMetadata("invalid JSON", { partial: true });
    expect(rec.getProblems()[0]!.type).toBe("corrupted-metadata");
    expect(rec.getProblems()[0]!.fatal).toBe(false);
  });

  it("records API failures", () => {
    const rec = new SessionRecovery();
    rec.recordApiFailure("tabs.query failed");
    expect(rec.getProblems()[0]!.type).toBe("api-failure");
  });

  it("records missing contexts", () => {
    const rec = new SessionRecovery();
    rec.recordMissingContext("tab not found");
    expect(rec.getProblems()[0]!.type).toBe("missing-context");
  });

  it("records restoration failures", () => {
    const rec = new SessionRecovery();
    rec.recordRestorationFailed("restore timed out");
    expect(rec.getProblems()[0]!.type).toBe("restoration-failed");
  });

  it("records incompatible browser as fatal", () => {
    const rec = new SessionRecovery();
    rec.recordIncompatibleBrowser("storage API unavailable");
    expect(rec.hasFatalProblem()).toBe(true);
    expect(rec.getProblems()[0]!.fatal).toBe(true);
  });

  it("attemptRecovery returns summary and sessions", () => {
    const rec = new SessionRecovery();
    rec.recordStorageError("minor write delay");
    const result = rec.attemptRecovery([
      { id: "s1", name: "Session 1" },
      { id: "s2", name: "Session 2" },
    ]);
    expect(result.recovered).toBe(true);
    expect(result.recoveredSessions).toHaveLength(2);
    expect(result.problems.length).toBe(1);
    expect(result.summary).toContain("problem");
  });

  it("attemptRecovery marks unrecovered when fatal problem exists", () => {
    const rec = new SessionRecovery();
    rec.recordIncompatibleBrowser("no storage");
    const result = rec.attemptRecovery([]);
    expect(result.recovered).toBe(false);
    expect(result.confirmationRequired).toBe(true);
  });

  it("clearProblems removes all recorded problems", () => {
    const rec = new SessionRecovery();
    rec.recordStorageError("error");
    rec.clearProblems();
    expect(rec.hasProblems()).toBe(false);
    expect(rec.getProblems()).toEqual([]);
  });

  it("logs problems via callback", () => {
    const logged: RecoveryProblem[] = [];
    const rec = new SessionRecovery({
      log: (p) => logged.push(p),
    });
    rec.recordApiFailure("test failure");
    expect(logged.length).toBe(1);
    expect(logged[0]!.type).toBe("api-failure");
  });
});
