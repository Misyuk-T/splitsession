import { useCallback, useEffect, useState } from 'preact/hooks';
import type { BridgeState } from '../background/bridge/agent-bridge';
import { facetApi } from '../engine/api-client';
import { describeError } from './format';

export interface BridgeView {
  /** The `agentBridge` setting. */
  enabled: boolean;
  state: BridgeState;
}

const OFF: BridgeState = { status: 'off', error: null, actions: 0, lastTool: null, lastAt: null };

/** The agent bridge's setting and live state (polled while the page is open), with the switch and "check again". */
export function useBridge(pollMs = 1000): {
  view: BridgeView | null;
  error: string | null;
  busy: boolean;
  setEnabled(next: boolean): Promise<void>;
  retry(): Promise<void>;
} {
  const [view, setView] = useState<BridgeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [settings, state] = await Promise.all([facetApi.getSettings(), facetApi.getBridgeState()]);
      setView({ enabled: settings.agentBridge, state });
    } catch (e) {
      setError(describeError(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), pollMs);
    return () => clearInterval(timer);
  }, [load, pollMs]);

  const setEnabled = async (next: boolean) => {
    setBusy(true);
    setView((v) => ({ enabled: next, state: v?.state ?? OFF })); // optimistic; the background confirms
    try {
      await facetApi.updateSettings({ agentBridge: next });
      setError(null);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
      await load();
    }
  };

  const retry = async () => {
    try {
      await facetApi.retryBridge();
    } catch (e) {
      setError(describeError(e));
    }
    await load();
  };

  return { view, error, busy, setEnabled, retry };
}
