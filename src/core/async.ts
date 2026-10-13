/** Small timing helpers shared by the background modules (pure: timers only, no `chrome.*`). */

export const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Waiters for a condition that some event makes true: `until` resolves with the first non-null `check()` (checked now
 * and on every `wake()`), or with `onTimeout()` after `ms`.
 */
export class Wakeups {
  private readonly waiters = new Set<() => void>();

  wake(): void {
    for (const wake of [...this.waiters]) wake();
  }

  until<T>(
    check: () => T | null,
    ms: number,
    onTimeout: () => T | null,
  ): Promise<T | null> {
    const now = check();
    if (now !== null) return Promise.resolve(now);
    return new Promise((resolve) => {
      const done = (value: T | null) => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve(value);
      };
      const wake = () => {
        const value = check();
        if (value !== null) done(value);
      };
      const timer = setTimeout(() => done(onTimeout()), ms);
      this.waiters.add(wake);
    });
  }
}

/** Deletes the entries of `map` that `stale` picks (in place). */
export function deleteWhere<K, V>(
  map: Map<K, V>,
  stale: (value: V, key: K) => boolean,
): void {
  for (const [key, value] of map) if (stale(value, key)) map.delete(key);
}

/** Runs `run` `delay` ms after the last `schedule()`, and at the latest `maxWait` ms after the first one of a burst. */
export class Debounced {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstAt = 0;

  constructor(
    private readonly run: () => void,
    private readonly delay: number,
    private readonly maxWait: number,
  ) {}

  /** A run is scheduled and has not happened yet. */
  get pending(): boolean {
    return this.timer !== null;
  }

  schedule(): void {
    const now = Date.now();
    if (this.timer) clearTimeout(this.timer);
    else this.firstAt = now;
    const wait = Math.max(
      0,
      Math.min(this.delay, this.firstAt + this.maxWait - now),
    );
    this.timer = setTimeout(() => {
      this.timer = null;
      this.run();
    }, wait);
  }

  /** Drops the scheduled run (the caller runs the work itself). */
  cancel(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
