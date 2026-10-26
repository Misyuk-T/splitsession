import { useEffect, useState } from "preact/hooks";

import { DEFAULT_SETTINGS, type Settings } from "../../core";
import { facetApi } from "../../engine/api-client";
import {
  bridgeStatus,
  BridgeStatusLine,
  BridgeSwitchCard,
} from "../components/BridgeCard";
import { Button } from "../components/Button";
import { CopyBlock } from "../components/CopyBlock";
import { Disclosure } from "../components/Disclosure";
import { More } from "../components/More";
import { TextField } from "../components/TextField";
import { Switch } from "../components/Toggle";
import { describeError } from "../format";
import { useBridge } from "../useBridge";

export const INSTALL_COMMAND = "npx splitsession-bridge install";
const DOCS_URL =
  "https://github.com/Misyuk-T/splitsession/blob/main/docs/agents.md";

const LABEL_MAX = 40;
// eslint-disable-next-line no-control-regex -- strips control characters from a user-typed label
const cleanLabel = (raw: string) => raw.replace(/[\u0000-\u001f\u007f]/g, "");

/** The name of this Chrome profile, which the agent reads through `bridge_info` to tell profiles apart. */
const ProfileLabel = ({ focus = false }: { focus?: boolean }) => {
  const [saved, setSaved] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    facetApi.getBridgeProfileLabel().then(
      (label) => {
        setSaved(label);
        setValue(label);
      },
      (e) => setError(describeError(e)),
    );
  }, []);

  // "Name this profile" in the switch card opened this: the field takes focus once it is enabled (the name has loaded).
  useEffect(() => {
    if (focus && saved !== null)
      document.getElementById("bridge-profile-name")?.focus();
  }, [focus, saved]);

  const save = async () => {
    if (saved === null || value.trim() === saved) return;
    try {
      const stored = await facetApi.setBridgeProfileLabel(value);
      setSaved(stored);
      setValue(stored);
      setError(null);
    } catch (e) {
      setError(describeError(e));
    }
  };

  return (
    <div data-testid="bridge-profile">
      <TextField
        label="Profile name"
        value={value}
        onValue={setValue}
        sanitize={cleanLabel}
        max={LABEL_MAX}
        placeholder="for example Work"
        hint="The agent sees this name on this profile's tabs. Name each Chrome profile that has the bridge on."
        id="bridge-profile-name"
        error={error}
        disabled={saved === null}
        onEnter={() => void save()}
        onBlur={() => void save()}
      />
    </div>
  );
};

/** "Show agent activity" and the two settings that let an agent tell accounts apart: all about what the agent sees or shows. */
const AgentSwitches = () => {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    facetApi.getSettings().then(setSettings, (e) => setError(describeError(e)));
  }, []);
  const change = async (patch: Partial<Settings>) => {
    const before = settings ?? DEFAULT_SETTINGS;
    setSettings({ ...before, ...patch }); // optimistic; the background confirms or we roll back
    try {
      setSettings(await facetApi.updateSettings(patch));
      setError(null);
    } catch (e) {
      setSettings(before);
      setError(describeError(e));
    }
  };
  const value = settings ?? DEFAULT_SETTINGS;
  return (
    <>
      <div class="opt-row" data-testid="bridge-activity">
        <Switch
          label="Show agent activity"
          description="A glow and a label on tabs the agent is using."
          checked={value.agentActivity}
          disabled={settings === null}
          onChange={(next) => void change({ agentActivity: next })}
        />
        <More id="more-activity" about="agent activity">
          <p>
            While the agent reads or works in a tab, that tab shows it: a
            glowing frame and a small label on the page (the agent session’s
            name and what it does, like “claude-code-3f9a: reading”), a ring of
            purple dots on the tab’s icon, the dot on the toolbar button blinks,
            and the ⧉ in front of its container’s tab group name blinks between
            ✦ and ✧, also when the group is collapsed. All of it fades a few
            seconds after the last action and never takes focus or switches
            tabs. Pages cannot read or click it.
          </p>
          <p>Off: nothing is shown or changed on your tabs.</p>
        </More>
      </div>
      <div class="opt-row" data-testid="bridge-window">
        <Switch
          label="Open agent tabs in a separate window"
          description="Tabs an agent opens itself go to their own window, not the one you work in."
          checked={value.agentWindow}
          disabled={settings === null}
          onChange={(next) => void change({ agentWindow: next })}
        />
        <More id="more-window" about="the agents’ window">
          <p>
            Off by default (tabs open in the window you work in). On: the first
            tab an agent opens (open_tab or open_in_container) makes one extra
            browser window of this profile, without taking focus; the next ones
            join it, and a container’s tabs get their tab group there as usual.
            If you close that window, the next tab an agent opens makes a new
            one. Chrome has no way to name a window, so it is told apart only by
            being the one that appears when an agent starts working.
          </p>
          <p>
            Agents can still work in any tab that is already open, including the
            one you are looking at: tell them “this tab” and they use the active
            tab of the window you used last. An agent that names a window itself
            always gets that window. Off: new tabs open in your current window.
          </p>
        </More>
      </div>
      <div class="opt-row">
        <Switch
          label="Show container name to pages"
          description="Pages and AI agents can read the container name."
          checked={value.showNameToPages}
          disabled={settings === null}
          onChange={(next) => void change({ showNameToPages: next })}
        />
        <More id="more-name" about="container name">
          <p>
            Off by default. On: pages in a container tab can read the
            container’s name, in the page’s “data-ctr” attribute and in front of
            the tab title. AI agents need it to tell accounts apart.
          </p>
          <p>
            Any script on the page can read it too, and the name is the same on
            every site, so trackers can link your visits through it. Off: pages
            see no name and titles get no prefix (the toolbar badge and the
            tab’s group still show it to you). Switching it off reaches open
            pages at once; switching it on, after they reload.
          </p>
        </More>
      </div>
      {value.showNameToPages && (
        <div class="opt-row">
          <Switch
            label="Put the container name in front of tab titles"
            description="A tab in Work shows as “[Work] Inbox”."
            checked={value.titlePrefix}
            disabled={settings === null}
            onChange={(next) => void change({ titlePrefix: next })}
          />
        </div>
      )}
      {error && (
        <p class="fx-notice fx-notice--error opt-row" role="alert">
          {error}
        </p>
      )}
    </>
  );
};

