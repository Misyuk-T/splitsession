import { describe, expect, it } from "vitest";

import { defaultPreferences, type NotificationPreferences } from "./preferences";
import {
  NotificationThrottle,
  buildMessage,
  canNotify,
  categoryForEvent,
  isQuietHours,
  minuteOfDay,
} from "./notifications";

const prefs = (patch: Partial<NotificationPreferences> = {}): NotificationPreferences =>
  ({
    ...defaultPreferences().notifications,
    ...patch,
    categories: {
      ...defaultPreferences().notifications.categories,
      ...(patch.categories ?? {}),
    },
    quietHours: {
      ...defaultPreferences().notifications.quietHours,
      ...patch.quietHours,
    },
  }) as NotificationPreferences;

const at = (hour: number, minute = 0) => new Date(2026, 0, 1, hour, minute, 0, 0);

describe("notification categories", () => {
  it("maps events to categories", () => {
    expect(categoryForEvent("session-created")).toBe("sessions");
    expect(categoryForEvent("profile-created")).toBe("profiles");
    expect(categoryForEvent("profile-expired")).toBe("security");
    expect(categoryForEvent("import-completed")).toBe("system");
  });

  it("respects disabled categories", () => {
    const decision = canNotify(
      prefs({
        categories: { ...defaultPreferences().notifications.categories, sessions: false },
      }),
      "sessions",
      "in-app",
      "granted",
      at(12),
    );
    expect(decision).toMatchObject({ allowed: false, reason: "category-disabled" });
    expect(decision.explanation).toContain("turned off");
  });

  it("allows in-app messages when enabled", () => {
    const decision = canNotify(prefs(), "sessions", "in-app", "denied", at(12));
    expect(decision).toEqual({ allowed: true, reason: null, explanation: null });
  });

  it("blocks in-app messages when in-app is disabled", () => {
    expect(canNotify(prefs({ inApp: false }), "profiles", "in-app", "granted", at(12))).toMatchObject({
      allowed: false,
      reason: "in-app-disabled",
    });
  });
});

describe("browser permission handling", () => {
  it("requires the browser preference and granted permission", () => {
    expect(canNotify(prefs({ browser: false }), "sessions", "browser", "granted", at(12))).toMatchObject({
      allowed: false,
      reason: "browser-disabled",
    });
    expect(canNotify(prefs({ browser: true }), "sessions", "browser", "granted", at(12)).allowed).toBe(true);
  });

  it("explains denied, default and unavailable permission without re-asking", () => {
    const denied = canNotify(prefs({ browser: true }), "sessions", "browser", "denied", at(12));
    expect(denied.reason).toBe("permission-denied");
    expect(denied.explanation).toContain("will not ask again");

    const unset = canNotify(prefs({ browser: true }), "sessions", "browser", "default", at(12));
    expect(unset.reason).toBe("permission-not-requested");
    expect(unset.explanation).toContain("never requests it repeatedly");

    const unavailable = canNotify(prefs({ browser: true }), "sessions", "browser", "unavailable", at(12));
    expect(unavailable.reason).toBe("permission-denied");
  });
});

describe("quiet hours", () => {
  it("handles same-day and midnight-wrapping windows", () => {
    expect(isQuietHours(12 * 60, 9 * 60, 17 * 60)).toBe(true);
    expect(isQuietHours(8 * 60, 9 * 60, 17 * 60)).toBe(false);
    expect(isQuietHours(23 * 60, 22 * 60, 7 * 60)).toBe(true);
    expect(isQuietHours(6 * 60, 22 * 60, 7 * 60)).toBe(true);
    expect(isQuietHours(12 * 60, 22 * 60, 7 * 60)).toBe(false);
    expect(isQuietHours(12 * 60, 10 * 60, 10 * 60)).toBe(false);
  });

  it("computes the local minute of day", () => {
    expect(minuteOfDay(at(13, 45))).toBe(13 * 60 + 45);
  });

  it("blocks messages during quiet hours", () => {
    const quiet = prefs({ quietHours: { enabled: true, start: 22 * 60, end: 7 * 60 } });
    expect(canNotify(quiet, "sessions", "in-app", "granted", at(23))).toMatchObject({
      allowed: false,
      reason: "quiet-hours",
    });
    expect(canNotify(quiet, "sessions", "in-app", "granted", at(12)).allowed).toBe(true);
  });

  it("ignores quiet hours when disabled", () => {
    const quiet = prefs({ quietHours: { enabled: false, start: 0, end: 23 * 60 + 59 } });
    expect(canNotify(quiet, "sessions", "in-app", "granted", at(12)).allowed).toBe(true);
  });
});

describe("messages and throttling", () => {
  it("builds honest messages without secret material", () => {
    const message = buildMessage("session-created", "Work GitHub");
    expect(message).toMatchObject({
      title: "Session created",
      category: "sessions",
      key: "session-created:Work GitHub",
    });
    expect(message.body).toContain("Work GitHub");
    expect(buildMessage("profile-expired", "Temp").body).toContain("Nothing was deleted automatically");
  });

  it("de-duplicates identical keys inside the window", () => {
    const throttle = new NotificationThrottle(10_000);
    expect(throttle.shouldNotify("a", 1000)).toBe(true);
    expect(throttle.shouldNotify("a", 2000)).toBe(false);
    expect(throttle.shouldNotify("b", 2000)).toBe(true);
    expect(throttle.shouldNotify("a", 12_000)).toBe(true);
    throttle.clear();
    expect(throttle.shouldNotify("a", 12_001)).toBe(true);
  });

  it("bounds its memory", () => {
    const throttle = new NotificationThrottle(0, 3);
    for (let index = 0; index < 10; index += 1) throttle.shouldNotify(`key-${index}`, index);
    expect(throttle.shouldNotify("key-0", 100)).toBe(true);
  });
});