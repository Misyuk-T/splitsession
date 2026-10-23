# Publishing `splitsession-bridge` to npm

The agent bridge's companion program is the npm package **`splitsession-bridge`** (source: `bridge/`; own
`bridge/package.json`). The package is one esbuild bundle (`dist/splitsession-bridge.mjs`, about 670 kB, no runtime
dependencies), so `npx splitsession-bridge install` needs nothing but Node 20+. Publishing is done by hand from the owner's
npm account; nothing in CI publishes it.

What the package contains (`files` whitelist): `dist/splitsession-bridge.mjs`, `README.md`, `LICENSE`, `package.json`.
Check with `npm pack --dry-run` in `bridge/` (4 files).

## One-time

1. An npm account with two-factor authentication on (`npm profile enable-2fa auth-and-writes`). Log in: `npm login`;
   check: `npm whoami`.
2. The name must be free: `npm view splitsession-bridge` should answer `E404`. If it is taken, pick a scoped name
   (`@misyuk-t/splitsession-bridge`), change `name` in `bridge/package.json`, and replace `npx splitsession-bridge` in
   `src/ui/options/BridgeSection.tsx`, `bridge/src/mcp.ts`, `bridge/src/cli.ts` (usage text), the docs and the e2e specs.

## Each release

From the repository root, on a clean `main` that passed the release gate ([development.md](../development.md#release-gate)):

```sh
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm test     # includes bridge/src/cli.test.ts and clients.test.ts
```

Before the first release that touches the AI-client registration (`bridge/src/clients.ts`), try it once with a scratch HOME,
never your real config: `HOME=$(mktemp -d) node bridge/dist/splitsession-bridge.mjs install --client all`, then `status` and
`uninstall` (the unit tests do the same against temporary folders).

1. Set the version in `bridge/package.json` (semver; the bridge and the extension talk a versioned protocol,
   `PROTOCOL_VERSION` in `src/bridge/protocol.ts`: a protocol change needs a new major or minor of the package, and a
   note in the extension's release notes saying which package version it needs). Commit it.
   Protocol history: 1 = bridge 0.1.x (one shared socket); 2 = bridge 0.2.0 (one socket per Chrome profile, `hello` with the
   profile key, `__profile` / `__tabs`). Each side works with the other's older version (agents.md, "Several Chrome
   profiles"), but several profiles at once need both: extension with protocol 2 and bridge 0.2.0+. After publishing a new
   minor, users run `npx splitsession-bridge@latest install` (the switch card shows it when it sees an older host) and
   restart their AI client.
2. Build and look at the tarball (nothing is uploaded):

   ```sh
   pnpm bridge:build
   node bridge/dist/splitsession-bridge.mjs version     # prints the version from bridge/package.json
   cd bridge && npm pack --dry-run
   ```

3. Publish (the `prepublishOnly` script rebuilds the bundle; `publishConfig.access` is already `public`):

   ```sh
   cd bridge
   npm publish --otp=<six digits from your authenticator>
   ```

4. Check it from a clean place, not from the checkout:

   ```sh
   cd "$(mktemp -d)"
   npm view splitsession-bridge version
   npx --yes splitsession-bridge@latest version
   npx --yes splitsession-bridge@latest status          # read-only
   ```

5. Tag the commit `bridge-v<version>` (the extension's own tags are `v<version>`): `git tag bridge-v0.1.0 && git push --tags`
   when the repository is public.

## Notes

- `npx splitsession-bridge install` copies the bundle to `~/Library/Application Support/SplitSession/host/` (macOS) or
  `$XDG_CONFIG_HOME/SplitSession/host/` (Linux), so Chrome keeps working after npx's cache is cleaned. Run
  `npx splitsession-bridge@latest install` again to update it; it is idempotent.
- `install` also registers the MCP server with the user's AI clients (`--client claude,codex,cursor,claude-desktop,gemini,vscode`;
  asks in a terminal, none in a script). It edits their config files (backup `<file>.bak-<time>`, atomic write, only the
  `splitsession` key), so a change to `clients.ts` is a user-facing change: mention it in the release notes. The formats
  (VS Code `servers` + `type: "stdio"`, Codex `[mcp_servers.<name>]`, others `mcpServers`) are those documented by each
  client when this was written; if one changes, `clients.ts` is the only place to fix.
- A Chrome Web Store build of Full gets another extension ID. The package already takes it:
  `npx splitsession-bridge install --extension-id <store id>` (the default stays the fixed ID of the unpacked Full build).
  When that ID is known, make it the default (`EXTENSION_ID` in `src/bridge/protocol.ts` or a second default) and publish
  a new version.
- A wrong release can be hidden within 72 hours with `npm unpublish splitsession-bridge@<version>`; later,
  `npm deprecate splitsession-bridge@<version> "<message>"` and publish a fixed version.
- Windows: `install` prints "not supported yet" and exits 1. `os` in `bridge/package.json` lists darwin and linux, so npm
  warns on Windows.
