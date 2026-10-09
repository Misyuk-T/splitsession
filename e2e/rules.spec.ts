import { at, expect, ext, go, test } from './fixtures';

interface Rule {
  domain: string;
  action: 'always' | 'ask';
  containerId?: string;
}

test.describe('domain rules', () => {
  test('"always": a plain tab that goes to the site moves into the container, and the navigation is repeated there', async ({ facet }) => {
    const W = await facet.container('Work');
    const login = await facet.openIn(W.name, at('a.localhost', '/login?user=ruled'));
    await expect(login.locator('#user')).toHaveText('ruled');
    await facet.api('setDomainRule', { domain: 'http://sub.a.localhost/anything', action: 'always', containerId: W.id });
    expect(await facet.api<Rule[]>('listDomainRules')).toEqual([{ domain: 'a.localhost', action: 'always', containerId: W.id }]);

    const page = await facet.plain(at('b.localhost', '/whoami'));
    expect(await facet.api('getTabContainer', await facet.tabIdOf(page))).toBeNull();
    await go(page, at('a.localhost', '/whoami?via=rule'));
    await expect(page.locator('#user')).toHaveText('ruled'); // the container's login: the final request carried the container's cookie
    expect(await facet.api('getTabContainer', await facet.tabIdOf(page))).toBe(W.id);
    expect(await facet.realCookies(at('a.localhost'))).toEqual([]);

    // The tab is in the right container now: navigating on inside the site does not loop.
    await go(page, at('a.localhost', '/whoami?second=1'));
    await expect(page.locator('#user')).toHaveText('ruled');
    expect(await facet.api('getTabContainer', await facet.tabIdOf(page))).toBe(W.id);
    const rulesLog = (await facet.api<Array<{ message: string }>>('getLog')).filter((e) => e.message.startsWith('domain rule:'));
    expect(rulesLog).toHaveLength(1);
  });

  test('a tab in another container is moved too, but a deliberate placement is respected', async ({ facet }) => {
    const W = await facet.container('Work');
    const P = await facet.container('Personal');
    await facet.api('setDomainRule', { domain: 'a.localhost', action: 'always', containerId: W.id });

    // open.html is a deliberate placement: the tab stays in P although the site has a rule.
    const stays = await facet.openIn(P.name, at('a.localhost', '/whoami?placed=1'));
    await expect(stays.locator('#user')).toHaveText('anonymous');
    expect(await facet.api('getTabContainer', await facet.tabIdOf(stays))).toBe(P.id);
    await go(stays, at('a.localhost', '/whoami?placed=2')); // same site: still exempt
    expect(await facet.api('getTabContainer', await facet.tabIdOf(stays))).toBe(P.id);

    // A navigation to ANOTHER site's rule... the exemption covers sites, not the tab. Take b.localhost into P and go to a.localhost.
    const roaming = await facet.openIn(P.name, at('b.localhost', '/whoami'));
    expect(await facet.api('getTabContainer', await facet.tabIdOf(roaming))).toBe(P.id);
    await go(roaming, at('a.localhost', '/whoami?roam=1'));
    await expect.poll(async () => facet.api('getTabContainer', await facet.tabIdOf(roaming))).toBe(W.id);
  });

  test('an explicit #ctr marker wins over a rule for the site', async ({ facet }) => {
    const W = await facet.container('Work');
    const P = await facet.container('Personal');
    await facet.api('setDomainRule', { domain: 'a.localhost', action: 'always', containerId: W.id });
    const page = await facet.plain(at('b.localhost', '/whoami'));
    await go(page, `${at('a.localhost', '/whoami')}#ctr=${encodeURIComponent(P.name)}`);
    await expect.poll(async () => facet.api('getTabContainer', await facet.tabIdOf(page))).toBe(P.id);
    await expect.poll(() => page.url()).toBe(at('a.localhost', '/whoami'));
    await new Promise((r) => setTimeout(r, 500));
    expect(await facet.api('getTabContainer', await facet.tabIdOf(page))).toBe(P.id); // not sent on to Work
  });

  test('an OAuth-style popup opened from a container page is not hijacked by a rule for the site it opens', async ({ facet }) => {
    const A = await facet.container('A');
    const W = await facet.container('Work');
    await facet.api('setDomainRule', { domain: 'sso.localhost', action: 'always', containerId: W.id });
    const pa = await facet.openIn(A.name, at('sso.localhost', '/sso/login?user=sso-alice'));
    await expect(pa.locator('#user')).toHaveText('sso-alice');
    await go(pa, at('a.localhost', '/popup-login'));
    const popupEvent = facet.ctx.waitForEvent('page');
    await pa.click('#go');
    const popup = await popupEvent;
    await expect(popup.locator('#user')).toHaveText('sso-alice');
    expect(await facet.api('getTabContainer', await facet.tabIdOf(popup))).toBe(A.id);
  });

  test('a tab opened by a container page that the shim did not intercept keeps its parent container, whatever the rules say', async ({ facet }) => {
    const A = await facet.container('A');
    const W = await facet.container('Work');
    const parent = await facet.openIn(A.name, at('a.localhost', '/login?user=former&next=/form'));
    await expect(parent.locator('#submit')).toBeVisible();
    await facet.api('setDomainRule', { domain: 'a.localhost', action: 'always', containerId: W.id });
    const opened = facet.ctx.waitForEvent('page');
    await parent.click('#submit'); // <form target=_blank>: Facet's own fallback inheritance races the rule engine
    const child = await opened;
    await expect(child.locator('#user')).toHaveText('former');
    expect(await facet.api('getTabContainer', await facet.tabIdOf(child))).toBe(A.id);
    expect(await facet.api('getTabContainer', await facet.tabIdOf(parent))).toBe(A.id);
  });

  test('"ask": the choose page opens; choosing and remembering turns it into an "always" rule', async ({ facet }) => {
    const W = await facet.container('Work');
    const login = await facet.openIn(W.name, at('a.localhost', '/login?user=asked'));
    await expect(login.locator('#user')).toHaveText('asked');
    await facet.api('setDomainRule', { domain: 'a.localhost', action: 'ask' });

    const page = await facet.plain(at('b.localhost', '/whoami'));
    const target = at('a.localhost', '/whoami?ask=1');
    await go(page, target);
    await expect.poll(() => page.url()).toContain(ext('choose.html'));
    await expect(page.getByTestId('choose-url')).toHaveText(target);
    expect(await facet.api('getTabContainer', await facet.tabIdOf(page))).toBeNull();

    await page.getByRole('switch', { name: /Remember my choice/ }).click();
    await page.getByTestId('choose-container').filter({ hasText: W.name }).click();
    await expect.poll(() => page.url()).toBe(target);
    await expect(page.locator('#user')).toHaveText('asked');
    expect(await facet.api('getTabContainer', await facet.tabIdOf(page))).toBe(W.id);
    expect(await facet.api<Rule[]>('listDomainRules')).toEqual([{ domain: 'a.localhost', action: 'always', containerId: W.id }]);

    // Remembered: the next plain tab goes straight into Work, no question.
    const next = await facet.plain(at('b.localhost', '/whoami'));
    await go(next, at('a.localhost', '/whoami?ask=2'));
    await expect(next.locator('#user')).toHaveText('asked');
    expect(next.url()).not.toContain('choose.html');
    expect(await facet.api('getTabContainer', await facet.tabIdOf(next))).toBe(W.id);
  });

  test('"ask" without remembering asks again; "open without a container" proceeds plain, and remembering that stops the questions', async ({ facet }) => {
    await facet.api('setDomainRule', { domain: 'a.localhost', action: 'ask' });
    const page = await facet.plain(at('b.localhost', '/whoami'));
    await go(page, at('a.localhost', '/whoami?q=1'));
    await expect.poll(() => page.url()).toContain('choose.html');
    await page.getByTestId('choose-none').click();
    await expect.poll(() => page.url()).toBe(at('a.localhost', '/whoami?q=1'));
    expect(await facet.api('getTabContainer', await facet.tabIdOf(page))).toBeNull();
    // The rule is still "ask": a navigation to another page of the site asks again.
    await go(page, at('b.localhost', '/whoami'));
    await go(page, at('a.localhost', '/whoami?q=2'));
    await expect.poll(() => page.url()).toContain('choose.html');

    await page.getByRole('switch', { name: /Remember my choice/ }).click();
    await page.getByTestId('choose-none').click();
    await expect.poll(() => page.url()).toBe(at('a.localhost', '/whoami?q=2'));
    expect(await facet.api<Rule[]>('listDomainRules')).toEqual([]);
    await go(page, at('b.localhost', '/whoami'));
    await go(page, at('a.localhost', '/whoami?q=3'));
    expect(page.url()).toBe(at('a.localhost', '/whoami?q=3'));
  });

  test('the choose page has no address to work with: it says so instead of failing', async ({ facet }) => {
    const page = await facet.ctx.newPage();
    await page.goto(ext('choose.html'));
    await expect(page.getByRole('status')).toContainText('nothing to choose');
    await page.goto(ext(`choose.html?url=${encodeURIComponent('javascript:alert(1)')}`));
    await expect(page.getByRole('status')).toContainText('nothing to choose');
    await page.close();
  });

  test('deleting a container removes its always-rules; invalid rules are refused', async ({ facet }) => {
    const W = await facet.container('Work');
    await facet.api('setDomainRule', { domain: 'github.com', action: 'always', containerId: W.id });
    await facet.api('setDomainRule', { domain: 'reddit.com', action: 'ask' });
    await expect(facet.api('setDomainRule', { domain: 'com', action: 'ask' })).rejects.toThrow(/public suffix/);
    await expect(facet.api('setDomainRule', { domain: 'x.com', action: 'always', containerId: 'ghost' })).rejects.toThrow(/does not exist/);
    await facet.api('deleteContainer', W.id);
    await expect.poll(() => facet.api<Rule[]>('listDomainRules')).toEqual([{ domain: 'reddit.com', action: 'ask' }]);
    expect(await facet.api('removeDomainRule', 'https://www.reddit.com/r/x')).toBe(true);
    expect(await facet.api('removeDomainRule', 'reddit.com')).toBe(false);
  });
});