/** The setup steps, behind a disclosure: only people who want an agent ever open it. */
const ConnectGuide = ({ bridge }: { bridge: ReturnType<typeof useBridge> }) => {
  const status = bridgeStatus(bridge);
  return (
    <Disclosure
      id="agent-connect"
      title="How to connect"
      testId="bridge-install"
    >
      <p class="fx-secondary">
        Needs Node.js 20 or newer, on macOS or Linux. The program stays on this
        computer; it is the only thing that talks to your agent.
      </p>
      <ol class="opt-steps">
        <li>
          <p>Run this in a terminal:</p>
          <CopyBlock text={INSTALL_COMMAND} testId="bridge-install-command" />
        </li>
        <li>
          <p>
            It finds your AI apps (Claude Code, Codex, Cursor, Claude Desktop,
            Gemini CLI, VS Code) and asks once which ones to connect. To skip
            the question, name them: <code>--client codex,cursor</code>.
          </p>
        </li>
        <li>
          <p>Switch “Agent bridge” on above, then check the connection.</p>
        </li>
      </ol>
      <BridgeStatusLine
        bridge={bridge}
        counter={false}
        data-testid="bridge-guide-status"
      />
      {status !== "off" && status !== "connected" && (
        <div class="opt-actions opt-actions--start">
          <Button small onClick={() => void bridge.retry()}>
            Check again
          </Button>
        </div>
      )}
      <p class="fx-secondary">
        <a href={DOCS_URL} target="_blank" rel="noopener noreferrer">
          Read the full guide on GitHub
        </a>
      </p>
    </Disclosure>
  );
};

/** Settings, "For AI agents": the switches, "How to connect", and what turning it on means. Low-key: one list of rows, the long text behind disclosures. */
export const BridgeSection = () => {
  const bridge = useBridge();
  const [advanced, setAdvanced] = useState(false);
  const [focusName, setFocusName] = useState(false);
  const nameProfile = () => {
    setAdvanced(true);
    setFocusName(true);
    // Already open: the field is there, focus it now.
    document.getElementById("bridge-profile-name")?.focus();
  };
  return (
    <section class="opt-section" aria-labelledby="agent-title" id="agent">
      <h2 id="agent-title">For AI agents</h2>
      <div class="opt-card opt-card--rows">
        <BridgeSwitchCard bridge={bridge} onNameProfile={nameProfile} />
        <AgentSwitches />
        <div class="opt-row">
          <ConnectGuide bridge={bridge} />
        </div>
        <div class="opt-row">
          <Disclosure
            id="agent-can"
            title="What an agent can do while it is on"
            testId="bridge-can"
          >
            <div class="fx-secondary opt-prose">
              <ul class="opt-list">
                <li>
                  list every tab of every window, with its address, title and
                  container;
                </li>
                <li>
                  read the text and HTML of any page, including pages you are
                  logged in to, and take screenshots of them;
                </li>
                <li>
                  click, type, scroll and run JavaScript in any tab, which also
                  means act as you on those sites;
                </li>
                <li>
                  open, navigate, close and move tabs, and open pages inside
                  containers;
                </li>
                <li>
                  upload files from this computer into pages, answer their
                  dialogs, and record their console and network.
                </li>
              </ul>
              <p>
                For real clicks and key presses SplitSession uses Chrome’s
                debugger on the tab the agent works in, only while this is on.
                Chrome then shows “SplitSession started debugging this browser”;
                its Cancel button takes the debugger back. The debugger is never
                used to read or change cookies, so containers stay separate.
              </p>
              <p>
                Only programs running as your macOS user can reach it (the
                connection is a private socket file), and only this extension
                may start the host. There are no per-site limits yet: it is
                everything or nothing. Switch it off here or in the toolbar
                popup at any time; the connection closes at once and the host
                process exits. Every action is logged (tool, tab, site, result,
                never page content) under Diagnostics.
              </p>
            </div>
          </Disclosure>
        </div>
        <div class="opt-row">
          <Disclosure
            id="agent-advanced"
            title="Advanced"
            testId="bridge-advanced"
            open={advanced}
            onToggle={(next) => {
              setAdvanced(next);
              if (!next) setFocusName(false);
            }}
          >
            <div class="opt-sub">
              <ProfileLabel focus={focusName} />
            </div>
          </Disclosure>
        </div>
      </div>
    </section>
  );
};
