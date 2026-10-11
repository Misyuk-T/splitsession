import { useEffect, useRef, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { CONTAINER_HEX } from '../../core';
import type { RestoreStatus } from '../../background/restore';
import { facetApi } from '../../engine/api-client';
import { Button, Dot } from '../components/Button';
import { Logo } from '../components/Logo';
import { describeError } from '../format';
import { useContainers } from '../useContainers';

/** The address this page stands for: `held.html?u=<address>` (set by Facet; only http(s) is accepted). */
function addressOf(search: string): string | null {
  const u = new URLSearchParams(search).get('u');
  return u && /^https?:\/\//i.test(u) ? u : null;
}

/**
 * What a tab shows while Facet is not sure which container it belongs to (docs/decisions.md, "Container tabs that come
 * back"): Chrome's "blocked by an extension" says nothing. The page makes no request. Same choices as the popup banner.
 */
export function Held() {
  const address = addressOf(location.search);
  const { containers, error: loadError } = useContainers();
  const [status, setStatus] = useState<RestoreStatus | null>(null);
  const [tabId, setTabId] = useState<number | null>(null);
  /** The container the tab is in right now (null: ordinary). Shown when nothing holds the tab any more. */
  const [current, setCurrent] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.title = 'Facet: choose a container';
    void (async () => {
      const tab = await browser.tabs.getCurrent();
      setTabId(tab?.id ?? null);
      setStatus(await facetApi.getRestoreStatus().catch(() => null));
      if (tab?.id !== undefined) setCurrent(await facetApi.getTabContainer(tab.id).catch(() => undefined));
    })();
  }, []);
  const entry = status && tabId !== null ? status.held.find((h) => h.tabId === tabId) : undefined;
  const ready = status !== null && containers !== null && tabId !== null;
  useEffect(() => {
    if (ready) list.current?.querySelector<HTMLElement>('button')?.focus();
  }, [ready]);

  if (!address) {
    return (
      <main class="held">
        <header class="held__head"><Logo size={28} /><h1>Facet</h1></header>
        <p class="fx-notice fx-notice--info" role="status">This page shows a tab that Facet is holding back after a restart. It was opened without an address, so there is nothing to choose.</p>
      </main>
    );
  }

  const nameOf = (id: string) => containers?.find((c) => c.id === id)?.name ?? id;
  const colorOf = (id: string) => containers?.find((c) => c.id === id)?.color;
  const choose = async (containerId: string | null) => {
    if (busy || tabId === null) return;
    setBusy(true);
    setError(null);
    try {
      if (entry) {
        // Facet puts the tab where it was chosen and sends it to its address.
        await facetApi.assignTab(tabId, containerId, { reload: true });
      } else if (containerId === null) {
        // The tab may still belong to a container (the hold ended after "Open in A", then Back): take it out first,
        // or the site would get that container's account.
        await facetApi.assignTab(tabId, null);
        location.replace(address);
      } else {
        // "Choose a container…": the choose page places the tab where the user picks, then sends it to the address.
        location.replace(`${browser.runtime.getURL('/choose.html' as never)}?url=${encodeURIComponent(address)}&tab=${tabId}`);
      }
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  };

  const candidates = entry ? entry.candidates.filter((id) => containers?.some((c) => c.id === id)) : [];
  return (
    <main class="held">
      <header class="held__head"><Logo size={28} /><h1>Facet</h1></header>
      <section class="held__card" aria-labelledby="held-title">
        <h2 id="held-title">{entry ? 'This tab is waiting for you' : 'This tab is no longer on hold'}</h2>
        <p>
          {entry
            ? 'Chrome brought this page back, and Facet is not sure which container it belongs to. Nothing has been sent to the site yet.'
            : 'Facet held this page back before the browser closed. Choose how to open it.'}
        </p>
        <p class="fx-secondary held__url" data-testid="held-url">{address}</p>
        {!entry && current !== undefined && (
          <p class="fx-secondary" data-testid="held-current">
            This tab is now {current === null ? 'an ordinary tab (regular Chrome profile)' : `in ${nameOf(current)}`}.
          </p>
        )}

        {loadError && <p class="fx-notice fx-notice--error" role="alert">{loadError}</p>}

        <div ref={list} class="held__options" role="group" aria-label="Where to open this tab">
          {entry
            ? candidates.map((id) => (
                <button key={id} type="button" class="held__option" disabled={busy || !ready} onClick={() => void choose(id)} data-testid="held-container">
                  <Dot color={CONTAINER_HEX[colorOf(id) ?? 'blue']} />
                  <span class="held__name">Open in {nameOf(id)}</span>
                  <span class="fx-secondary">Maybe</span>
                </button>
              ))
            : null}
          {!entry && (
            <button type="button" class="held__option" disabled={busy || !ready} onClick={() => void choose('')} data-testid="held-choose">
              <span class="held__name">Choose a container…</span>
            </button>
          )}
          <button type="button" class="held__option held__option--plain" disabled={busy || !ready} onClick={() => void choose(null)} data-testid="held-plain">
            <span class="held__nodot" aria-hidden="true" />
            <span class="held__name">Open as an ordinary tab</span>
            <span class="fx-secondary">Regular Chrome profile</span>
          </button>
        </div>
        {error && <p class="fx-notice fx-notice--error" role="alert">{error}</p>}
        {entry && <p class="fx-secondary">The Facet button in the toolbar offers the same choices for every waiting tab at once.</p>}
      </section>
    </main>
  );
}
