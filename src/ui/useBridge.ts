import { useCallback, useEffect, useState } from "preact/hooks";
import { browser } from "wxt/browser";

import type { BridgeState } from "../background/bridge/agent-bridge";
import {
  BRIDGE_CONSENT_VERSION,
  NATIVE_MESSAGING,
} from "../core/bridge-consent";
import { facetApi } from "../engine/api-client";
import { describeError } from "./format";

export interface BridgeView {
  /** The `agentBridge` setting. */
  enabled: boolean;
  /** The `agentActivity` setting: show on tabs what the agent touches. */
  activity: boolean;
  state: BridgeState;
}

const OFF: BridgeState = {
  status: "off",
  error: null,
  actions: 0,
  lastTool: null,
  lastAt: null,
  recent: [],
  profileLabel: "",
  profileKey: null,
  profiles: null,
  hostOutdated: false,
};

const PERMISSION_DENIED =
  "Chrome did not give SplitSession permission to talk to a program on this computer, so the agent bridge stays off.";

/**
 * Chrome's permission for the native host. The unpacked Full declares it, so `contains` is true and nothing is asked. The store
 * build asks here, in a page the user is looking at (the request needs a click, and the popup would close when Chrome's prompt
 * takes the focus). Chrome may grant it again without a prompt after it was taken back; the bridge's own consent is a separate
 * step and is always asked (`BridgeConsentDialog`).
 */
async function ensureNativeMessaging(): Promise<boolean> {
  const permissions = browser.permissions as unknown as {
    contains(p: { permissions: string[] }): Promise<boolean>;
    request(p: { permissions: string[] }): Promise<boolean>;
  };
  const request = { permissions: [NATIVE_MESSAGING] };
  try {
    return (
      (await permissions.contains(request)) ||
      (await permissions.request(request))
    );
  } catch {
    return false;
  }
}

/**
 * The agent bridge's setting and live state (polled while the page is open), with the switch and "check again". Turning
 * the switch on without the user's consent on record does not reach the background: it opens the disclosure instead
 * (`consent.asking`), and only "Allow agent access" records consent and turns the bridge on. In the store build the same
 * click first asks Chrome for the `nativeMessaging` permission; a refusal leaves the bridge off, with a message. The
 * background refuses `agentBridge: true` without consent or the permission anyway (src/background/bridge/consent.ts).
 */
export function useBridge(pollMs = 1000): {
  view: BridgeView | null;
  error: string | null;
  busy: boolean;
  setEnabled(next: boolean): Promise<void>;
  setActivity(next: boolean): Promise<void>;
  retry(): Promise<void>;
  consent: {
    /** The disclosure dialog is open. */
    asking: boolean;
    error: string | null;
    allow(): Promise<void>;
    cancel(): void;
  };
} {
  const [view, setView] = useState<BridgeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  // Whether consent is on record (null: not read yet). Known before the click, so Chrome's prompt can be the click's first await.
  const [consented, setConsented] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    try {
      const [settings, state, consent] = await Promise.all([
        facetApi.getSettings(),
        facetApi.getBridgeState(),
        facetApi.getBridgeConsent(),
      ]);
      setConsented(consent !== null);
      setView({
        enabled: settings.agentBridge,
        activity: settings.agentActivity,
        state,
      });
    } catch (e) {
      setError(describeError(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), pollMs);
    return () => clearInterval(timer);
  }, [load, pollMs]);

  const switchTo = async (next: boolean) => {
    setBusy(true);
    setView((v) => ({
      enabled: next,
      activity: v?.activity ?? true,
      state: v?.state ?? OFF,
    })); // optimistic; the background confirms
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

  const setEnabled = async (next: boolean) => {
    if (next) {
      // Consent first: Chrome's prompt must not come before the user has read the disclosure.
      if (consented === false) {
        setConsentError(null);
        setAsking(true);
        return;
      }
      // The first await of the click, so the click still counts for Chrome when it is asked.
      const granted = await ensureNativeMessaging();
      if (!granted) {
        setError(PERMISSION_DENIED);
        return;
      }
      let known: boolean;
      try {
        known = (await facetApi.getBridgeConsent()) !== null;
      } catch (e) {
        setError(describeError(e));
        return;
      }
      if (!known) {
        setConsentError(null);
        setAsking(true);
        return;
      }
    }
    await switchTo(next);
  };

  const allow = async () => {
    setBusy(true);
    // Allow is a click too: Chrome's prompt comes now, and nothing is recorded if it is refused.
    if (!(await ensureNativeMessaging())) {
      setConsentError(PERMISSION_DENIED);
      setBusy(false);
      return;
    }
    try {
      await facetApi.grantBridgeConsent(BRIDGE_CONSENT_VERSION);
    } catch (e) {
      setConsentError(describeError(e));
      setBusy(false);
      return;
    }
    setConsented(true);
    setAsking(false);
    await switchTo(true);
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

  return {
    view,
    error,
    busy,
    setEnabled,
    setActivity,
    retry,
    consent: {
      asking,
      error: consentError,
      allow,
      cancel: () => setAsking(false),
    },
  };
}
