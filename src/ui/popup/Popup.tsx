import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import type { ContainerInfo } from '../../background/facet';
import { CONTAINER_COLORS, CONTAINER_HEX, type ContainerColor, type Settings } from '../../core';
import { facetApi } from '../../engine/api-client';
import { Button, Dot } from '../components/Button';
import { ContainerForm } from '../components/ContainerForm';
import { ConfirmDialog } from '../components/Dialog';
import { describeError, hostOf, isWebUrl, tabsLabel } from '../format';
import { Logo } from '../components/Logo';
import { MenuButton, type MenuItem } from '../components/Menu';

interface TabInfo {
  id: number;
  url: string;
}

type Mode = { kind: 'idle' } | { kind: 'create' } | { kind: 'edit'; id: string };
interface Status {
  text: string;
  error?: boolean;
}

const NONE = '__none__';

/** The tab the popup acts on: the active tab of this window (a `?tab=<id>` override exists for tests). */
async function currentTab(): Promise<TabInfo | null> {
  const override = new URLSearchParams(location.search).get('tab');
  const tab = override ? await browser.tabs.get(Number(override)).catch(() => undefined) : (await browser.tabs.query({ active: true, currentWindow: true }))[0];
  return tab?.id === undefined ? null : { id: tab.id, url: tab.url ?? tab.pendingUrl ?? '' };
}

