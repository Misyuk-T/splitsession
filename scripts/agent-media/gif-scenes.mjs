// The script of docs/media/agent-bridge.gif as states: a drawn terminal on the left types the request and the tool calls, and
// on the right the drawn browser window of the README animations shows the REAL picture of the Brand tab after each call
// (scripts/agent-media/capture.mjs with `frames`): the agent glow, the "Agent: ..." pill, the text in the composer, the new
// post. The terminal lines come from what the tools answered (./session.mjs). Same stage, fonts, captions and GIF palette
// approach as scripts/readme-media/scenes.mjs.
/* eslint-disable import/extensions -- local .mjs modules, run directly by node */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import {
  CONTENT,
  esc,
  htmlLayer,
  imageLayer,
  stagePage,
  visibleTitle,
  WIN,
} from "../readme-media/mock.mjs";
import { Stage, Timeline } from "../readme-media/timeline.mjs";

const require = createRequire(import.meta.url);
const MONO = `data:font/woff2;base64,${readFileSync(
  require.resolve("@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2"),
).toString("base64")}`;

const AGENT = "#8b5cf6"; // the agent's purple (src/core/indicators.ts)
const TERM = { x: WIN.x, y: WIN.y, w: 336, h: WIN.h };
/** The browser window sits right of the terminal; its page area is VIEWPORT (the capture is made at that size, 1x). */
const BROWSER = { x: TERM.x + TERM.w + 12 };
BROWSER.w = WIN.x + WIN.w - BROWSER.x;
export const VIEWPORT = {
  width: BROWSER.w - 2,
  height: CONTENT.h,
};

const CSS = `
@font-face{font-family:"Term Mono";font-weight:100 800;src:url(${MONO}) format("woff2")}
.win{left:${BROWSER.x}px;width:${BROWSER.w}px}
.strip{padding-left:66px}
.tab{width:84px;padding:0 8px;gap:6px}
.term{background:#10131a;color:#e4e7f0;border:1px solid #2a2f3d;border-radius:10px;overflow:hidden;font-family:"Term Mono",ui-monospace,monospace}
.term .tb{height:36px;background:#181c26;border-bottom:1px solid #2a2f3d;display:flex;align-items:center;padding:0 14px;gap:7px}
.term .tb i{width:12px;height:12px;border-radius:50%;background:#3a3f50}
.term .tb span{margin-left:10px;font-size:12px;color:#8d93a8}
#term-body{padding:16px 18px 0;font-size:13px;line-height:20px;font-weight:450}
.term .row{display:flex;gap:9px;align-items:flex-start}
.term .g{flex:none;width:12px;height:20px;display:flex;justify-content:center;align-items:center;color:#8d93a8;font-weight:700}
.term .dot{width:8px;height:8px;border-radius:50%;background:${AGENT}}
.term .ask{color:#f2f4fb;font-weight:550;margin-bottom:12px}
.term .tn{color:#c4b5fd;font-weight:600}
.term .out{color:#9aa1b5;margin:0 0 8px 21px;display:flex;gap:8px}
.term .out i{flex:none;width:8px;height:9px;border-left:2px solid #4b5166;border-bottom:2px solid #4b5166;border-bottom-left-radius:3px;margin-top:3px}
.term .done{margin-top:4px;color:#f2f4fb;font-weight:550}
.term .done svg{width:13px;height:13px;stroke:#4ade80;stroke-width:3;fill:none;stroke-linecap:round;stroke-linejoin:round}
.term .cur{display:inline-block;width:8px;height:15px;background:#e4e7f0;vertical-align:-3px}
`;

const CHECK = `<svg viewBox="0 0 16 16"><path d="M2.5 8.5l3.5 3.5 7.5-8"/></svg>`;

/**
 * The terminal body for a state.
 * @param {{ ask: string, steps: {tool: string, arg: string, out: string[]}[], done: string }} script
 * @param {{ typed: number, tools: number, outs: number, done: boolean }} s characters of the request typed, tool lines
 *   shown, of them with their answer, and whether the closing line is there
 */
