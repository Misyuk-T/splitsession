import { useEffect, useState } from "preact/hooks";

import { DEFAULT_SETTINGS, type Settings } from "../../core";
import { facetApi } from "../../engine/api-client";
import { Button } from "../components/Button";
import { More } from "../components/More";
import { Switch } from "../components/Toggle";
import { WhyStrict } from "../components/WhyStrict";
import { describeError } from "../format";

export const GeneralSection = () => {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [strictBusy, setStrictBusy] = useState(false);
  const [strictError, setStrictError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [regrouped, setRegrouped] = useState(false);

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

  // Not optimistic: turning it on removes every service worker first, and the switch moves only when that worked.
  const changeStrict = async (next: boolean) => {
    if (strictBusy) return;
    setStrictBusy(true);
    setStrictError(null);
    try {
      setSettings(await facetApi.updateSettings({ strictMode: next }));
    } catch (e) {
      setStrictError(
        next
          ? `Could not remove service workers: ${describeError(e)}`
          : describeError(e),
      );
    } finally {
      setStrictBusy(false);
    }
  };

  const value = settings ?? DEFAULT_SETTINGS;
  return (
    <section class="opt-section" aria-labelledby="general-title" id="general">
      <h2 id="general-title">General</h2>
      <div class="opt-card opt-card--rows">
        <div class="opt-row">
          <Switch
            label="Show containers as tab groups"
            description="Tabs are grouped by container, with its name and colour."
            checked={value.tabGroups}
            disabled={settings === null}
            onChange={(next) => void change({ tabGroups: next })}
          />
          <div class="opt-row__foot">
            <More id="more-groups" about="tab groups">
              <p>Dragging a tab out of a group never changes its container.</p>
            </More>
            {value.tabGroups && (
              <>
                {regrouped && (
                  <span class="fx-secondary" role="status">
                    Tabs grouped by container.
                  </span>
                )}
                <Button
                  small
                  disabled={settings === null}
                  onClick={() =>
                    void facetApi
                      .regroupTabs()
                      .then(() => setRegrouped(true))
                      .catch((e: unknown) =>
                        setError(`Could not re-group: ${describeError(e)}`),
                      )
                  }
                >
                  Re-group tabs now
                </Button>
              </>
            )}
          </div>
        </div>
        <div class="opt-row">
          <Switch
            label="Mark container tabs outside their group"
            description="Adds ⧉ to the tab title. Sites can read titles."
            checked={value.markOutsideGroup}
            disabled={settings === null}
            onChange={(next) => void change({ markOutsideGroup: next })}
          />
          <More id="more-mark" about="the tab mark">
            <p>
              A container tab that is not inside its container’s group (dragged
              out, or tab groups switched off) gets ⧉ in front of its title, so
              it does not look like an ordinary tab. The mark goes when the tab
              is back in its group or leaves the container.
            </p>
            <p>
              The mark never contains the container’s name, but a page can read
              its own title, so a site can tell that this is a container tab.
              Off: titles stay as the site sets them.
            </p>
          </More>
        </div>
        <div class="opt-row">
          <Switch
            label="Restore container tabs after restart"
            description="Tabs come back in their containers after Chrome restarts."
            checked={value.restoreTabs}
            disabled={settings === null}
            onChange={(next) => void change({ restoreTabs: next })}
          />
          <More id="more-restore" about="restoring tabs">
            <p>
              When Chrome brings tabs back (restarting with “Continue where you
              left off”, Reopen closed tab, History, a closed tab group opened
              again), container tabs return to their container before they load.
              SplitSession keeps the addresses of container tabs on this
              computer for that.
            </p>
            <p>
              A tab it cannot match with certainty waits unloaded, and the popup
              asks you. Off: such tabs come back as ordinary tabs.
            </p>
          </More>
        </div>
        <div class="opt-row">
          <Switch
            label="Strict mode"
            description="Sites can’t send push notifications while it’s on."
            checked={value.strictMode}
            disabled={settings === null || strictBusy}
            onChange={(next) => void changeStrict(next)}
          />
          <WhyStrict />
          {strictBusy && (
            <p class="fx-secondary" role="status">
              {value.strictMode
                ? "Turning off…"
                : "Turning on: removing service workers…"}
            </p>
          )}
          {strictError && (
            <p class="fx-notice fx-notice--error" role="alert">
              {strictError}
            </p>
          )}
        </div>
      </div>
      {error && (
        <p class="fx-notice fx-notice--error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
};
