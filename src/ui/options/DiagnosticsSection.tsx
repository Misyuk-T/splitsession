import { useCallback, useEffect, useState } from "preact/hooks";

import { facetApi } from "../../engine/api-client";
import type { ContentScriptStatus } from "../../engine/content-scripts";
import { Button } from "../components/Button";
import { describeError } from "../format";

interface Diagnostics {
  sessionRules: number;
  stats: { rules: number; regexRules: number; keys: number };
  managedSites: string[];
  scripts: ContentScriptStatus;
  log: Array<{ at: number; level: string; message: string; data?: unknown }>;
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** "All sites" / "Container sites only (N)" / "Off", and why: the page scripts are registered only while containers are in use. */
export function describeScripts(status: ContentScriptStatus): {
  scope: string;
  reason: string;
} {
  const scope =
    status.scope === "all"
      ? "All sites"
      : status.scope === "managed"
        ? `Container sites only (${status.sites})`
        : "Off";
  const r = status.reason;
  let reason =
    r.kind === "tabs"
      ? plural(r.count, "container tab open", "container tabs open")
      : r.kind === "moving"
        ? plural(
            r.count,
            "tab being moved into a container",
            "tabs being moved into containers",
          )
        : r.kind === "waiting"
          ? plural(
              r.count,
              "tab waiting to be restored",
              "tabs waiting to be restored",
            )
          : r.kind === "starting"
            ? "matching the tabs restored with the browser"
            : "no containers in use";
  if (status.scope !== status.wanted)
    reason += status.error
      ? `; the last change failed (${status.error}), retrying`
      : "; changing in a moment";
  return { scope, reason };
}

const time = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour12: false });

/** Read-only view of what the engine is doing, for bug reports. Nothing here can be changed. It sits folded under Advanced: most people never need it. */
export const DiagnosticsBody = () => {
  const [data, setData] = useState<Diagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [rules, stats, managedSites, scripts, log] = await Promise.all([
        facetApi.getSessionRules(),
        facetApi.stats(),
        facetApi.getManagedSites(),
        facetApi.getContentScripts(),
        facetApi.getLog(),
      ]);
      setData({
        sessionRules: rules.length,
        stats,
        managedSites,
        scripts,
        log: log as Diagnostics["log"],
      });
      setError(null);
    } catch (e) {
      setError(describeError(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <div class="opt-actions opt-actions--start opt-actions--center">
        <Button small onClick={() => void load()}>
          Refresh
        </Button>
        <span class="fx-secondary">
          Read-only. Useful when you report a problem.
        </span>
      </div>
      {error && (
        <p class="fx-notice fx-notice--error" role="alert">
          {error}
        </p>
      )}
      {data && (
        <>
          <dl class="opt-facts" data-testid="diagnostics">
            <dt>Session rules in use</dt>
            <dd data-testid="diag-session-rules">{data.sessionRules}</dd>
            <dt>Rules (regex rules)</dt>
            <dd>
              {data.stats.rules} ({data.stats.regexRules})
            </dd>
            <dt>Rule groups</dt>
            <dd>{data.stats.keys}</dd>
            <dt>Managed sites</dt>
            <dd data-testid="diag-managed">
              {data.managedSites.length === 0
                ? "none yet"
                : data.managedSites.join(", ")}
            </dd>
            <dt>Page scripts</dt>
            <dd data-testid="diag-scripts">
              {describeScripts(data.scripts).scope}
              <span class="fx-secondary">
                {" "}
                · {describeScripts(data.scripts).reason}
              </span>
            </dd>
          </dl>
          <h3>Recent log</h3>
          {data.log.length === 0 ? (
            <p class="fx-secondary">Nothing logged yet.</p>
          ) : (
            <pre
              class="opt-log"
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the log is a scrollable region, so keyboard users need to focus it to scroll
              tabIndex={0}
              aria-label="Recent log entries"
              data-testid="diag-log"
            >
              {data.log
                .slice(-60)
                .reverse()
                .map(
                  (e) =>
                    `${time(e.at)} ${e.level.padEnd(5)} ${e.message}${e.data === undefined ? "" : ` ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}`}`,
                )
                .join("\n")}
            </pre>
          )}
        </>
      )}
    </>
  );
};
