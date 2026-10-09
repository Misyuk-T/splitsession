import { useEffect, useRef, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { CONTAINER_COLORS, CONTAINER_HEX, parseChooseParams, ruleKeyOf } from '../../core';
import { facetApi } from '../../engine/api-client';
import { Button, Dot } from '../components/Button';
import { ContainerForm } from '../components/ContainerForm';
import { Logo } from '../components/Logo';
import { Switch } from '../components/Toggle';
import { describeError, tabsLabel } from '../format';
import { useContainers } from '../useContainers';

/**
 * `choose.html?url=<target>&tab=<id>`: where a domain rule with "ask" sends a tab. The user picks a container (or none),
 * optionally remembers the choice as a rule, and the tab continues to the address, already placed.
 */
export function Choose() {
  const params = parseChooseParams(location.search);
  const site = params.url ? ruleKeyOf(params.url) : null;
  const { containers, error: loadError, reload } = useContainers();
  const [remember, setRemember] = useState(false);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.title = site ? `Facet: open ${site} in…` : 'Facet';
  }, [site]);
  useEffect(() => {
    if (containers) list.current?.querySelector<HTMLElement>('button')?.focus();
  }, [containers !== null]);

  if (!params.url || !site) {
    return (
      <main class="choose">
        <header class="choose__head"><Logo size={28} /><h1>Facet</h1></header>
        <p class="fx-notice fx-notice--info" role="status">
          This page opens when a domain rule asks where a site should open. It was opened without an address, so there is nothing to choose.
        </p>
        <div><Button onClick={() => void browser.runtime.openOptionsPage()}>Open settings</Button></div>
      </main>
    );
  }
  const url = params.url;

  const go = async (containerId: string | null) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const tab = await browser.tabs.getCurrent();
      const tabId = tab?.id ?? params.tab;
      if (tabId === undefined || tabId === null) throw new Error('This page must be opened in a tab.');
      const { replaced } = await facetApi.applyChoice({ tabId, url, containerId, remember });
      // Replaced: the address opened in a fresh tab (no opener link) and this tab is being closed.
      if (!replaced) location.replace(url);
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('button.choose__option') ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at === -1) return;
    const next = event.key === 'ArrowDown' ? at + 1 : event.key === 'ArrowUp' ? at - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    buttons[(next + buttons.length) % buttons.length]?.focus();
  };

  const names = (containers ?? []).map((c) => c.name);
  const nextColor = CONTAINER_COLORS.find((c) => !(containers ?? []).some((x) => x.color === c)) ?? CONTAINER_COLORS[0]!;

  return (
    <main class="choose">
      <header class="choose__head">
        <Logo size={28} />
        <h1>Facet</h1>
      </header>
      <section class="choose__card" aria-labelledby="choose-title">
        <h2 id="choose-title">Open {site} in which container?</h2>
        <p class="fx-secondary choose__url" data-testid="choose-url">{url}</p>

        <Switch
          label={`Remember my choice for ${site}`}
          description="Next time this site opens in that container without asking. Choosing “no container” stops the questions."
          checked={remember}
          onChange={setRemember}
        />

        {loadError && <p class="fx-notice fx-notice--error" role="alert">{loadError}</p>}

        <div ref={list} class="choose__options" role="group" aria-label="Containers" onKeyDown={onKeyDown}>
          {(containers ?? []).map((c) => (
            <button key={c.id} type="button" class="choose__option" disabled={busy} onClick={() => void go(c.id)} data-testid="choose-container">
              <Dot color={CONTAINER_HEX[c.color]} />
              <span class="choose__name">{c.name}</span>
              <span class="fx-secondary">{tabsLabel(c.tabCount)}</span>
            </button>
          ))}
          <button type="button" class="choose__option choose__option--plain" disabled={busy} onClick={() => void go(null)} data-testid="choose-none">
            <span class="popup-nodot" aria-hidden="true" />
            <span class="choose__name">Open without a container</span>
            <span class="fx-secondary">Regular Chrome profile</span>
          </button>
        </div>

        {containers && containers.length === 0 && <p class="fx-secondary">You have no containers yet. Create one to open this site in it.</p>}

        {creating ? (
          <div class="choose__create">
            <ContainerForm
              existingNames={names}
              defaultColor={nextColor}
              submitLabel="Create and open"
              onCancel={() => setCreating(false)}
              onSubmit={async (value) => {
                const made = await facetApi.createContainer(value);
                await reload();
                await go(made.id);
              }}
            />
          </div>
        ) : (
          <div>
            <Button small onClick={() => setCreating(true)} disabled={busy}>New container…</Button>
          </div>
        )}
        {error && <p class="fx-notice fx-notice--error" role="alert">{error}</p>}
      </section>
    </main>
  );
}
