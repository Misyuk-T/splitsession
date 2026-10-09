import { useCallback, useEffect, useState } from 'preact/hooks';
import { facetApi } from '../../engine/api-client';
import { Button } from '../components/Button';
import { describeError } from '../format';

interface Diagnostics {
  sessionRules: number;
  stats: { rules: number; regexRules: number; keys: number };
  managedSites: string[];
  log: Array<{ at: number; level: string; message: string; data?: unknown }>;
}

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour12: false });

/** Read-only view of what the engine is doing, for bug reports. Nothing here can be changed. */
export function DiagnosticsSection() {
  const [data, setData] = useState<Diagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [rules, stats, managedSites, log] = await Promise.all([facetApi.getSessionRules(), facetApi.stats(), facetApi.getManagedSites(), facetApi.getLog()]);
      setData({ sessionRules: rules.length, stats, managedSites, log: log as Diagnostics['log'] });
      setError(null);
    } catch (e) {
      setError(describeError(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section class="opt-section" aria-labelledby="diag-title" id="diagnostics">
      <h2 id="diag-title">Diagnostics</h2>
      <p class="fx-secondary opt-lead">Read-only. Useful when something does not behave and you want to report it.</p>
      <div class="opt-card">
        <div class="opt-actions opt-actions--start">
          <Button small onClick={() => void load()}>Refresh</Button>
        </div>
        {error && <p class="fx-notice fx-notice--error" role="alert">{error}</p>}
        {data && (
          <>
            <dl class="opt-facts" data-testid="diagnostics">
              <dt>Session rules in use</dt>
              <dd data-testid="diag-session-rules">{data.sessionRules}</dd>
              <dt>Rules (regex rules)</dt>
              <dd>{data.stats.rules} ({data.stats.regexRules})</dd>
              <dt>Rule groups</dt>
              <dd>{data.stats.keys}</dd>
              <dt>Managed sites</dt>
              <dd data-testid="diag-managed">{data.managedSites.length === 0 ? 'none yet' : data.managedSites.join(', ')}</dd>
            </dl>
            <h3>Recent log</h3>
            {data.log.length === 0 ? (
              <p class="fx-secondary">Nothing logged yet.</p>
            ) : (
              <pre class="opt-log" tabIndex={0} aria-label="Recent log entries" data-testid="diag-log">
                {data.log
                  .slice(-60)
                  .reverse()
                  .map((e) => `${time(e.at)} ${e.level.padEnd(5)} ${e.message}${e.data === undefined ? '' : ` ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}`}`)
                  .join('\n')}
              </pre>
            )}
          </>
        )}
      </div>
    </section>
  );
}
