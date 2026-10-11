import type { Page } from '@playwright/test';
import { at, expect, ext, test } from './fixtures';

interface Info {
  id: string;
  name: string;
  color: string;
  tabCount: number;
}

async function openPopup(facet: { ctx: import('@playwright/test').BrowserContext }, forTab?: number): Promise<Page> {
  const page = await facet.ctx.newPage();
  await page.setViewportSize({ width: 380, height: 700 });
  await page.goto(ext(`popup.html${forTab === undefined ? '' : `?tab=${forTab}`}`));
  await expect(page.getByRole('heading', { name: 'Containers' })).toBeVisible();
  return page;
}

const create = async (page: Page, name: string, color?: string) => {
  await page.getByRole('button', { name: 'New container' }).click();
  await page.getByLabel('Name').fill(name);
  if (color) await page.getByRole('radio', { name: color }).click();
  await page.getByRole('button', { name: 'Create' }).click();
};

test.describe('popup', () => {
  test('creating a container validates while typing and rejects empty, long and duplicate names', async ({ facet }) => {
    const existing = await facet.container('Taken');
    const popup = await openPopup(facet);
    await popup.getByRole('button', { name: 'New container' }).click();
    const name = popup.getByLabel('Name');
    const submit = popup.getByRole('button', { name: 'Create' });
    await expect(submit).toBeDisabled();

    await name.fill('x'.repeat(60)); // typing cannot go past the limit
    await expect(name).toHaveValue('x'.repeat(32));
    await expect(popup.getByText('32/32')).toBeVisible();

    await name.fill(existing.name.toUpperCase()); // a duplicate is reported as the user types, ignoring case
    await expect(popup.getByText(/already exists/)).toBeVisible();
    await expect(submit).toBeDisabled();

    await name.fill('   ');
    await expect(submit).toBeDisabled();
    await name.fill('');
    await name.blur();
    await expect(popup.getByText('Give the container a name.')).toBeVisible();

    await name.fill('Bad\u0007Name​');
    await expect(name).toHaveValue('BadName'); // control and zero-width characters never enter the box
    await expect(submit).toBeEnabled();
    await expect(popup.getByText(/already exists|Give the container/)).toHaveCount(0);

    // Escape closes the form without creating anything.
    await name.press('Escape');
    await expect(popup.getByLabel('Name')).toHaveCount(0);
    expect((await facet.api<Info[]>('listContainers')).some((c) => c.name === 'BadName')).toBe(false);
    await popup.close();
  });

  test('creates a container with the chosen colour, by mouse and by keyboard', async ({ facet }) => {
    const popup = await openPopup(facet);
    const fresh = `Mouse-${Date.now().toString(36)}`;
    await create(popup, fresh, 'Orange');
    await expect(popup.getByTestId('container-row').filter({ hasText: fresh })).toBeVisible();
    expect((await facet.api<Info[]>('listContainers')).find((c) => c.name === fresh)?.color).toBe('orange');

    const byKey = `Keys-${Date.now().toString(36)}`;
    await popup.getByRole('button', { name: 'New container' }).click();
    await popup.getByLabel('Name').fill(byKey);
    const selected = popup.getByRole('radio', { checked: true });
    await selected.focus();
    const before = await selected.getAttribute('aria-label');
    await popup.keyboard.press('ArrowRight');
    const after = await popup.getByRole('radio', { checked: true }).getAttribute('aria-label');
    expect(after).not.toBe(before);
    await popup.keyboard.press('End');
    await expect(popup.getByRole('radio', { name: 'Purple', checked: true })).toBeFocused();
    await popup.getByLabel('Name').press('Enter'); // Enter in the name field submits
    await expect(popup.getByTestId('container-row').filter({ hasText: byKey })).toBeVisible();
    expect((await facet.api<Info[]>('listContainers')).find((c) => c.name === byKey)?.color).toBe('purple');
    await popup.close();
  });

  test('"Reopen this tab in…" puts the tab into a container (and back out) and reloads it', async ({ facet }) => {
    const W = await facet.container('Work');
    const login = await facet.openIn(W.name, at('a.localhost', '/login?user=popup-user'));
    await expect(login.locator('#user')).toHaveText('popup-user');

    const plain = await facet.plain(at('a.localhost', '/whoami'));
    await expect(plain.locator('#user')).toHaveText('anonymous');
    const tabId = await facet.tabIdOf(plain);
    const popup = await openPopup(facet, tabId);
    await expect(popup.getByTestId('current-container')).toContainText('No container');

    await popup.getByRole('button', { name: /Reopen in/ }).click();
    await expect(popup.getByRole('menu', { name: 'Reopen this tab in' })).toBeVisible();
    await popup.getByRole('menuitemradio', { name: W.name }).click();
    await expect(popup.getByTestId('current-container')).toContainText(W.name);
    await expect(plain.locator('#user')).toHaveText('popup-user'); // reloaded with the container's cookies
    expect(await facet.api('getTabContainer', tabId)).toBe(W.id);

    // Same menu, by keyboard: ArrowDown opens on the first item, End goes to "No container", Enter chooses.
    const trigger = popup.getByRole('button', { name: /Reopen in/ });
    await trigger.focus();
    await popup.keyboard.press('ArrowDown');
    await expect(popup.getByRole('menuitemradio').first()).toBeFocused();
    await popup.keyboard.press('End');
    await expect(popup.getByRole('menuitemradio', { name: 'No container' })).toBeFocused();
    await popup.keyboard.press('Enter');
    await expect(popup.getByTestId('current-container')).toContainText('No container');
    await expect(plain.locator('#user')).toHaveText('anonymous');
    expect(await facet.api('getTabContainer', tabId)).toBeNull();
    await expect(trigger).toBeFocused(); // focus returns to where it came from

    // Escape closes the menu and keeps focus on the button.
    await trigger.press('ArrowDown');
    await popup.keyboard.press('Escape');
    await expect(popup.getByRole('menu')).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await popup.close();
  });

  test('a page that is not a website cannot be put in a container', async ({ facet }) => {
    const blank = await facet.ctx.newPage();
    await blank.goto('about:blank');
    const popup = await openPopup(facet, await facet.tabIdOf(blank));
    await expect(popup.getByRole('button', { name: /Reopen in/ })).toBeDisabled();
    await expect(popup.getByRole('button', { name: /Reopen in/ })).toHaveAttribute('title', /Only web pages/);
    await popup.close();
    await blank.close();
  });

  test('"New tab" opens a blank tab that is already in the container', async ({ facet }) => {
    const W = await facet.container('Work');
    const popup = await openPopup(facet);
    const row = popup.getByTestId('container-row').filter({ hasText: W.name });
    await expect(row.getByTestId('container-tabs')).toHaveCount(0); // no tabs: no number
    const opened = facet.ctx.waitForEvent('page');
    await row.getByRole('button', { name: `New tab in ${W.name}` }).click();
    const tab = await opened;
    await expect.poll(async () => (await facet.api<Array<{ containerId: string }>>('listTabs')).filter((t) => t.containerId === W.id).length).toBe(1);
    await expect.poll(() => popup.isClosed()).toBe(true); // a popup closes itself once its job is done
    const again = await openPopup(facet);
    await expect(again.getByTestId('container-row').filter({ hasText: W.name }).getByTestId('container-tabs')).toHaveText('1');
    await again.close();
    // Typing an address into that tab keeps it isolated: here via navigation as the omnibox would do it.
    await tab.goto(at('a.localhost', '/login?user=blank-tab')); // 302 to /whoami
    await expect(tab.locator('#user')).toHaveText('blank-tab');
    expect(await facet.realCookies(at('a.localhost'))).toEqual([]);
    await tab.close();
  });

  test('create a container in the popup, then open a tab in it from the same row', async ({ facet }) => {
    const popup = await openPopup(facet);
    const fresh = `Flow-${Date.now().toString(36)}`;
    await create(popup, fresh, 'Pink');
    const row = popup.getByTestId('container-row').filter({ hasText: fresh });
    await expect(row.getByTestId('container-tabs')).toHaveCount(0);
    const opened = facet.ctx.waitForEvent('page');
    await row.getByRole('button', { name: `New tab in ${fresh}` }).click();
    const tab = await opened;
    const made = (await facet.api<Info[]>('listContainers')).find((c) => c.name === fresh)!;
    expect(made.color).toBe('pink');
    await expect.poll(async () => (await facet.api<Array<{ containerId: string }>>('listTabs')).filter((t) => t.containerId === made.id).length).toBe(1);
    await tab.close();
  });

  test('rename, recolour and delete (with a custom confirmation that closes the tabs)', async ({ facet }) => {
    const W = await facet.container('Work');
    const page = await facet.openIn(W.name, at('a.localhost', '/whoami'));
    const popup = await openPopup(facet);
    const row = popup.getByTestId('container-row').filter({ hasText: W.name });

    // Edit through the row's menu, with the keyboard only.
    const actions = row.getByRole('button', { name: `Actions for ${W.name}` });
    await actions.focus();
    await popup.keyboard.press('Enter');
    await expect(popup.getByRole('menuitem', { name: /Rename or recolour/ })).toBeFocused();
    await popup.keyboard.press('Enter');
    const field = popup.getByLabel('Name');
    await expect(field).toHaveValue(W.name);
    await expect(popup.getByRole('button', { name: 'Save' })).toBeEnabled(); // its own name is not a duplicate
    const renamed = `${W.name}-new`;
    await field.fill(renamed);
    await popup.getByRole('radio', { name: 'Pink' }).click();
    await popup.getByRole('button', { name: 'Save' }).click();
    const edited = popup.getByTestId('container-row').filter({ hasText: renamed });
    await expect(edited).toBeVisible();
    expect((await facet.api<Info[]>('listContainers')).find((c) => c.id === W.id)).toMatchObject({ name: renamed, color: 'pink' });
    await expect.poll(() => page.evaluate(() => document.title)).toContain(`[${renamed}]`);

    // Delete: Escape and Cancel keep it, the dialog is a real modal with focus management.
    await edited.getByRole('button', { name: `Actions for ${renamed}` }).click();
    await popup.getByRole('menuitem', { name: /Delete/ }).click();
    const dialog = popup.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('1 tab'.replace('1 tab', 'Its open tab'));
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused(); // the safe answer first
    await popup.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Delete container' })).toBeFocused();
    await popup.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused(); // focus stays inside
    await popup.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect((await facet.api<Info[]>('listContainers')).some((c) => c.id === W.id)).toBe(true);

    await edited.getByRole('button', { name: `Actions for ${renamed}` }).click();
    await popup.getByRole('menuitem', { name: /Delete/ }).click();
    await popup.getByRole('alertdialog').getByRole('button', { name: 'Delete container' }).click();
    await expect(popup.getByTestId('container-row').filter({ hasText: renamed })).toHaveCount(0);
    expect((await facet.api<Info[]>('listContainers')).some((c) => c.id === W.id)).toBe(false);
    await expect.poll(() => page.isClosed()).toBe(true);
    await popup.close();
  });

  test('no native controls, no dialogs, text of at least 14px, and both colour schemes', async ({ facet }) => {
    const W = await facet.container('Work');
    const tab = await facet.openIn(W.name, at('a.localhost', '/whoami'));
    const tabId = await facet.tabIdOf(tab);
    const pages: Array<[string, string]> = [
      ['popup', ext(`popup.html?tab=${tabId}`)],
      ['options', ext('options.html')],
      ['choose', ext(`choose.html?url=${encodeURIComponent(at('a.localhost', '/whoami'))}&tab=${tabId}`)],
      ['state', ext('state.html')],
    ];
    for (const scheme of ['light', 'dark'] as const) {
      for (const [name, url] of pages) {
        const page = await facet.ctx.newPage();
        const dialogs: string[] = [];
        page.on('dialog', async (d) => {
          dialogs.push(d.message());
          await d.dismiss();
        });
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto(url);
        await page.waitForTimeout(400);
        const audit = await page.evaluate(() => {
          const banned = document.querySelectorAll('select, dialog, datalist, input[type=date], input[type=time], input[type=datetime-local], input[type=month], input[type=week], input[type=color], input[type=range], input[type=number], input[type=email], input[type=url], input[type=tel]');
          const forms = [...document.querySelectorAll('form')].filter((f) => !f.noValidate).length;
          const tooSmall: string[] = [];
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (!n.textContent?.trim()) continue;
            const el = n.parentElement!;
            const style = getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || el.closest('.fx-sr-only')) continue;
            if (parseFloat(style.fontSize) < 14) tooSmall.push(`${el.tagName}.${el.className}:${style.fontSize}:${n.textContent.trim().slice(0, 30)}`);
          }
          return { banned: banned.length, forms, tooSmall, background: getComputedStyle(document.body).backgroundColor };
        });
        expect(audit.banned, `${name}: native controls`).toBe(0);
        expect(audit.forms, `${name}: forms without novalidate`).toBe(0);
        expect(audit.tooSmall, `${name}: text under 14px`).toEqual([]);
        expect(dialogs, `${name}: alert/confirm/prompt`).toEqual([]);
        const [r, g, b] = audit.background.match(/\d+/g)!.map(Number) as [number, number, number];
        const light = (r + g + b) / 3 > 128;
        expect(light, `${name} in ${scheme} mode`).toBe(scheme === 'light');
        await page.close();
      }
    }
  });
});
