// HTML of docs/media/agent-bridge.png (1600x900): a terminal panel with an agent session on the left, and on the right a
// drawn browser window around the REAL picture of the demo page with the REAL agent activity (glow, pill) that
// scripts/agent-media/capture.mjs took. The marketing frame (light theme, window chrome, fonts) is the one of the Chrome
// Web Store pictures (scripts/store-assets/frames.mjs).
/* eslint-disable import/extensions -- local .mjs modules, run directly by node */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import {
  esc,
  ICON_48,
  INTER,
  page,
  THEMES,
  windowHtml,
} from "../store-assets/frames.mjs";

const require = createRequire(import.meta.url);
const MONO = `data:font/woff2;base64,${readFileSync(
  require.resolve("@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2"),
).toString("base64")}`;

export const SIZE = { width: 1600, height: 900 };
const AGENT = "#8b5cf6"; // the agent's purple (src/core/indicators.ts)
const BAND = 100; // the caption strip at the bottom
const WIN = { x: 680, w: 872, h: 640 }; // the page area is (w - 2) x (h - 90)

const CSS = `
@font-face{font-family:"Term Mono";font-weight:100 800;src:url(${MONO}) format("woff2")}
.term{position:absolute;left:48px;width:600px;border-radius:14px;overflow:hidden;background:#10131a;color:#e4e7f0;border:1px solid #2a2f3d;box-shadow:0 24px 60px rgba(40,40,120,.28),0 3px 10px rgba(20,20,60,.18);display:flex;flex-direction:column;font-family:"Term Mono",ui-monospace,monospace}
.term .tb{height:44px;flex:none;background:#181c26;border-bottom:1px solid #2a2f3d;display:flex;align-items:center;padding:0 16px;gap:8px}
.term .tb i{width:12px;height:12px;border-radius:50%;background:#3a3f50}
.term .tb span{margin-left:12px;font-size:14px;color:#8d93a8;letter-spacing:.01em}
.term .body{flex:1;padding:22px 26px 0;font-size:19px;line-height:30px;font-weight:450}
.term .row{display:flex;gap:11px;align-items:flex-start}
.term .row>.g{flex:none;width:12px;display:flex;justify-content:center;height:30px;align-items:center}
.term .dot{width:9px;height:9px;border-radius:50%;background:${AGENT};box-shadow:0 0 10px ${AGENT}}
.term .tool{color:#c4b5fd;font-weight:600}
.term .arg{color:#e4e7f0}
.term .out{color:#9aa1b5;padding-left:23px;margin:0 0 9px}
.term .out .elb{display:inline-block;width:9px;height:11px;border-left:2px solid #4b5166;border-bottom:2px solid #4b5166;border-bottom-left-radius:3px;margin:0 9px 0 0;vertical-align:5px}
.term .out>div{padding-left:20px;text-indent:-20px}
.term .ask{color:#f2f4fb;font-weight:550;margin-bottom:14px}
.term .ask .g{color:#8d93a8;font-weight:700}
.term .ask .gt{flex:none;width:12px;color:#8d93a8;font-weight:700}
.term .done{margin-top:6px;color:#f2f4fb;font-weight:550}
.term .done svg{width:15px;height:15px;stroke:#4ade80;stroke-width:3;fill:none;stroke-linecap:round;stroke-linejoin:round}
.term .cur{display:inline-block;width:10px;height:21px;background:#e4e7f0;vertical-align:-3px;opacity:.85}
.band{position:absolute;left:0;right:0;bottom:0;height:${BAND}px;display:flex;align-items:center;justify-content:space-between;padding:0 64px 0 56px;background:rgba(255,255,255,.62);border-top:1px solid var(--line)}
.band h1{font-size:44px;line-height:52px;font-weight:750;letter-spacing:-.02em;white-space:nowrap}
.band h1 em{font-style:normal;color:var(--accent)}
.band .brand{position:static;font-size:26px}
.band .brand img{width:44px;height:44px}
`;

const check = `<svg viewBox="0 0 16 16"><path d="M2.5 8.5l3.5 3.5 7.5-8"/></svg>`;

/** One tool call of the session: a bullet, the tool, its argument, and what came back (a line or two). */
const call = (tool, arg, out) =>
  `<div class="row"><div class="g"><i class="dot"></i></div><div><span class="tool">splitsession.${esc(tool)}</span>${arg ? ` <span class="arg">${esc(arg)}</span>` : ""}</div></div>
<div class="out">${out.map((l) => `<div><i class="elb"></i>${esc(l)}</div>`).join("")}</div>`;

/** The terminal panel; `session` is what the real tool calls returned (see ../agent-media.mjs). */
function terminal({ top, h, ask, steps, done }) {
  return `<div class="term" style="top:${top}px;height:${h}px"><div class="tb"><i></i><i></i><i></i><span>AI agent  ·  splitsession (MCP)</span></div>
<div class="body"><div class="row ask"><span class="gt">&gt;</span><div>${esc(ask)}</div></div>
${steps.map((s) => call(s.tool, s.arg, s.out)).join("")}
<div class="row done"><div class="g">${check}</div><div>${esc(done)}</div></div>
<div class="row ask" style="margin-top:14px"><span class="gt">&gt;</span><span class="cur"></span></div></div></div>`;
}

const dataUri = (png) => `data:image/png;base64,${png.toString("base64")}`;

/**
 * @param {object} p
 * @param {Buffer} p.shot 2x picture of the page, with the real agent activity on it
 * @param {Array} p.strip tab strip items (as the extension made the tabs and groups)
 * @param {string} p.badge colour of the dot on the toolbar button
 */
export function shotAgent({ shot, strip, badge, ask, steps, done, headline }) {
  const top = Math.round((SIZE.height - BAND - WIN.h) / 2);
  const w = WIN.w - 2;
  const content = `<div class="pane" style="width:${w}px;height:100%"><img src="${dataUri(shot)}" width="${w}" alt=""></div>`;
  const words = headline.split(" ");
  const last = words.splice(-3).join(" ");
  return `${page(
    "light",
    `${terminal({ top, h: WIN.h, ask, steps, done })}${windowHtml({
      x: WIN.x,
      y: top,
      w: WIN.w,
      h: WIN.h,
      strip,
      address: "loop.example",
      content,
      badge,
    })}<div class="band"><h1>${esc(words.join(" "))} <em>${esc(last)}</em></h1><div class="brand"><img src="${ICON_48}" alt="">SplitSession</div></div>`,
  ).replace("</style>", `${CSS}</style>`)}`;
}

export { INTER, THEMES };
