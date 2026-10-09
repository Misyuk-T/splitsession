import { useEffect, useState } from 'preact/hooks';
import { DEFAULT_SETTINGS, type Settings } from '../../core';
import { facetApi } from '../../engine/api-client';
import type { StrictModeStatus } from '../../engine/strict-mode';
import { Button } from '../components/Button';
import { StrictConsentDialog } from '../components/StrictMode';
import { Switch } from '../components/Toggle';
import { describeError } from '../format';

const when = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function GeneralSection() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [strict, setStrict] = useState<StrictModeStatus | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  const [consentBusy, setConsentBusy] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadStrict = async () => {
    const status = await facetApi.getStrictMode();
    setStrict(status);
    if (status.prompt) setConsentOpen(true);
  };

  useEffect(() => {
    facetApi.getSettings().then(setSettings, (e) => setError(describeError(e)));
    loadStrict().catch((e) => setError(describeError(e)));
  }, []);

  const change = async (patch: Partial<Settings>) => {
    const before = settings ?? DEFAULT_SETTINGS;
    setSettings({ ...before, ...patch }); // optimistic; the background confirms or we roll back
    try {
      setSettings(await facetApi.updateSettings(patch));
      setError(null);
      if ('strictMode' in patch) await loadStrict(); // turning it on asks for consent
    } catch (e) {
      setSettings(before);
      setError(describeError(e));
    }
  };

  const accept = async () => {
    if (consentBusy) return;
    setConsentBusy(true);
    setConsentError(null);
    try {
      setStrict(await facetApi.grantStrictMode());
      setConsentOpen(false);
    } catch (e) {
      setConsentError(`Could not remove service workers: ${describeError(e)}`);
    } finally {
      setConsentBusy(false);
    }
  };
  const later = () => {
    setConsentOpen(false);
    setConsentError(null);
    void facetApi.dismissStrictModePrompt().then(setStrict, () => {});
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
      </div>

      <h3 id="strict-title">Service workers</h3>
      <div class="opt-card" aria-labelledby="strict-title">
        <Switch
          label="Strict mode: no service workers in this profile"
          description="With your OK, Facet removes every service worker of this Chrome profile and stops sites from installing new ones, so none can answer a container tab with your regular logins. Cost: push notifications and offline mode of every site in this profile. Off: workers are removed only on sites you use in containers, and a container’s first visit to a site can still be answered by one."
          checked={value.strictMode}
          disabled={settings === null}
          onChange={(next) => void change({ strictMode: next })}
        />
        {strict?.enabled && strict.active && strict.consentAt !== null && (
          <p class="fx-secondary" data-testid="strict-status">
            Active since {when(strict.consentAt)}.
          </p>
        )}
        {strict?.enabled && !strict.active && (
          <div class="fx-notice fx-notice--warn fx-strict-warning" data-testid="strict-status">
            <p>Waiting for your OK: service workers have not been removed yet.</p>
            <Button small onClick={() => setConsentOpen(true)}>
              Review…
            </Button>
          </div>
        )}
      </div>
      {error && <p class="fx-notice fx-notice--error" role="alert">{error}</p>}
      {consentOpen && strict?.enabled && !strict.active && (
        <StrictConsentDialog busy={consentBusy} error={consentError} onAccept={() => void accept()} onLater={later} />
      )}
    </section>
  );
}
