// Developer wrapper around the bridge CLI (bridge/src/cli.ts): builds the bridge from this checkout, then runs the
// same `install` / `uninstall` that `npx splitsession-bridge` runs.
//
//   pnpm bridge:install                       build, copy the host to the per-user folder, register it with Google Chrome
//   pnpm bridge:install --browser chromium    ... another browser (chrome | chromium | brave | edge | arc | all)
//   pnpm bridge:install --client claude       ... and register the MCP server with Claude Code (default here: print only)
//   pnpm bridge:install --dir <path>          ... into an explicit NativeMessagingHosts directory (tests)
//   --host-dir <path>                         where the host program is copied (tests)
//   --no-build                                skip the build (the e2e suite builds once)
//   pnpm bridge:uninstall                     remove the host registration (every browser unless --browser/--dir is given)
//
// Unlike the published package, this wrapper does not touch your AI client's configuration unless you pass --client:
// it defaults to `--client none`, which prints the snippets.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const entry = path.join(root, "bridge", "dist", "splitsession-bridge.mjs");

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(
    "usage: node scripts/bridge-install.mjs [--uninstall] [--browser chrome|chromium|brave|edge|arc|all] [--client claude|codex|cursor|none] [--dir <NativeMessagingHosts dir>] [--host-dir <dir>] [--no-build]",
  );
  process.exit(0);
}
const uninstall = args.includes("--uninstall");
const noBuild = args.includes("--no-build");
const rest = args.filter((a) => a !== "--uninstall" && a !== "--no-build");

if ((!noBuild && !uninstall) || !existsSync(entry)) {
  const built = spawnSync(
    process.execPath,
    [path.join(root, "bridge", "build.mjs")],
    { stdio: "inherit" },
  );
  if (built.status !== 0) process.exit(built.status ?? 1);
}
if (
  !uninstall &&
  !rest.some((a) => a === "--client" || a.startsWith("--client="))
)
  rest.push("--client", "none");

const run = spawnSync(
  process.execPath,
  [entry, uninstall ? "uninstall" : "install", ...rest],
  { stdio: "inherit" },
);
process.exit(run.status ?? 1);
