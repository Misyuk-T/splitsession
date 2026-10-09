export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  at: number;
  level: LogLevel;
  message: string;
  data?: unknown;
}

export interface Logger {
  (level: LogLevel, message: string, data?: unknown): void;
  /** Most recent entries (bounded), for the state page and e2e diagnostics. */
  entries(): LogEntry[];
}

export function createLogger(capacity = 300): Logger {
  const buffer: LogEntry[] = [];
  const log = ((level: LogLevel, message: string, data?: unknown) => {
    buffer.push({ at: Date.now(), level, message, data });
    if (buffer.length > capacity) buffer.splice(0, buffer.length - capacity);
    const method = level === 'error' ? console.error : level === 'warn' ? console.warn : console.debug;
    if (data === undefined) method(`[facet] ${message}`);
    else method(`[facet] ${message}`, data);
  }) as Logger;
  log.entries = () => buffer.map((e) => ({ ...e }));
  return log;
}
