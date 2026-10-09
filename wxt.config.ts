import { readFileSync } from 'node:fs';
import preact from '@preact/preset-vite';
import { defineConfig } from 'wxt';

// Public half of the key pair from `pnpm keygen`; pins the extension ID (see docs/development.md).
const extensionKey = readFileSync(new URL('./extension-key.pub', import.meta.url), 'utf8').trim();

export default defineConfig({
  srcDir: 'src',
  vite: () => ({ plugins: [preact()] }),
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
    ],
    // v0.1 asks for every host up front: header rewriting needs host access, and
    // headless e2e cannot click permission prompts. Optional-permission onboarding is deferred.
    host_permissions: ['<all_urls>'],
    optional_permissions: ['cookies'],
    action: { default_title: 'Facet' },
  },
});
