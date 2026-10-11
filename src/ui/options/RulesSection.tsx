import { useEffect, useState } from 'preact/hooks';
import type { ContainerInfo } from '../../background/facet';
import { CONTAINER_HEX, normalizeRuleDomain, type DomainRule } from '../../core';
import { facetApi } from '../../engine/api-client';
import { Button, Dot } from '../components/Button';
import { Select } from '../components/Select';
import { TextField } from '../components/TextField';
import { describeError } from '../format';

const ACTIONS = [
  { value: 'always', label: 'Always open in a container' },
  { value: 'ask', label: 'Ask me every time' },
];

export function RulesSection({ containers }: { containers: ContainerInfo[] | null }) {
  const [rules, setRules] = useState<DomainRule[] | null>(null);
  const [site, setSite] = useState('');
  const [action, setAction] = useState<'always' | 'ask'>('always');
  const [containerId, setContainerId] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = async () => setRules(await facetApi.listDomainRules());
  useEffect(() => {
    load().catch((e) => setError(describeError(e)));
  }, []);

  const list = containers ?? [];
  const checked = normalizeRuleDomain(site);
  const existing = checked.ok ? rules?.find((r) => r.domain === checked.domain) : undefined;
  const chosen = list.find((c) => c.id === containerId) ?? null;
  const needsContainer = action === 'always';
  const valid = checked.ok && (!needsContainer || chosen !== null);
  const siteError = !checked.ok && (site.trim() !== '' || touched) ? checked.message : null;
  const siteHint = checked.ok ? (existing ? `This replaces the existing rule for ${checked.domain}.` : `Applies to ${checked.domain} and all its subdomains.`) : 'For example github.com or reddit.com.';

  const submit = async () => {
    setTouched(true);
    if (!checked.ok || busy) return;
    if (needsContainer && !chosen) return;
    setBusy(true);
    setError(null);
    try {
      const rule: DomainRule = needsContainer ? { domain: checked.domain, action: 'always', containerId: chosen!.id } : { domain: checked.domain, action: 'ask' };
      await facetApi.setDomainRule(rule);
      await load();
      setNote(`Rule saved for ${checked.domain}.`);
      setSite('');
      setTouched(false);
      document.getElementById('rule-site')?.focus(); // ready for the next rule
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (rule: DomainRule) => {
    try {
      await facetApi.removeDomainRule(rule.domain);
      await load();
      setNote(`Rule for ${rule.domain} removed.`);
    } catch (e) {
      setError(describeError(e));
    }
  };

  const edit = (rule: DomainRule) => {
    setSite(rule.domain);
    setAction(rule.action);
    setContainerId(rule.containerId ?? null);
    setNote(null);
    document.getElementById('rule-site')?.focus();
  };

  return (
    <section class="opt-section" aria-labelledby="rules-title" id="rules">
      <h2 id="rules-title">Domain rules</h2>
      <p class="fx-secondary opt-lead">
        Decide where a site opens. With “always open in”, a tab that goes to the site moves into that container; with “ask”, you choose each time. A tab
        that moves has already sent its first request from where it was, so that one request is not isolated.
      </p>

      <form
        class="opt-card opt-ruleform"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <TextField
          label="Site"
          value={site}
          onValue={(v) => {
            setSite(v);
            setNote(null);
          }}
          error={siteError}
          hint={siteHint}
          placeholder="github.com"
          inputMode="url"
          onBlur={() => setTouched(true)}
          sanitize={(raw) => raw.slice(0, 253)}
          id="rule-site"
        />
        <div class="opt-ruleform__row">
          <div class="opt-ruleform__col">
            <span class="fx-field__label" id="rule-action-label">What to do</span>
            <Select label="What to do" value={action} options={ACTIONS} onChange={(v) => setAction(v as 'always' | 'ask')} />
          </div>
          {needsContainer && (
            <div class="opt-ruleform__col">
              <span class="fx-field__label" id="rule-container-label">Container</span>
              <Select
                label="Container"
                value={containerId}
                options={list.map((c) => ({ value: c.id, label: c.name, dot: CONTAINER_HEX[c.color] }))}
                onChange={setContainerId}
                placeholder={list.length === 0 ? 'No containers yet' : 'Choose a container'}
                emptyText="Create a container in the SplitSession popup first."
                invalid={touched && chosen === null}
              />
            </div>
          )}
        </div>
        {error && <p class="fx-notice fx-notice--error" role="alert">{error}</p>}
        <div class="opt-actions">
          <Button type="submit" variant="primary" disabled={!valid}>
            {existing ? 'Replace rule' : 'Add rule'}
          </Button>
        </div>
      </form>

      <div class="fx-status" role="status" aria-live="polite">{note}</div>

      {rules === null ? (
        <p class="fx-secondary">Loading rules…</p>
      ) : rules.length === 0 ? (
        <p class="fx-secondary" data-testid="no-rules">No rules yet.</p>
      ) : (
        <ul class="opt-rules" aria-label="Domain rules">
          {rules.map((rule) => {
            const target = rule.action === 'always' ? list.find((c) => c.id === rule.containerId) : undefined;
            return (
              <li key={rule.domain} class="opt-rule" data-testid="rule-row">
                <strong class="opt-rule__domain">{rule.domain}</strong>
                <span class="opt-rule__action">
                  {rule.action === 'ask' ? (
                    'Ask every time'
                  ) : (
                    <>
                      Always open in {target ? <><Dot color={CONTAINER_HEX[target.color]} /> {target.name}</> : 'a container that no longer exists'}
                    </>
                  )}
                </span>
                <Button small onClick={() => edit(rule)} aria-label={`Edit the rule for ${rule.domain}`}>Edit</Button>
                <Button small onClick={() => void remove(rule)} aria-label={`Remove the rule for ${rule.domain}`}>Remove</Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
