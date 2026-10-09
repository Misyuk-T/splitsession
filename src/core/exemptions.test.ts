import { describe, expect, it } from 'vitest';
import { Exemptions } from './exemptions';

describe('Exemptions', () => {
  it('a placement exempts the next navigation, and then that navigation\'s site', () => {
    const ex = new Exemptions();
    ex.markNext(1, 'work');
    expect(ex.check(1, 'work', 'github.com')).toBe(true); // spends the mark
    expect(ex.check(1, 'work', 'github.com')).toBe(true); // the site stays exempt while the tab stays on it
    expect(ex.check(1, 'work', 'reddit.com')).toBe(false); // another site is subject to rules again
  });

  it('visiting another site ends the exemption: coming back is a new visit', () => {
    const ex = new Exemptions();
    ex.markNext(1, null);
    expect(ex.check(1, null, 'a.com')).toBe(true);
    expect(ex.check(1, null, 'b.com')).toBe(false);
    expect(ex.has(1)).toBe(false);
    expect(ex.check(1, null, 'a.com')).toBe(false);
  });

  it('tabs without a placement are never exempt', () => {
    const ex = new Exemptions();
    expect(ex.check(7, null, 'github.com')).toBe(false);
    expect(ex.has(7)).toBe(false);
  });

  it('the exemption dies when the tab changes container, and does not come back', () => {
    const ex = new Exemptions();
    ex.markNext(1, 'work');
    ex.check(1, 'work', 'github.com');
    expect(ex.check(1, 'home', 'github.com')).toBe(false);
    expect(ex.has(1)).toBe(false);
    expect(ex.check(1, 'work', 'github.com')).toBe(false);
  });

  it('a plain placement (taken out of a container) is exempt too', () => {
    const ex = new Exemptions();
    ex.markNext(2, null);
    expect(ex.check(2, null, 'reddit.com')).toBe(true);
  });

  it('markSite names the site of the placement and spends the pending mark', () => {
    const ex = new Exemptions();
    ex.markNext(3, 'work'); // what the assignment itself does
    ex.markSite(3, 'work', 'github.com'); // what a rule move / the choose page adds
    expect(ex.check(3, 'work', 'github.com')).toBe(true);
    expect(ex.check(3, 'work', 'reddit.com')).toBe(false); // the mark was spent: a later navigation is judged
  });

  it('markSite for another container starts a fresh entry', () => {
    const ex = new Exemptions();
    ex.markSite(4, 'work', 'a.com');
    ex.markSite(4, 'home', 'b.com');
    expect(ex.check(4, 'home', 'a.com')).toBe(false);
    ex.markSite(4, 'home', 'b.com');
    expect(ex.check(4, 'home', 'b.com')).toBe(true);
  });

  it('re-placing into the same container keeps the known site and adds a pending mark', () => {
    const ex = new Exemptions();
    ex.markSite(1, 'work', 'a.com');
    ex.markNext(1, 'work');
    expect(ex.check(1, 'work', 'b.com')).toBe(true); // via the pending mark
    expect(ex.check(1, 'work', 'a.com')).toBe(false); // a.com is no longer the placement's site
  });

  it('placing into another container forgets the old site', () => {
    const ex = new Exemptions();
    ex.markSite(1, 'work', 'a.com');
    ex.markNext(1, 'home');
    expect(ex.check(1, 'home', 'z.com')).toBe(true);
    expect(ex.check(1, 'home', 'a.com')).toBe(false);
  });

  it('moves entries to a replacement tab and forgets removed tabs', () => {
    const ex = new Exemptions();
    ex.markNext(8, 'work');
    ex.move(8, 9);
    expect(ex.has(8)).toBe(false);
    expect(ex.check(9, 'work', 'a.com')).toBe(true);
    expect(ex.forget(9)).toBe(true);
    expect(ex.forget(9)).toBe(false);
  });

  it('round-trips through JSON and ignores malformed stored data', () => {
    const ex = new Exemptions();
    ex.markNext(1, 'work');
    ex.markNext(2, null);
    ex.check(2, null, 'a.com');
    const copy = new Exemptions(JSON.parse(JSON.stringify(ex.toJSON())));
    expect(copy.check(1, 'work', 'x.com')).toBe(true);
    expect(copy.check(2, null, 'a.com')).toBe(true);
    const junk = new Exemptions({
      '1': { container: 5 as never, site: null, next: true },
      abc: { container: null, site: null, next: true },
      '3': { container: null, site: 'ok', next: false },
      '4': { container: null, site: 7 as never, next: false },
    });
    expect(junk.has(1)).toBe(false);
    expect(junk.has(3)).toBe(true);
    expect(junk.has(4)).toBe(false);
  });
});
