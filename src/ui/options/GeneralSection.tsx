import { useEffect, useState } from 'preact/hooks';
import { DEFAULT_SETTINGS, type Settings } from '../../core';
import { facetApi } from '../../engine/api-client';
import { Switch } from '../components/Toggle';
import { WhyStrict } from '../components/WhyStrict';
import { describeError } from '../format';

export function GeneralSection() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [strictBusy, setStrictBusy] = useState(false);
  const [strictError, setStrictError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      setStrictError(next ? `Could not remove service workers: ${describeError(e)}` : describeError(e));
    } finally {
      setStrictBusy(false);
    }
  };

  const value = settings ?? DEFAULT_SETTINGS;
  return (
    <section class="opt-section" aria-labelledby="general-title" id="general">
      <h2 id="general-title">General</h2>
      <div class="opt-card">
        <Switch
          label="Show containers as tab groups"
          description="Tabs of one container are grouped in the tab strip with the container's name and colour. Dragging a tab out of a group never changes its container."
          checked={value.tabGroups}
          disabled={settings === null}
          onChange={(next) => void change({ tabGroups: next })}
        />
        <Switch
          label="Restore container tabs after restart"
          description="When Chrome brings tabs back (restarting with “Continue where you left off”, Reopen closed tab, History, a closed tab group opened again), container tabs return to their container before they load. SplitSession keeps the addresses of container tabs on this computer for that. A tab it cannot match with certainty waits unloaded, and the popup asks you. Off: such tabs come back as ordinary tabs."
          checked={value.restoreTabs}
          disabled={settings === null}
          onChange={(next) => void change({ restoreTabs: next })}
        />
        {/* Agent / privacy features: Full edition only (docs/decisions.md, "Two editions"). */}
        {__FULL__ && (
          <>
            <Switch
              label="Show the container name to pages (for AI agents)"
              description={
                <>
                  Off by default. On: pages in a container tab can read the container’s name, in the page’s “data-ctr”
                  attribute and in front of the tab title. AI agents driving the browser need it to tell accounts apart.
                  Any script on the page can read it too, and the name is the same on every site, so trackers can link your
                  visits through it. Off: pages see no name and titles get no prefix (the toolbar badge and the tab’s group still
                  show it to you). Switching it off reaches open pages at once; switching it on, after they reload.
                </>
              }
              checked={value.showNameToPages}
              disabled={settings === null}
              onChange={(next) => void change({ showNameToPages: next })}
            />
            <Switch
              label="Put the container name in front of tab titles"
              description={
                value.showNameToPages
                  ? 'A tab in the container Work shows as “[Work] Inbox”. It makes accounts easy to tell apart in the tab strip and in tab lists.'
                  : 'Needs “Show the container name to pages”: a page can read its own title.'
              }
              checked={value.titlePrefix && value.showNameToPages}
              disabled={settings === null || !value.showNameToPages}
              onChange={(next) => void change({ titlePrefix: next })}
            />
          </>
        )}
      </div>

      <h3 id="strict-title">Service workers</h3>
      <div class="opt-card" aria-labelledby="strict-title">
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
            {value.strictMode ? 'Turning off…' : 'Turning on: removing service workers…'}
          </p>
        )}
        {strictError && (
          <p class="fx-notice fx-notice--error" role="alert">
            {strictError}
          </p>
        )}
      </div>
      {error && <p class="fx-notice fx-notice--error" role="alert">{error}</p>}
    </section>
  );
}
