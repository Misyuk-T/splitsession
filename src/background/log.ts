export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  at: number;
  level: LogLevel;
  message: string;
  data?: unknown;
}

export interface Logger {
  (level: LogLevel, message: string, data?: unknown): void;
  /** Most recent entries (bounded), for the options Diagnostics and e2e. */
  entries(): LogEntry[];
}

export function createLogger(capacity = 300): Logger {
  const buffer: LogEntry[] = [];
  const log = ((level: LogLevel, message: string, data?: unknown) => {
    buffer.push({ at: Date.now(), level, message, data });
    if (buffer.length > capacity) buffer.splice(0, buffer.length - capacity);
    /* eslint-disable no-console -- this is the extension's one logging seam (debug-level lines go to the DevTools console) */
    const method =
      level === "error"
        ? console.error
        : level === "warn"
          ? console.warn
          : console.debug;
    /* eslint-enable no-console */
    if (data === undefined) method(`[splitsession] ${message}`);
    else method(`[splitsession] ${message}`, data);
  }) as Logger;
  log.entries = () => buffer.map((e) => ({ ...e }));
  return log;
}

/** A `.catch` handler that logs the failure as an error under `message`. */
export const logFailure =
  (log: Logger, message: string) =>
  (error: unknown): void =>
    log("error", message, String(error));
