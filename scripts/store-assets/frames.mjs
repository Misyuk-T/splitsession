// HTML for the Chrome Web Store pictures: a marketing frame (brand background, headline, browser-window mock) around the
// REAL pictures of the extension (popup, settings page) and of the demo site that scripts/store-assets.mjs captured.
// The browser window is drawn here (a plain Chromium window cannot be captured with its tab strip and groups); its tab
// strip is built from the real tab and group data the extension produced.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "../..");
const dataUri = (buf, type) => `data:${type};base64,${buf.toString("base64")}`;
const INTER = dataUri(
  readFileSync(
    require.resolve("@fontsource-variable/inter/files/inter-latin-wght-normal.woff2"),
  ),
  "font/woff2",
);
export const ICON_48 = dataUri(
  readFileSync(resolve(root, "public/icons/icon-48.png")),
  "image/png",
);
const ICON_SVG = readFileSync(resolve(root, "assets/icon.svg"), "utf8");

const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

/** Chrome's tab-group colours. */
const GROUP_HEX = {
  grey: "#80868b",
  blue: "#1a73e8",
  red: "#d93025",
  yellow: "#f9ab00",
  green: "#1e8e3e",
  pink: "#d01884",
  purple: "#9334e6",
  cyan: "#0b8793",
  orange: "#e8710a",
};
/** Favicon colour of each demo site. */
const SITE_HEX = {
  "mail.example": "#d9480f",
  "board.example": "#0a7d6a",
  "invoices.example": "#5b3fd1",
  "notes.example": "#b5530b",
  "loop.example": "#0b7a75",
};

const THEMES = {
  light: `--bg1:#eef0ff;--bg2:#def2ff;--ink:#14161b;--muted:#434a59;--accent:#3f3fd9;
--strip:#d9dde6;--bar:#f7f8fa;--tabtext:#2a2f3a;--tabdim:#4a505e;--pill:#e9ebf0;--line:#c9cdd8;--shadow:0 24px 60px rgba(40,40,120,.22),0 3px 10px rgba(20,20,60,.14);--card:#ffffff`,
  dark: `--bg1:#0b1020;--bg2:#221a63;--ink:#f3f4fc;--muted:#b9bdd6;--accent:#a7a7ff;
--strip:#14161c;--bar:#25282f;--tabtext:#eceef3;--tabdim:#a9aebb;--pill:#14161c;--line:#3a3e49;--shadow:0 24px 60px rgba(0,0,0,.55),0 3px 10px rgba(0,0,0,.4);--card:#1f222a`,
};

const CSS = `
@font-face{font-family:"Frame Inter";font-weight:100 900;src:url(${INTER}) format("woff2")}
*{box-sizing:border-box;margin:0}
html,body{width:100%;height:100%;overflow:hidden}
body{font-family:"Frame Inter",system-ui,sans-serif;color:var(--ink);background:linear-gradient(135deg,var(--bg1),var(--bg2));position:relative}
.cap{position:absolute;left:64px;top:44px}
.cap h1{font-size:56px;line-height:64px;font-weight:750;letter-spacing:-.02em}
.cap h1 em{font-style:normal;color:var(--accent)}
.cap p{margin-top:8px;font-size:22px;line-height:30px;font-weight:450;color:var(--muted)}
.brand{position:absolute;right:64px;top:52px;display:flex;align-items:center;gap:12px;font-size:24px;font-weight:700;letter-spacing:-.01em}
.brand img{width:40px;height:40px}
.win{position:absolute;border-radius:14px;overflow:hidden;background:var(--bar);box-shadow:var(--shadow);border:1px solid var(--line)}
.strip{overflow:hidden;height:44px;background:var(--strip);display:flex;align-items:flex-end;padding:0 12px 0 74px;gap:2px;position:relative}
.lights{position:absolute;left:16px;top:15px;display:flex;gap:8px}
.lights i{width:12px;height:12px;border-radius:50%;background:var(--line)}
.grp{display:flex;align-items:flex-end;gap:2px;height:100%;padding-bottom:0;position:relative}
.chip{align-self:center;margin:0 4px 0 6px;height:24px;padding:0 10px;border-radius:7px;font-size:13px;font-weight:600;line-height:24px;color:#fff;white-space:nowrap}
.grp .rule{position:absolute;left:0;right:0;bottom:0;height:3px;border-radius:2px}
.tab{width:150px;height:36px;display:flex;align-items:center;gap:8px;padding:0 10px;border-radius:10px 10px 0 0;font-size:13px;color:var(--tabdim);white-space:nowrap}
.tab span{overflow:hidden;text-overflow:ellipsis;flex:1}
.tab.on{background:var(--bar);color:var(--tabtext);font-weight:500}
.split{display:flex;align-items:flex-end;height:36px;margin:0 4px;background:var(--bar);border-radius:10px 10px 0 0;padding:0 2px}
.split .tab.on{background:transparent}
.split>i{width:1px;height:18px;margin-bottom:9px;background:var(--line);flex:none}
.fav{width:15px;height:15px;border-radius:4px;flex:none}
.bar{height:44px;background:var(--bar);display:flex;align-items:center;gap:6px;padding:0 12px;border-bottom:1px solid var(--line)}
.bar svg{width:20px;height:20px;flex:none;stroke:var(--tabdim);fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;margin:0 5px}
.url{flex:1;height:30px;border-radius:15px;background:var(--pill);display:flex;align-items:center;padding:0 14px;font-size:14px;color:var(--tabtext);gap:8px;overflow:hidden;white-space:nowrap}
.url svg{width:14px;height:14px;margin:0}
.ext{width:30px;height:30px;border-radius:8px;display:grid;place-items:center;background:var(--pill);margin-left:6px}
.ext img{width:22px;height:22px}
.panes{display:flex;gap:2px;background:var(--line)}
.pane{position:relative;overflow:hidden;background:#fff}
.pane img{display:block}
.pop{position:absolute;border-radius:12px;box-shadow:0 14px 40px rgba(10,10,40,.38),0 2px 6px rgba(10,10,40,.25);border:1px solid var(--line);overflow:hidden;background:var(--card)}
.pop img{display:block;width:100%}
`;

