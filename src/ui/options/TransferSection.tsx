import { useRef, useState } from 'preact/hooks';
import { parseExport, planImport, type ExportFile, type ImportPlan } from '../../core';
import { facetApi } from '../../engine/api-client';
import { Button } from '../components/Button';
import { Checkbox } from '../components/Toggle';
import { describeError } from '../format';

interface Pending {
  fileName: string;
  file: ExportFile;
  plan: ImportPlan;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function TransferSection({ onChanged }: { onChanged(): void }) {
  const [includeJars, setIncludeJars] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const doExport = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const file = await facetApi.exportData({ includeJars });
      const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `facet-${includeJars ? 'with-cookies-' : ''}${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
      setNote(`Exported ${plural(file.containers.length, 'container')} and ${plural(file.rules.length, 'rule')}${includeJars ? ', with cookies' : ''}.`);
    } catch (e) {
      setProblem(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const choose = async (file: File | undefined) => {
    setNote(null);
    setProblem(null);
    setPending(null);
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      setProblem('That file is too large to be a Facet export.');
      return;
    }
    const parsed = parseExport(await file.text());
    if (!parsed.ok) {
      setProblem(parsed.error);
      return;
    }
    try {
      const [containers, rules] = await Promise.all([facetApi.listContainers(), facetApi.listDomainRules()]);
      setPending({ fileName: file.name, file: parsed.file, plan: planImport(parsed.file, containers, rules) });
    } catch (e) {
      setProblem(describeError(e));
    }
  };

  const doImport = async () => {
    if (!pending || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const summary = await facetApi.importData(pending.file);
      setNote(
        `Imported: ${plural(summary.createdContainers, 'container')} created, ${plural(summary.matchedContainers, 'container')} already existed, ${plural(summary.rules, 'rule')}` +
          (summary.cookies > 0 ? `, ${plural(summary.cookies, 'cookie')}.` : '.'),
      );
      setPending(null);
      onChanged();
    } catch (e) {
      setProblem(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="opt-section" aria-labelledby="transfer-title" id="transfer">
      <h2 id="transfer-title">Export and import</h2>
      <p class="fx-secondary opt-lead">
        Move your containers and domain rules to another browser or back them up. By default the file holds no cookies, so nobody can sign in with it.
      </p>

      <div class="opt-card">
        <h3>Export</h3>
        <Checkbox
          label="Also include cookie jars (saved logins)"
          description="Only if you want the logins to move too."
          checked={includeJars}
          onChange={setIncludeJars}
          describedBy="jar-warning"
        />
        {includeJars && (
          <p id="jar-warning" class="fx-notice fx-notice--warn" role="note" data-testid="jar-warning">
            <strong>Careful.</strong> The cookie jars contain live login sessions for every site you used in these containers. Anyone who gets this file can sign
            in as you, no password needed. Keep it private, do not send it anywhere, and delete it when you are done.
          </p>
        )}
        <div class="opt-actions">
          <Button variant="primary" onClick={() => void doExport()} >
            {includeJars ? 'Export with cookies…' : 'Export'}
          </Button>
        </div>
      </div>

      <div class="opt-card">
        <h3>Import</h3>
        <p class="fx-secondary">Containers are matched by name: ones you already have are kept as they are, the rest are created. Rules for the same site are replaced.</p>
        <input
          ref={picker}
          class="fx-sr-only"
          type="file"
          accept=".json,application/json"
          tabIndex={-1}
          aria-label="Facet export file"
          data-testid="import-file"
          onChange={(event) => {
            const input = event.currentTarget;
            void choose(input.files?.[0]).finally(() => (input.value = ''));
          }}
        />
        <div class="opt-actions">
          <Button onClick={() => picker.current?.click()}>
            Choose a file…
          </Button>
        </div>

        {pending && (
          <div class="opt-plan" role="region" aria-label="What the import will do" data-testid="import-plan">
            <p>
              <strong>{pending.fileName}</strong> will:
            </p>
            <ul>
              <li>
                create {plural(pending.plan.create.length, 'container')}
                {pending.plan.create.length > 0 && <span class="fx-secondary"> ({pending.plan.create.map((c) => c.name).join(', ')})</span>}
              </li>
              <li>keep {plural(pending.plan.match.length, 'container')} you already have</li>
              <li>
                set {plural(pending.plan.rules, 'domain rule')}
                {pending.plan.replacedRules > 0 && <span class="fx-secondary"> ({pending.plan.replacedRules} replace existing)</span>}
              </li>
              {pending.plan.cookies > 0 && (
                <li>
                  <strong>add {plural(pending.plan.cookies, 'cookie')}</strong> to {plural(pending.plan.jarContainers, 'container')}: this file contains saved logins
                </li>
              )}
            </ul>
            <div class="opt-actions">
              <Button onClick={() => setPending(null)}>Cancel</Button>
              <Button variant="primary" onClick={() => void doImport()}>Import</Button>
            </div>
          </div>
        )}
      </div>

      {problem && <p class="fx-notice fx-notice--error" role="alert" data-testid="transfer-error">{problem}</p>}
      <div class="fx-status" role="status" aria-live="polite" data-testid="transfer-status">{note}</div>
    </section>
  );
}
