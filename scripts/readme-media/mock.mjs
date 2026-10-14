// The stage of the README animations: a flat (gradient-free, so a GIF palette holds it) drawn browser window with a
// tab strip, tab groups and a toolbar, a caption band and a mouse cursor. The pictures of the demo site, of the
// extension and of chrome://extensions are REAL captures, placed in this window as image layers.
//
// A scene is a plain object (see `apply` below): which layers show, where they sit, what the tab strip and the address
// bar say, the caption and the cursor. The page is built once; every frame is `apply(state)` plus a screenshot.
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
const ICON_48 = dataUri(
  readFileSync(resolve(root, "public/icons/icon-48.png")),
  "image/png",
);

export const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

/** The canvas and the browser window in it, in CSS pixels. The window's content area is `CONTENT`. */
export const SIZE = { width: 880, height: 600 };
export const WIN = { x: 14, y: 12, w: 852, h: 498 };
const STRIP_H = 36;
const BAR_H = 38;
export const CONTENT = {
  x: WIN.x + 1,
  y: WIN.y + 1 + STRIP_H + BAR_H,
  w: WIN.w - 2,
  h: WIN.h - 2 - STRIP_H - BAR_H,
};

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

/** A group chip's title as Chrome shows it: the invisible marker characters SplitSession appends are dropped. */
// eslint-disable-next-line prefer-regex-literals -- escapes, so no invisible character sits in this source
const INVISIBLE = new RegExp("[​-‏⁠-⁤⠀﻿]", "g");
export const visibleTitle = (title) => title.replace(INVISIBLE, "").trim();

const CSS = `
@font-face{font-family:"Media Inter";font-weight:100 900;src:url(${INTER}) format("woff2")}
*{box-sizing:border-box;margin:0}
html,body{width:${SIZE.width}px;height:${SIZE.height}px;overflow:hidden}
body{position:relative;font-family:"Media Inter",system-ui,sans-serif;color:#14161b;background:#eceefb;-webkit-font-smoothing:antialiased}
.win{position:absolute;left:${WIN.x}px;top:${WIN.y}px;width:${WIN.w}px;height:${WIN.h}px;border-radius:10px;overflow:hidden;background:#fff;border:1px solid #aab0c2}
.strip{height:${STRIP_H}px;background:#d6dae5;display:flex;align-items:flex-end;padding:0 10px 0 72px;gap:2px;position:relative;overflow:hidden}
.lights{position:absolute;left:14px;top:12px;display:flex;gap:8px}
.lights i{width:12px;height:12px;border-radius:50%;background:#aeb4c4}
.grp{display:flex;align-items:flex-end;gap:2px;height:100%;position:relative;margin-left:4px}
.chip{align-self:center;margin:0 4px 0 3px;height:22px;padding:0 9px;border-radius:6px;font-size:13px;font-weight:600;line-height:22px;color:#fff;white-space:nowrap}
.grp .rule{position:absolute;left:0;right:0;bottom:0;height:3px}
.tab{width:176px;height:30px;display:flex;align-items:center;gap:8px;padding:0 10px;border-radius:9px 9px 0 0;font-size:13px;color:#454b59;white-space:nowrap}
.tab span{overflow:hidden;text-overflow:ellipsis;flex:1}
.tab.on{background:#f6f7fa;color:#14161b;font-weight:500}
.split{display:flex;align-items:center;height:30px;margin-left:4px;background:#f6f7fa;border-radius:9px 9px 0 0;padding:0 2px}
.split .tab.on{background:transparent}
.split>i{width:1px;height:16px;background:#aab0c2;flex:none}
.fav{width:15px;height:15px;border-radius:4px;flex:none}
.bar{height:${BAR_H}px;background:#f6f7fa;display:flex;align-items:center;gap:4px;padding:0 10px;border-bottom:1px solid #c9cdd9}
.bar svg{width:20px;height:20px;flex:none;stroke:#454b59;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;margin:0 4px}
.url{flex:1;height:28px;border-radius:14px;background:#e6e9f0;display:flex;align-items:center;padding:0 14px;font-size:14px;color:#14161b;gap:7px;overflow:hidden;white-space:nowrap;border:2px solid #e6e9f0}
.url.focus{background:#fff;border-color:#3f3fd9}
.url svg{width:14px;height:14px;margin:0;stroke:#454b59}
.caret{display:inline-block;width:1px;height:16px;background:#14161b;margin-left:-5px}
.tool{width:30px;height:30px;border-radius:8px;display:grid;place-items:center;flex:none}
.tool img{width:20px;height:20px}
.tool.hot{background:#dfe3ee}
.layer{position:absolute;visibility:hidden}
.layer.on{visibility:visible}
.cap{position:absolute;left:0;right:0;bottom:0;height:${SIZE.height - WIN.y - WIN.h - 4}px;display:flex;align-items:center;justify-content:center;gap:14px;padding:0 24px}
.cap b.n{flex:none;width:34px;height:34px;border-radius:50%;background:#3f3fd9;color:#fff;font-size:18px;line-height:34px;text-align:center;font-weight:700}
.cap span{text-align:center;font-size:26px;line-height:32px;font-weight:650;letter-spacing:-.012em;color:#14161b;white-space:nowrap}
.cap em{font-style:normal;color:#3f3fd9}
.cursor{position:absolute;left:0;top:0;width:24px;height:24px;visibility:hidden;z-index:50}
.ring{position:absolute;border-radius:50%;border:3px solid #3f3fd9;visibility:hidden;z-index:49}
`;

