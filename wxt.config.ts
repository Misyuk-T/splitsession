import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import preact from '@preact/preset-vite';
import { defineConfig } from 'wxt';

/**
 * Two editions from one codebase (docs/decisions.md, "Two editions"). `FACET_EDITION=lite` selects Lite; anything else is
 * Full, the author's daily build and the default of `pnpm build`, `pnpm dev` and the e2e suite. Name and description per
 * edition live here and nowhere else (the names are placeholders until the final one is picked).
 */
const edition = process.env.FACET_EDITION === 'lite' ? 'lite' : 'full';
const full = edition === 'full';
const EDITIONS = {
  full: {
    name: 'Facet (Full)',
    description: 'Containers for Chrome: several accounts of the same site open side by side in one profile. Includes the local AI-agent bridge (off by default).',
  },
  lite: {
    name: 'Facet',
    description: 'Containers for Chrome: several accounts of the same site open side by side in one profile.',
  },
} as const;

// Public half of the key pair from `pnpm keygen`; pins the Full extension's ID (see docs/development.md). Lite has no
// key: the Chrome Web Store assigns its own ID, and a local Lite build gets a path-derived one, so Lite and Full can
// be installed side by side.
const extensionKey = full ? readFileSync(new URL('./extension-key.pub', import.meta.url), 'utf8').trim() : undefined;

// Rendered from assets/icon.svg by scripts/make-icons.mjs and committed.
const iconSet = { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' };

export default defineConfig({
  srcDir: 'src',
  // Full keeps `.output/chrome-mv3` (the folder loaded unpacked in Chrome); Lite builds into `.output/lite/chrome-mv3`.
  outDir: full ? '.output' : '.output/lite',
  zip: { artifactTemplate: `facet-${edition}-{{version}}.zip` },
  vite: () => ({
    plugins: [
      preact(),
      // A side-effect-only `import './x.css'` survives tree-shaking even when the component importing it is dead code, so the
      // Full-only stylesheet is resolved to an empty module in Lite.
      ...(full
        ? []
        : [
            {
              name: 'facet-lite-drop-full-only-css',
              enforce: 'pre' as const,
              resolveId: (id: string) => (id.endsWith('/bridge-card.css') ? '\0facet-empty-css.css' : undefined),
              load: (id: string) => (id === '\0facet-empty-css.css' ? '' : undefined),
            },
          ]),
    ],
    // Compile-time edition flag (src/env.d.ts): the bundler removes every `if (__FULL__)` branch from Lite, and with it the
    // modules only those branches use (agent bridge, CDP, activity overlay, page-name features).
    define: { __FULL__: JSON.stringify(full) },
  }),
  hooks: {
    // Full-only pages are not part of Lite at all (no file, no manifest entry, no link target).
    'entrypoints:found': (_wxt, infos) => {
      if (full) return;
      for (let i = infos.length - 1; i >= 0; i--) if (infos[i]!.name === 'state') infos.splice(i, 1);
    },
    // The beacon runs in every frame of every tab: swap the full Public Suffix List for a tiny stand-in there
    // (see src/content/tldts-lite.ts). The background keeps the real one.
    'vite:build:extendConfig': (entrypoints, config) => {
      if (!entrypoints.some((e) => e.name === 'beacon')) return;
      const lite = fileURLToPath(new URL('./src/content/tldts-lite.ts', import.meta.url));
      config.resolve ??= {};
      const alias = config.resolve.alias;
      const entry = { find: /^tldts$/, replacement: lite };
      if (Array.isArray(alias)) alias.push(entry);
      else config.resolve.alias = [...Object.entries(alias ?? {}).map(([find, replacement]) => ({ find, replacement: String(replacement) })), entry];
    },
  },
  manifest: {
    name: EDITIONS[edition].name,
    description: EDITIONS[edition].description,
    ...(extensionKey ? { key: extensionKey } : {}),
    minimum_chrome_version: '119',
    permissions: [
      'declarativeNetRequest',
      'webRequest',
      'scripting',
      'tabs',
      'tabGroups',
      'storage',
      'webNavigation',
      'browsingData',
      'alarms',
      // Container tabs that come back: which recently-closed tab or window was just reopened (docs/decisions.md).
      'sessions',
      // Full only. Agent bridge (off by default): talk to the local native host `com.facet.bridge` (docs/agents.md).
      ...(full ? ['nativeMessaging'] : []),
      // Full only. Agent bridge "full hands": trusted input, accessibility snapshots, screenshots of background tabs,
      // console and network capture through the Chrome DevTools Protocol. Attached only while the bridge is on and a tool runs.
      ...(full ? ['debugger'] : []),
    ],
    // v0.1 asks for every host up front: header rewriting needs host access, and
    // headless e2e cannot click permission prompts. Optional-permission onboarding is deferred.
    host_permissions: ['<all_urls>'],
    // Full only: userScripts is for run_js on pages whose Content-Security-Policy forbids eval; asked for in the options page.
    optional_permissions: ['cookies', ...(full ? (['userScripts'] as const) : [])],
    icons: iconSet,
    action: { default_title: 'Facet', default_icon: iconSet },
    // Static default answer for the beacon (`{}` = no container) so the content script never reaches the network,
    // even before the service worker has started. Per-tab (session) and managed-site (dynamic) rules override it.
    declarative_net_request: {
      rule_resources: [{ id: 'facet_defaults', enabled: true, path: 'rules/defaults.json' }],
    },
  },
});
