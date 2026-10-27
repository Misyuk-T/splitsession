import { useEffect, useState } from "preact/hooks";
import { browser } from "wxt/browser";

import { Button } from "../components/Button";

/** `chrome.storage.local` key: set once the user has pressed "Got it". */
export const UPGRADE_NOTICE_DISMISSED_KEY = "noticeFullUpgradeDismissed";

/**
 * Lite only. The Web Store item will be updated in place to the Full build, which adds two required permissions; Chrome
 * disables the extension until the user approves them, and meanwhile container tabs are plain tabs. Warn in advance,
 * until "Got it" (kept in `storage.local`, so it never comes back).
 */
export const UpgradeNotice = () => {
  // undefined: not read yet (nothing is drawn, so the notice does not flash for someone who already dismissed it)
  const [dismissed, setDismissed] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    browser.storage.local.get(UPGRADE_NOTICE_DISMISSED_KEY).then(
      (stored) =>
        alive && setDismissed(stored[UPGRADE_NOTICE_DISMISSED_KEY] === true),
      () => alive && setDismissed(false),
    );
    return () => {
      alive = false;
    };
  }, []);
  if (dismissed !== false) return null;
  const dismiss = () => {
    setDismissed(true);
    void browser.storage.local
      .set({ [UPGRADE_NOTICE_DISMISSED_KEY]: true })
      .catch(() => {});
  };
  return (
    <div
      class="fx-notice fx-notice--info fx-copynotice"
      role="region"
      aria-labelledby="upgrade-notice-title"
      data-testid="upgrade-notice"
    >
      <p class="fx-copynotice__text">
        <strong id="upgrade-notice-title">
          Coming next: optional AI-agent access
        </strong>
        <br />
        The next update lets your own AI agent use your tabs. It stays off
        unless you turn it on.
      </p>
      <p class="fx-copynotice__text">
        Chrome will pause SplitSession once and ask for new permissions. Approve
        them soon: until then, container tabs act like normal tabs. Your
        containers are kept.
      </p>
      <Button small onClick={dismiss} data-testid="upgrade-notice-dismiss">
        Got it
      </Button>
    </div>
  );
};