function termHtml(script, s) {
  const typing = s.typed < script.ask.length;
  const ask = `<div class="row ask"><span class="g">&gt;</span><div>${esc(script.ask.slice(0, s.typed))}${typing || s.tools === 0 ? '<span class="cur"></span>' : ""}</div></div>`;
  const calls = script.steps
    .slice(0, s.tools)
    .map((st, i) => {
      const line = `<div class="row"><span class="g"><i class="dot"></i></span><div><span class="tn">splitsession.${esc(st.tool)}</span>${st.arg ? ` ${esc(st.arg)}` : ""}</div></div>`;
      const out =
        i < s.outs
          ? `<div class="out"><i></i><div>${st.out.map(esc).join("<br>")}</div></div>`
          : "";
      return line + out;
    })
    .join("");
  const done = s.done
    ? `<div class="row done"><span class="g">${CHECK}</span><div>${esc(script.done)}</div></div><div class="row ask" style="margin-top:12px"><span class="g">&gt;</span><span class="cur"></span></div>`
    : "";
  return ask + calls + done;
}

const caption = (n, html) => ({ n, html });

/**
 * @param {import("@playwright/test").Browser} browser
 * @param {{ frames: {name: string, png: Buffer, pill: string, strip: any[]}[] }} cap the capture (see capture.mjs)
 * @param {{ ask: string, steps: any[], done: string }} script the terminal session (see session.mjs)
 */
export async function agentGif(browser, cap, script) {
  const layers = [
    htmlLayer(
      "term",
      TERM.x,
      TERM.y,
      `width:${TERM.w}px;height:${TERM.h}px;`,
      `<div class="term" style="width:100%;height:100%"><div class="tb"><i></i><i></i><i></i><span>AI agent · splitsession (MCP)</span></div><div id="term-body"></div></div>`,
    ),
    ...cap.frames.map((f, i) =>
      imageLayer(`f-${i}`, f.png, BROWSER.x + 1, CONTENT.y),
    ),
  ].join("");
  const stage = await Stage.open(browser, stagePage({ layers, extraCss: CSS }));
  const T = new Timeline();
  try {
    const strip = (f) =>
      f.strip.map((it, i) =>
        it.type === "group"
          ? {
              type: "group",
              id: `g${i}`,
              title: visibleTitle(it.title),
              color: it.color,
              tabs: it.tabs.map((t, k) => ({
                id: `g${i}t${k}`,
                title: visibleTitle(t.title),
                fav: "loop",
                active: t.active,
              })),
            }
          : {
              type: "tab",
              id: `t${i}`,
              title: visibleTitle(it.title),
              fav: "page",
              active: false,
            },
      );
    // Frame i of the capture: 0 idle, then one per tool call.
    const state = (frame, term, cap1) => ({
      tabs: strip(cap.frames[frame]),
      url: "loop.example",
      tools: ["ext", "puzzle"],
      show: ["term", `f-${frame}`],
      text: { "term-body": termHtml(script, term) },
      caption: cap1,
    });
    const n = script.steps.length;
    const c1 = caption(1, "Ask your <em>AI agent</em> in plain words");
    const c2 = caption(2, "It works in the <em>right account</em>, tab by tab");
    const c3 = caption(3, "Done. The reply is <em>first in the feed</em>");

    // 1. The request is typed; the browser is idle.
    T.scene();
    T.hold(state(0, { typed: 0, tools: 0, outs: 0, done: false }, c1), 500);
    for (let k = 3; k < script.ask.length; k += 3)
      T.hold(state(0, { typed: k, tools: 0, outs: 0, done: false }, c1), 70);
    const asked = { typed: script.ask.length, tools: 0, outs: 0, done: false };
    T.hold(state(0, asked, c1), 450);

    // 2. One tool call per picture: the line appears over the previous picture, then the answer and the new picture.
    for (let i = 0; i < n; i++) {
      T.hold(
        state(i, { ...asked, tools: i + 1, outs: i, done: false }, c2),
        300,
      );
      T.scene();
      T.hold(
        state(i + 1, { ...asked, tools: i + 1, outs: i + 1, done: false }, c2),
        i === n - 1 ? 1000 : 1100,
      );
    }

    // 3. Done, held.
    T.hold(state(n, { ...asked, tools: n, outs: n, done: true }, c3), 1600);
    return await stage.render(T.items);
  } finally {
    await stage.close();
  }
}
