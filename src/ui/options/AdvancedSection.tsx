import { Disclosure } from "../components/Disclosure";
import { DiagnosticsBody } from "./DiagnosticsSection";
import { TransferBody } from "./TransferSection";

/** Which folded part of Advanced is open. A link like `options.html#transfer` opens one and lands on it. */
export interface AdvancedOpen {
  transfer: boolean;
  diagnostics: boolean;
}

/** The rarely needed things, folded away: moving your containers between machines, and the engine's read-only facts. */
export const AdvancedSection = ({
  open,
  onToggle,
  onChanged,
}: {
  open: AdvancedOpen;
  onToggle(key: keyof AdvancedOpen, open: boolean): void;
  onChanged(): void;
}) => (
  <section class="opt-section" aria-labelledby="advanced-title" id="advanced">
    <h2 id="advanced-title">Advanced</h2>
    <div class="opt-card opt-card--rows">
      <div class="opt-row">
        <Disclosure
          id="transfer-body"
          toggleId="transfer"
          title="Export and import"
          testId="transfer-disclosure"
          open={open.transfer}
          onToggle={(o) => onToggle("transfer", o)}
        >
          <TransferBody onChanged={onChanged} />
        </Disclosure>
      </div>
      <div class="opt-row">
        <Disclosure
          id="diag-body"
          toggleId="diagnostics"
          title="Diagnostics"
          testId="diagnostics-disclosure"
          open={open.diagnostics}
          onToggle={(o) => onToggle("diagnostics", o)}
        >
          <DiagnosticsBody />
        </Disclosure>
      </div>
    </div>
  </section>
);
