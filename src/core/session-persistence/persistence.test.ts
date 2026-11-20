/**
 * Unit tests for `src/core/session-persistence/persistence.ts`.
 * Uses MemoryStorageArea (no real browser storage required).
 */

import { describe, expect, it } from "vitest";

import { MemoryStorageArea } from "../../engine/storage/storage-area";
import {
  SessionPersistence,
  DEFAULT_PERSISTENCE_STATE,
  PERSISTENCE_STATE_KEY,
} from "./persistence";
import { createSession } from "../session-manager/session";

describe("SessionPersistence", () => {
  it("loads default state when nothing is stored", async () => {
    const area = new MemoryStorageArea();
    const pers = new SessionPersistence(area);
    await pers.load();
    expect(pers.getState()).toEqual(DEFAULT_PERSISTENCE_STATE);
  });

  it("loads stored state", async () => {
    const area = new MemoryStorageArea();
    await area.set({
      [PERSISTENCE_STATE_KEY]: {
        restorationPolicy: "selected",
        selectedSessionIds: ["s1", "s2"],
        lastWrittenAt: 5000,
        autoRestore: false,
      },
    });
    const pers = new SessionPersistence(area);
    await pers.load();
    const state = pers.getState();
    expect(state.restorationPolicy).toBe("selected");
    expect(state.selectedSessionIds).toEqual(["s1", "s2"]);
    expect(state.lastWrittenAt).toBe(5000);
    expect(state.autoRestore).toBe(false);
  });

  it("sets restoration policy", async () => {
    const area = new MemoryStorageArea();
    const pers = new SessionPersistence(area);
    await pers.load();
    await pers.setRestorationPolicy("none");
    expect(pers.getState().restorationPolicy).toBe("none");
    const stored = area.data.get(PERSISTENCE_STATE_KEY) as {
      restorationPolicy?: string;
    };
    expect(stored.restorationPolicy).toBe("none");
  });

  it("sets selected sessions", async () => {
    const area = new MemoryStorageArea();
    const pers = new SessionPersistence(area);
    await pers.load();
    await pers.setSelectedSessions(["a", "b", "a"]);
    expect(pers.getState().selectedSessionIds).toEqual(["a", "b"]);
  });

  it("sets auto restore", async () => {
    const area = new MemoryStorageArea();
    const pers = new SessionPersistence(area);
    await pers.load();
    await pers.setAutoRestore(false);
    expect(pers.getState().autoRestore).toBe(false);
  });

  it("selects all restorable sessions for 'all' policy", async () => {
    const area = new MemoryStorageArea();
    const pers = new SessionPersistence(area);
    await pers.setRestorationPolicy("all");

    const s1 = createSession({
      name: "A", domain: "a.com", profileId: "p1",
      createdAt: 1000, lastUsedAt: null, persistent: true, restorable: true,
    });
    const s2 = createSession({
      name: "B", domain: "b.com", profileId: "p1",
      createdAt: 1000, lastUsedAt: null, persistent: true, restorable: true,
    });
    const s3 = createSession({
      name: "C", domain: "c.com", profileId: "p1",
      createdAt: 1000, lastUsedAt: null, persistent: true, restorable: false,
    });
    const s4 = createSession({
      name: "D", domain: "d.com", profileId: "p1",
      createdAt: 1000, lastUsedAt: null, persistent: true, restorable: true,
    });
    // s4 is closed, should not be restored
    s4.state = "closed";

    const selected = pers.selectSessionsToRestore([s1, s2, s3, s4]);
    expect(selected.map((s) => s.id)).toEqual([s1.id, s2.id]);
  });

  it("selects only selected sessions for 'selected' policy", async () => {
    const area = new MemoryStorageArea();
    const pers = new SessionPersistence(area);
    await pers.setRestorationPolicy("selected");
    await pers.setSelectedSessions(["s2"]);

    const s1 = createSession({
      name: "A", domain: "a.com", profileId: "p1",
      createdAt: 1000, lastUsedAt: null, persistent: true, restorable: true,
    });
    s1.id = "s1";
    const s2 = createSession({
      name: "B", domain: "b.com", profileId: "p1",
      createdAt: 1000, lastUsedAt: null, persistent: true, restorable: true,
    });
    s2.id = "s2";

    const selected = pers.selectSessionsToRestore([s1, s2]);
    expect(selected.map((s) => s.id)).toEqual(["s2"]);
  });

  it("selects nothing for 'none' policy", async () => {
    const area = new MemoryStorageArea();
    const pers = new SessionPersistence(area);
    await pers.setRestorationPolicy("none");

    const s1 = createSession({
      name: "A", domain: "a.com", profileId: "p1",
      createdAt: 1000, lastUsedAt: null, persistent: true, restorable: true,
    });
    const selected = pers.selectSessionsToRestore([s1]);
    expect(selected).toEqual([]);
  });

  it("computeRestore returns restored and skipped sessions", async () => {
    const area = new MemoryStorageArea();
    const pers = new SessionPersistence(area);
    await pers.setRestorationPolicy("all");

    const s1 = createSession({
      name: "A", domain: "a.com", profileId: "p1",
      createdAt: 1000, lastUsedAt: null, persistent: true, restorable: true,
    });
    const s2 = createSession({
      name: "B", domain: "b.com", profileId: "p1",
      createdAt: 1000, lastUsedAt: null, persistent: true, restorable: true,
    });
    s2.state = "closed";
    const s3 = createSession({
      name: "C", domain: "c.com", profileId: "p1",
      createdAt: 1000, lastUsedAt: null, persistent: true, restorable: false,
    });

    const available = new Map<string, typeof s1>();
    available.set(s1.id, s1);

    const result = pers.computeRestore([s1, s2, s3], available);
    expect(result.restored.map((s) => s.id)).toEqual([s1.id]);
    expect(result.skipped.length).toBe(2);
    expect(result.ok).toBe(true);
  });

  it("marks dirty and updates lastWrittenAt", async () => {
    const area = new MemoryStorageArea();
    const pers = new SessionPersistence(area);
    await pers.load();
    const before = pers.getState().lastWrittenAt;
    await pers.markDirty();
    const after = pers.getState().lastWrittenAt;
    expect(after).toBeGreaterThanOrEqual(before);
  });
});
