// Bundles the agent bridge into bridge/dist/splitsession-bridge.mjs (no node_modules needed at runtime). It is the
// npm package's `bin` (bridge/package.json) and what `install` copies to the per-user host folder. Subcommands:
// install / uninstall / status (people), host (Chrome), mcp (the AI client).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const version = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
).version;

await build({
  absWorkingDir: root,
  entryPoints: { "splitsession-bridge": "bridge/src/main.ts" },
  outdir: "bridge/dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  legalComments: "none",
  define: { __VERSION__: JSON.stringify(version) },
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __facetCreateRequire } from 'node:module'; const require = __facetCreateRequire(import.meta.url);",
  },
  logLevel: "warning",
});
console.log("bridge built: bridge/dist/splitsession-bridge.mjs");