export function Popup() {
  const [containers, setContainers] = useState<ContainerInfo[] | null>(null);
  const [tab, setTab] = useState<TabInfo | null>(null);
  const [tabContainer, setTabContainer] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: 'idle' });
  const [deleting, setDeleting] = useState<ContainerInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const say = (text: string, error = false) => {
    setStatus({ text, error });
    if (statusTimer.current) clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setStatus(null), error ? 8000 : 4000);
  };

  const refresh = useCallback(async () => {
    try {
      const [list, active, prefs] = await Promise.all([facetApi.listContainers(), currentTab(), facetApi.getSettings()]);
      setContainers(list);
      setTab(active);
      setSettings(prefs);
      setTabContainer(active ? await facetApi.getTabContainer(active.id) : null);
      setLoadError(null);
    } catch (error) {
      setLoadError(describeError(error));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (work: () => Promise<void>, failure: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await work();
    } catch (error) {
      say(`${failure}: ${describeError(error)}`, true);
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <main class="popup">
        <p class="fx-notice fx-notice--error" role="alert">Facet could not start: {loadError}</p>
        <Button onClick={() => void refresh()}>Try again</Button>
      </main>
    );
  }
  if (!containers) {
    return (
      <main class="popup" aria-busy="true">
        <p class="fx-secondary">Loading…</p>
      </main>
    );
  }

  const current = containers.find((c) => c.id === tabContainer) ?? null;
  const names = containers.map((c) => c.name);
  const web = isWebUrl(tab?.url);
  const nextColor: ContainerColor = CONTAINER_COLORS.find((c) => !containers.some((x) => x.color === c)) ?? CONTAINER_COLORS[containers.length % CONTAINER_COLORS.length]!;

  const reopenItems: MenuItem[] = [
    ...containers.map((c) => ({ id: c.id, label: c.name, dot: CONTAINER_HEX[c.color], checked: c.id === tabContainer })),
    { id: NONE, label: 'No container', separatorBefore: containers.length > 0, checked: tabContainer === null },
  ];

  const reopen = (id: string) =>
    run(async () => {
      if (!tab) return;
      const target = id === NONE ? null : id;
      if (target === tabContainer) return;
      await facetApi.assignTab(tab.id, target, { reload: true });
      await refresh();
      say(target === null ? 'Reopened without a container.' : `Reopened in “${containers.find((c) => c.id === target)?.name}”.`);
    }, 'Could not reopen the tab');

  const newTab = (c: ContainerInfo) =>
    run(async () => {
      await facetApi.newTabInContainer(c.id);
      await refresh();
      window.close(); // the popup closes by itself when the new tab takes focus; this covers the rest
    }, 'Could not open a tab');

  const rowMenu = (c: ContainerInfo): MenuItem[] => [
    { id: 'edit', label: 'Rename or recolour…' },
    { id: 'delete', label: 'Delete…', danger: true, separatorBefore: true },
  ];

  const editing = mode.kind === 'edit' ? containers.find((c) => c.id === mode.id) : undefined;

  return (
    <main class="popup">
      <header class="popup__head">
        <Logo size={26} />
        <h1 class="popup__title">Facet</h1>
        <span class="popup__spacer" />
        <Button variant="ghost" small onClick={() => void browser.runtime.openOptionsPage()}>
          Settings
        </Button>
      </header>

      <section class="popup__current" aria-labelledby="current-title">
        <h2 id="current-title" class="popup__label">This tab</h2>
        <div class="popup__tab" data-testid="current-container">
          {current ? <Dot color={CONTAINER_HEX[current.color]} /> : <span class="popup__nodot" aria-hidden="true" />}
          <div class="popup__tabtext">
            <strong class="popup__tabname">{current ? current.name : 'No container'}</strong>
            <span class="fx-secondary">{web ? hostOf(tab?.url) : 'Not a web page'}</span>
          </div>
        </div>
        <MenuButton
          items={reopenItems}
          onSelect={(id) => void reopen(id)}
          menuLabel="Reopen this tab in"
          disabled={!web}
          block
        >
          <span>Reopen this tab in…</span>
          <span aria-hidden="true">▾</span>
        </MenuButton>
        {!web && <p class="fx-secondary popup__note">Only web pages (http or https) can be put in a container.</p>}
        {web && !current && <p class="fx-secondary popup__note">It uses your regular Chrome profile.</p>}
      </section>

      <section class="popup__list" aria-labelledby="containers-title">
        <div class="popup__listhead">
          <h2 id="containers-title" class="popup__label">Containers</h2>
          {mode.kind === 'idle' && (
            <Button small variant="primary" onClick={() => setMode({ kind: 'create' })}>
              New container
            </Button>
          )}
        </div>

        {mode.kind === 'create' && (
          <div class="popup__form">
            <ContainerForm
              existingNames={names}
              defaultColor={nextColor}
              submitLabel="Create"
              onCancel={() => setMode({ kind: 'idle' })}
              onSubmit={async (value) => {
                await facetApi.createContainer(value);
                setMode({ kind: 'idle' });
                await refresh();
                say(`Created “${value.name}”.`);
              }}
            />
          </div>
        )}

        {containers.length === 0 && mode.kind !== 'create' && (
          <p class="popup__empty fx-secondary">No containers yet. A container keeps its own logins, so you can use two accounts of one site side by side.</p>
        )}

        <ul class="popup__rows">
          {containers.map((c) =>
            editing?.id === c.id ? (
              <li key={c.id} class="popup__row popup__row--editing">
                <ContainerForm
                  existingNames={names}
                  initial={{ name: c.name, color: c.color }}
                  submitLabel="Save"
                  onCancel={() => setMode({ kind: 'idle' })}
                  onSubmit={async (value) => {
                    await facetApi.updateContainer(c.id, value);
                    setMode({ kind: 'idle' });
                    await refresh();
                    say('Saved.');
                  }}
                />
              </li>
            ) : (
              <li key={c.id} class="popup__row" data-testid="container-row" data-current={c.id === tabContainer ? 'true' : undefined}>
                <Dot color={CONTAINER_HEX[c.color]} />
                <div class="popup__rowtext">
                  <span class="popup__rowname">{c.name}</span>
                  <span class="fx-secondary">{tabsLabel(c.tabCount)}</span>
                </div>
                <Button small onClick={() => void newTab(c)} aria-label={`New tab in ${c.name}`}>
                  New tab
                </Button>
                <MenuButton
                  ariaLabel={`Actions for ${c.name}`}
                  menuLabel={`${c.name} actions`}
                  items={rowMenu(c)}
                  align="end"
                  variant="ghost"
                  small
                  icon
                  onSelect={(id) => (id === 'edit' ? setMode({ kind: 'edit', id: c.id }) : setDeleting(c))}
                >
                  <span aria-hidden="true">⋯</span>
                </MenuButton>
              </li>
            ),
          )}
        </ul>
      </section>

      <div class={`popup__status${status?.error ? ' fx-status--error' : ''} fx-status`} role="status" aria-live="polite">
        {status?.text}
      </div>

      <footer class="popup__foot">
        <Button variant="ghost" small onClick={() => void browser.tabs.create({ url: browser.runtime.getURL('/state.html' as never) })}>
          Open state page
        </Button>
        {settings?.tabGroups && containers.some((c) => c.tabCount > 0) && (
          <Button
            variant="ghost"
            small
            onClick={() =>
              void run(async () => {
                await facetApi.regroupTabs();
                say('Tabs grouped by container.');
              }, 'Could not re-group')
            }
          >
            Re-group tabs
          </Button>
        )}
      </footer>

      {deleting && (
        <ConfirmDialog
          title={`Delete “${deleting.name}”?`}
          confirmLabel="Delete container"
          danger
          busy={busy}
          onCancel={() => setDeleting(null)}
          onConfirm={() =>
            void run(async () => {
              const target = deleting;
              await facetApi.deleteContainer(target.id);
              setDeleting(null);
              await refresh();
              say(`Deleted “${target.name}”.`);
            }, 'Could not delete')
          }
        >
          <p>
            {deleting.tabCount > 0
              ? `${deleting.tabCount === 1 ? 'Its open tab' : `Its ${deleting.tabCount} open tabs`} will be closed and its saved logins (cookies) forgotten.`
              : 'Its saved logins (cookies) will be forgotten.'}
          </p>
          <p class="fx-secondary">This cannot be undone.</p>
        </ConfirmDialog>
      )}
    </main>
  );
}
