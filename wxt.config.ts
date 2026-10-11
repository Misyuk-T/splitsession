import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import preact from '@preact/preset-vite';
import { defineConfig } from 'wxt';

// Public half of the key pair from `pnpm keygen`; pins the extension ID (see docs/development.md).
const extensionKey = readFileSync(new URL('./extension-key.pub', import.meta.url), 'utf8').trim();

// Rendered from assets/icon.svg by scripts/make-icons.mjs and committed.
const iconSet = { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' };

export default defineConfig({
  srcDir: 'src',
  vite: () => ({ plugins: [preact()] }),
  hooks: {
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
    name: 'Facet',
    description: 'Containers for Chrome: several accounts of the same site open side by side in one profile.',
    key: extensionKey,
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
      // Agent bridge (off by default): talk to the local native host `com.facet.bridge` (docs/agents.md).
      'nativeMessaging',
      // Agent bridge "full hands": trusted input, accessibility snapshots, screenshots of background tabs, console and
      // network capture through the Chrome DevTools Protocol. Attached only while the bridge is on and a tool runs.
      'debugger',
    ],
    // v0.1 asks for every host up front: header rewriting needs host access, and
    // headless e2e cannot click permission prompts. Optional-permission onboarding is deferred.
    host_permissions: ['<all_urls>'],
    // userScripts: only for run_js on pages whose Content-Security-Policy forbids eval; asked for in the options page.
    optional_permissions: ['cookies', 'userScripts'],
    icons: iconSet,
    action: { default_title: 'Facet', default_icon: iconSet },
    // Static default answer for the beacon (`{}` = no container) so the content script never reaches the network,
    // even before the service worker has started. Per-tab (session) and managed-site (dynamic) rules override it.
    declarative_net_request: {
      rule_resources: [{ id: 'facet_defaults', enabled: true, path: 'rules/defaults.json' }],
    },
  },
});
