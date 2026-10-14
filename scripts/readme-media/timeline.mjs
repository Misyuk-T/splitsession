// Builds the list of frames of an animation and renders them. Motion (a cursor gliding, a click ring) is drawn at
// FPS frames per second; a state that just stays is ONE frame with a long delay, so key frames cost nothing.
/* eslint-disable import/extensions -- local .mjs modules, run directly by node */
import { SIZE } from "./mock.mjs";

export const FPS = 12;
const STEP = 1000 / FPS;

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export class Timeline {
  constructor() {
    /** @type {{ state: object, ms: number, seg: number }[]} */
    this.items = [];
    this.seg = 0;
  }

  /** A new scene: it gets its own colour palette (see gif.mjs). */
  scene() {
    this.seg += 1;
  }

  /** The state stays on screen for `ms`. */
  hold(state, ms) {
    this.items.push({ state, ms, seg: this.seg });
  }

  /** The cursor glides from `from` to `to` over `ms`; `state` is everything else on screen. */
  glide(state, from, to, ms) {
    const n = Math.max(2, Math.round(ms / STEP));
    for (let i = 1; i <= n; i++) {
      const k = ease(i / n);
      const cursor = {
        x: from.x + (to.x - from.x) * k,
        y: from.y + (to.y - from.y) * k,
      };
      this.hold({ ...state, cursor }, ms / n);
    }
  }

  /** A click at `at`: a ring grows around the cursor. `state` is what is on screen while it does. */
  click(state, at) {
    for (const ring of [7, 14, 21])
      this.hold({ ...state, cursor: { ...at, ring } }, STEP);
  }
}

/** One page that holds the whole stage: it measures cursor targets while a scene is written, then renders the frames. */
export class Stage {
  /** @param {import("@playwright/test").Browser} browser @param {string} html the page from stagePage() */
  static async open(browser, html) {
    const page = await browser.newPage({
      viewport: SIZE,
      deviceScaleFactor: 1,
    });
    await page.setContent(html);
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() =>
      Promise.all(
        [...document.images].map((i) => i.decode().catch(() => undefined)),
      ),
    );
    return new Stage(page);
  }

  constructor(page) {
    this.page = page;
  }

  /** The stage rectangles of the `data-hit` elements for a state (where the cursor should go). */
  async hits(state) {
    await this.page.evaluate((s) => window.apply(s), state);
    return this.page.evaluate(() => window.hits());
  }

  /**
   * Renders every distinct state once (the same state twice in a row only adds time to the frame before).
   * @param {{ state: object, ms: number, seg: number }[]} items
   * @returns {Promise<{ png: Buffer, ms: number, seg: number }[]>}
   */
  async render(items) {
    const frames = [];
    let lastKey = null;
    for (const item of items) {
      const key = `${item.seg}|${JSON.stringify(item.state)}`;
      if (key === lastKey) {
        frames[frames.length - 1].ms += item.ms;
        continue;
      }
      lastKey = key;
      await this.page.evaluate((s) => window.apply(s), item.state);
      frames.push({
        png: await this.page.screenshot({ animations: "disabled" }),
        ms: item.ms,
        seg: item.seg,
      });
    }
    return frames;
  }

  close() {
    return this.page.close();
  }
}
