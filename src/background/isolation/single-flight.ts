/** A call made while the previous one is still running gets that run's promise; once it settles, the next call starts a new run. */
export function singleFlight(run: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  return () => {
    running ??= run().finally(() => {
      running = null;
    });
    return running;
  };
}
