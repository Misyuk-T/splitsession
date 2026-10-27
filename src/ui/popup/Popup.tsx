import { useState } from "preact/hooks";
import { browser } from "wxt/browser";

import type { ContainerInfo } from "../../background/facet";
import { CONTAINER_COLORS, type ContainerColor, isHttpUrl } from "../../core";
import { facetApi } from "../../engine/api-client";
import { BridgeRow } from "../components/BridgeCard";
import { Button } from "../components/Button";
import { ContainerForm } from "../components/ContainerForm";
import { CopyNotice, useOtherCopies } from "../components/CopyNotice";
import { describeError, plural, tabsLabel } from "../format";
import { IconPlus } from "../icons";
import { useBridge } from "../useBridge";
import { ContainerRow } from "./ContainerRow";
import { DeleteDialog } from "./DeleteDialog";
import { Header } from "./Header";
import { HeldBanner } from "./HeldBanner";
import { NONE, rowId } from "./ids";
import { RestoreOffer } from "./RestoreOffer";
import { RuleBudgetNotice } from "./RuleBudgetNotice";
import { ThisTabRow } from "./ThisTabRow";
import { usePopupData } from "./usePopupData";
import { useStatus } from "./useStatus";

type Mode =
  { kind: "idle" } | { kind: "create" } | { kind: "edit"; id: string };

