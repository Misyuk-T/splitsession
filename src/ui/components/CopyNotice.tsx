import { useEffect, useState } from "preact/hooks";
import { browser } from "wxt/browser";

import type { OtherCopy } from "../../core/copies";
import { facetApi } from "../../engine/api-client";
import { Button } from "./Button";

/** Other enabled SplitSession copies in this profile (asked of the background, which caches the answer for a minute). */
export function useOtherCopies(): OtherCopy[] {
  const [copies, setCopies] = useState<OtherCopy[]>([]);
  useEffect(() => {
    let alive = true;
    facetApi.getOtherCopies().then(
      (found) => alive && setCopies(found),
      () => {}, // no answer is no warning
    );
    return () => {
      alive = false;
    };
  }, []);
  return copies;
}

const label = (c: OtherCopy) =>
  `${c.edition === "full" ? "Full" : "Lite"} ${c.version}`;

/**
 * Two enabled copies of SplitSession fight over cookies and logins do not stick: say so, and offer chrome://extensions
 * (an extension may open it with tabs.create; a link from a page could not). Nothing is shown when there is no other copy.
 */
export const CopyNotice = ({ copies }: { copies: OtherCopy[] }) => {
  if (copies.length === 0) return null;
  const one = copies.length === 1;
  const open = () => {
    const url = one
      ? `chrome://extensions/?id=${copies[0]!.id}`
      : "chrome://extensions/";
    void browser.tabs.create({ url }).catch(() => {});
  };
  return (
    <div
      class="fx-notice fx-notice--warn fx-copynotice"
      role="alert"
      data-testid="duplicate-copy-notice"
    >
      <p class="fx-copynotice__text">
        {one
          ? "Another copy of SplitSession is on"
          : "Other copies of SplitSession are on"}{" "}
        ({copies.map(label).join(", ")}). Two copies fight over cookies: keep
        one and turn {one ? "the other" : "the others"} off in
        chrome://extensions.
      </p>
      <Button small onClick={open} data-testid="duplicate-copy-open">
        Open extensions
      </Button>
    </div>
  );
};
