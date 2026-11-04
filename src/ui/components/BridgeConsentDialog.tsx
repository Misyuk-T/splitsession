import { Button } from "./Button";
import { Dialog } from "./Dialog";

/**
 * The disclosure shown before the agent bridge turns on for the first time (Full only; src/core/bridge-consent.ts). Plain
 * words for what the agent program can do and where the data goes, then "Allow agent access" or "Cancel" (also Esc and a
 * click outside). Changing what this says materially means raising `BRIDGE_CONSENT_VERSION`.
 */
export const BridgeConsentDialog = ({
  busy,
  error,
  onAllow,
  onCancel,
}: {
  busy: boolean;
  error: string | null;
  onAllow(): void;
  onCancel(): void;
}) => (
  <Dialog
    title="Allow agent access?"
    onClose={onCancel}
    actions={
      <>
        <Button data-autofocus onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={onAllow}
          disabled={busy}
          data-testid="bridge-consent-allow"
        >
          Allow agent access
        </Button>
      </>
    }
  >
    <div class="fx-consent" data-testid="bridge-consent">
      <p>
        With the agent bridge on, an AI agent program on this computer (one you
        connected with the splitsession-bridge program, like Claude Code, Codex
        or Cursor) can:
      </p>
      <ul class="fx-consent__list">
        <li>
          read the content of pages in every tab and window, including pages you
          are signed in to;
        </li>
        <li>
          take screenshots of {__CDP__ ? "your tabs" : "the tab on show"};
        </li>
        {__CDP__ && (
          <li>read the pages’ console messages and network activity;</li>
        )}
        <li>type and click as you, in any tab and any container;</li>
        {__CDP__ && <li>run JavaScript in pages.</li>}
      </ul>
      {!__CDP__ && (
        <p>
          Chrome may ask to let SplitSession talk to a program on this computer.
          The extension does not run scripts an agent sends it, and has no
          debugger access.
        </p>
      )}
      <p>
        <strong>Where it goes.</strong> Only to that program on this computer,
        through Chrome’s native messaging. SplitSession sends nothing to any
        server. The agent program itself may send what it reads to its AI
        provider, under that provider’s terms.
      </p>
      <p>
        <strong>How to stop.</strong> Switch “Agent bridge” off here or in the
        toolbar popup at any time; the connection closes at once.
      </p>
      {error && (
        <p class="fx-notice fx-notice--error" role="alert">
          {error}
        </p>
      )}
    </div>
  </Dialog>
);
