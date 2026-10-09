# Facet

Facet is an open-source Chrome (Manifest V3) extension that gives you Firefox-style containers: several accounts of the same site open side by side, in different tabs of one Chrome profile. Each container keeps its own cookies and page storage, so two Threads, Supabase or Reddit accounts can be logged in at the same moment without a second profile or a second browser.

**Work in progress.** Only the pure-TypeScript core (cookie jar, `Set-Cookie` parser, declarativeNetRequest rule compiler) exists so far; there is nothing to install yet. See [docs/PLAN.md](docs/PLAN.md) for the design and [docs/development.md](docs/development.md) for building from source.

License: [MIT](LICENSE).
