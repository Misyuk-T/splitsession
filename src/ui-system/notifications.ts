/**
 * Notification policy (AEGOX_multisession, Module 04).
 *
 * Pure decision logic for in-app and browser notifications. The UI owns the
 * actual `Notification` call and permission prompt; this module answers whether
 * a message may be shown and why not. Permission is never requested here.
 */

import type { NotificationCategory, NotificationPreferences } from "./preferences";

export type BrowserPermissionState = "granted" | "denied" | "default" | "unavailable";

export type NotificationEvent =
  | "session-created"
  | "session-paused"
  | "session-resumed"
  | "session-archived"
  | "session-deleted"
  | "profile-created"
  | "profile-archived"
  | "profile-expired"
  | "import-completed"
  | "storage-error";

export interface NotificationMessage {
  title: string;
  body: string;
  category: NotificationCategory;
  /** ISO-ish stable key used for de-duplication. */
  key: string;
}

export interface NotificationDecision {
  allowed: boolean;
  /** Why the message is blocked; null when allowed. */
  reason:
    | "category-disabled"
    | "in-app-disabled"
    | "browser-disabled"
    | "permission-denied"
    | "permission-not-requested"
    | "quiet-hours"
    | null;
  /** Human-readable explanation suitable for a settings panel. */
  explanation: string | null;
}

const EVENT_CATEGORY: Readonly<Record<NotificationEvent, NotificationCategory>> = {
  "session-created": "sessions",
  "session-paused": "sessions",
  "session-resumed": "sessions",
  "session-archived": "sessions",
  "session-deleted": "sessions",
  "profile-created": "profiles",
  "profile-archived": "profiles",
  "profile-expired": "security",
  "import-completed": "system",
  "storage-error": "security",
};

export function categoryForEvent(event: NotificationEvent): NotificationCategory {
  return EVENT_CATEGORY[event];
}

/** Local wall-clock minute of day. */
export function minuteOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * Quiet hours may wrap midnight (22:00-07:00). An equal start and end means
 * "never quiet" rather than a whole day, which is easier to reason about.
 */
export function isQuietHours(minute: number, start: number, end: number): boolean {
  if (start === end) return false;
  if (start < end) return minute >= start && minute < end;
  return minute >= start || minute < end;
}

/** True when the user's preferences and the real permission allow a message. */
export function canNotify(
  preferences: NotificationPreferences,
  category: NotificationCategory,
  channel: "in-app" | "browser",
  permission: BrowserPermissionState = "granted",
  now = new Date(),
): NotificationDecision {
  if (!preferences.categories[category]) {
    return {
      allowed: false,
      reason: "category-disabled",
      explanation: `The ${category} notification category is turned off.`,
    };
  }
  if (preferences.quietHours.enabled) {
    const minute = minuteOfDay(now);
    if (isQuietHours(minute, preferences.quietHours.start, preferences.quietHours.end)) {
      return {
        allowed: false,
        reason: "quiet-hours",
        explanation: "Quiet hours are active; messages stay silent until they end.",
      };
    }
  }
  if (channel === "in-app") {
    return preferences.inApp
      ? { allowed: true, reason: null, explanation: null }
      : {
          allowed: false,
          reason: "in-app-disabled",
          explanation: "In-app notifications are turned off.",
        };
  }
  if (!preferences.browser) {
    return {
      allowed: false,
      reason: "browser-disabled",
      explanation: "Browser notifications are turned off in the dashboard settings.",
    };
  }
  if (permission === "unavailable") {
    return {
      allowed: false,
      reason: "permission-denied",
      explanation: "This browser or page cannot show system notifications.",
    };
  }
  if (permission === "denied") {
    return {
      allowed: false,
      reason: "permission-denied",
      explanation:
        "The browser blocked notification permission. Enable it in the browser's site settings; the dashboard will not ask again.",
    };
  }
  if (permission === "default") {
    return {
      allowed: false,
      reason: "permission-not-requested",
      explanation:
        "Permission has not been granted yet. Use the enable button once; the dashboard never requests it repeatedly.",
    };
  }
  return { allowed: true, reason: null, explanation: null };
}

/** Message templates. Bodies contain only names from the stores, never secrets. */
export function buildMessage(event: NotificationEvent, subject: string): NotificationMessage {
  const category = categoryForEvent(event);
  const key = `${event}:${subject}`;
  switch (event) {
    case "session-created":
      return { title: "Session created", body: `“${subject}” is ready.`, category, key };
    case "session-paused":
      return { title: "Session paused", body: `“${subject}” is paused.`, category, key };
    case "session-resumed":
      return { title: "Session resumed", body: `“${subject}” is active again.`, category, key };
    case "session-archived":
      return { title: "Session archived", body: `“${subject}” was archived, not deleted.`, category, key };
    case "session-deleted":
      return { title: "Session deleted", body: `“${subject}” was deleted.`, category, key };
    case "profile-created":
      return { title: "Profile created", body: `“${subject}” is ready.`, category, key };
    case "profile-archived":
      return { title: "Profile archived", body: `“${subject}” was archived.`, category, key };
    case "profile-expired":
      return {
        title: "Temporary profile expired",
        body: `“${subject}” reached its expiry. Nothing was deleted automatically.`,
        category,
        key,
      };
    case "import-completed":
      return { title: "Import completed", body: subject, category, key };
    case "storage-error":
      return { title: "Storage problem", body: subject, category, key };
  }
}

/**
 * Bounded in-memory de-duplicator. It is not a log and never persists; it only
 * prevents the same event from producing two messages in a short window.
 */
export class NotificationThrottle {
  private readonly seen = new Map<string, number>();

  constructor(private readonly windowMs = 15_000, private readonly maxEntries = 100) {}

  /** Returns true when the caller may show this key now. */
  shouldNotify(key: string, now = Date.now()): boolean {
    const previous = this.seen.get(key);
    if (previous !== undefined && now - previous < this.windowMs) return false;
    this.seen.set(key, now);
    if (this.seen.size > this.maxEntries) {
      const oldest = [...this.seen.entries()].sort((a, b) => a[1] - b[1])[0];
      if (oldest) this.seen.delete(oldest[0]);
    }
    return true;
  }

  clear(): void {
    this.seen.clear();
  }
}

/** Returns a short, human-readable label for a notification category. */
export function categoryLabel(category: NotificationCategory): string {
  return {
    sessions: "Sesiones",
    profiles: "Perfiles",
    security: "Seguridad",
    system: "Sistema",
  }[category];
}

/** Returns the default enabled state for a category. */
export function defaultCategoryEnabled(category: NotificationCategory): boolean {
  return category !== "system";
}
