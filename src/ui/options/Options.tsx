import { useContainers } from '../useContainers';
import { Logo } from '../components/Logo';
import { BridgeSection } from './BridgeSection';
import { DiagnosticsSection } from './DiagnosticsSection';
import { GeneralSection } from './GeneralSection';
import { RulesSection } from './RulesSection';
import { TransferSection } from './TransferSection';

export function Options() {
  const { containers, error, reload } = useContainers();
  return (
    <div class="opt-page">
      <header class="opt-head">
        <Logo size={32} />
        <h1>Facet settings</h1>
      </header>
      <nav class="opt-nav" aria-label="Sections">
        <a href="#general">General</a>
        {__FULL__ && <a href="#agent">AI agent</a>}
        <a href="#rules">Domain rules</a>
        <a href="#transfer">Export and import</a>
        <a href="#diagnostics">Diagnostics</a>
      </nav>
      {error && <p class="fx-notice fx-notice--error" role="alert">Facet could not load its containers: {error}</p>}
      <main>
        <GeneralSection />
        {__FULL__ && <BridgeSection />}
        <RulesSection containers={containers} />
        <TransferSection onChanged={() => void reload()} />
        <DiagnosticsSection />
      </main>
    </div>
  );
}