const page = (theme, inner) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>:root{${THEMES[theme]}}${CSS}</style></head><body>${inner}</body></html>`;

const lockSvg = `<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`;
const backSvg = `<svg viewBox="0 0 24 24"><path d="M19 12H5m6-6-6 6 6 6"/></svg>`;
const fwdSvg = `<svg viewBox="0 0 24 24"><path d="M5 12h14m-6-6 6 6-6 6"/></svg>`;
const reloadSvg = `<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.5-5.8M20 4v5h-5"/></svg>`;

/** Headline and sub-line; the last `accent` words of the headline are in the accent colour. */
const caption = (headline, sub, accent = 2) => {
  const words = headline.split(" ");
  const last = words.splice(-accent).join(" ");
  return `<div class="cap"><h1>${esc(words.join(" "))} <em>${esc(last)}</em></h1><p>${esc(sub)}</p></div>
<div class="brand"><img src="${ICON_48}" alt="">SplitSession</div>`;
};

const fav = (host) =>
  host === "settings"
    ? `<img class="fav" src="${ICON_48}" alt="">`
    : `<i class="fav" style="background:${SITE_HEX[host] ?? "#888"}"></i>`;

/** A group chip's title as Chrome shows it: the invisible marker characters SplitSession appends are dropped. */
// eslint-disable-next-line prefer-regex-literals -- escapes, so no invisible character sits in this source
const INVISIBLE = new RegExp("[\u200b-\u200f\u2060-\u2064\u2800\ufeff]", "g");
const visibleTitle = (title) => title.replace(INVISIBLE, "").trim();

/** One tab-strip cell. */
const tabHtml = (t) =>
  `<div class="tab${t.active ? " on" : ""}">${fav(t.host)}<span>${esc(t.title)}</span></div>`;

/** The tab strip: groups (chip + tabs + a rule in the group colour), a split-view pair and ungrouped tabs, in order. */
function stripHtml(items) {
  return `<div class="strip"><div class="lights"><i></i><i></i><i></i></div>${items
    .map((it) => {
      if (it.type === "tab") return tabHtml(it);
      if (it.type === "split")
        return `<div class="split">${tabHtml({ ...it.tabs[0], active: true })}<i></i>${tabHtml({ ...it.tabs[1], active: true })}</div>`;
      const hex = GROUP_HEX[it.color] ?? GROUP_HEX.grey;
      return `<div class="grp"><div class="chip" style="background:${hex};${it.color === "yellow" ? "color:#241c00" : ""}">${esc(visibleTitle(it.title))}</div>${it.tabs.map(tabHtml).join("")}<i class="rule" style="background:${hex}"></i></div>`;
    })
    .join("")}</div>`;
}

const toolbar = (address) =>
  `<div class="bar">${backSvg}${fwdSvg}${reloadSvg}<div class="url">${lockSvg}${esc(address)}</div><div class="ext"><img src="${ICON_48}" alt=""></div></div>`;

/** A browser window mock: `content` is placed in the area below the toolbar (width x height `size`). */
const windowHtml = ({ x, y, w, h, strip, address, content }) =>
  `<div class="win" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px">${stripHtml(strip)}${toolbar(address)}<div style="height:${h - 90}px;position:relative">${content}</div></div>`;

