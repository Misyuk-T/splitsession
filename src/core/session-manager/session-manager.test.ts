/**
 * Unit tests for `src/core/session-manager/session-manager.ts`.
 * Uses MemoryStorageArea (no real browser storage required).
 */

import { describe, expect, it } from "vitest";

import { MemoryStorageArea } from "../../engine/storage/storage-area";
import { SessionManager, SESSIONS_KEY } from "./session-manager";
import { createSession } from "./session";

describe("SessionManager", () => {
  it("starts empty and persists created sessions", async () => {
    const area = new MemoryStorageArea();
    const mgr = new SessionManager(area);
    await mgr.load();
    expect(mgr.list()).toEqual([]);

    const created = await mgr.create({ name: "Work", domain: "example.com" });
    expect(created.session.metadata.name).toBe("Work");
    expect(created.session.metadata.domain).toBe("example.com");
    expect(created.session.state).toBe("active");
    expect(created.duplicateDetected).toBe(false);

    const list = mgr.list();
    expect(list.length).toBe(1);
    expect(list[0]!.id).toBe(created.session.id);

    const stored = area.data.get(SESSIONS_KEY);
    expect(Array.isArray(stored)).toBe(true);
    expect((stored as unknown[]).length).toBe(1);
  });

  it("rejects duplicate names", async () => {
    const area = new MemoryStorageArea();
    const mgr = new SessionManager(area);
    await mgr.create({ name: "Work" });
    await expect(mgr.create({ name: "WORK" })).rejects.toThrow();
  });

  it("gets and resolves sessions by ID and name", async () => {
    const area = new MemoryStorageArea();
    const mgr = new SessionManager(area);
    const created = await mgr.create({ name: "Work", domain: "example.com" });

    const byId = mgr.get(created.session.id);
    expect(byId?.id).toBe(created.session.id);

    const byName = mgr.resolve("work");
    expect(byName?.id).toBe(created.session.id);

    expect(mgr.get("nonexistent")).toBeUndefined();
  });

  it("updates session metadata", async () => {
    const area = new MemoryStorageArea();
    const mgr = new SessionManager(area);
    const created = await mgr.create({ name: "Work", domain: "example.com" });

    const updated = await mgr.update(created.session.id, {
      name: "Work Updated",
      domain: "work.example.com",
    });
    expect(updated.metadata.name).toBe("Work Updated");
    expect(updated.metadata.domain).toBe("work.example.com");
    expect(updated.id).toBe(created.session.id);
  });

  it("changes session state", async () => {
    const area = new MemoryStorageArea();
    const mgr = new SessionManager(area);
    const created = await mgr.create({ name: "Work" });

    const paused = await mgr.setState(created.session.id, "paused");
    expect(paused.state).toBe("paused");

    const active = await mgr.setState(created.session.id, "active");
    expect(active.state).toBe("active");
  });

  it("deletes a session", async () => {
    const area = new MemoryStorageArea();
    const mgr = new SessionManager(area);
    const created = await mgr.create({ name: "Work" });

    const deleted = await mgr.delete(created.session.id);
    expect(deleted).toBe(true);
    expect(mgr.get(created.session.id)).toBeUndefined();
    expect(mgr.delete("nonexistent")).resolves.toBe(false);
  });

  it("detects duplicates by domain + profile, not name", async () => {
    const area = new MemoryStorageArea();
    const mgr = new SessionManager(area);

    await mgr.create({ name: "Personal", domain: "example.com", profileId: "p1" });
    const result = await mgr.create({
      name: "Work",
      domain: "example.com",
      profileId: "p1",
    });
    expect(result.duplicateDetected).toBe(true);
    expect(result.session.metadata.name).toBe("Work");
  });

  it("does not flag different profiles as duplicates", async () => {
    const area = new MemoryStorageArea();
    const mgr = new SessionManager(area);

    await mgr.create({ name: "Work", domain: "example.com", profileId: "p1" });
    const result = await mgr.create({
      name: "Work",
      domain: "example.com",
      profileId: "p2",
    });
    expect(result.duplicateDetected).toBe(false);
  });

  it("loads existing sessions from storage", async () => {
    const area = new MemoryStorageArea();
    const session = createSession({
      name: "Persisted",
      domain: "example.com",
      profileId: "p1",
      createdAt: 1000,
      lastUsedAt: 2000,
      persistent: true,
      restorable: true,
    });
    await area.set({ [SESSIONS_KEY]: [session] });

    const mgr = new SessionManager(area);
    await mgr.load();
    expect(mgr.list().length).toBe(1);
    expect(mgr.list()[0]!.metadata.name).toBe("Persisted");
  });
});
