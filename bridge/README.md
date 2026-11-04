# splitsession-bridge

The companion program of the **SplitSession (Full)** Chrome extension. It lets your own AI agent (Claude Code, Codex,
Cursor) list your Chrome tabs, see which SplitSession container each one is in, and operate them, through a local MCP
server. Nothing leaves your computer: Chrome talks to the program through Native Messaging, and your agent talks to it
through a private Unix socket (no network port).

The extension has the switch, and it is **off by default**: while it is off nothing is reachable.

```sh
npx splitsession-bridge install            # registers with Chrome; in a terminal it asks which AI clients to register too
npx splitsession-bridge install --client claude,codex   # or: cursor, claude-desktop, gemini, vscode, all, none
npx splitsession-bridge status
npx splitsession-bridge uninstall
```

Then open SplitSession Settings > "For AI agents" and switch on "Agent bridge".

No AI client at hand? `npx splitsession-bridge try` is a read-only self-test of the running bridge: one PASS/FAIL line each
for `bridge_info` (extension version, mode, windows / tabs / containers per profile), `list_containers` (names, colours) and
`list_tabs` (counts only, never titles or URLs). Open https://example.com and run `try --tab <id>` (it prints the ID) to also
read that one tab. `--profile <name or key>` picks a profile; exit code 0 when everything passed. It changes nothing.

Options of `install`: `--browser chrome|chromium|brave|edge|arc|all` (default `chrome`), `--extension-id <id>` (default
the SplitSession Full extension), `--client <list>`: any of `claude`, `codex`, `cursor`, `claude-desktop` (macOS),
`gemini`, `vscode`, or `all` / `none`. Without `--client`, a terminal run asks Y/n for each AI client it finds, and a
script run (no terminal) registers none and prints what to add. macOS and Linux; Windows is not supported yet. Needs
Node 20 or newer.

How each client is registered: Claude Code with `claude mcp add --scope user`; Codex with `codex mcp add` (or, without the
CLI, a line-level edit of `~/.codex/config.toml` that keeps your comments and other tables); Cursor
`~/.cursor/mcp.json`, Claude Desktop `claude_desktop_config.json`, Gemini CLI `~/.gemini/settings.json` (all
`mcpServers.splitsession`) and VS Code's user `mcp.json` (`servers.splitsession`, `type: "stdio"`) by merging one key.
Only the `splitsession` entry is added or replaced. A changed file is first copied to `<file>.bak-<time>` and then
replaced atomically; a file that is not plain JSON (comments) is left alone and the snippet is printed instead.
`uninstall` removes just that entry from each client (`--client` limits it); `status` shows which clients have it.

What it installs: a copy of itself in `~/Library/Application Support/SplitSession/host/` (macOS) or
`$XDG_CONFIG_HOME/SplitSession/host/` (Linux, default `~/.config`), and the browser's native messaging host manifest
`com.splitsession.bridge.json`. Full guide, tool list and security model:
https://github.com/Misyuk-T/splitsession/blob/main/docs/agents.md

MIT licensed.
