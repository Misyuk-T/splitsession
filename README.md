# Facet

Facet is an open-source Chrome (Manifest V3) extension that gives you Firefox-style containers: several accounts of the same site open side by side, in different tabs of one Chrome profile. Each container keeps its own cookies and page storage, so two Threads, Supabase or Reddit accounts can be logged in at the same moment without a second profile or a second browser.

**Work in progress.** The isolation engine works and is covered by an end-to-end suite; there is no user interface yet (containers are driven through `open.html` and a programmatic API). See [docs/PLAN.md](docs/PLAN.md) for the design, [docs/limits.md](docs/limits.md) for what is and is not isolated, and [docs/development.md](docs/development.md) for building from source.

License: [MIT](LICENSE).
