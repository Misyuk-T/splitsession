# Documentation

Start with the [project README](../README.md).

| Document | What it is for |
| --- | --- |
| [features.md](features.md) | Everything SplitSession does in detail, the Lite and Full editions compared, and project status. |
| [how-it-works.md](how-it-works.md) | The isolation model in eight steps, the security model in one page, and how the agent bridge is wired. |
| [limits.md](limits.md) | The honest, detailed list of what SplitSession isolates, what it deliberately switches off and what it does not isolate, with the mechanism behind each item. Read before trusting it with anything important. |
| [agents.md](agents.md) | Using SplitSession with AI agents: `open.html`, the `#ctr=` marker, telling accounts apart, Claude in Chrome and Playwright, and the Full edition's agent bridge (set-up, security model, tool list). |
| [development.md](development.md) | Building, testing and the end-to-end stand; Lite and Full editions; the source layout by folder; test hooks; the extension ID and signing key. |
| [decisions.md](decisions.md) | The decision log (ADRs): what was decided at each stage and why, including every security fix. Newest topics are at the end. |
| [privacy.md](privacy.md) | The privacy policy (both editions): what is handled, what leaves the device (nothing), the agent bridge, permissions, deletion. Served by GitHub Pages as `/privacy` once the repository is public. |
| [release/](release) | Release preparation: [chrome-web-store.md](release/chrome-web-store.md) (research and checklists), [listing-draft.md](release/listing-draft.md) (store texts), [npm.md](release/npm.md) (publishing `splitsession-bridge`). |
| [commit-gap.md](commit-gap.md) | The one known isolation hole that is documented and not fixed (same-origin frames and popups during navigation), with measurements and the rejected fixes. |
| [open-questions.md](open-questions.md) | Observations without a decision yet. |
| [screenshots/](screenshots) | The pictures used in the README and features.md (`node scripts/screenshots.mjs`, see development.md). |