const SVG = {
  lock: `<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`,
  info: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg>`,
  back: `<svg viewBox="0 0 24 24"><path d="M19 12H5m6-6-6 6 6 6"/></svg>`,
  fwd: `<svg viewBox="0 0 24 24"><path d="M5 12h14m-6-6 6 6-6 6"/></svg>`,
  reload: `<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.5-5.8M20 4v5h-5"/></svg>`,
  download: `<svg viewBox="0 0 24 24"><path d="M12 4v11m-5-5 5 5 5-5M5 20h14"/></svg>`,
  puzzle: `<svg viewBox="0 0 24 24"><path d="M10 4a2 2 0 1 1 4 0v2h4v4h-2a2 2 0 1 0 0 4h2v4h-4v-2a2 2 0 1 0-4 0v2H6v-4H4a2 2 0 1 1 0-4h2V6h4z"/></svg>`,
};

/** The arrow cursor; its tip is the element's top-left corner. */
const CURSOR = `<svg class="cursor" id="cursor" viewBox="0 0 24 24"><path d="M3 2v17l4.5-4 3 7 3-1.3-3-6.7H17z" fill="#fff" stroke="#14161b" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

/**
 * The page-side renderer. `apply(state)`:
 *   tabs     strip items: { type: "tab", title, fav, active } | { type: "group", title, color, tabs: [...] }
 *            | { type: "split", tabs: [two tabs] } (Chrome's split view: both halves drawn as one joined, active pair)
 *   url      address-bar text; urlFocus draws the focus ring, caret the text cursor; secure picks lock or info icon
 *   tools    toolbar buttons on the right: any of "download", "puzzle", "ext"; hot = the one drawn pressed
 *   show     ids of the layers (images, drawn pages, popups) that are visible
 *   pos      { layerId: [x, y] } moves a layer (stage coordinates)
 *   text     { elementId: html } sets the text of an element
 *   caption  { n, html } the caption band (n = step number; null: no badge)
 *   cursor   { x, y, ring } the mouse cursor (ring = radius of the click ring, 0 for none)
 * Returns the stage rectangles of every element that has data-hit (cursor targets).
 */
const PAGE_JS = `
const $ = (id) => document.getElementById(id);
const GROUP_HEX = ${JSON.stringify(GROUP_HEX)};
const SVG = ${JSON.stringify(SVG)};
const ICON = ${JSON.stringify(ICON_48)};
const FAV = { mail: "#d9480f", ext: "ext", page: "#8a90a0", gh: "#3a3f4b", folder: "#2f7bf5" };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fav = (f) => f === "ext" ? '<img class="fav" src="' + ICON + '" alt="">' : '<i class="fav" style="background:' + (FAV[f] || "#8a90a0") + '"></i>';
const tabHtml = (t, i) => '<div class="tab' + (t.active ? " on" : "") + '" data-hit="tab-' + (t.id ?? i) + '">' + fav(t.fav) + "<span>" + esc(t.title) + "</span></div>";
const stripHtml = (items) => '<div class="lights"><i></i><i></i><i></i></div>' + items.map((it, i) => {
  if (it.type === "tab") return tabHtml(it, i);
  if (it.type === "split") return '<div class="split">' + tabHtml({ ...it.tabs[0], active: true }, 0) + "<i></i>" + tabHtml({ ...it.tabs[1], active: true }, 1) + "</div>";
  const hex = GROUP_HEX[it.color] || GROUP_HEX.grey;
  return '<div class="grp"><div class="chip" data-hit="chip-' + (it.id ?? i) + '" style="background:' + hex + '">' + esc(it.title) + "</div>" + it.tabs.map(tabHtml).join("") + '<i class="rule" style="background:' + hex + '"></i></div>';
}).join("");
const toolHtml = (name, hot) => '<div class="tool' + (hot === name ? " hot" : "") + '" data-hit="tool-' + name + '">' + (name === "ext" ? '<img src="' + ICON + '" alt="">' : SVG[name]) + "</div>";
window.apply = (s) => {
  $("strip").innerHTML = stripHtml(s.tabs || []);
  const url = $("url");
  url.className = "url" + (s.urlFocus ? " focus" : "");
  url.innerHTML = (s.secure === false ? SVG.info : SVG.lock) + "<span>" + esc(s.url || "") + "</span>" + (s.caret ? '<i class="caret"></i>' : "");
  $("tools").innerHTML = ["download", "ext", "puzzle"].filter((n) => (s.tools || []).includes(n)).map((n) => toolHtml(n, s.hot)).join("");
  const on = new Set(s.show || []);
  for (const el of document.querySelectorAll(".layer")) {
    el.classList.toggle("on", on.has(el.id));
    const p = (s.pos || {})[el.id];
    if (p) { el.style.left = p[0] + "px"; el.style.top = p[1] + "px"; }
  }
  for (const [id, html] of Object.entries(s.text || {})) $(id).innerHTML = html;
  const cap = $("cap");
  cap.style.visibility = s.caption ? "visible" : "hidden";
  if (s.caption) cap.innerHTML = (s.caption.n ? '<b class="n">' + s.caption.n + "</b>" : "") + "<span>" + s.caption.html + "</span>";
  const c = s.cursor, cur = $("cursor"), ring = $("ring");
  cur.style.visibility = c ? "visible" : "hidden";
  ring.style.visibility = c && c.ring ? "visible" : "hidden";
  if (c) {
    cur.style.left = c.x + "px"; cur.style.top = c.y + "px";
    if (c.ring) { ring.style.width = ring.style.height = c.ring * 2 + "px"; ring.style.left = c.x - c.ring + "px"; ring.style.top = c.y - c.ring + "px"; }
  }
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
};
window.hits = () => {
  const out = {};
  for (const el of document.querySelectorAll("[data-hit]")) {
    const r = el.getBoundingClientRect();
    out[el.dataset.hit] = { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  }
  return out;
};
`;

/** An image layer (a real capture, or a drawn picture) at stage position (x, y). */
export const imageLayer = (id, png, x, y, extraStyle = "") =>
  `<img class="layer" id="${id}" src="${dataUri(png, "image/png")}" style="left:${x}px;top:${y}px;${extraStyle}" alt="">`;

/** A layer of drawn HTML at (x, y). */
export const htmlLayer = (id, x, y, style, inner) =>
  `<div class="layer" id="${id}" style="left:${x}px;top:${y}px;${style}">${inner}</div>`;

/**
 * The whole page: the window frame (strip and toolbar filled in by `apply`), the white content area, then `layers`
 * (images and drawn pages, in paint order), the caption band and the cursor.
 */
export function stagePage({ layers, extraCss = "" }) {
  const frame = `<div class="win"><div class="strip" id="strip"></div><div class="bar">${SVG.back}${SVG.fwd}${SVG.reload}<div class="url" id="url" data-hit="url"></div><div id="tools" style="display:flex;gap:2px;margin-left:4px"></div></div></div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}${extraCss}</style></head><body>${frame}${layers}<div class="cap" id="cap"></div><i class="ring" id="ring"></i>${CURSOR}<script>${PAGE_JS}</script></body></html>`;
}

export { dataUri, GROUP_HEX, ICON_48, INTER };