/** The toolbar popup: this tab's container, tabs waiting for a restore decision, and the containers. */
export const Popup = () => {
  // Full only (a compile-time constant, so the hook order never changes): one poll of the bridge for the MCP pill and the agent row.
  // eslint-disable-next-line react-hooks/rules-of-hooks -- __FULL__ is a build-time constant, so the hook is either always or never called
  const bridge = __FULL__ ? useBridge() : null;
  const {
    containers,
    tab,
    tabContainer,
    restore,
    groupOffer,
    ruleStats,
    loadError,
    refresh,
  } = usePopupData();
  const otherCopies = useOtherCopies();
  const { busy, status, say, run } = useStatus();
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [deleting, setDeleting] = useState<ContainerInfo | null>(null);
  const [heldOpen, setHeldOpen] = useState(false);
  const [restoredNote, setRestoredNote] = useState<string | null>(null);

  if (loadError) {
    return (
      <main class="popup">
        <p class="fx-notice fx-notice--error" role="alert">
          SplitSession could not start: {loadError}
        </p>
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
  const web = isHttpUrl(tab?.url);
  const nextColor: ContainerColor =
    CONTAINER_COLORS.find((c) => !containers.some((x) => x.color === c)) ??
    CONTAINER_COLORS[containers.length % CONTAINER_COLORS.length]!;
  const nameOf = (id: string) =>
    containers.find((c) => c.id === id)?.name ?? id;

  const reopen = (id: string) =>
    run(async () => {
      if (!tab) return;
      const target = id === NONE ? null : id;
      if (target === tabContainer) return;
      const left = tabContainer;
      await facetApi.assignTab(tab.id, target, { reload: true });
      await refresh();
      say(
        target === null
          ? "Reopened without a container."
          : `Reopened in “${containers.find((c) => c.id === target)?.name}”.`,
      );
      // The "This tab" row is gone once the tab has no container, and the pressed "move in" icon goes once the tab is in
      // that container: focus goes to the main button of the container the tab left, or entered (still about that tab).
      const focusRow = target ?? left;
      if (focusRow)
        setTimeout(() => document.getElementById(rowId(focusRow))?.focus(), 0);
    }, "Could not reopen the tab");

  const newTab = (c: ContainerInfo) =>
    run(async () => {
      await facetApi.newTabInContainer(c.id);
      await refresh();
      window.close(); // the popup closes by itself when the new tab takes focus; this covers the rest
    }, "Could not open a tab");

  /**
   * The row's main action. With open tabs: show the container's first tab (lowest index in this window, else the first
   * in any window): open its group if it is collapsed, make the tab active, focus its window. No tabs: open the saved
   * ones (all of them), or a new blank one when nothing is saved.
   */
  const goTo = (c: ContainerInfo) =>
    run(async () => {
      const ids = new Set(
        (await facetApi.listTabs())
          .filter((t) => t.containerId === c.id)
          .map((t) => t.tabId),
      );
      const tabs = (
        await Promise.all(
          [...ids].map((id) => browser.tabs.get(id).catch(() => undefined)),
        )
      ).filter((t): t is Browser.tabs.Tab => t?.id !== undefined);
      if (tabs.length === 0 && c.savedCount > 0) {
        // The container's last tabs were saved when they closed: all of them come back, in this window.
        const here = (await browser.windows.getCurrent()).id;
        await facetApi.openSavedTabs(
          c.id,
          here === undefined ? {} : { windowId: here },
        );
      } else if (tabs.length === 0) {
        await facetApi.newTabInContainer(c.id);
      } else {
        const here = (await browser.windows.getCurrent()).id;
        const inHere = tabs.filter((t) => t.windowId === here);
        const first = (inHere.length > 0 ? inHere : tabs).reduce((a, b) =>
          b.index < a.index ? b : a,
        );
        if (first.groupId !== undefined && first.groupId >= 0)
          await browser.tabGroups
            .update(first.groupId, { collapsed: false })
            .catch(() => {});
        await browser.tabs.update(first.id!, { active: true });
        await browser.windows.update(first.windowId, { focused: true });
      }
      await refresh();
      window.close(); // the popup closes by itself when another tab takes focus; this covers the rest
    }, "Could not open the container");

  const resolveHeld = (action: "restore" | "plain") =>
    run(async () => {
      const count = await facetApi.resolveHeldTabs(action);
      await refresh();
      say(
        action === "restore"
          ? `${tabsLabel(count)} back in their containers.`
          : `${tabsLabel(count)} opened as ordinary tabs.`,
      );
    }, "Could not open the tabs");
  const chooseHeld = (tabId: number, choice: string) =>
    run(async () => {
      await facetApi.assignTab(tabId, choice === NONE ? null : choice, {
        reload: true,
      });
      await refresh();
      say(
        choice === NONE
          ? "Opened as an ordinary tab."
          : `Opened in “${nameOf(choice)}”.`,
      );
    }, "Could not open the tab");

  const restoreGroups = () =>
    run(async () => {
      const done = await facetApi.restoreFromGroups();
      await refresh();
      const failed =
        done.failed > 0
          ? ` ${plural(done.failed, "tab")} could not be moved in.`
          : "";
      setRestoredNote(
        `Restored ${plural(done.containers, "container")}. Sign in again: a reinstall removes saved logins.${failed}`,
      );
      setTimeout(
        () =>
          document
            .querySelector<HTMLElement>('[data-testid="container-list"] button')
            ?.focus(),
        0,
      );
    }, "Could not restore the containers");

  const dismissGroupOffer = () =>
    run(async () => {
      await facetApi.dismissGroupRestoreOffer();
      await refresh();
      setTimeout(
        () =>
          document
            .querySelector<HTMLElement>('button[aria-label="New container"]')
            ?.focus(),
        0,
      );
    }, "Could not dismiss");

  const create = async (value: { name: string; color: ContainerColor }) => {
    const made = await facetApi.createContainer(value);
    setMode({ kind: "idle" });
    // The point of a new container is to use it: open a tab in it (as a click on its row does) and let go.
    try {
      await facetApi.newTabInContainer(made.id);
    } catch (error) {
      await refresh();
      say(
        `Created “${value.name}”, but could not open a tab: ${describeError(error)}`,
        true,
      );
      return;
    }
    await refresh();
    say(`Created “${value.name}”.`);
    window.close(); // the popup closes by itself when the new tab takes focus; this covers the rest
  };

  const save =
    (c: ContainerInfo) =>
    async (value: { name: string; color: ContainerColor }) => {
      await facetApi.updateContainer(c.id, value);
      setMode({ kind: "idle" });
      await refresh();
      say("Saved.");
    };

  const forgetSaved = (c: ContainerInfo) =>
    run(async () => {
      const count = await facetApi.forgetSavedTabs(c.id);
      await refresh();
      say(`Forgot ${plural(count, "saved tab")} of “${c.name}”.`);
      // The button that was pressed is gone: focus stays in the edit form.
      setTimeout(
        () =>
          document
            .querySelector<HTMLElement>(".popup__row--editing input")
            ?.focus(),
        0,
      );
    }, "Could not forget the saved tabs");

  const confirmDelete = () =>
    void run(async () => {
      const target = deleting!;
      await facetApi.deleteContainer(target.id);
      setDeleting(null);
      await refresh();
      say(`Deleted “${target.name}”.`);
    }, "Could not delete");

  const editing =
    mode.kind === "edit" ? containers.find((c) => c.id === mode.id) : undefined;
  const held = restore?.held ?? [];

  return (
    <main class="popup">
      <Header bridge={bridge} />

      <CopyNotice copies={otherCopies} />

      <RuleBudgetNotice stats={ruleStats} />

      {__FULL__ && bridge && <BridgeRow bridge={bridge} />}

      {held.length > 0 && (
        <HeldBanner
          restore={restore!}
          containers={containers}
          busy={busy}
          open={heldOpen}
          onToggle={() => setHeldOpen(!heldOpen)}
          onResolve={(action) => void resolveHeld(action)}
          onChoose={(tabId, choice) => void chooseHeld(tabId, choice)}
        />
      )}

      {current && (
        <ThisTabRow
          current={current}
          containers={containers}
          tabUrl={tab?.url}
          onReopen={(id) => void reopen(id)}
        />
      )}

      <section class="popup__list" aria-labelledby="containers-title">
        <div class="popup__listhead">
          <h2 id="containers-title" class="popup__label">
            Containers
          </h2>
          {mode.kind === "idle" && (
            <Button
              variant="ghost"
              small
              icon
              aria-label="New container"
              title="New container"
              onClick={() => setMode({ kind: "create" })}
            >
              <IconPlus />
            </Button>
          )}
        </div>

        {groupOffer && containers.length === 0 && (
          <RestoreOffer
            offer={groupOffer}
            busy={busy}
            onRestore={() => void restoreGroups()}
            onDismiss={() => void dismissGroupOffer()}
          />
        )}

        {restoredNote && (
          <p
            class="popup__note fx-secondary"
            role="status"
            data-testid="group-restore-note"
          >
            {restoredNote}
          </p>
        )}

        {mode.kind === "create" && (
          <div class="popup__form">
            <ContainerForm
              existingNames={names}
              defaultColor={nextColor}
              submitLabel="Create"
              onCancel={() => setMode({ kind: "idle" })}
              onSubmit={create}
            />
          </div>
        )}

        {containers.length === 0 && mode.kind !== "create" && !groupOffer && (
          <p class="popup__empty fx-secondary">
            No containers yet. Add one with +.
          </p>
        )}

        <ul class="popup__rows" data-testid="container-list">
          {containers.map((c) => (
            <ContainerRow
              key={c.id}
              container={c}
              editing={editing?.id === c.id}
              isCurrent={c.id === tabContainer}
              canMoveHere={web && c.id !== tabContainer}
              names={names}
              onGo={() => void goTo(c)}
              onNewTab={() => void newTab(c)}
              onMoveHere={() => void reopen(c.id)}
              onEdit={() => setMode({ kind: "edit", id: c.id })}
              onDelete={() => setDeleting(c)}
              onCancelEdit={() => setMode({ kind: "idle" })}
              onSave={save(c)}
              onForgetSaved={() => void forgetSaved(c)}
            />
          ))}
        </ul>
      </section>

      <div
        class={`popup__status fx-status${status?.error ? " fx-status--error" : ""}${status ? " popup__status--on" : ""}`}
        role="status"
        aria-live="polite"
      >
        {status?.text}
      </div>

      {deleting && (
        <DeleteDialog
          container={deleting}
          busy={busy}
          onCancel={() => setDeleting(null)}
          onConfirm={confirmDelete}
        />
      )}
    </main>
  );
};
