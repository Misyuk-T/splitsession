import { useCallback, useEffect, useState } from 'preact/hooks';
import { useContainers } from '../useContainers';
import { Logo } from '../components/Logo';
import { BridgeSection } from './BridgeSection';
import { AdvancedSection, type AdvancedOpen } from './AdvancedSection';
import { GeneralSection } from './GeneralSection';
import { RulesSection } from './RulesSection';

const FOLDED: ReadonlyArray<keyof AdvancedOpen> = ['transfer', 'diagnostics'];

/**
 * `options.html#agent` (also `#agents`): scroll to that section and put keyboard focus on its heading. Runs again when only the hash changes.
 * `#transfer` and `#diagnostics` are the folded parts of Advanced: they open that part, then scroll to and focus its button.
 */
function useSectionHash(openFolded: (key: keyof AdvancedOpen) => void): void {
  useEffect(() => {
    const go = () => {
      const raw = decodeURIComponent(location.hash.slice(1));
      const id = raw === 'agents' ? 'agent' : raw;
      const folded = FOLDED.find((key) => key === id);
      if (folded) openFolded(folded);
      const target = folded ? document.getElementById(folded) : id ? document.getElementById(id)?.querySelector<HTMLElement>('h2') : null;
      if (!target) return;
      if (!folded) target.tabIndex = -1;
      target.scrollIntoView({ block: 'start' });
      target.focus({ preventScroll: true });
    };
    go();
    window.addEventListener('hashchange', go);
    return () => window.removeEventListener('hashchange', go);
  }, [openFolded]);
}

export function Options() {
  const { containers, error, reload } = useContainers();
  const [advanced, setAdvanced] = useState<AdvancedOpen>({ transfer: false, diagnostics: false });
  const openFolded = useCallback((key: keyof AdvancedOpen) => setAdvanced((now) => ({ ...now, [key]: true })), []);
  useSectionHash(openFolded);
  return (
    <div class="opt-page">
      <header class="opt-head">
        <Logo size={32} />
        <h1>SplitSession settings</h1>
      </header>
      <nav class="opt-nav" aria-label="Sections">
        <a href="#general">General</a>
        {__FULL__ && <a href="#agent">For AI agents</a>}
        <a href="#rules">Domain rules</a>
        <a href="#advanced">Advanced</a>
      </nav>
      {error && <p class="fx-notice fx-notice--error" role="alert">SplitSession could not load its containers: {error}</p>}
      <main>
        <GeneralSection />
        {__FULL__ && <BridgeSection />}
        <RulesSection containers={containers} />
        <AdvancedSection open={advanced} onToggle={(key, open) => setAdvanced((now) => ({ ...now, [key]: open }))} onChanged={() => void reload()} />
      </main>
    </div>
  );
}
