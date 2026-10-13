import { useRef, useState } from "preact/hooks";

import { describeError } from "../format";

export interface Status {
  text: string;
  error?: boolean;
}

/**
 * The status line (`say`: shown for 4 s, errors 8 s) and `run`, which runs one action at a time (`busy` meanwhile) and
 * says `failure: <reason>` when it throws.
 */
export function useStatus() {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const say = (text: string, error = false) => {
    setStatus({ text, error });
    if (statusTimer.current) clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(
      () => setStatus(null),
      error ? 8000 : 4000,
    );
  };

  const run = async (work: () => Promise<void>, failure: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await work();
    } catch (error) {
      say(`${failure}: ${describeError(error)}`, true);
    } finally {
      setBusy(false);
    }
  };

  return { busy, status, say, run };
}
