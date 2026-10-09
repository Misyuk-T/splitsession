import { useEffect, useState } from 'preact/hooks';
import { DEFAULT_SETTINGS, type Settings } from '../../core';
import { facetApi } from '../../engine/api-client';
import { Switch } from '../components/Toggle';
import { describeError } from '../format';

export function GeneralSection() {
  const [settings, setSettings] = useState<Settings | null>(null);
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
          label="Put the container name in front of tab titles"
          description="A tab in the container Work shows as “[Work] Inbox”. It makes accounts easy to tell apart in the tab strip and in tab lists."
          checked={value.titlePrefix}
          disabled={settings === null}
          onChange={(next) => void change({ titlePrefix: next })}
        />
      </div>
      {error && <p class="fx-notice fx-notice--error" role="alert">{error}</p>}
    </section>
  );
}