/** Size of a captured PNG as CSS pixels (captured at 2x). */
export const cssSize = (png) => ({
  w: png.readUInt32BE(16) / 2,
  h: png.readUInt32BE(20) / 2,
});
const img = (png) => dataUri(png, "image/png");

/** Size of the content area of the 1200-wide browser window of screenshots 1 and 3 (the window has a 1px border). */
export const PAGE = { w: 1198, h: 522 };

/** Screenshot 1: one window, a personal and a brand account in two tab groups, the popup open on the active tab. */
export function shotGroups({ strip, page: pic, popup }) {
  const p = cssSize(popup);
  const content = `<div class="pane" style="width:${PAGE.w}px;height:100%"><img src="${img(pic)}" width="${PAGE.w}" alt=""></div>
<div class="pop" style="right:8px;top:6px;width:${p.w}px"><img src="${img(popup)}" alt=""></div>`;
  return page(
    "light",
    caption(
      "Personal and brand. One window.",
      "Both signed in at once, in two tab groups of one Chrome profile.",
    ) +
      windowHtml({
        x: 40,
        y: 170,
        w: 1200,
        h: 612,
        strip,
        address: "loop.example",
        content,
      }),
  );
}

/** Screenshot 3: two accounts as the two halves of Chrome's split view (the pair stands outside the groups). */
export function shotSplit({ strip, left, right }) {
  const half = (PAGE.w - 2) / 2;
  const label = (who, hex, x) =>
    `<div style="position:absolute;left:${x + 14}px;bottom:16px;background:${hex};color:#fff;font-size:15px;line-height:20px;font-weight:700;padding:6px 13px;border-radius:8px">&#x29C9; ${esc(who)}</div>`;
  const content = `<div class="panes" style="height:100%">
<div class="pane" style="width:${half}px"><img src="${img(left.png)}" width="${half}" alt=""></div>
<div class="pane" style="width:${half}px"><img src="${img(right.png)}" width="${half}" alt=""></div></div>
${label(left.name, GROUP_HEX[left.color], 0)}${label(right.name, GROUP_HEX[right.color], half + 2)}`;
  return page(
    "light",
    caption(
      "Two accounts, side by side.",
      "Chrome's split view, a different account in each half.",
      3,
    ) +
      windowHtml({
        x: 40,
        y: 170,
        w: 1200,
        h: 612,
        strip,
        address: "loop.example",
        content,
      }),
  );
}

/** Screenshot 2: the popup close-up next to the tab groups it creates. */
export function shotPopup({ popup, groups }) {
  const scale = 1.6;
  const p = cssSize(popup);
  const top = 170 + Math.round((630 - p.h * scale) / 2) - 16;
  const rows = groups
    .map((g) => {
      const hex = GROUP_HEX[g.color] ?? GROUP_HEX.grey;
      return `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:16px 0;border-top:1px solid var(--line)">
<div class="chip" style="background:${hex};margin:0;height:28px;line-height:28px;font-size:15px;${g.color === "yellow" ? "color:#241c00" : ""}">${esc(visibleTitle(g.title))}</div>
${g.tabs.map((t) => `<div style="display:flex;align-items:center;gap:8px;background:var(--pill);border-radius:9px;padding:6px 12px;font-size:15px;color:var(--tabtext)">${fav(t.host)}${esc(t.title.replace(/ – .*/, ""))} <span style="color:var(--tabdim)">${esc(t.host)}</span></div>`).join("")}</div>`;
    })
    .join("");
  const cap = caption(
    "Every tab knows its account.",
    "A coloured group and a name on every tab you open in a container.",
  );
  return page(
    "light",
    `${cap}<div class="pop" style="left:90px;top:${top}px;width:${p.w * scale}px;border-radius:16px"><img src="${img(popup)}" alt=""></div>
<div style="position:absolute;left:${90 + p.w * scale + 56}px;top:${top}px;height:${Math.round(p.h * scale)}px;right:64px;display:flex;align-items:center">
<div style="flex:1;background:var(--card);border-radius:16px;box-shadow:var(--shadow);border:1px solid var(--line);padding:22px 24px 10px">
<div style="font-size:15px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--tabdim);margin-bottom:12px">In your tab strip</div>${rows}</div></div>`,
  );
}

