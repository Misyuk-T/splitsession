import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { EXTENSION_ID, EXTENSION_PATH } from './env';
import { expect, ext, type Facet } from './fixtures';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridgeEntry = path.join(root, 'bridge', 'dist', 'facet-bridge.mjs');
export const MANIFEST = 'com.facet.bridge.json';

/** Builds the bridge and registers the native host with THIS run's browser profile only (no system directory is touched). */
let built = false;
export function installHost(facet: Facet): void {
  const args = [path.join(root, 'scripts', 'bridge-install.mjs'), '--dir', facet.profile.nativeHostsDir, '--host-dir', facet.profile.hostDir];
  execFileSync(process.execPath, built ? [...args, '--no-build'] : args, { stdio: 'pipe' });
  built = true;
}

export function uninstallHost(facet: Facet): void {
  rmSync(path.join(facet.profile.nativeHostsDir, MANIFEST), { force: true });
}

export interface ToolResponse {
  isError: boolean;
  /** Text blocks joined. */
  text: string;
  /** The text blocks one by one. */
  texts: string[];
  images: Array<{ data: string; mimeType: string }>;
}

export interface Mcp {
  client: Client;
  call(name: string, args?: Record<string, unknown>): Promise<ToolResponse>;
  json<T = any>(name: string, args?: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

/** An MCP client that launches the bridge's stdio MCP server the way Claude Code would. */
export async function startMcp(facet: Facet, manifestDirs: string = facet.profile.nativeHostsDir): Promise<Mcp> {
  expect(existsSync(bridgeEntry), 'run `node bridge/build.mjs` first').toBe(true);
  const client = new Client({ name: 'facet-e2e', version: '0.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bridgeEntry, 'mcp'],
    env: { ...(process.env as Record<string, string>), FACET_BRIDGE_SOCKET: facet.profile.socketPath, FACET_BRIDGE_MANIFEST_DIRS: manifestDirs },
    stderr: 'pipe',
  });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResponse> => {
    const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };
    const texts = result.content.filter((c) => c.type === 'text').map((c) => c.text ?? '');
    return {
      isError: result.isError === true,
      text: texts.join('\n'),
      texts,
      images: result.content.filter((c) => c.type === 'image').map((c) => ({ data: c.data ?? '', mimeType: c.mimeType ?? '' })),
    };
  };
  return {
    client,
    call,
    async json(name, args) {
      const r = await call(name, args);
      expect(r.isError, `${name} failed: ${r.text}`).toBe(false);
      return JSON.parse(r.texts[0]!);
    },
    close: () => client.close(),
  };
}

/** Opens the popup as a page and returns it with its agent bridge switch. */
export async function openPopup(facet: Facet): Promise<{ page: Page; toggle: ReturnType<Page['getByRole']> }> {
  const page = await facet.ctx.newPage();
  await page.setViewportSize({ width: 420, height: 800 });
  await page.goto(ext('popup.html'));
  await expect(page.getByRole('heading', { name: 'Containers' })).toBeVisible();
  return { page, toggle: page.getByRole('switch', { name: /Agent bridge/ }) };
}

/** PIDs of the processes that have the bridge socket open (the host; clients only while connected). */
export function hostPids(facet: Facet): number[] {
  try {
    return execFileSync('lsof', ['-t', facet.profile.socketPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

/** A second Chrome profile with Facet loaded, its own host manifest, and the SAME bridge socket as `facet`'s profile. */
export interface SecondProfile {
  ctx: BrowserContext;
  api<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
  popup(): Promise<Page>;
  close(): Promise<void>;
}

export async function startSecondProfile(facet: Facet): Promise<SecondProfile> {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'facet-e2e2-'));
  const nativeHostsDir = path.join(userDataDir, 'NativeMessagingHosts');
  mkdirSync(nativeHostsDir);
  execFileSync(process.execPath, [path.join(root, 'scripts', 'bridge-install.mjs'), '--dir', nativeHostsDir, '--host-dir', path.join(userDataDir, 'facet-host'), '--no-build'], { stdio: 'pipe' });
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    env: { ...(process.env as Record<string, string>), FACET_BRIDGE_SOCKET: facet.profile.socketPath },
  });
  const ours = (w: { url(): string }) => w.url().startsWith(`chrome-extension://${EXTENSION_ID}/`);
  const worker = async () => ctx.serviceWorkers().filter(ours).at(-1) ?? (await ctx.waitForEvent('serviceworker', { predicate: ours, timeout: 15_000 }));
  const api = async <T,>(method: string, ...args: unknown[]): Promise<T> =>
    (await worker()).evaluate(
      async ([m, a]) => (globalThis as unknown as { facet: Record<string, (...x: unknown[]) => Promise<unknown>> }).facet[m as string]!(...(a as unknown[])),
      [method, args] as const,
    ) as Promise<T>;
  await api('listContainers'); // waits for the worker to be ready
  return {
    ctx,
    api,
    async popup() {
      const page = await ctx.newPage();
      await page.setViewportSize({ width: 420, height: 800 });
      await page.goto(ext('popup.html'));
      await expect(page.getByRole('heading', { name: 'Containers' })).toBeVisible();
      return page;
    },
    async close() {
      await api('updateSettings', { agentBridge: false }).catch(() => {});
      await ctx.close().catch(() => {});
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}
