import { useState } from 'preact/hooks';
import { IconChevron } from '../icons';

/** "Why we need this" under the Strict mode switch: a disclosure (custom button, not a native `<details>`). */
export function WhyStrict() {
  const [open, setOpen] = useState(false);
  return (
    <div class="fx-why">
      <button type="button" class="fx-why__toggle" aria-expanded={open} aria-controls="fx-why-strict" onClick={() => setOpen(!open)}>
        <span>Why we need this</span>
        <span class={`fx-why__chevron${open ? ' fx-why__chevron--open' : ''}`} aria-hidden="true">
          <IconChevron />
        </span>
      </button>
      {open && (
        <div id="fx-why-strict" class="fx-why__body fx-secondary">
          <p>
            Chrome gives each site one background helper (a service worker) for the whole profile, not one per container. It
            runs with your main account and can answer a container tab instead of the site, so the tab may open as your main
            account.
          </p>
          <p>
            Chrome can’t give each container its own helper, so Strict mode removes them and blocks new ones. Push notifications
            need these helpers, so they stop too. Logins and site data stay.
          </p>
          <p>Off: helpers are removed only on sites you use in containers.</p>
        </div>
      )}
    </div>
  );
}
