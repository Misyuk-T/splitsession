import { browser } from "wxt/browser";

import { type Bridge, McpButton } from "../components/BridgeCard";
import { Button } from "../components/Button";
import { Logo } from "../components/Logo";
import { IconSettings } from "../icons";

/** Logo, name, the MCP pill (Full) and Settings. */
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
      aria-label="Settings"
      title="Settings"
      onClick={() => void browser.runtime.openOptionsPage()}
    >
      <IconSettings />
    </Button>
  </header>
);
