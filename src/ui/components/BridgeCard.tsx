import { useState } from 'preact/hooks';
import type { BridgeState, RecentAction } from '../../background/bridge/agent-bridge';
import { useBridge } from '../useBridge';
import { IconChevron } from '../icons';
import { Button } from './Button';
import { Switch, SwitchControl } from './Toggle';
import './bridge-card.css';

export const INSTALL_COMMAND = 'pnpm bridge:install';

const actionsLabel = (n: number) => (n === 1 ? '1 action' : `${n} actions`);
const FRESH: BridgeState = { status: 'connecting', error: null, actions: 0, lastTool: null, lastAt: null, recent: [] };

function headline(state: BridgeState): string {
  switch (state.status) {
    case 'connected':
      return 'Agent connected — full access';
    case 'host-missing':
      return 'ON, but the agent host is not installed';
    case 'busy':
      return 'Another Chrome profile holds the agent bridge — turn it off there first';
    case 'error':
      return 'ON, but the connection failed';
    default:
      return 'ON — connecting to the agent host…';
  }
}

/** What the row says, in two words, when the bridge is on but not connected. */
const SHORT: Record<BridgeState['status'], string> = { off: '', connecting: 'Connecting…', connected: '', 'host-missing': 'Setup needed', busy: 'In use elsewhere', error: 'Not working' };

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

/** The agent's latest actions: when, which tool, on which tab (title, else site). Never page content. */
function RecentActions({ recent }: { recent: RecentAction[] }) {
  if (recent.length === 0) {
    return (
      <p class="fx-bridge__none" data-testid="bridge-recent-empty">
        Nothing yet.
      </p>
    );
  }
  return (
    <ul class="fx-bridge__recent" aria-label="Recent agent actions" data-testid="bridge-recent">
      {recent.map((r) => {
        const target = r.title || r.host || '';
        return (
          <li key={`${r.at}-${r.tool}`} class={r.ok ? undefined : 'fx-bridge__failed'} data-testid="bridge-recent-item" title={[r.title, r.host].filter(Boolean).join(' — ') || undefined}>
            <time class="fx-bridge__time" dateTime={new Date(r.at).toISOString()}>
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
}

/**
 * The agent bridge switch with its live status. One switch, all or nothing: on, the user's own AI agent can read and
 * operate every tab. The card changes colour while it is on so that the state is never missed. In the popup it is one
 * row (two when on) plus the latest actions; the options page gets the roomy version.
 */
export function BridgeCard({ layout }: { layout: 'popup' | 'options' }) {
  const { view, error, busy, setEnabled, setActivity, retry } = useBridge();
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const on = view?.enabled ?? false;
  const state = view?.state;
  const status = on ? (state && state.status !== 'off' ? state.status : 'connecting') : 'off';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked: the command stays selectable on screen */
    }
  };

  const help = (
    <>
      {on && status === 'host-missing' && (
        <div class="fx-bridge__help" data-testid="bridge-install">
          <p>Run this in the SplitSession source folder, then press “Check again”:</p>
          <div class="fx-bridge__cmd">
            <code>{INSTALL_COMMAND}</code>
            <Button small onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <Button small onClick={() => void retry()}>
            Check again
          </Button>
        </div>
      )}
      {on && status === 'busy' && (
        <div class="fx-bridge__help" data-testid="bridge-busy">
          <p>
            Only one Chrome profile can hold the agent bridge at a time. Switch it off in the other profile; this one
            connects by itself a few seconds later.
          </p>
          <Button small onClick={() => void retry()}>
            Check again
          </Button>
        </div>
      )}
      {on && status === 'error' && (
        <div class="fx-bridge__help">
          <p>{state?.error ?? 'The host stopped.'} SplitSession keeps trying.</p>
          <Button small onClick={() => void retry()}>
            Check again
          </Button>
        </div>
      )}
      {error && (
        <p class="fx-notice fx-notice--error" role="alert">
          {error}
        </p>
      )}
    </>
  );

  if (layout === 'options') {
    return (
      <section class={`fx-bridge fx-bridge--options${on ? ' fx-bridge--on' : ''}`} aria-label="Agent bridge" data-testid="bridge-card" data-status={status}>
        <Switch
          label="Agent bridge"
          description={
            on
              ? 'On. An AI agent on this computer can read and operate every tab in every window, containers included.'
              : 'Off. No AI agent can see or control your tabs.'
          }
          checked={on}
          disabled={view === null || busy}
          onChange={(next) => void setEnabled(next)}
        />
        {on && (
          <div class="fx-bridge__live" role="status" data-testid="bridge-status">
            <span class={`fx-bridge__dot fx-bridge__dot--${status}`} aria-hidden="true" />
            <strong class="fx-bridge__headline">{headline(state ?? FRESH)}</strong>
            {status === 'connected' && state && (
              <span class="fx-bridge__count" data-testid="bridge-actions">
                {actionsLabel(state.actions)}
              </span>
            )}
          </div>
        )}
        {help}
      </section>
    );
  }

  // ---- popup: one quiet row. The log is folded away until the row is pressed.
  const note = !on ? null : status === 'connected' ? null : SHORT[status];
  const count = state?.actions ?? 0;
  const canOpen = on && status === 'connected';
  const tip = on ? `${headline(state ?? FRESH)}. Settings has the details.` : 'Agent bridge is off. No AI agent can see or control your tabs.';
  const label = (
    <>
      <span class={`fx-bridge__dot fx-bridge__dot--${on ? status : 'off'}`} aria-hidden="true" />
      <span class="fx-bridge__name">Agent</span>
      {canOpen && (
        <span class="fx-bridge__count" data-testid="bridge-actions">
          {count}
        </span>
      )}
      {note && <span class="fx-bridge__note">{note}</span>}
      {canOpen && <span class={`fx-chevron${open ? ' fx-chevron--open' : ''}`}><IconChevron /></span>}
    </>
  );
  return (
    <section class={`fx-bridge fx-bridge--popup${on ? ' fx-bridge--on' : ''}`} aria-label="Agent bridge" data-testid="bridge-card" data-status={status} title={tip}>
      <div class="fx-bridge__row">
        {canOpen ? (
          <button type="button" class="fx-bridge__main" aria-expanded={open} aria-controls="fx-bridge-log" aria-label={`Agent, ${actionsLabel(count)}. ${open ? 'Hide' : 'Show'} recent actions`} onClick={() => setOpen(!open)}>
            {label}
          </button>
        ) : (
          <div class="fx-bridge__main fx-bridge__main--static">{label}</div>
        )}
        {on && (
          <span class="fx-sr-only" role="status" data-testid="bridge-status">
            {headline(state ?? FRESH)}
          </span>
        )}
        <SwitchControl label="Agent bridge" checked={on} disabled={view === null || busy} onChange={(next) => void setEnabled(next)} />
      </div>
      {canOpen && open && (
        <div id="fx-bridge-log">
          <RecentActions recent={state?.recent ?? []} />
        </div>
      )}
      {help}
    </section>
  );
}
