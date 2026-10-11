// Bundles the agent bridge into bridge/dist/ (no node_modules needed at runtime):
//   splitsession-bridge.mjs   `host` and `mcp` modes
//   paths.mjs          socket and host-manifest locations, imported by scripts/bridge-install.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

await build({
  absWorkingDir: root,
  entryPoints: { 'splitsession-bridge': 'bridge/src/main.ts', paths: 'bridge/src/paths.ts' },
  outdir: 'bridge/dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  legalComments: 'none',
  define: { __VERSION__: JSON.stringify(version) },
  banner: { js: "import { createRequire as __facetCreateRequire } from 'node:module'; const require = __facetCreateRequire(import.meta.url);" },
  logLevel: 'warning',
});
console.log('bridge built: bridge/dist/splitsession-bridge.mjs');
