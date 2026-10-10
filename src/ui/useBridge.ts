import { useCallback, useEffect, useState } from 'preact/hooks';
import type { BridgeState } from '../background/bridge/agent-bridge';
import { facetApi } from '../engine/api-client';
import { describeError } from './format';

export interface BridgeView {
  /** The `agentBridge` setting. */
  enabled: boolean;
  /** The `agentActivity` setting: show on tabs what the agent touches. */
  activity: boolean;
  state: BridgeState;
}

const OFF: BridgeState = { status: 'off', error: null, actions: 0, lastTool: null, lastAt: null, recent: [] };

/** The agent bridge's setting and live state (polled while the page is open), with the switch and "check again". */
export function useBridge(pollMs = 1000): {
  view: BridgeView | null;
  error: string | null;
  busy: boolean;
  setEnabled(next: boolean): Promise<void>;
  setActivity(next: boolean): Promise<void>;
  retry(): Promise<void>;
} {
  const [view, setView] = useState<BridgeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [settings, state] = await Promise.all([facetApi.getSettings(), facetApi.getBridgeState()]);
      setView({ enabled: settings.agentBridge, activity: settings.agentActivity, state });
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
    setView((v) => ({ enabled: next, activity: v?.activity ?? true, state: v?.state ?? OFF })); // optimistic; the background confirms
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

  const setActivity = async (next: boolean) => {
    setView((v) => (v ? { ...v, activity: next } : v));
    try {
      await facetApi.updateSettings({ agentActivity: next });
      setError(null);
    } catch (e) {
      setError(describeError(e));
    }
    await load();
  };

  const retry = async () => {
    try {
      await facetApi.retryBridge();
    } catch (e) {
      setError(describeError(e));
    }
    await load();
  };

  return { view, error, busy, setEnabled, setActivity, retry };
}
