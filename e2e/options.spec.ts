import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { at, expect, ext, test } from './fixtures';

interface Rule {
  domain: string;
  action: 'always' | 'ask';
  containerId?: string;
}

const openOptions = async (facet: { ctx: import('@playwright/test').BrowserContext }): Promise<Page> => {
  const page = await facet.ctx.newPage();
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.goto(ext('options.html'));
  await expect(page.getByRole('heading', { name: 'Facet settings' })).toBeVisible();
  return page;
};

/** Picks an option of a custom Select by clicking. */
const pick = async (page: Page, select: string, option: string | RegExp) => {
  await page.getByRole('combobox', { name: select }).click();
  await page.getByRole('option', { name: option }).click();
};

test.describe('options page', () => {
  test('the two settings are switches that default to on and take effect', async ({ facet }) => {
    const page = await openOptions(facet);
    const groups = page.getByRole('switch', { name: /tab groups/ });
    const prefix = page.getByRole('switch', { name: /in front of tab titles/ });
    await expect(groups).toHaveAttribute('aria-checked', 'true');
    await expect(prefix).toHaveAttribute('aria-checked', 'true');

    await groups.click();
    await expect(groups).toHaveAttribute('aria-checked', 'false');
    expect(await facet.api('getSettings')).toMatchObject({ tabGroups: false, titlePrefix: true });
    await prefix.focus();
    await page.keyboard.press('Space'); // keyboard works
    await expect(prefix).toHaveAttribute('aria-checked', 'false');
    expect(await facet.api('getSettings')).toMatchObject({ tabGroups: false, titlePrefix: false });

    await page.reload();
    await expect(page.getByRole('switch', { name: /tab groups/ })).toHaveAttribute('aria-checked', 'false');
    await page.close();
  });

  test('domain rules: add, validate while typing, replace, edit and remove', async ({ facet }) => {
    const W = await facet.container('Work');
    const page = await openOptions(facet);
    const site = page.getByLabel('Site');
    const add = page.getByRole('button', { name: /Add rule|Replace rule/ });
    await expect(page.getByTestId('no-rules')).toBeVisible();
    await expect(add).toBeDisabled();

    await site.fill('com');
    await expect(page.getByText(/public suffix/)).toBeVisible();
    await expect(add).toBeDisabled();
    await site.fill('not a site');
    await expect(page.getByText(/cannot contain spaces/)).toBeVisible();

    await site.fill('https://www.GitHub.com/login?x=1');
    await expect(page.getByText('Applies to github.com and all its subdomains.')).toBeVisible();
    await expect(add).toBeDisabled(); // "always" needs a container
    await pick(page, 'Container', W.name);
    await expect(add).toBeEnabled();
    await add.click();
    const row = page.getByTestId('rule-row').filter({ hasText: 'github.com' });
    await expect(row).toContainText(`Always open in ${W.name}`);
    expect(await facet.api<Rule[]>('listDomainRules')).toEqual([{ domain: 'github.com', action: 'always', containerId: W.id }]);
    await expect(site).toHaveValue(''); // form is ready for the next rule

    // Same site again replaces: say so before the user commits to it.
    await site.fill('gist.github.com');
    await expect(page.getByText('This replaces the existing rule for github.com.')).toBeVisible();
    await pick(page, 'What to do', 'Ask me every time');
    await expect(page.getByRole('combobox', { name: 'Container' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Replace rule' }).click();
    await expect(row).toContainText('Ask every time');
    expect(await facet.api<Rule[]>('listDomainRules')).toEqual([{ domain: 'github.com', action: 'ask' }]);

    await row.getByRole('button', { name: /Edit the rule for github.com/ }).click();
    await expect(site).toHaveValue('github.com');
    await row.getByRole('button', { name: /Remove the rule for github.com/ }).click();
    await expect(page.getByTestId('no-rules')).toBeVisible();
    expect(await facet.api<Rule[]>('listDomainRules')).toEqual([]);
    await page.close();
  });

  test('the custom select works from the keyboard', async ({ facet }) => {
    const names = [await facet.container('KbdA'), await facet.container('KbdB')];
    const page = await openOptions(facet);
    const select = page.getByRole('combobox', { name: 'What to do' });
    await select.focus();
    await page.keyboard.press('Enter'); // opens
    await expect(page.getByRole('listbox', { name: 'What to do' })).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter'); // picks "Ask me every time"
    await expect(select).toContainText('Ask me every time');
    await expect(select).toBeFocused();
    await page.keyboard.press('ArrowUp'); // opens again
    await page.keyboard.press('Home');
    await page.keyboard.press(' ');
    await expect(select).toContainText('Always open in a container');

    const container = page.getByRole('combobox', { name: 'Container' });
    await container.focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.type(names[1]!.name.slice(0, 5)); // type-ahead: "KbdB-..." shares "Kbd" so it lands on the first match
    await page.keyboard.press('Escape'); // closes without choosing
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(container).toContainText('Choose a container');
    await page.close();
  });

  test('export has no cookies unless asked, and then it says what that means', async ({ facet }) => {
    const W = await facet.container('Work');
    await facet.api('setDomainRule', { domain: 'github.com', action: 'always', containerId: W.id });
    await facet.api('setDomainRule', { domain: 'reddit.com', action: 'ask' });
    const login = await facet.openIn(W.name, at('a.localhost', '/login?user=exported'));
    await expect(login.locator('#user')).toHaveText('exported');
    const page = await openOptions(facet);

    const plainDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const download = await plainDownload;
    expect(download.suggestedFilename()).toMatch(/^facet-\d{4}-\d\d-\d\d\.json$/);
    const body = readFileSync((await download.path())!, 'utf8');
    const plain = JSON.parse(body);
    expect(plain).toMatchObject({ format: 'facet-export', version: 1 });
    expect(plain.containers.find((c: { id: string }) => c.id === W.id)).toMatchObject({ name: W.name });
    expect(plain.rules).toEqual(expect.arrayContaining([{ domain: 'github.com', action: 'always', containerId: W.id }, { domain: 'reddit.com', action: 'ask' }]));
    expect('jars' in plain).toBe(false);
    expect(body).not.toContain('sid');

    await expect(page.getByTestId('jar-warning')).toHaveCount(0);
    await page.getByRole('checkbox', { name: /include cookie jars/ }).click();
    await expect(page.getByTestId('jar-warning')).toContainText('Anyone who gets this file can sign in as you');
    const jarDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export with cookies…' }).click();
    const withJars = JSON.parse(readFileSync((await (await jarDownload).path())!, 'utf8'));
    expect(withJars.jars[W.id].map((c: { name: string }) => c.name)).toContain('sid');
    await page.close();
  });

  test('import: shows what will happen, then does it; a broken file changes nothing', async ({ facet }) => {
    const existing = await facet.container('Keep');
    const existingColor = (await facet.api<Array<{ id: string; color: string }>>('listContainers')).find((c) => c.id === existing.id)!.color;
    const fresh = `Imported-${Date.now().toString(36)}`;
    const file = {
      format: 'facet-export',
      version: 1,
      exportedAt: Date.now(),
      containers: [
        { id: 'aaa111', name: existing.name.toUpperCase(), color: 'red' },
        { id: 'bbb222', name: fresh, color: 'pink' },
      ],
      rules: [
        { domain: 'github.com', action: 'always', containerId: 'bbb222' },
        { domain: 'reddit.com', action: 'ask' },
      ],
      jars: {
        bbb222: [
          { name: 'sid', value: 'imported-session', domain: 'a.localhost', hostOnly: true, path: '/', secure: false, httpOnly: true, sameSite: 'lax', partitioned: false, partitionKey: null, expires: null, creationTime: 1 },
        ],
      },
    };
    const page = await openOptions(facet);
    const input = page.getByTestId('import-file');

    await input.setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{"format":"facet-export","version":1,"containers":[{"id":"x","name":"X","color":"teal"}],"rules":[]}') });
    await expect(page.getByTestId('transfer-error')).toContainText('unknown colour');
    await input.setInputFiles({ name: 'junk.json', mimeType: 'application/json', buffer: Buffer.from('not json') });
    await expect(page.getByTestId('transfer-error')).toContainText('not valid JSON');
    expect((await facet.api<Array<{ name: string }>>('listContainers')).some((c) => c.name === fresh)).toBe(false);

    await input.setInputFiles({ name: 'facet.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
    const plan = page.getByTestId('import-plan');
    await expect(plan).toContainText('create 1 container');
    await expect(plan).toContainText(fresh);
    await expect(plan).toContainText('keep 1 container you already have');
    await expect(plan).toContainText('set 2 domain rules');
    await expect(plan).toContainText('add 1 cookie');
    expect((await facet.api<Array<{ name: string }>>('listContainers')).some((c) => c.name === fresh)).toBe(false); // nothing changed yet

    await plan.getByRole('button', { name: 'Import' }).click();
    await expect(page.getByTestId('transfer-status')).toContainText('1 container created');
    const containers = await facet.api<Array<{ id: string; name: string; color: string }>>('listContainers');
    const made = containers.find((c) => c.name === fresh)!;
    expect(made.color).toBe('pink');
    expect(containers.find((c) => c.id === existing.id)!.color).toBe(existingColor); // matched containers are left as they are (their random colour may even be red)
    expect(await facet.api<Rule[]>('listDomainRules')).toEqual([
      { domain: 'github.com', action: 'always', containerId: made.id },
      { domain: 'reddit.com', action: 'ask' },
    ]);
    expect((await facet.api<Array<{ value: string }>>('getJar', made.id)).map((c) => c.value)).toEqual(['imported-session']);

    // The imported login works: a tab in the new container is that session.
    const tab = await facet.openIn(made.name, at('a.localhost', '/whoami'));
    expect(await tab.locator('#cookies').textContent()).toContain('sid=imported-session');
    await page.close();
  });

  test('diagnostics are read-only facts about the engine', async ({ facet }) => {
    const W = await facet.container('Work');
    await facet.openIn(W.name, at('a.localhost', '/whoami'));
    const page = await openOptions(facet);
    await expect(page.getByTestId('diag-session-rules')).not.toHaveText('0');
    await expect(page.getByTestId('diag-managed')).toContainText('a.localhost');
    await expect(page.getByTestId('diag-log')).toContainText('->');
    await page.close();
  });
});

test.describe('state page', () => {
  test('lists containers, their tabs and copy-ready recipes as plain text', async ({ facet }) => {
    const W = await facet.container('Work');
    const tab = await facet.openIn(W.name, at('a.localhost', '/whoami?state=1'));
    const tabId = await facet.tabIdOf(tab);
    const page = await facet.ctx.newPage();
    await page.goto(ext('state.html'));
    await expect(page.getByRole('heading', { name: /Open container tabs/ })).toBeVisible();
    const text = await page.innerText('body');
    expect(text).toContain(`id=${W.id} name="${W.name}"`);
    expect(text).toMatch(new RegExp(`tabId=${tabId} container="${W.name}" \\(${W.id}\\)`));
    expect(text).toContain(at('a.localhost', '/whoami?state=1'));
    expect(text).toContain(`[${W.name}]`); // the title as Chrome sees it, prefix included
    expect(text).toContain('/open.html?container=');
    expect(text).toContain('#ctr=');
    expect(text).toContain('data-ctr');

    // The recipe it prints works as printed.
    const recipe = await page.locator('pre').first().innerText();
    const url = recipe.replace(/container=[^&]*&/, `container=${encodeURIComponent(W.name)}&`).replace(/url=.*$/, `url=${encodeURIComponent(at('b.localhost', '/whoami'))}`);
    const opened = await facet.ctx.newPage();
    await opened.goto(url);
    await expect.poll(() => opened.url()).toBe(at('b.localhost', '/whoami'));
    expect(await facet.api('getTabContainer', await facet.tabIdOf(opened))).toBe(W.id);

    // It follows: the new tab shows up without reloading.
    await expect(page.getByText(new RegExp(`tabId=${tabId}`))).toBeVisible();
    await expect.poll(async () => (await page.innerText('body')).match(new RegExp(`tabId=\\d+ container="${W.name}"`, 'g'))?.length).toBe(2);
    expect(await tab.evaluate(() => document.documentElement.dataset.ctr)).toBe(W.name);
    await page.close();
    await opened.close();
  });
});
