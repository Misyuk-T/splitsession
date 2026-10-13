import { useState } from "preact/hooks";
import { browser } from "wxt/browser";

import type {
  BridgeState,
  RecentAction,
} from "../../background/bridge/agent-bridge";
import { IconChevron, IconSettings } from "../icons";
import { useBridge } from "../useBridge";
import { Button } from "./Button";
import { Switch, SwitchControl } from "./Toggle";

import "./bridge-card.css";

const actionsLabel = (n: number) => (n === 1 ? "1 action" : `${n} actions`);

function headline(state: BridgeState): string {
  switch (state.status) {
    case "connected":
      return "Agent connected — full access";
    case "host-missing":
      return "ON, but the agent host is not installed";
    case "busy":
      return "Another Chrome profile holds the agent bridge — turn it off there first";
    case "error":
      return "ON, but the connection failed";
    default:
      return "ON — connecting to the agent host…";
  }
}

/** The options page scrolled to "For AI agents" (`#agent`): an options tab that is already open is reused, not duplicated. */
export async function openAgentSettings(): Promise<void> {
  const base = browser.runtime.getURL("/options.html" as never);
  const url = `${base}#agent`;
  const open = (await browser.tabs.query({ url: `${base}*` })).find(
    (t) => t.id !== undefined,
  );
  if (open?.id !== undefined) {
    await browser.tabs.update(open.id, { url, active: true });
    if (open.windowId !== undefined)
      await browser.windows.update(open.windowId, { focused: true });
  } else {
    await browser.tabs.create({ url });
  }
}

const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

/** The agent's latest actions: when, which tool, on which tab (title, else site). Never page content. */
const RecentActions = ({ recent }: { recent: RecentAction[] }) => {
  if (recent.length === 0) {
    return (
      <p class="fx-bridge__none" data-testid="bridge-recent-empty">
        Nothing yet.
      </p>
    );
  }
  return (
    <ul
      class="fx-bridge__recent"
      aria-label="Recent agent actions"
      data-testid="bridge-recent"
    >
      {recent.map((r) => {
        const target = r.title || r.host || "";
        return (
          <li
            key={`${r.at}-${r.tool}`}
            class={r.ok ? undefined : "fx-bridge__failed"}
            data-testid="bridge-recent-item"
            title={[r.title, r.host].filter(Boolean).join(" — ") || undefined}
          >
            <time
              class="fx-bridge__time"
              dateTime={new Date(r.at).toISOString()}
            >
              {clock(r.at)}
            </time>
            <span class="fx-bridge__tool">{r.tool}</span>
            {!r.ok && <span class="fx-sr-only"> failed</span>}
            {target && <span class="fx-bridge__target">{target}</span>}
          </li>
        );
      })}
    </ul>
  );
};

export type Bridge = ReturnType<typeof useBridge>;

/** The live status of a bridge: the setting plus the connection, `off` when the setting is off. */
export function bridgeStatus(bridge: Bridge): BridgeState["status"] {
  const { view } = bridge;
  if (!view?.enabled) return "off";
  return view.state.status !== "off" ? view.state.status : "connecting";
}

/** The options page's wording for a status: short, the details go in a second phrase. */
function optionsStatus(
  status: BridgeState["status"],
  state: BridgeState | undefined,
): { text: string; detail: string | null } {
  switch (status) {
    case "off":
      return { text: "Off", detail: null };
    case "connected":
      return { text: "Connected", detail: null };
    case "connecting":
      return { text: "Connecting…", detail: null };
    case "host-missing":
      return {
        text: "Not connected",
        detail: "The agent host is not installed.",
      };
    case "busy":
      return {
        text: "Not connected",
        detail:
          "Another Chrome profile holds the bridge. Turn it off there first.",
      };
    default:
      return {
        text: "Not connected",
        detail: `${state?.error ?? "The host stopped."} SplitSession keeps trying.`,
      };
  }
}

/** One quiet line: dot, "Connected" / "Not connected" / "Off", and the action count. Shown in the settings list and again inside "How to connect". */
export const BridgeStatusLine = ({
  bridge,
  counter = true,
  ...rest
}: {
  bridge: Bridge;
  counter?: boolean;
  role?: "status";
  "data-testid": string;
}) => {
  const status = bridgeStatus(bridge);
  const state = bridge.view?.state;
  if (bridge.view === null) return null;
  const { text, detail } = optionsStatus(status, state);
  return (
    <div class="fx-bridge__live" {...rest}>
      <span
        class={`fx-bridge__dot fx-bridge__dot--${status}`}
        aria-hidden="true"
      />
      <span class="fx-bridge__headline">{text}</span>
      {detail && (
        <span
          class="fx-secondary"
          data-testid={status === "busy" ? "bridge-busy" : undefined}
        >
          {detail}
        </span>
      )}
      {counter && status === "connected" && state && (
        <span class="fx-bridge__count" data-testid="bridge-actions">
          {actionsLabel(state.actions)}
        </span>
      )}
    </div>
  );
};

