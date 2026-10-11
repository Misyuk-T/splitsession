import { useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { BridgeCard, INSTALL_COMMAND } from '../components/BridgeCard';
import { Button } from '../components/Button';
import { Switch } from '../components/Toggle';
import { TextField } from '../components/TextField';
import { facetApi } from '../../engine/api-client';
import { describeError } from '../format';

const USER_SCRIPTS = { permissions: ['userScripts'] } as never;
const LABEL_MAX = 40;
const cleanLabel = (raw: string) => raw.replace(/[\u0000-\u001f\u007f]/g, '');

/** The name of this Chrome profile, which the agent reads through `bridge_info` to tell profiles apart. */
function ProfileLabel() {
  const [saved, setSaved] = useState<string | null>(null);
  const [value, setValue] = useState('');
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
    <div class="opt-card" data-testid="bridge-profile">
      <h3>Name of this Chrome profile</h3>
      <p class="fx-secondary">
        If you use the bridge from several Chrome profiles (only one can hold it at a time), give each a name. The agent
        reads it through the “bridge_info” tool, so it knows which profile it is working in.
      </p>
      <TextField
        label="Profile name"
        value={value}
        onValue={setValue}
        sanitize={cleanLabel}
        max={LABEL_MAX}
        placeholder="for example Work"
        error={error}
        disabled={saved === null}
        onEnter={() => void save()}
        onBlur={() => void save()}
      />
    </div>
  );
}

/** "Show agent activity": the overlay, title mark and badge on the tab the agent touches. */
function ActivitySwitch() {
  const [on, setOn] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    facetApi.getSettings().then(
      (settings) => setOn(settings.agentActivity),
      (e) => setError(describeError(e)),
    );
  }, []);
  const change = async (next: boolean) => {
    const before = on;
    setOn(next);
    try {
      setOn((await facetApi.updateSettings({ agentActivity: next })).agentActivity);
      setError(null);
    } catch (e) {
      setOn(before);
      setError(describeError(e));
    }
  };
  return (
    <div class="opt-card" data-testid="bridge-activity">
      <Switch
        label="Show agent activity"
        description="While the agent reads or works in a tab, that tab shows it: a glowing frame and a small “Agent: reading” label on the page, an eye in front of the tab title while it reads, and “AI” on the toolbar button. It fades about 2.5 seconds after the last action and never takes focus or switches tabs. Pages cannot read or click it. Off: nothing is shown or changed on your tabs."
        checked={on ?? true}
        disabled={on === null}
        onChange={(next) => void change(next)}
      />
      {error && <p class="fx-notice fx-notice--error" role="alert">{error}</p>}
    </div>
  );
}

/** The same switch as the popup's, with a plain explanation of what turning it on means. */
export function BridgeSection() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    browser.permissions.contains(USER_SCRIPTS).then(setAllowed, () => setAllowed(false));
  }, []);

  const allow = async () => {
    try {
      setAllowed(await browser.permissions.request(USER_SCRIPTS));
      setError(null);
    } catch (e) {
      setError(describeError(e));
    }
  };

  return (
    <section class="opt-section" aria-labelledby="agent-title" id="agent">
      <h2 id="agent-title">AI agent bridge</h2>
      <p class="opt-lead">
        Lets your own AI coding agent (for example Claude Code, running on this Mac) see your Chrome tabs and work in them,
        through a small program on this computer. It is one switch: off, nothing is reachable; on, everything is.
      </p>
      <BridgeCard layout="options" />
      <ActivitySwitch />
      <ProfileLabel />
      <div class="opt-card">
        <h3>While it is on, the agent can</h3>
        <ul class="opt-list">
          <li>list every tab of every window, with its address, title and container;</li>
          <li>read the text and HTML of any page, including pages you are logged in to, and take screenshots of them;</li>
          <li>click, type, scroll and run JavaScript in any tab, which also means act as you on those sites;</li>
          <li>open, navigate, close and move tabs, and open pages inside containers;</li>
          <li>upload files from this computer into pages, answer their dialogs, and record their console and network.</li>
        </ul>
        <p>
          For real clicks and key presses SplitSession uses Chrome’s debugger on the tab the agent works in, only while this is on.
          Chrome then shows “SplitSession started debugging this browser”; its Cancel button takes the debugger back from SplitSession.
          The debugger is never used to read or change cookies, so containers stay separate.
        </p>
        <p>
          Only programs running as your macOS user can reach it (the connection is a private socket file), and only this
          extension may start the host. There are no per-site limits yet: it is everything or nothing. Switch it off here or
          in the toolbar popup at any time; the connection closes at once and the host process exits. Every action is logged
          (tool, tab, site, result, never page content) under Diagnostics.
        </p>
        <p class="fx-secondary">
          Set-up: run <code>{INSTALL_COMMAND}</code> in the SplitSession source folder, run the <code>claude mcp add …</code> command
          it prints, then switch this on. Details: docs/agents.md in the repository.
        </p>
      </div>
      <div class="opt-card">
        <h3>Run JavaScript on pages that forbid it</h3>
        <p class="fx-secondary">
          When SplitSession cannot use the debugger on a tab, a site’s Content-Security-Policy can block the “run_js” tool. As an optional fallback SplitSession can use Chrome’s
          userScripts permission, which those policies do not cover. Chrome also needs “Allow User Scripts” switched on
          in this extension’s details page.
        </p>
        <div class="opt-actions opt-actions--start">
          {allowed ? (
            <span class="fx-secondary" data-testid="userscripts-status">The userScripts fallback is allowed.</span>
          ) : (
            <Button onClick={() => void allow()} disabled={allowed === null}>
              Allow the userScripts fallback
            </Button>
          )}
        </div>
        {error && <p class="fx-notice fx-notice--error" role="alert">{error}</p>}
      </div>
    </section>
  );
}
