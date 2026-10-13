/* eslint-disable @typescript-eslint/no-explicit-any -- the browser event types are only reachable through `any`: it lets each registration infer its own handler parameters */

type AnyListener = (...args: any[]) => unknown;
type Addable = { addListener(listener: AnyListener, ...rest: any[]): void };

/** `event.addListener(listener, ...rest)` for any `chrome.*` event (listeners.ts, extras-listeners.ts). */
export const on = (event: unknown, listener: AnyListener, ...rest: unknown[]) =>
  (event as Addable).addListener(listener, ...rest);
