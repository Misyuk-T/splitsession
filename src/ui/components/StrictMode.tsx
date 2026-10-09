import { Button } from './Button';
import { Dialog } from './Dialog';

interface ConsentProps {
  busy?: boolean;
  error?: string | null;
  onAccept(): void;
  onLater(): void;
}

/**
 * Strict-mode consent. Facet asks before removing service workers because the cost lands on every site of the
 * profile, not only on the ones used in containers. The safe answer ("Not now") has focus first.
 */
export function StrictConsentDialog({ busy, error, onAccept, onLater }: ConsentProps) {
  return (
    <Dialog
      title="Keep service workers away from containers?"
      role="alertdialog"
      onClose={onLater}
      actions={
        <>
          <Button data-autofocus onClick={onLater} disabled={busy}>
            Not now
          </Button>
          <Button variant="primary" onClick={onAccept} disabled={busy} data-testid="strict-accept">
            {busy ? 'Removing…' : 'Remove service workers'}
          </Button>
        </>
      }
    >
      <p>
        Sites can install service workers: scripts that answer the site’s requests themselves. A worker installed in your regular
        profile answers with your regular logins, even in a container tab. A container could then open a site as your regular
        account, and a login made there could land in your regular profile.
      </p>
      <p>Strict mode removes every service worker in this Chrome profile now and stops sites from installing new ones.</p>
      <p class="fx-secondary">
        Cost: push notifications and offline mode stop working for every site in this profile. Logins, cookies and saved site data
        are not touched. You can turn strict mode off in Settings.
      </p>
      {error && (
        <p class="fx-notice fx-notice--error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}

/** Persistent warning while strict mode waits for the user's OK. */
export function StrictWarning({ onReview }: { onReview(): void }) {
  return (
    <div class="fx-notice fx-notice--warn fx-strict-warning" role="status" data-testid="strict-warning">
      <p>
        <strong>Strict mode is waiting for your OK.</strong> Until then a service worker of your regular profile can answer a
        container tab’s first visit to a site.
      </p>
      <Button small onClick={onReview}>
        Review…
      </Button>
    </div>
  );
}