/** Screenshots 3 and 4: the settings page inside a window of its own. */
export function shotSettings({
  theme,
  headline,
  sub,
  strip,
  settings,
  address = "chrome-extension://splitsession/options.html",
}) {
  const w = 880;
  const s = cssSize(settings);
  const h = 90 + s.h;
  const content = `<img src="${img(settings)}" width="${s.w}" style="display:block" alt="">`;
  return page(
    theme,
    caption(headline, sub) +
      windowHtml({
        x: (1280 - w) / 2,
        y: 800 - 16 - h,
        w,
        h,
        strip,
        address,
        content,
      }),
  );
}

const iconSvg = (size) =>
  ICON_SVG.replace(
    / width="128" height="128"/,
    ` width="${size}" height="${size}"`,
  ).replace(/<title>.*?<\/title>/, "");

const TAGLINE = "Same site, separate logins.";

/** Small promo tile, 440x280. */
export function promoTile() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:"Frame Inter";font-weight:100 900;src:url(${INTER}) format("woff2")}
*{box-sizing:border-box;margin:0}html,body{width:440px;height:280px;overflow:hidden}
body{font-family:"Frame Inter",system-ui,sans-serif;color:#fff;background:linear-gradient(135deg,#2a2ab8 0%,#4a3fe0 55%,#7a3fe6 100%);display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:6px}
svg{filter:drop-shadow(0 8px 14px rgba(10,10,60,.35));margin-bottom:8px}
h1{font-size:40px;line-height:46px;font-weight:750;letter-spacing:-.02em}
p{font-size:22px;line-height:28px;font-weight:500;opacity:.92}
</style></head><body>${iconSvg(88)}<h1>SplitSession</h1><p>${TAGLINE}</p></body></html>`;
}

/** Marquee promo tile, 1400x560. */
export function marquee({ work, personal, popup }) {
  const p = cssSize(popup);
  const cardW = 400;
  const card = (png, hex, x, y) =>
    `<div style="position:absolute;left:${x}px;top:${y}px;width:${cardW}px;border-radius:14px;overflow:hidden;box-shadow:0 18px 44px rgba(10,10,60,.4);background:#fff"><div style="height:7px;background:${hex}"></div><img src="${img(png)}" width="${cardW}" style="display:block" alt=""></div>`;
  const popW = 328; // whole pixels: no sub-pixel resampling, so every run draws the same
  const popH = Math.round((p.h * popW) / p.w);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:"Frame Inter";font-weight:100 900;src:url(${INTER}) format("woff2")}
*{box-sizing:border-box;margin:0}html,body{width:1400px;height:560px;overflow:hidden}
body{font-family:"Frame Inter",system-ui,sans-serif;color:#fff;background:linear-gradient(120deg,#2a2ab8 0%,#4a3fe0 50%,#7a3fe6 100%);position:relative}
.t{position:absolute;left:96px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center;gap:14px}
.t svg{filter:drop-shadow(0 10px 18px rgba(10,10,60,.35))}
h1{font-size:76px;line-height:82px;font-weight:750;letter-spacing:-.025em}
.pop{position:absolute;border-radius:12px;overflow:hidden;background:#fff;box-shadow:0 18px 44px rgba(10,10,60,.4)}.pop img{display:block;width:100%}
p{font-size:38px;line-height:46px;font-weight:500;opacity:.94}
</style></head><body><div class="t">${iconSvg(116)}<h1>SplitSession</h1><p>${TAGLINE}</p></div>
${card(work, GROUP_HEX.blue, 700, 56)}${card(personal, GROUP_HEX.green, 920, 150)}
<div class="pop" style="left:${1400 - 56 - popW}px;top:${560 - 40 - popH}px;width:${popW}px;height:${popH}px;border:0"><img src="${img(popup)}" width="${popW}" height="${popH}" alt=""></div>
</body></html>`;
}

/** Screenshot 5: after a restart. The window comes back with its groups; a tab SplitSession is unsure about waits. */
export function shotRestart({ strip, held, popup }) {
  const w = 1240;
  const p = cssSize(popup);
  const content = `<div class="pane" style="width:${w}px;height:100%"><img src="${img(held)}" width="${w}" style="margin-left:-220px" alt=""></div>
<div class="pop" style="right:4px;top:6px;width:${p.w}px"><img src="${img(popup)}" alt=""></div>`;
  return page(
    "light",
    caption(
      "Comes back after a restart.",
      "Tabs return to their accounts. A tab it is unsure about waits for you.",
    ) +
      windowHtml({
        x: 20,
        y: 170,
        w,
        h: 612,
        strip,
        address: "chrome-extension://splitsession/held.html",
        content,
      }),
  );
}