/** The agent bridge switch (options page) as a plain row, with its status line. Setup steps are not here: they sit in "How to connect". */
export const BridgeSwitchCard = ({ bridge }: { bridge: Bridge }) => {
  const { view, error, busy, setEnabled } = bridge;
  const on = view?.enabled ?? false;
  const status = bridgeStatus(bridge);
  return (
    <div
      class="opt-row"
      role="group"
      aria-label="Agent bridge"
      data-testid="bridge-card"
      data-status={status}
    >
      <Switch
        label="Agent bridge"
        description="Lets an AI agent on this computer see and use your tabs."
        checked={on}
        disabled={view === null || busy}
        onChange={(next) => void setEnabled(next)}
      />
      <BridgeStatusLine
        bridge={bridge}
        role="status"
        data-testid="bridge-status"
      />
      {error && (
        <p class="fx-notice fx-notice--error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
};

/**
 * The popup's agent row. It does not exist while the bridge is off: the popup is about containers, and an agent is for
 * people who went looking for it (Settings, "For AI agents"). On, it is one quiet row: status, counter, the latest
 * actions on press, a switch to turn it off. Never install instructions: when the host is missing the row says "not
 * connected" and points to Settings.
 */
export const BridgeRow = ({ bridge }: { bridge: Bridge }) => {
  const { view, busy, setEnabled } = bridge;
  const [open, setOpen] = useState(false);
  if (!view?.enabled) return null;
  const state = view.state;
  const status = state.status !== "off" ? state.status : "connecting";
  const count = state.actions;
  const canOpen = status === "connected";
  const note =
    status === "connected"
      ? null
      : status === "connecting"
        ? "Connecting…"
        : status === "busy"
          ? "in use elsewhere"
          : "not connected";
  const needsSettings =
    status === "host-missing" || status === "error" || status === "busy";
  const openSettings = () => void openAgentSettings();
  const label = (
    <>
      <span
        class={`fx-bridge__dot fx-bridge__dot--${status}`}
        aria-hidden="true"
      />
      <span class="fx-bridge__name">Agent</span>
      {canOpen && (
        <span class="fx-bridge__count" data-testid="bridge-actions">
          {count}
        </span>
      )}
      {note && <span class="fx-bridge__note">{note}</span>}
      {canOpen && (
        <span class={`fx-chevron${open ? " fx-chevron--open" : ""}`}>
          <IconChevron />
        </span>
      )}
    </>
  );
  return (
    <section
      class="fx-bridge fx-bridge--popup fx-bridge--on"
      aria-label="Agent bridge"
      data-testid="bridge-card"
      data-status={status}
      title={`${headline(state)}. Settings has the details.`}
    >
      <div class="fx-bridge__row">
        {canOpen ? (
          <button
            type="button"
            class="fx-bridge__main"
            aria-expanded={open}
            aria-controls="fx-bridge-log"
            aria-label={`Agent, ${actionsLabel(count)}. ${open ? "Hide" : "Show"} recent actions`}
            onClick={() => setOpen(!open)}
          >
            {label}
          </button>
        ) : (
          <div class="fx-bridge__main fx-bridge__main--static">{label}</div>
        )}
        <span class="fx-sr-only" role="status" data-testid="bridge-status">
          {headline(state)}
        </span>
        {needsSettings && (
          <Button
            variant="ghost"
            small
            icon
            aria-label="Agent settings"
            title="Open the agent settings"
            onClick={openSettings}
          >
            <IconSettings />
          </Button>
        )}
        <SwitchControl
          label="Agent bridge"
          checked
          disabled={busy}
          onChange={(next) => void setEnabled(next)}
        />
      </div>
      {canOpen && open && (
        <div id="fx-bridge-log">
          <RecentActions recent={state.recent} />
        </div>
      )}
    </section>
  );
};

/**
 * The popup header's "MCP" pill (Full only): a way to the agent settings for people who know the word. With the bridge on it
 * carries a status dot (purple: connected, amber: not connected); off, no dot. Settings is where the bridge is switched on.
 */
export const McpButton = ({ bridge }: { bridge: Bridge }) => {
  const status = bridgeStatus(bridge);
  const on = status !== "off";
  const connected = status === "connected";
  const state = on ? (connected ? ", connected" : ", not connected") : "";
  return (
    <button
      type="button"
      class="fx-mcp"
      data-testid="mcp-button"
      data-status={status}
      aria-label={`MCP, AI agents settings${state}`}
      title={`AI agents (MCP)${on ? (connected ? ": connected" : ": not connected") : ""}`}
      onClick={() => void openAgentSettings().then(() => window.close())}
    >
      {on && (
        <span
          class={`fx-mcp__dot${connected ? " fx-mcp__dot--on" : ""}`}
          aria-hidden="true"
        />
      )}
      MCP
    </button>
  );
};
