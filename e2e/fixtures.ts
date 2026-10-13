import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test as base,
  type Worker,
} from "@playwright/test";

import { at, ext, EXTENSION_ID, TEST_PORT } from "./env";
import { apiOf, extensionArgs, isOurWorker } from "./extension";

export { at, expect, ext };

export interface LogEntry {
  at: number;
  host: string;
  path: string;
  method: string;
  cookie: string;
}

/** Where this run's browser profile and agent-bridge socket live (a private temp dir, removed afterwards). */
export interface Profile {
  userDataDir: string;
  /** Chrome reads host manifests from `<user data dir>/NativeMessagingHosts`. */
  nativeHostsDir: string;
  /** Where the installer copies the host program for this run. */
  hostDir: string;
  socketPath: string;
}

export interface Facet {
  ctx: BrowserContext;
  profile: Profile;
  /** Current extension service worker (re-resolved after restarts). */
  sw(): Promise<Worker>;
  api<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
  /** Creates a container with a unique name; returns its id and name. */
  container(label: string): Promise<{ id: string; name: string }>;
  /** New tab through open.html: assigned before its first request. */
  openIn(containerRef: string, url: string): Promise<Page>;
  /** New tab without a container. */
  plain(url: string): Promise<Page>;
  tabIdOf(page: Page): Promise<number>;
  /** Closes `page` with the test (a tab the test did not open itself, e.g. one SplitSession created). */
  adopt(page: Page): void;
  /** Requests the stand received; `clearLog` first to scope them. */
  serverLog(): Promise<LogEntry[]>;
  clearLog(): Promise<void>;
  /** Stops the extension service worker (CDP Target.closeTarget); the next extension event starts a fresh one. */
  stopServiceWorker(via: Page): Promise<void>;
  /** Number of running extension service-worker targets (asked through an existing page: opening a tab would wake it). */
  serviceWorkerTargets(via: Page): Promise<number>;
  /** Tab and tab-group facts as Chrome reports them (asked through the extension worker). */
  tabInfo(tabId: number): Promise<{
    id: number;
    title: string;
    url: string;
    groupId: number;
    windowId: number;
    badge: string;
    badgeColor: number[];
  }>;
  /** `title` without SplitSession's invisible container marker; `marker`: the container ID it names (null: none). */
  groupInfo(groupId: number): Promise<{
    id: number;
    title: string;
    color: string;
    windowId: number;
    marker: string | null;
  } | null>;
  /** Runs `fn` in the extension worker (use the global `chrome` inside it). */
  inWorker<T, A>(fn: (arg: A) => Promise<T> | T, arg: A): Promise<T>;
  /** Cookies in the real profile (what an ordinary tab would send). */
  realCookies(
    url: string,
  ): Promise<Array<{ name: string; value: string; domain: string }>>;
}

let counter = 0;
const unique = (label: string) =>
  `${label}-${Date.now().toString(36)}-${++counter}`;

export const test = base.extend<
  { facet: Facet },
  { profile: Profile; extContext: BrowserContext }
