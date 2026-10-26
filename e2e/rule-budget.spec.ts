import type { Page } from "@playwright/test";

import { at, expect, ext, test } from "./fixtures";

interface Stats {
  rules: number;
  softLimit: number;
  hardLimit: number;
  refusedAt: number | null;
}
interface SessionRule {
  priority: number;
  action: { type: string };
  condition: {
    tabIds?: number[];
    requestDomains?: string[];
    urlFilter?: string;
  };
}

const SITES = ["a.localhost", "b.localhost", "c.localhost", "d.localhost"];
const TABS_PER_CONTAINER = 10;

/** The Cookie header a same-origin fetch from the page carries. */
const echo = (page: Page) =>
  page.evaluate(async () => (await fetch("/echo")).text());

test.describe("rule budget", () => {
  test("30 container tabs in 3 containers on 4 cookie-heavy sites (partitioned cookies included) share their containers' rules and stay isolated", async ({
    facet,
  }) => {
    test.setTimeout(180_000);
    const containers = await Promise.all(
      ["Budget A", "Budget B", "Budget C"].map((n) => facet.container(n)),
    );
    const tabs: Array<{ page: Page; mark: string; containerId: string }> = [];
    const addresses = new Set<string>();
    const open = async (i: number) => {
      for (const c of containers) {
        const mark = c.name;
        const url = at(
          SITES[i % SITES.length]!,
          `/heavy?mark=${encodeURIComponent(mark)}`,
        );
        addresses.add(url);
        const page = await facet.openIn(c.name, url);
        await expect(page.locator("#mark")).toHaveText(mark);
        tabs.push({ page, mark, containerId: c.id });
      }
    };

    /**
     * The restore gate opens each container tab's address with one `allow` rule (per address, not per tab) once the
     * restore snapshot is written, a moment after the tab committed (debounced). Rules are counted after that: read too
     * early, the last address's opener is missing and the count is one short.
     */
    const restoreGateCaughtUp = () =>
      expect
        .poll(async () => {
          const open = new Set(
            (await facet.api<SessionRule[]>("getSessionRules"))
              .filter((r) => r.action.type === "allow")
              .map((r) => r.condition.urlFilter),
          );
          return [...addresses].filter((a) => !open.has(`|${a}|`));
        })
        .toEqual([]);

    // Every container on every site once: the jars are complete and each container has 4 top-level-site groups.
    for (let i = 0; i < SITES.length; i++) await open(i);
    await expect
      .poll(async () =>
        (
          await facet.api<Array<{ partitioned: boolean }>>(
            "getJar",
            containers[0]!.id,
          )
        ).some((c) => c.partitioned),
      )
      .toBe(true);
    await restoreGateCaughtUp();
    const afterFirst = (await facet.api<Stats>("stats")).rules;

    for (let i = SITES.length; i < TABS_PER_CONTAINER; i++) await open(i);
    await restoreGateCaughtUp();
    const stats = await facet.api<Stats>("stats");
    // More tabs on the same sites add no rules: they join the containers' existing rules.
    expect(stats.rules).toBe(afterFirst);
    expect(stats.rules).toBeLessThan(stats.softLimit);
    expect(stats.refusedAt).toBeNull();

    // One catch-all per container (not one per container and top-level site), covering all its tabs.
    const ids = await Promise.all(tabs.map((t) => facet.tabIdOf(t.page)));
    const catchAll = (await facet.api<SessionRule[]>("getSessionRules")).filter(
      (r) =>
        r.priority === 2 &&
        !r.condition.requestDomains &&
        r.condition.tabIds?.some((t) => ids.includes(t)),
    );
    expect(catchAll).toHaveLength(containers.length);
    for (const c of containers) {
      const mine = ids.filter((_, i) => tabs[i]!.containerId === c.id);
      expect(
        catchAll.some((r) =>
          mine.every((t) => r.condition.tabIds!.includes(t)),
        ),
      ).toBe(true);
    }

    // Every tab is in its container and sends only that container's cookies.
    for (const [i, { page, mark, containerId }] of tabs.entries()) {
      expect(await facet.api("getTabContainer", ids[i])).toBe(containerId);
      const header = await echo(page);
      expect(header).toContain(`mark=${encodeURIComponent(mark)}`);
      for (const other of containers)
        if (other.name !== mark)
          expect(header).not.toContain(
            `mark=${encodeURIComponent(other.name)}`,
          );
    }
    expect(await facet.realCookies(at("a.localhost"))).toEqual([]);
  });

  test("the popup shows no rule budget notice while the rules are under the soft limit", async ({
    facet,
  }) => {
    const C = await facet.container("Budget");
    await facet.openIn(C.name, at("a.localhost", "/heavy?mark=x"));
    const popup = await facet.ctx.newPage();
    facet.adopt(popup);
    await popup.goto(ext("popup.html"));
    await expect(popup.locator(".popup")).toBeVisible();
    await expect(popup.getByTestId("rule-budget-notice")).toHaveCount(0);
  });
});
