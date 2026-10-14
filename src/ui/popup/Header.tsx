import { browser } from "wxt/browser";

import { type Bridge, McpButton } from "../components/BridgeCard";
import { Button } from "../components/Button";
import { Logo } from "../components/Logo";
import { IconCoffee, IconSettings } from "../icons";

/** Where the support button leads: a one-off tip on Ko-fi. */
export const SUPPORT_URL = "https://ko-fi.com/tomashdev/tip";

/**
 * A plain tab at the end of the window: no opener and no `index`, so Chrome neither groups it with the active tab nor
 * gives it a container (SplitSession only assigns tabs it opens itself or finds in a container's group).
 */
const openSupport = async () => {
  await browser.tabs.create({ url: SUPPORT_URL, active: true });
  window.close();
};

/** Logo, name, the MCP pill (Full), Support and Settings. */
export const Header = ({ bridge }: { bridge: Bridge | null }) => (
  <header class="popup__head">
    <Logo size={24} />
    <h1 class="popup__title">SplitSession</h1>
    <span class="popup__spacer" />
    {__FULL__ && bridge && <McpButton bridge={bridge} />}
    <Button
      variant="ghost"
      small
      icon
      aria-label="Support development on Ko-fi"
      title="Support development"
      data-testid="popup-support"
      onClick={() => void openSupport()}
    >
      <IconCoffee />
    </Button>
    <Button
      variant="ghost"
      small
      icon
      aria-label="Settings"
      title="Settings"
      onClick={() => void browser.runtime.openOptionsPage()}
    >
      <IconSettings />
    </Button>
  </header>
);
