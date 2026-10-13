import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";

import { at, expect, ext, test } from "./fixtures";

interface Rule {
  domain: string;
  action: "always" | "ask";
  containerId?: string;
}

const openOptions = async (facet: {
  ctx: import("@playwright/test").BrowserContext;
}): Promise<Page> => {
  const page = await facet.ctx.newPage();
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.goto(ext("options.html"));
  await expect(
    page.getByRole("heading", { name: "SplitSession settings" }),
  ).toBeVisible();
  return page;
};

/** Opens the folded "Export and import" part of Advanced. */
const openTransfer = async (page: Page) => {
  const toggle = page.getByRole("button", { name: "Export and import" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
};

/** Picks an option of a custom Select by clicking. */
const pick = async (page: Page, select: string, option: string | RegExp) => {
  await page.getByRole("combobox", { name: select }).click();
  await page.getByRole("option", { name: option }).click();
};

test.describe("options page", () => {
  test('a link to #agent (or #agents) lands on "For AI agents" with the heading focused; the font is the bundled Inter', async ({
    facet,
  }) => {
    for (const hash of ["agent", "agents"]) {
      const page = await facet.ctx.newPage();
      await page.setViewportSize({ width: 1000, height: 600 });
      await page.goto(ext(`options.html#${hash}`));
      const heading = page.getByRole("heading", { name: "For AI agents" });
      await expect(heading).toBeFocused();
      await expect(heading).toBeInViewport();
      expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
      if (hash === "agent") {
        const font = await page.evaluate(async () => {
          await document.fonts.ready;
          return {
            body: getComputedStyle(document.body).fontFamily,
            mono: getComputedStyle(
              document.querySelector(".opt-card code") ?? document.body,
            ).fontFamily,
          };
        });
        expect(font.body.replace(/"/g, "")).toMatch(/^Inter Variable,/);
      }
      await page.close();
    }
    // Following an in-page link moves focus to the section too.
    const page = await openOptions(facet);
    await page.getByRole("link", { name: "Domain rules" }).click();
    await expect(
      page.getByRole("heading", { name: "Domain rules" }),
    ).toBeFocused();
    await page.close();
  });

  test("sections come in the order General, For AI agents, Domain rules, Advanced; the top links follow it", async ({
    facet,
  }) => {
    const page = await openOptions(facet);
    const names = ["General", "For AI agents", "Domain rules", "Advanced"];
    expect(await page.locator("main h2").allInnerTexts()).toEqual(names);
    expect(await page.locator(".opt-nav a").allInnerTexts()).toEqual(names);
    // Export and import and Diagnostics are folded inside Advanced, in that order, and closed.
    const folded = page.locator("#advanced").getByRole("button");
    expect(await folded.allInnerTexts()).toEqual([
      "Export and import",
      "Diagnostics",
    ]);
    for (const toggle of await folded.all())
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(
      page.getByRole("heading", { name: "Export and import" }),
    ).toHaveCount(0);
    await page.close();
  });

  test("#transfer and #diagnostics open that part of Advanced and focus it; an in-page link does too", async ({
    facet,
  }) => {
    for (const [hash, title, probe] of [
      ["transfer", "Export and import", "import-file"],
      ["diagnostics", "Diagnostics", "diagnostics"],
    ] as const) {
      const page = await facet.ctx.newPage();
      await page.setViewportSize({ width: 1000, height: 600 });
      await page.goto(ext(`options.html#${hash}`));
      const toggle = page.getByRole("button", { name: title });
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(toggle).toBeFocused();
      await expect(toggle).toBeInViewport();
      await expect(page.getByTestId(probe)).toBeAttached();
      // The other part stays closed.
      const other = page.locator(
        hash === "transfer" ? "button#diagnostics" : "button#transfer",
      );
      await expect(other).toHaveAttribute("aria-expanded", "false");
      await page.close();
    }
    // Changing only the hash on a page that is already open does the same.
    const page = await openOptions(facet);
    await page.evaluate(() => (location.hash = "#transfer"));
    await expect(
      page.getByRole("button", { name: "Export and import" }),
    ).toHaveAttribute("aria-expanded", "true");
    await expect(
      page.getByRole("button", { name: "Export and import" }),
    ).toBeFocused();
    await page.getByRole("link", { name: "Advanced" }).click();
    await expect(page.getByRole("heading", { name: "Advanced" })).toBeFocused();
    await page.close();
  });

  test("the two settings are switches that default to on and take effect", async ({
    facet,
  }) => {
    const page = await openOptions(facet);
    const groups = page.getByRole("switch", { name: /tab groups/ });
    const prefix = page.getByRole("switch", { name: /in front of tab titles/ });
    await expect(groups).toHaveAttribute("aria-checked", "true");
    await expect(prefix).toHaveAttribute("aria-checked", "true");

    await groups.click();
    await expect(groups).toHaveAttribute("aria-checked", "false");
    expect(await facet.api("getSettings")).toMatchObject({
      tabGroups: false,
      titlePrefix: true,
    });
    await prefix.focus();
    await page.keyboard.press("Space"); // keyboard works
    await expect(prefix).toHaveAttribute("aria-checked", "false");
    expect(await facet.api("getSettings")).toMatchObject({
      tabGroups: false,
      titlePrefix: false,
    });

    await page.reload();
    await expect(
      page.getByRole("switch", { name: /tab groups/ }),
    ).toHaveAttribute("aria-checked", "false");
    await page.close();
  });

  test('long explanations sit behind "More"; the title-prefix switch exists only while container names are shown to pages', async ({
    facet,
  }) => {
    const page = await openOptions(facet);
    const more = page.getByRole("button", { name: /^More: restoring tabs/ });
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByText(/Continue where you left off/)).toHaveCount(0);
    await more.click();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText(/Continue where you left off/)).toBeVisible();

    const names = page.getByRole("switch", { name: /container name to pages/ });
    const prefix = page.getByRole("switch", { name: /in front of tab titles/ });
    await expect(names).toHaveAttribute("aria-checked", "true");
    await expect(prefix).toBeVisible();
    await names.click();
    await expect(names).toHaveAttribute("aria-checked", "false");
    await expect(prefix).toHaveCount(0); // hidden, not shown disabled
    await names.click();
    await expect(prefix).toBeVisible();
    await page.close();
  });

  test("domain rules: add, validate while typing, replace, edit and remove", async ({
    facet,
  }) => {
    const W = await facet.container("Work");
    const page = await openOptions(facet);
    const site = page.getByLabel("Site");
    const add = page.getByRole("button", { name: /Add rule|Replace rule/ });
    await expect(page.getByTestId("no-rules")).toBeVisible();
    await expect(add).toBeDisabled();

    await site.fill("com");
    await expect(page.getByText(/public suffix/)).toBeVisible();
    await expect(add).toBeDisabled();
    await site.fill("not a site");
    await expect(page.getByText(/cannot contain spaces/)).toBeVisible();

    await site.fill("https://www.GitHub.com/login?x=1");
    await expect(
      page.getByText("Applies to github.com and all its subdomains."),
    ).toBeVisible();
    await expect(add).toBeDisabled(); // "always" needs a container
    await pick(page, "Container", W.name);
    await expect(add).toBeEnabled();
    await add.click();
    const row = page.getByTestId("rule-row").filter({ hasText: "github.com" });
    await expect(row).toContainText(`Always open in ${W.name}`);
    expect(await facet.api<Rule[]>("listDomainRules")).toEqual([
      { domain: "github.com", action: "always", containerId: W.id },
    ]);
    await expect(site).toHaveValue(""); // form is ready for the next rule

    // Same site again replaces: say so before the user commits to it.
    await site.fill("gist.github.com");
    await expect(
      page.getByText("This replaces the existing rule for github.com."),
    ).toBeVisible();
    await pick(page, "What to do", "Ask me every time");
    await expect(page.getByRole("combobox", { name: "Container" })).toHaveCount(
      0,
    );
    await page.getByRole("button", { name: "Replace rule" }).click();
    await expect(row).toContainText("Ask every time");
    expect(await facet.api<Rule[]>("listDomainRules")).toEqual([
      { domain: "github.com", action: "ask" },
    ]);

    await row
      .getByRole("button", { name: /Edit the rule for github.com/ })
      .click();
    await expect(site).toHaveValue("github.com");
    await row
      .getByRole("button", { name: /Remove the rule for github.com/ })
      .click();
    await expect(page.getByTestId("no-rules")).toBeVisible();
    expect(await facet.api<Rule[]>("listDomainRules")).toEqual([]);
    await page.close();
  });

  test("the custom select works from the keyboard", async ({ facet }) => {
    const names = [
      await facet.container("KbdA"),
      await facet.container("KbdB"),
    ];
    const page = await openOptions(facet);
    const select = page.getByRole("combobox", { name: "What to do" });
    await select.focus();
    await page.keyboard.press("Enter"); // opens
    await expect(
      page.getByRole("listbox", { name: "What to do" }),
    ).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter"); // picks "Ask me every time"
    await expect(select).toContainText("Ask me every time");
    await expect(select).toBeFocused();
    await page.keyboard.press("ArrowUp"); // opens again
    await page.keyboard.press("Home");
    await page.keyboard.press(" ");
    await expect(select).toContainText("Always open in a container");

    const container = page.getByRole("combobox", { name: "Container" });
    await container.focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.type(names[1]!.name.slice(0, 5)); // type-ahead: "KbdB-..." shares "Kbd" so it lands on the first match
    await page.keyboard.press("Escape"); // closes without choosing
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(container).toContainText("Choose a container");
    await page.close();
  });

  test("export has no cookies unless asked, and then it says what that means", async ({
    facet,
  }) => {
    const W = await facet.container("Work");
    await facet.api("setDomainRule", {
      domain: "github.com",
      action: "always",
      containerId: W.id,
    });
    await facet.api("setDomainRule", { domain: "reddit.com", action: "ask" });
    const login = await facet.openIn(
      W.name,
      at("a.localhost", "/login?user=exported"),
    );
    await expect(login.locator("#user")).toHaveText("exported");
    const page = await openOptions(facet);
    await openTransfer(page);

    const plainDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const download = await plainDownload;
    expect(download.suggestedFilename()).toMatch(
      /^splitsession-\d{4}-\d\d-\d\d\.json$/,
    );
    const body = readFileSync((await download.path())!, "utf8");
    const plain = JSON.parse(body);
    expect(plain).toMatchObject({ format: "facet-export", version: 1 });
    expect(
      plain.containers.find((c: { id: string }) => c.id === W.id),
    ).toMatchObject({ name: W.name });
    expect(plain.rules).toEqual(
      expect.arrayContaining([
        { domain: "github.com", action: "always", containerId: W.id },
        { domain: "reddit.com", action: "ask" },
      ]),
    );
    expect("jars" in plain).toBe(false);
    expect(body).not.toContain("sid");

    await expect(page.getByTestId("jar-warning")).toHaveCount(0);
    await page.getByRole("checkbox", { name: /include cookie jars/ }).click();
    await expect(page.getByTestId("jar-warning")).toContainText(
      "Anyone who gets this file can sign in as you",
    );
    const jarDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export with cookies…" }).click();
    const withJars = JSON.parse(
      readFileSync((await (await jarDownload).path())!, "utf8"),
    );
    expect(withJars.jars[W.id].map((c: { name: string }) => c.name)).toContain(
      "sid",
    );
    await page.close();
  });

  test("import: shows what will happen, then does it; a broken file changes nothing", async ({
    facet,
  }) => {
    const existing = await facet.container("Keep");
    const existingColor = (
      await facet.api<Array<{ id: string; color: string }>>("listContainers")
    ).find((c) => c.id === existing.id)!.color;
    const fresh = `Imported-${Date.now().toString(36)}`;
    const file = {
      format: "facet-export",
      version: 1,
      exportedAt: Date.now(),
      containers: [
        { id: "aaa111", name: existing.name.toUpperCase(), color: "red" },
        { id: "bbb222", name: fresh, color: "pink" },
      ],
      rules: [
        { domain: "github.com", action: "always", containerId: "bbb222" },
        { domain: "reddit.com", action: "ask" },
      ],
      jars: {
        bbb222: [
          {
            name: "sid",
            value: "imported-session",
            domain: "a.localhost",
            hostOnly: true,
            path: "/",
            secure: false,
            httpOnly: true,
            sameSite: "lax",
            partitioned: false,
            partitionKey: null,
            expires: null,
            creationTime: 1,
          },
        ],
      },
    };
    const page = await openOptions(facet);
    await openTransfer(page);
    const input = page.getByTestId("import-file");

    await input.setInputFiles({
      name: "broken.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        '{"format":"facet-export","version":1,"containers":[{"id":"x","name":"X","color":"teal"}],"rules":[]}',
      ),
    });
    await expect(page.getByTestId("transfer-error")).toContainText(
      "unknown colour",
    );
    await input.setInputFiles({
      name: "junk.json",
      mimeType: "application/json",
      buffer: Buffer.from("not json"),
    });
    await expect(page.getByTestId("transfer-error")).toContainText(
      "not valid JSON",
    );
    expect(
      (await facet.api<Array<{ name: string }>>("listContainers")).some(
        (c) => c.name === fresh,
      ),
    ).toBe(false);

    await input.setInputFiles({
      name: "facet.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(file)),
    });
    const plan = page.getByTestId("import-plan");
    await expect(plan).toContainText("create 1 container");
    await expect(plan).toContainText(fresh);
    await expect(plan).toContainText("keep 1 container you already have");
    await expect(plan).toContainText("set 2 domain rules");
    await expect(plan).toContainText("add 1 cookie");
    expect(
      (await facet.api<Array<{ name: string }>>("listContainers")).some(
        (c) => c.name === fresh,
      ),
    ).toBe(false); // nothing changed yet

    await plan.getByRole("button", { name: "Import" }).click();
    await expect(page.getByTestId("transfer-status")).toContainText(
      "1 container created",
    );
    const containers =
      await facet.api<Array<{ id: string; name: string; color: string }>>(
        "listContainers",
      );
    const made = containers.find((c) => c.name === fresh)!;
    expect(made.color).toBe("pink");
    expect(containers.find((c) => c.id === existing.id)!.color).toBe(
      existingColor,
    ); // matched containers are left as they are (their random colour may even be red)
    expect(await facet.api<Rule[]>("listDomainRules")).toEqual([
      { domain: "github.com", action: "always", containerId: made.id },
      { domain: "reddit.com", action: "ask" },
    ]);
    expect(
      (await facet.api<Array<{ value: string }>>("getJar", made.id)).map(
        (c) => c.value,
      ),
    ).toEqual(["imported-session"]);

    // The imported login works: a tab in the new container is that session.
    const tab = await facet.openIn(made.name, at("a.localhost", "/whoami"));
    expect(await tab.locator("#cookies").textContent()).toContain(
      "sid=imported-session",
    );
    await page.close();
  });

  test("diagnostics are read-only facts about the engine", async ({
    facet,
  }) => {
    const W = await facet.container("Work");
    await facet.openIn(W.name, at("a.localhost", "/whoami"));
    const page = await openOptions(facet);
    await expect(page.getByTestId("diag-session-rules")).toHaveCount(0); // folded away until asked for
    const show = page.getByRole("button", { name: "Diagnostics" });
    await expect(show).toHaveAttribute("aria-expanded", "false");
    await show.click();
    await expect(page.getByTestId("diag-session-rules")).not.toHaveText("0");
    await expect(page.getByTestId("diag-managed")).toContainText("a.localhost");
    await expect(page.getByTestId("diag-scripts")).toHaveText(
      /^All sites · \d+ container tabs? open$/,
    );
    await expect(page.getByTestId("diag-log")).toContainText("->");
    await page.close();
  });
});
