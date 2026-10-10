import { useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import type { BridgeState, RecentAction } from '../../background/bridge/agent-bridge';
import { useBridge } from '../useBridge';
import { Button } from './Button';
import { MenuButton, type MenuItem } from './Menu';
import { Switch, SwitchControl } from './Toggle';

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

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

/** The agent's latest actions: when, which tool, on which tab (title, else site). Never page content. */
function RecentActions({ recent }: { recent: RecentAction[] }) {
  if (recent.length === 0) {
    return (
      <p class="fx-bridge__none" data-testid="bridge-recent-empty">
        No agent actions yet.
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
          <p>Run this in the Facet source folder, then press “Check again”:</p>
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
          <p>{state?.error ?? 'The host stopped.'} Facet keeps trying.</p>
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

  // ---- popup: compact
  const menu: MenuItem[] = [
    { id: 'activity', label: 'Show agent activity', checked: view?.activity ?? true, toggle: true },
    { id: 'settings', label: 'Bridge settings…', separatorBefore: true },
  ];
  const onMenu = (id: string) => {
    if (id === 'activity') void setActivity(!(view?.activity ?? true));
    else void browser.tabs.create({ url: browser.runtime.getURL('/options.html#agent' as never) });
  };
  return (
    <section class={`fx-bridge fx-bridge--popup${on ? ' fx-bridge--on' : ''}`} aria-label="Agent bridge" data-testid="bridge-card" data-status={status}>
      <div class="fx-bridge__row">
        {on && <span class={`fx-bridge__dot fx-bridge__dot--${status}`} aria-hidden="true" />}
        <div class="fx-bridge__text">
          <div class="fx-bridge__title">
            <strong>Agent bridge</strong>
            {on && status === 'connected' && state ? (
              <span class="fx-bridge__count fx-secondary" data-testid="bridge-actions">
                {actionsLabel(state.actions)}
              </span>
            ) : (
              !on && <span class="fx-secondary">Off · no access</span>
            )}
          </div>
          {on && (
            <span class="fx-secondary" role="status" data-testid="bridge-status">
              {headline(state ?? FRESH)}
            </span>
          )}
        </div>
        <MenuButton ariaLabel="Agent bridge options" menuLabel="Agent bridge options" items={menu} onSelect={onMenu} align="end" variant="ghost" small icon>
          <span aria-hidden="true">⋯</span>
        </MenuButton>
        <SwitchControl label="Agent bridge" checked={on} disabled={view === null || busy} onChange={(next) => void setEnabled(next)} />
      </div>
      {on && status === 'connected' && <RecentActions recent={state?.recent ?? []} />}
      {help}
    </section>
  );
}
