import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import type { ContainerInfo } from '../../background/facet';
import { CONTAINER_COLORS, CONTAINER_HEX, type ContainerColor, type Settings } from '../../core';
import { facetApi } from '../../engine/api-client';
import { BridgeCard } from '../components/BridgeCard';
import { Button, Dot } from '../components/Button';
import { ContainerForm } from '../components/ContainerForm';
import { ConfirmDialog } from '../components/Dialog';
import type { RestoreStatus } from '../../background/restore';
import { describeError, hostOf, isWebUrl, tabsLabel } from '../format';
import { Logo } from '../components/Logo';
import { MenuButton, type MenuItem } from '../components/Menu';
import { IconChevron, IconMore, IconPlus, IconSettings, IconSwap } from '../icons';

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
/** Waiting tabs listed by name in the banner; the rest are counted. */
const HELD_ROWS = 3;

/** "github.com/org/repo?tab=1" for a waiting tab (its title is the address while nothing has loaded). */
function shortAddress(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname === '/' ? '' : u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

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
  const [restore, setRestore] = useState<RestoreStatus | null>(null);
  const [heldOpen, setHeldOpen] = useState(false);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const say = (text: string, error = false) => {
    setStatus({ text, error });
    if (statusTimer.current) clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setStatus(null), error ? 8000 : 4000);
  };

  const refresh = useCallback(async () => {
    try {
      const [list, active, prefs, restoreStatus] = await Promise.all([
        facetApi.listContainers(),
        currentTab(),
        facetApi.getSettings(),
        facetApi.getRestoreStatus(),
      ]);
      setContainers(list);
      setRestore(restoreStatus);
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
        <p class="fx-notice fx-notice--error" role="alert">SplitSession could not start: {loadError}</p>
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

  const held = restore?.held ?? [];
  const nameOf = (id: string) => containers.find((c) => c.id === id)?.name ?? id;
  const resolveHeld = (action: 'restore' | 'plain') =>
    run(async () => {
      const count = await facetApi.resolveHeldTabs(action);
      await refresh();
      say(action === 'restore' ? `${tabsLabel(count)} back in their containers.` : `${tabsLabel(count)} opened as ordinary tabs.`);
    }, 'Could not open the tabs');
  const chooseHeld = (tabId: number, choice: string) =>
    run(async () => {
      await facetApi.assignTab(tabId, choice === NONE ? null : choice, { reload: true });
      await refresh();
      say(choice === NONE ? 'Opened as an ordinary tab.' : `Opened in “${nameOf(choice)}”.`);
    }, 'Could not open the tab');

  const editing = mode.kind === 'edit' ? containers.find((c) => c.id === mode.id) : undefined;

  const canRegroup = !!settings?.tabGroups && containers.some((c) => c.tabCount > 0);
  const regroup = () =>
    void run(async () => {
      await facetApi.regroupTabs();
      say('Tabs grouped by container.');
    }, 'Could not re-group');
  // Full: the "More" menu also holds the state page. Lite has no state page: its menu holds only "Re-group tabs", and the
  // button is disabled while there is nothing to group (a menu whose only item is disabled cannot be opened).
  const overflowItems: MenuItem[] = [
    ...(__FULL__ ? [{ id: 'state', label: 'Open state page' }] : []),
    { id: 'regroup', label: 'Re-group tabs by container', disabled: !canRegroup },
  ];
  const onOverflow = (id: string) => {
    if (__FULL__ && id === 'state') void browser.tabs.create({ url: browser.runtime.getURL('/state.html' as never) });
    else regroup();
  };

  const heldLabel = held.length === 1 ? '1 tab waiting' : `${held.length} tabs waiting`;
  const heldName = (h: (typeof held)[number]) => (h.title && h.title !== h.url ? h.title : shortAddress(h.url));

  return (
    <main class="popup">
      <header class="popup__head">
        <Logo size={24} />
        <h1 class="popup__title">SplitSession</h1>
        <span class="popup__spacer" />
        <Button variant="ghost" small icon aria-label="Settings" title="Settings" onClick={() => void browser.runtime.openOptionsPage()}>
          <IconSettings />
        </Button>
        <MenuButton ariaLabel="More" menuLabel="More" items={overflowItems} onSelect={onOverflow} align="end" variant="ghost" small icon disabled={!__FULL__ && !canRegroup}>
          <IconMore />
        </MenuButton>
      </header>

      {__FULL__ && <BridgeCard layout="popup" />}

      {held.length > 0 && (
        <section class="popup__held" aria-label="Tabs waiting" data-testid="restore-banner">
          <div class="popup__heldline">
            <button type="button" class="popup__heldmain" aria-expanded={heldOpen} aria-controls="popup-held-list" onClick={() => setHeldOpen(!heldOpen)}>
              <span class="popup__helddot" aria-hidden="true" />
              <span>{heldLabel}</span>
              <span class={`fx-chevron${heldOpen ? ' fx-chevron--open' : ''}`}><IconChevron /></span>
            </button>
            {restore!.oneClick > 0 && (
              <Button
                small
                variant="primary"
                disabled={busy}
                aria-label={`Restore ${restore!.oneClick === 1 ? '1 container tab' : `${restore!.oneClick} container tabs`}`}
                title="Put the tabs SplitSession is sure about back in their containers"
                onClick={() => void resolveHeld('restore')}
              >
                Restore
              </Button>
            )}
            <MenuButton
              ariaLabel="Waiting tabs options"
              menuLabel="Waiting tabs"
              items={[{ id: 'plain', label: restore!.oneClick > 0 ? 'Open the rest as ordinary tabs' : 'Open as ordinary tabs', disabled: busy }]}
              onSelect={() => void resolveHeld('plain')}
              align="end"
              variant="ghost"
              small
              icon
            >
              <IconMore />
            </MenuButton>
          </div>
          {heldOpen && (
            <ul id="popup-held-list" class="popup__heldrows">
              {held.slice(0, HELD_ROWS).map((h) => (
                <li key={h.tabId} class="popup__heldrow" data-testid="held-tab">
                  <span class="popup__heldtext">
                    <span class="popup__heldname" title={h.url}>
                      {heldName(h)}
                    </span>
                    <span class="fx-secondary popup__heldname">{h.candidates.map(nameOf).join(' or ')}?</span>
                  </span>
                  <MenuButton
                    ariaLabel={`Open ${heldName(h)} in`}
                    menuLabel="Open this tab in"
                    items={[
                      ...h.candidates.map((id) => {
                        const c = containers.find((x) => x.id === id);
                        return { id, label: c?.name ?? id, ...(c ? { dot: CONTAINER_HEX[c.color] } : {}) };
                      }),
                      { id: NONE, label: 'Ordinary tab', separatorBefore: true },
                    ]}
                    onSelect={(id) => void chooseHeld(h.tabId, id)}
                    align="end"
                    variant="ghost"
                    small
                    icon
                  >
                    <IconSwap />
                  </MenuButton>
                </li>
              ))}
              {held.length > HELD_ROWS && <li class="fx-secondary popup__heldmore">and {held.length - HELD_ROWS} more</li>}
            </ul>
          )}
        </section>
      )}

      <section class="popup__tab" aria-label="This tab" data-testid="current-container">
        {current ? <Dot color={CONTAINER_HEX[current.color]} /> : <span class="popup__nodot" aria-hidden="true" />}
        <div class="popup__tabtext">
          <strong class={`popup__tabname${current ? '' : ' popup__tabname--none'}`}>{current ? current.name : 'No container'}</strong>
          <span class="fx-secondary popup__tabsite">{web ? hostOf(tab?.url) : 'Web pages only'}</span>
        </div>
        <MenuButton
          items={reopenItems}
          onSelect={(id) => void reopen(id)}
          ariaLabel="Reopen in…"
          title={web ? 'Reopen in…' : 'Only web pages can be put in a container'}
          menuLabel="Reopen this tab in"
          align="end"
          disabled={!web}
          variant="ghost"
          small
          icon
        >
          <IconSwap />
        </MenuButton>
      </section>

      <section class="popup__list" aria-labelledby="containers-title">
        <div class="popup__listhead">
          <h2 id="containers-title" class="popup__label">Containers</h2>
          {mode.kind === 'idle' && (
            <Button variant="ghost" small icon aria-label="New container" title="New container" onClick={() => setMode({ kind: 'create' })}>
              <IconPlus />
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

        {containers.length === 0 && mode.kind !== 'create' && <p class="popup__empty fx-secondary">No containers yet. Add one with +.</p>}

        <ul class="popup__rows" data-testid="container-list">
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
                <button type="button" class="popup__rowmain" aria-label={`New tab in ${c.name}`} title={`New tab in ${c.name}${c.tabCount > 0 ? ` (${tabsLabel(c.tabCount)} open)` : ''}`} onClick={() => void newTab(c)}>
                  <Dot color={CONTAINER_HEX[c.color]} />
                  <span class="popup__rowname">{c.name}</span>
                  {c.tabCount > 0 && (
                    <span class="fx-secondary popup__rowtabs" data-testid="container-tabs">
                      {c.tabCount}
                    </span>
                  )}
                </button>
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
                  <IconMore />
                </MenuButton>
              </li>
            ),
          )}
        </ul>
      </section>

      <div class={`popup__status fx-status${status?.error ? ' fx-status--error' : ''}${status ? ' popup__status--on' : ''}`} role="status" aria-live="polite">
        {status?.text}
      </div>

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