>({
  profile: [
    // eslint-disable-next-line no-empty-pattern -- Playwright reads the fixture dependencies from this destructuring, so it must stay
    async ({}, use) => {
      const userDataDir = mkdtempSync(path.join(tmpdir(), "facet-e2e-"));
      const nativeHostsDir = path.join(userDataDir, "NativeMessagingHosts");
      mkdirSync(nativeHostsDir);
      // Unix socket paths are short (104 bytes on macOS, and $TMPDIR there is long): a short directory directly under /tmp.
      const socketDir = mkdtempSync(
        path.join(process.platform === "win32" ? tmpdir() : "/tmp", "fb-"),
      );
      await use({
        userDataDir,
        nativeHostsDir,
        hostDir: path.join(userDataDir, "facet-host"),
        socketPath: path.join(socketDir, "bridge.sock"),
      });
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(socketDir, { recursive: true, force: true });
    },
    { scope: "worker" },
  ],
  extContext: [
    async ({ profile }, use) => {
      const context = await chromium.launchPersistentContext(
        profile.userDataDir,
        {
          channel: "chromium",
          headless: !process.env.HEADED,
          args: extensionArgs(),
          // The agent bridge host Chrome starts inherits this: its socket stays inside the test's temp dir.
          env: {
            ...(process.env as Record<string, string>),
            FACET_BRIDGE_SOCKET: profile.socketPath,
          },
        },
      );
      await use(context);
      await context.close();
    },
    { scope: "worker" },
  ],
  facet: async ({ extContext: context, profile }, use, testInfo) => {
    let latest: Worker | null =
      context.serviceWorkers().filter(isOurWorker).at(-1) ?? null;
    const onWorker = (w: Worker) => {
      if (isOurWorker(w)) latest = w;
    };
    context.on("serviceworker", onWorker);
    const sw = async (): Promise<Worker> =>
      latest ??
      (latest = await context.waitForEvent("serviceworker", {
        predicate: isOurWorker,
        timeout: 15_000,
      }));
    const api = async <T>(method: string, ...args: unknown[]): Promise<T> =>
      apiOf(await sw())<T>(method, ...args);
    const opened: Page[] = [];
    const facet: Facet = {
      ctx: context,
      profile,
      sw,
      api,
      async container(label) {
        const c = await api<{ id: string; name: string }>("createContainer", {
          name: unique(label),
        });
        return { id: c.id, name: c.name };
      },
      async openIn(ref, url) {
        const page = await context.newPage();
        opened.push(page);
        const openUrl = `chrome-extension://${EXTENSION_ID}/open.html?container=${encodeURIComponent(ref)}&url=${encodeURIComponent(url)}`;
        await page.goto(openUrl);
        await expect
          .poll(() => page.url(), { timeout: 10_000 })
          .toMatch(/^http:/);
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        return page;
      },
      async plain(url) {
        const page = await context.newPage();
        opened.push(page);
        // The restore gate holds a brand-new tab on the address of a just-closed container tab until SplitSession has seen
        // the tab; a person cannot type that fast, a test can.
        await api("flushRestore");
        await page.goto(url);
        return page;
      },
      adopt(page) {
        opened.push(page);
      },
      async tabIdOf(page) {
        const marker = `facet-tab-${Math.random().toString(36).slice(2)}`;
        // The tab may be in the middle of a navigation the extension started (a rule moving it): try again.
        let original = "";
        for (let attempt = 0; ; attempt++) {
          try {
            original = await page.title();
            await page.evaluate((m) => (document.title = m), marker);
            break;
          } catch (error) {
            if (
              attempt >= 8 ||
              !/context was destroyed|navigation|Target closed/i.test(
                String(error),
              )
            )
              throw error;
            await page.waitForLoadState("domcontentloaded").catch(() => {});
          }
        }
        const worker = await sw();
        const id = await worker.evaluate(async (m) => {
          const chromeApi = (globalThis as any).chrome;
          for (let i = 0; i < 20; i++) {
            const tabs: Array<{ id?: number; title?: string }> =
              await chromeApi.tabs.query({});
            const tab = tabs.find((t) => (t.title ?? "").endsWith(m)); // container tabs carry a "[name] " prefix
            if (tab?.id !== undefined) return tab.id;
            await new Promise((r) => setTimeout(r, 50));
          }
          throw new Error(`no tab titled ${m}`);
        }, marker);
        await page.evaluate((t) => (document.title = t), original);
        return id;
      },
      async serverLog() {
        const res = await fetch(`http://127.0.0.1:${TEST_PORT}/__log`);
        return (await res.json()) as LogEntry[];
      },
      async clearLog() {
        await fetch(`http://127.0.0.1:${TEST_PORT}/__log?clear=1`);
      },
      async stopServiceWorker(via) {
        const cdp = await context.newCDPSession(via);
        const { targetInfos } = (await cdp.send("Target.getTargets")) as {
          targetInfos: Array<{ targetId: string; type: string; url: string }>;
        };
        for (const t of targetInfos) {
          if (
            t.type === "service_worker" &&
            t.url.startsWith(`chrome-extension://${EXTENSION_ID}/`)
          ) {
            await cdp.send("Target.closeTarget", { targetId: t.targetId });
          }
        }
        await cdp.detach();
      },
      async serviceWorkerTargets(via) {
        const cdp = await context.newCDPSession(via);
        await via.waitForTimeout(300);
        const { targetInfos } = (await cdp.send("Target.getTargets")) as {
          targetInfos: Array<{ type: string; url: string }>;
        };
        await cdp.detach();
        return targetInfos.filter(
          (t) =>
            t.type === "service_worker" &&
            t.url.startsWith(`chrome-extension://${EXTENSION_ID}/`),
        ).length;
      },
      async inWorker(fn, arg) {
        const worker = await sw();
        return worker.evaluate(fn as never, arg as never) as Promise<never>;
      },
      async tabInfo(tabId) {
        return this.inWorker(async (id: number) => {
          const c = (globalThis as any).chrome;
          const tab = await c.tabs.get(id);
          return {
            id: tab.id,
            title: tab.title ?? "",
            url: tab.url ?? "",
            groupId: tab.groupId,
            windowId: tab.windowId,
            badge: await c.action.getBadgeText({ tabId: id }),
            badgeColor: await c.action.getBadgeBackgroundColor({ tabId: id }),
          };
        }, tabId);
      },
      async groupInfo(groupId) {
        if (groupId < 0) return null;
        return this.inWorker(async (id: number) => {
          const c = (globalThis as any).chrome;
          try {
            const g = await c.tabGroups.get(id);
            const raw: string = g.title ?? "";
            // eslint-disable-next-line no-misleading-character-class -- the marker alphabet is zero-width code points
            const m = /\u2063([\u200b\u200c\u200d\u2060]+)\u2063$/.exec(raw);
            let marker: string | null = null;
            if (m) {
              const digits = ["\u200b", "\u200c", "\u200d", "\u2060"];
              marker = "";
              for (let i = 0; i < m[1]!.length; i += 3) {
                const n =
                  (digits.indexOf(m[1]![i]!) << 4) |
                  (digits.indexOf(m[1]![i + 1]!) << 2) |
                  digits.indexOf(m[1]![i + 2]!);
                marker += "0123456789abcdefghijklmnopqrstuvwxyz"[n];
              }
            }
            return {
              id: g.id,
              title: m ? raw.slice(0, m.index) : raw,
              color: g.color,
              windowId: g.windowId,
              marker,
            };
          } catch {
            return null;
          }
        }, groupId);
      },
      async realCookies(url) {
        return (await context.cookies(url)).map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
        }));
      },
    };
    await sw();
    await api("listContainers"); // waits for the worker to be ready
    await context.clearCookies(); // real profile starts empty for every test
    // Containers outlive a test in the shared browser too (with their jars, rules, tabs and groups): every test starts with
    // none, so a list that grows with the suite (the popup, the swap menu) cannot depend on which specs ran before it.
    for (const c of await api<Array<{ id: string }>>("listContainers"))
      await api("deleteContainer", c.id);
    // Rules and settings outlive a test in the shared browser: start from the defaults.
    for (const rule of await api<Array<{ domain: string }>>("listDomainRules"))
      await api("removeDomainRule", rule.domain);
    await api("updateSettings", {
      tabGroups: true,
      titlePrefix: true,
      strictMode: true,
      showNameToPages: true,
      agentBridge: false,
      agentActivity: true,
      restoreTabs: true,
      markOutsideGroup: true,
    });
    // Container tabs closed by earlier tests are not reopened by this one.
    await api("forgetClosedTabs");
    // No container tab is open now: the content scripts go down to what that state needs at once (instead of after the
    // grace period), so every test starts the same way and its first container tab exercises the registration.
    await api("flushContentScripts");
    // Strict mode is on for every test (the isolation steady state; tests of the other states change it themselves).
    expect(await api("getStrictMode")).toMatchObject({
      enabled: true,
      active: true,
    });
    await use(facet);
    if (testInfo.status !== testInfo.expectedStatus) {
      const log = await Promise.race([
        api("getLog"),
        new Promise((r) => setTimeout(() => r("worker unreachable"), 2_000)),
      ]).catch(String);
      await testInfo.attach("facet-log.json", {
        body: JSON.stringify(log, null, 1),
        contentType: "application/json",
      });
      const requests = await facet.serverLog().catch(() => []);
      await testInfo.attach("server-log.json", {
        body: JSON.stringify(requests.slice(-60), null, 1),
        contentType: "application/json",
      });
      if (process.env.FACET_E2E_DEBUG) {
        console.log(JSON.stringify(log, null, 1));
        console.log(
          requests
            .slice(-25)
            .map((r) => `${r.at} ${r.host}${r.path} cookie=${r.cookie}`)
            .join("\n"),
        );
      }
    }
    for (const page of opened) await page.close().catch(() => {});
    context.off("serviceworker", onWorker);
  },
});

