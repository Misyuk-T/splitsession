import { useState } from 'preact/hooks';
import type { BridgeState } from '../../background/bridge/agent-bridge';
import { useBridge } from '../useBridge';
import { Button } from './Button';
import { Switch } from './Toggle';

export const INSTALL_COMMAND = 'pnpm bridge:install';

const actionsLabel = (n: number) => (n === 1 ? '1 action' : `${n} actions`);

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

/**
 * The agent bridge switch with its live status. One switch, all or nothing: on, the user's own AI agent can read and
 * operate every tab. The card changes colour while it is on so that the state is never missed.
 */
export function BridgeCard({ layout }: { layout: 'popup' | 'options' }) {
  const { view, error, busy, setEnabled, retry } = useBridge();
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

  return (
    <section class={`fx-bridge fx-bridge--${layout}${on ? ' fx-bridge--on' : ''}`} aria-label="Agent bridge" data-testid="bridge-card" data-status={status}>
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
          <strong class="fx-bridge__headline">{headline(state ?? { status: 'connecting', error: null, actions: 0, lastTool: null, lastAt: null })}</strong>
          {status === 'connected' && state && (
            <span class="fx-bridge__count" data-testid="bridge-actions">
              {actionsLabel(state.actions)}
            </span>
          )}
        </div>
      )}
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
    </section>
  );
}
