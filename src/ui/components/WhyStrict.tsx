import { More } from "./More";

/** "Why we need this" under the Strict mode switch: a disclosure (custom button, not a native `<details>`). */
export const WhyStrict = () => (
  <More id="fx-why-strict" title="Why we need this">
    <p>
      Chrome gives each site one background helper (a service worker) for the
      whole profile, not one per container. It runs with your main account and
      can answer a container tab instead of the site, so the tab may open as
      your main account.
    </p>
    <p>
      Chrome can’t give each container its own helper, so Strict mode removes
      them and blocks new ones. Push notifications need these helpers, so they
      stop too. Logins and site data stay.
    </p>
    <p>Off: helpers are removed only on sites you use in containers.</p>
  </More>
);