/**
 * page.goto that tolerates the extension re-navigating the tab mid-load (stale-hop repair after a 302 login):
 * Playwright then reports net::ERR_ABORTED although the tab ends up where it should.
 */
export async function go(page: Page, url: string): Promise<void> {
  try {
    await page.goto(url);
  } catch (error) {
    if (
      !String(error).includes("ERR_ABORTED") &&
      !String(error).includes("interrupted by another navigation")
    )
      throw error;
    await page.waitForLoadState("domcontentloaded").catch(() => {});
  }
}

/** fetch() from the page (MAIN world, i.e. through the shim) returning JSON. */
export const pageJson = <T = any>(
  page: Page,
  url: string,
  init?: RequestInit,
): Promise<T> =>
  page.evaluate(async ([u, i]) => (await fetch(u, i as RequestInit)).json(), [
    url,
    init ?? {},
  ] as const) as Promise<T>;

export const pageText = (page: Page, url: string): Promise<string> =>
  page.evaluate(async (u) => (await fetch(u)).text(), url);

/**
 * Runs `action` (a navigation that a domain rule or the choose page answers with a FRESH tab) and returns the page that
 * replaced `page`: `page` is closed, the new one has loaded the address in the container.
 */
export async function followReplacement(
  facet: Facet,
  page: Page,
  action: () => Promise<unknown>,
): Promise<Page> {
  const created = facet.ctx.waitForEvent("page", { timeout: 15_000 });
  await action().catch(() => {}); // the old page closes under the navigation
  const next = await created;
  facet.adopt(next);
  await expect.poll(() => page.isClosed(), { timeout: 10_000 }).toBe(true);
  await expect.poll(() => next.url(), { timeout: 10_000 }).toMatch(/^http:/);
  await next.waitForLoadState("domcontentloaded").catch(() => {});
  return next;
}
