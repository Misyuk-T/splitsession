import { defineConfig } from '@playwright/test';
import { TEST_PORT } from './env';

/**
 * Facet e2e: Chromium with the built extension (.output/chrome-mv3) in a persistent context, against the local
 * multi-host stand in test-server/. `pnpm e2e` builds first. HEADED=1 to watch.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 7_000 },
  reporter: [['list']],
  webServer: {
    command: `node test-server/server.mjs ${TEST_PORT}`,
    cwd: '..',
    port: TEST_PORT,
    reuseExistingServer: false,
    stdout: 'ignore',
  },
});
