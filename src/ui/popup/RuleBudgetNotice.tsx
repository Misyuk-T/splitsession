import type { RuleStats } from "../../engine/dnr/session-rules";

/**
 * Chrome caps an extension's session rules at 5000. When a batch was refused for that (a tab could not be put in its
 * container and stays a plain tab) or the rules are above the soft limit, say so loudly instead of leaving it to the
 * diagnostics log. Closing all tabs of a container frees its rules.
 */
export const RuleBudgetNotice = ({ stats }: { stats: RuleStats | null }) => {
  if (!stats) return null;
  const refused = stats.refusedAt !== null;
  if (!refused && stats.rules <= stats.softLimit) return null;
  return (
    <p
      class={`fx-notice ${refused ? "fx-notice--error" : "fx-notice--warn"}`}
      role="alert"
      data-testid="rule-budget-notice"
    >
      Too many container cookie rules ({stats.rules} of {stats.hardLimit}):
      close some container tabs.
      {refused &&
        " A tab could not be put in its container and was left without one."}
    </p>
  );
};
