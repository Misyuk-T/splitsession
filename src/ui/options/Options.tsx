import { useEffect } from 'preact/hooks';
import { useContainers } from '../useContainers';
import { Logo } from '../components/Logo';
import { BridgeSection } from './BridgeSection';
import { DiagnosticsSection } from './DiagnosticsSection';
import { GeneralSection } from './GeneralSection';
import { RulesSection } from './RulesSection';
import { TransferSection } from './TransferSection';

/** `options.html#agent` (also `#agents`): scroll to that section and put keyboard focus on its heading. Runs again when only the hash changes. */
function useSectionHash(): void {
  useEffect(() => {
    const go = () => {
      const raw = decodeURIComponent(location.hash.slice(1));
      const id = raw === 'agents' ? 'agent' : raw;
      const heading = id ? document.getElementById(id)?.querySelector<HTMLElement>('h2') : null;
      if (!heading) return;
      heading.tabIndex = -1;
      heading.scrollIntoView({ block: 'start' });
      heading.focus({ preventScroll: true });
    };
    go();
    window.addEventListener('hashchange', go);
    return () => window.removeEventListener('hashchange', go);
  }, []);
}

export function Options() {
  const { containers, error, reload } = useContainers();
  useSectionHash();
  return (
    <div class="opt-page">
      <header class="opt-head">
        <Logo size={32} />
        <h1>SplitSession settings</h1>
      </header>
      <nav class="opt-nav" aria-label="Sections">
        <a href="#general">General</a>
        <a href="#rules">Domain rules</a>
        <a href="#transfer">Export and import</a>
        {__FULL__ && <a href="#agent">For AI agents</a>}
        <a href="#diagnostics">Diagnostics</a>
      </nav>
      {error && <p class="fx-notice fx-notice--error" role="alert">SplitSession could not load its containers: {error}</p>}
      <main>
        <GeneralSection />
        <RulesSection containers={containers} />
        <TransferSection onChanged={() => void reload()} />
        {__FULL__ && <BridgeSection />}
        <DiagnosticsSection />
      </main>
    </div>
  );
}
