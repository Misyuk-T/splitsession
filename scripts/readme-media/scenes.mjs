// The two README animations as scripts of states: what is on screen, where the cursor goes, what the caption says.
// REAL: every picture of the demo site, of the popup and of chrome://extensions (see capture.mjs). DRAWN: the browser
// window around them, the new-tab page, the Releases page, Finder, the file picker, the extensions menu, the
// download bubble, the cursor and the captions.
/* eslint-disable import/extensions -- local .mjs modules, run directly by node */
import {
  CONTENT,
  esc,
  GROUP_HEX,
  htmlLayer,
  ICON_48,
  imageLayer,
  SIZE,
  stagePage,
  WIN,
} from "./mock.mjs";
import { Stage, Timeline } from "./timeline.mjs";

const at = (box, dx = 0, dy = 0) => ({
  x: box.x + (box.w ?? 0) / 2 + dx,
  y: box.y + (box.h ?? 0) / 2 + dy,
});
const caption = (n, html) => ({ n, html });
const WHERE = { x: CONTENT.x, y: CONTENT.y };
const TOOLS = ["ext", "puzzle"];

const POPUP_STYLE =
  "border:1px solid #aab0c2;border-radius:12px;box-shadow:0 2px 6px rgba(20,22,50,.2);";
const KEY_STYLE =
  "background:#fff;border:2px solid #14161b;border-bottom-width:5px;border-radius:9px;padding:5px 16px;font-size:19px;font-weight:650;color:#14161b;";

/** A drawn page filling the window's content area. */
const pageLayer = (id, inner, style = "") =>
  htmlLayer(
    id,
    WHERE.x,
    WHERE.y,
    `width:${CONTENT.w}px;height:${CONTENT.h}px;background:#fff;overflow:hidden;${style}`,
    inner,
  );

/** The animation "Two accounts, side by side": the real Lite extension on the demo mail site. */
export async function howItWorks(browser, cap) {
  const { popup, signIn } = cap;
  const popX = CONTENT.x + CONTENT.w - 420 - 10;
  const popY = CONTENT.y - 3;
  const popAt = (box) => ({
    x: popX + 1 + box.x + box.w / 2,
    y: popY + 1 + box.y + box.h / 2,
  });
  const layers = [
    imageLayer("v-personal", cap.personal, WHERE.x, WHERE.y),
    imageLayer("v-work", cap.work, WHERE.x, WHERE.y),
    pageLayer(
      "v-newtab",
      `<div style="position:absolute;left:225px;top:150px;width:400px;height:46px;border-radius:23px;background:#fff;border:2px solid #d6d9e3;font-size:16px;line-height:42px;padding-left:22px;color:#6b7180">Search or type a URL</div>`,
    ),
    imageLayer("v-si-empty", signIn.empty, WHERE.x, WHERE.y),
    imageLayer("v-si-focused", signIn.focused, WHERE.x, WHERE.y),
    ...signIn.typed.map((png, i) =>
      imageLayer(`v-si-${i}`, png, WHERE.x, WHERE.y),
    ),
    imageLayer("p-empty", popup.empty, popX, popY, POPUP_STYLE),
    imageLayer("p-form", popup.form, popX, popY, POPUP_STYLE),
    ...popup.typed.map((png, i) =>
      imageLayer(`p-typed-${i}`, png, popX, popY, POPUP_STYLE),
    ),
    htmlLayer("key", popX - 118, popY + 118, KEY_STYLE, "Enter"),
  ].join("");
  const stage = await Stage.open(browser, stagePage({ layers }));
  const T = new Timeline();
  try {
    const { personalTitle, workTitle, group } = cap;
    const strip = (active, work) => [
      {
        type: "tab",
        id: "personal",
        title: personalTitle,
        fav: "mail",
        active: active === "personal",
      },
      ...(work
        ? [
            {
              type: "group",
              id: "work",
              title: group.title,
              color: group.color,
              tabs: [
                { type: "tab", id: "work", ...work, active: active === "work" },
              ],
            },
          ]
        : []),
    ];
    const NEW = { title: "New Tab", fav: "page" };
    const SIGN = { title: "Sign in – Postline", fav: "mail" };
    const WORK = { title: workTitle, fav: "mail" };
    const base = (over) => ({
      tabs: strip("personal"),
      url: "mail.example",
      tools: TOOLS,
      show: ["v-personal"],
      ...over,
    });

    // 1. Dana is signed in, personal.
    const c1 = caption(1, "Dana is signed in. <em>Personal</em> account");
    T.hold(base({ caption: c1 }), 2000);

    // 2. Open the popup, press +, type "Work", Enter.
    const c2 = caption(2, "Open SplitSession. Press <em>+</em>, name it Work");
    const s2 = base({ caption: c2 });
    const hits0 = await stage.hits(s2);
    const extBtn = at(hits0["tool-ext"]);
    const start = { x: 640, y: 330 };
    T.glide(s2, start, extBtn, 800);
    T.click(s2, extBtn);
    const open = base({
      caption: c2,
      hot: "ext",
      show: ["v-personal", "p-empty"],
    });
    T.hold({ ...open, cursor: extBtn }, 700);
    const plus = popAt(cap.plusBox);
    T.glide(open, extBtn, plus, 600);
    T.click(open, plus);
    const form = base({
      caption: c2,
      hot: "ext",
      show: ["v-personal", "p-form"],
    });
    T.hold({ ...form, cursor: plus }, 700);
    popup.typed.forEach((_, i) => {
      T.hold(
        base({ caption: c2, hot: "ext", show: ["v-personal", `p-typed-${i}`] }),
        i === popup.typed.length - 1 ? 800 : 320,
      );
    });
    T.hold(
      base({
        caption: c2,
        hot: "ext",
        show: ["v-personal", "p-typed-3", "key"],
      }),
      650,
    );

    // 3. A new tab opens in the Work group.
    const c3 = caption(3, "A new tab opens in the <em>Work</em> group");
    const fresh = {
      tabs: strip("work", NEW),
      url: "",
      tools: TOOLS,
      show: ["v-newtab"],
      caption: c3,
    };
    T.hold(fresh, 1500);

    // 4. Sign in there as someone else, on the same site.
    const c4 = caption(4, "Sign in there as <em>someone else</em>");
    const hits1 = await stage.hits({ ...fresh, caption: c4 });
    const urlBar = at(hits1.url, -120);
    const go = { ...fresh, caption: c4 };
    T.glide(go, { x: 520, y: 330 }, urlBar, 800);
    T.click(go, urlBar);
    const typing = { ...go, urlFocus: true, caret: true };
    for (let n = 1; n <= "mail.example".length; n++)
      T.hold({ ...typing, url: "mail.example".slice(0, n) }, 70);
    T.hold({ ...typing, url: "mail.example" }, 350);
    const signed = {
      tabs: strip("work", SIGN),
      url: "mail.example",
      tools: TOOLS,
      caption: c4,
    };
    T.hold({ ...signed, show: ["v-si-empty"] }, 800);
    const email = {
      x: WHERE.x + cap.emailBox.x + 100,
      y: WHERE.y + cap.emailBox.y + cap.emailBox.h / 2,
    };
    T.glide({ ...signed, show: ["v-si-empty"] }, urlBar, email, 650);
    T.click({ ...signed, show: ["v-si-empty"] }, email);
    T.hold({ ...signed, show: ["v-si-focused"], cursor: email }, 400);
    signIn.typed.forEach((_, i) =>
      T.hold(
        { ...signed, show: [`v-si-${i}`] },
        i === signIn.typed.length - 1 ? 600 : 130,
      ),
    );
    const cont = at({
      x: WHERE.x + cap.continueBox.x,
      y: WHERE.y + cap.continueBox.y,
      w: cap.continueBox.w,
      h: cap.continueBox.h,
    });
    T.glide(
      { ...signed, show: [`v-si-${signIn.typed.length - 1}`] },
      email,
      cont,
      600,
    );
    T.click({ ...signed, show: [`v-si-${signIn.typed.length - 1}`] }, cont);

    // 5. Both tabs stay signed in: different inbox, same site.
    const c5 = caption(5, "Same site. Two accounts. <em>One window.</em>");
    const work = {
      tabs: strip("work", WORK),
      url: "mail.example",
      tools: TOOLS,
      show: ["v-work"],
      caption: c5,
    };
    T.hold({ ...work, cursor: cont }, 1500);
    const hits2 = await stage.hits(work);
    const tabP = at(hits2["tab-personal"]);
    const tabW = at(hits2["tab-work"]);
    const onPersonal = {
      ...work,
      tabs: strip("personal", WORK),
      show: ["v-personal"],
    };
    T.glide(work, cont, tabP, 750);
    T.click(work, tabP);
    T.hold({ ...onPersonal, cursor: tabP }, 1500);
    T.glide(onPersonal, tabP, tabW, 450);
    T.click(onPersonal, tabW);
    T.hold({ ...work, cursor: tabW }, 1500);
    T.glide(work, tabW, tabP, 450);
    T.click(work, tabP);
    T.hold({ ...onPersonal, cursor: tabP }, 2600);
    return await stage.render(T.items);
  } finally {
    await stage.close();
  }
}

/**
 * The picture "Chrome's split view": the Work and the Personal tab of the demo mail site as one joined pair in one tab
 * strip, a pane each. REAL: both panes (the extension's own tabs, signed in as two accounts, with the ⧉ mark in the
 * title the extension puts on a container tab outside its group). DRAWN: the window, the joined pair, the divider and
 * the two container labels. Returns the PNG.
 */
export async function splitView(browser, cap) {
  const half = (CONTENT.w - 2) / 2;
  const rightX = CONTENT.x + half + 2;
  const label = (id, x, who) =>
    htmlLayer(
      id,
      x + 14,
      CONTENT.y + CONTENT.h - 46,
      `background:${GROUP_HEX[who.color]};color:#fff;font-size:16px;line-height:20px;font-weight:700;padding:7px 14px;border-radius:8px`,
      `⧉ ${esc(who.name)}`,
    );
  const layers = [
    imageLayer("v-left", cap.work.png, CONTENT.x, CONTENT.y),
    imageLayer("v-right", cap.personal.png, rightX, CONTENT.y),
    htmlLayer(
      "divider",
      CONTENT.x + half,
      CONTENT.y,
      `width:2px;height:${CONTENT.h}px;background:#c3c7d4`,
      `<div style="position:absolute;left:-2px;top:${CONTENT.h / 2 - 24}px;width:6px;height:48px;border-radius:3px;background:#8a90a0"></div>`,
    ),
    label("lbl-left", CONTENT.x, cap.work),
    label("lbl-right", rightX, cap.personal),
  ].join("");
  const stage = await Stage.open(browser, stagePage({ layers }));
  try {
    const state = {
      tabs: [
        {
          type: "split",
          tabs: [
            { title: cap.work.title, fav: "mail" },
            { title: cap.personal.title, fav: "mail" },
          ],
        },
      ],
      url: "mail.example",
      tools: TOOLS,
      show: ["v-left", "v-right", "divider", "lbl-left", "lbl-right"],
      caption: caption(
        null,
        "Works with Chrome's split view:<br><em>two accounts, literally side by side.</em>",
      ),
    };
    const [frame] = await stage.render([{ state, ms: 1, seg: 0 }]);
    return frame.png;
  } finally {
    await stage.close();
  }
}

// ---- drawn pieces of the install animation ----

const zipIcon = `<svg width="64" height="64" viewBox="0 0 64 64"><path d="M14 4h26l12 12v44H14z" fill="#fff" stroke="#8a90a0" stroke-width="2.5" stroke-linejoin="round"/><path d="M40 4v12h12" fill="none" stroke="#8a90a0" stroke-width="2.5" stroke-linejoin="round"/><g fill="#8a90a0"><rect x="30" y="6" width="5" height="5"/><rect x="25" y="13" width="5" height="5"/><rect x="30" y="20" width="5" height="5"/><rect x="25" y="27" width="5" height="5"/></g><rect x="24" y="36" width="12" height="14" rx="3" fill="#fff" stroke="#8a90a0" stroke-width="2.5"/></svg>`;
const folderIcon = `<svg width="72" height="64" viewBox="0 0 72 64"><path d="M4 12a5 5 0 0 1 5-5h18l6 7h30a5 5 0 0 1 5 5v33a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z" fill="#5aa9ff"/><path d="M4 22h64v28a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z" fill="#3b8ef0"/></svg>`;
const pinIcon = (on) =>
  `<svg width="22" height="22" viewBox="0 0 24 24" fill="${on ? "#1a73e8" : "none"}" stroke="${on ? "#1a73e8" : "#454b59"}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3zM12 14v7"/></svg>`;

const finderHtml = () => `
<div style="position:absolute;left:0;top:0;width:${SIZE.width}px;height:${WIN.y + WIN.h + 4}px;background:#c9d3ec"></div>
<div style="position:absolute;left:90px;top:34px;width:700px;height:420px;border-radius:12px;background:#fff;border:1px solid #aab0c2;overflow:hidden">
<div style="height:42px;background:#ececf2;border-bottom:1px solid #d3d6e0;position:relative;text-align:center;font-size:15px;font-weight:650;line-height:42px;color:#2a2f3a">Downloads
<span style="position:absolute;left:16px;top:15px;display:flex;gap:8px"><i style="width:12px;height:12px;border-radius:50%;background:#ff5f57"></i><i style="width:12px;height:12px;border-radius:50%;background:#febc2e"></i><i style="width:12px;height:12px;border-radius:50%;background:#28c840"></i></span></div>
<div style="display:flex;height:376px"><div style="width:176px;background:#f1f2f7;border-right:1px solid #d3d6e0;padding:14px 10px;font-size:14px;color:#2a2f3a;line-height:30px">
<div style="font-size:12px;font-weight:650;color:#6b7180;letter-spacing:.04em;text-transform:uppercase;line-height:22px;padding-left:8px">Favourites</div>
<div style="padding-left:8px">Recents</div><div style="padding-left:8px">Applications</div><div style="padding-left:8px">Documents</div><div style="padding-left:8px">Desktop</div>
<div style="padding-left:8px;background:#d5d9e8;border-radius:6px;font-weight:650">Downloads</div></div>
<div style="flex:1"></div></div></div>`;

/** A Finder icon with its name (the layer is 150 wide: the icon is centred in it). */
const fileItem = (icon, label, hit = "") =>
  `<div ${hit ? `data-hit="${hit}"` : ""} style="margin:0 auto;width:72px;height:72px;display:grid;place-items:center">${icon}</div><div style="margin-top:6px;font-size:13px;line-height:17px;color:#14161b;text-align:center;overflow-wrap:anywhere;padding:0 12px">${esc(label)}</div>`;

// Finder's icon area starts at (267, 77) of the stage: the window's left 90 + sidebar 177, top 34 + title bar 43.
const FILES = { x: 267 + 22, y: 77 + 22 };

const releasesHtml = `
<div style="padding:26px 40px;font-size:15px;color:#1f2328">
<div style="font-size:15px;color:#59636e;margin-bottom:18px">Misyuk-T / <b style="color:#1f2328">splitsession</b> / Releases</div>
<div style="display:flex;align-items:center;gap:12px"><span style="font-size:30px;font-weight:700;letter-spacing:-.01em">v0.1.0</span><span style="border:1px solid #1a7f37;color:#1a7f37;border-radius:999px;padding:1px 10px;font-size:13px;font-weight:600">Latest</span></div>
<div style="margin:6px 0 22px;color:#59636e">SplitSession 0.1.0: the first public release (Lite and Full).</div>
<div style="border:1px solid #d1d9e0;border-radius:8px;overflow:hidden;font-size:15px">
<div style="background:#f6f8fa;padding:10px 16px;font-weight:650;border-bottom:1px solid #d1d9e0">Assets</div>
<div style="padding:10px 16px;border-bottom:1px solid #e3e8ee"><span data-hit="dl-lite" id="dl-lite" style="color:#0969da;font-weight:600">splitsession-lite-0.1.0.zip</span></div>
<div style="padding:10px 16px;border-bottom:1px solid #e3e8ee"><span style="color:#0969da">splitsession-full-0.1.0.zip</span></div>
<div style="padding:10px 16px;border-bottom:1px solid #e3e8ee"><span style="color:#0969da">Source code (zip)</span></div>
<div style="padding:10px 16px"><span style="color:#0969da">Source code (tar.gz)</span></div></div></div>`;

/** The Open panel Chrome shows for "Load unpacked" (drawn: the real OS picker cannot be recorded). */
const pickerHtml = (selected) => `
<div style="position:absolute;left:0;top:0;width:560px;height:330px;background:#fff;border:1px solid #aab0c2;border-radius:0 0 12px 12px;overflow:hidden;font-size:14px;color:#14161b;box-shadow:0 2px 6px rgba(20,22,50,.2)">
<div style="padding:12px 18px 8px;font-size:15px;font-weight:650">Select the extension folder</div>
<div style="display:flex;height:232px;border-top:1px solid #d3d6e0;border-bottom:1px solid #d3d6e0">
<div style="width:150px;background:#f1f2f7;border-right:1px solid #d3d6e0;padding:10px 8px;line-height:28px"><div style="font-size:12px;font-weight:650;color:#6b7180;text-transform:uppercase;letter-spacing:.04em;line-height:20px;padding-left:6px">Favourites</div><div style="padding-left:6px">Documents</div><div style="padding-left:6px">Desktop</div><div style="padding-left:6px;background:#d5d9e8;border-radius:6px;font-weight:650">Downloads</div></div>
<div style="flex:1;padding:8px">
<div data-hit="pk-folder" style="height:30px;line-height:30px;border-radius:6px;padding-left:8px;display:flex;align-items:center;gap:9px;${selected ? "background:#2f6fe4;color:#fff" : ""}"><svg width="20" height="17" viewBox="0 0 72 64"><path d="M4 12a5 5 0 0 1 5-5h18l6 7h30a5 5 0 0 1 5 5v33a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z" fill="#5aa9ff"/><path d="M4 22h64v28a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z" fill="#3b8ef0"/></svg>splitsession-lite-0.1.0</div>
<div style="height:30px;line-height:30px;padding-left:8px;color:#8a90a0;display:flex;align-items:center;gap:9px"><svg width="17" height="20" viewBox="0 0 64 64"><path d="M14 4h26l12 12v44H14z" fill="#fff" stroke="#b8bdc9" stroke-width="4"/></svg>splitsession-lite-0.1.0.zip</div></div></div>
<div style="display:flex;justify-content:flex-end;gap:10px;padding:14px 18px"><div style="border:1px solid #c3c7d4;border-radius:8px;padding:7px 18px;font-weight:550;background:#fff">Cancel</div><div data-hit="pk-select" style="border-radius:8px;padding:7px 18px;font-weight:650;background:${selected ? "#2f6fe4" : "#9db9ee"};color:#fff">Select</div></div></div>`;

const menuHtml = (pinned) => `
<div style="width:320px;background:#fff;border:1px solid #aab0c2;border-radius:12px;box-shadow:0 2px 6px rgba(20,22,50,.2);padding:10px 8px;font-size:14px;color:#14161b">
<div style="padding:4px 10px 8px;font-weight:650;font-size:15px">Extensions</div>
<div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;background:#f1f3f8"><img src="${ICON_48}" width="22" height="22" alt=""><span style="flex:1;line-height:18px">SplitSession: Multiple Logins per Site</span><span data-hit="pin" style="width:30px;height:30px;display:grid;place-items:center;border-radius:6px">${pinIcon(pinned)}</span></div></div>`;

/** The animation "Install in Chrome": from the Releases page to the pinned toolbar button. */
export async function install(browser, cap) {
  const L = (id, png) => imageLayer(id, png, WHERE.x, WHERE.y);
  const pickerX = CONTENT.x + Math.round((CONTENT.w - 560) / 2);
  const dlX = CONTENT.x + CONTENT.w - 320 - 8;
  const layers = [
    pageLayer("v-releases", releasesHtml),
    L("v-ext-off", cap.off),
    L("v-ext-on", cap.on),
    L("v-ext-card", cap.card),
    htmlLayer(
      "p-download",
      dlX,
      CONTENT.y - 3,
      "width:320px;background:#fff;border:1px solid #aab0c2;border-radius:12px;box-shadow:0 2px 6px rgba(20,22,50,.2);padding:14px 16px;font-size:14px;color:#14161b",
      `<div style="display:flex;align-items:center;gap:12px"><svg width="26" height="30" viewBox="0 0 64 64"><path d="M14 4h26l12 12v44H14z" fill="#fff" stroke="#8a90a0" stroke-width="4" stroke-linejoin="round"/></svg><div style="flex:1;min-width:0"><div style="font-weight:650;white-space:nowrap">splitsession-lite-0.1.0.zip</div><div id="dl-state" style="color:#59636e;margin-top:3px">Done</div></div></div>`,
    ),
    htmlLayer(
      "v-finder",
      0,
      0,
      `width:${SIZE.width}px;height:${WIN.y + WIN.h + 4}px;overflow:hidden`,
      finderHtml(),
    ),
    htmlLayer(
      "f-zip-sel",
      FILES.x + 33 - 6,
      FILES.y - 3,
      "width:84px;height:84px;border-radius:10px;background:#dfe3ee",
      "",
    ),
    htmlLayer(
      "f-zip",
      FILES.x,
      FILES.y,
      "width:150px",
      fileItem(zipIcon, "splitsession-lite-0.1.0.zip", "f-zip"),
    ),
    htmlLayer(
      "f-folder",
      FILES.x + 160,
      FILES.y,
      "width:150px",
      fileItem(folderIcon, "splitsession-lite-0.1.0"),
    ),
    htmlLayer(
      "p-menu",
      CONTENT.x + CONTENT.w - 320 - 8,
      CONTENT.y - 3,
      "",
      menuHtml(false),
    ),
    htmlLayer(
      "p-menu-pinned",
      CONTENT.x + CONTENT.w - 320 - 8,
      CONTENT.y - 3,
      "",
      menuHtml(true),
    ),
    htmlLayer("p-picker", pickerX, CONTENT.y - 3, "", pickerHtml(false)),
    htmlLayer("p-picker-sel", pickerX, CONTENT.y - 3, "", pickerHtml(true)),
  ].join("");
  const stage = await Stage.open(browser, stagePage({ layers }));
  const T = new Timeline();
  try {
    const gh = [{ type: "tab", title: "Releases", fav: "gh", active: true }];
    const ext = [
      { type: "tab", title: "Extensions", fav: "page", active: true },
    ];
    const rel = {
      tabs: gh,
      url: "github.com/Misyuk-T/splitsession/releases",
      tools: [],
      show: ["v-releases"],
    };

    // 1. Download the zip from the Releases page.
    const c1 = caption(1, "Download <em>splitsession-lite-0.1.0.zip</em>");
    const s1 = { ...rel, caption: c1 };
    T.hold(s1, 1400);
    const link = at((await stage.hits(s1))["dl-lite"]);
    T.glide(s1, { x: 700, y: 330 }, link, 900);
    T.click(s1, link);
    const dl = { ...s1, tools: ["download"] };
    T.hold(
      {
        ...dl,
        hot: "download",
        show: ["v-releases", "p-download"],
        text: { "dl-state": "Downloading…" },
        cursor: link,
      },
      700,
    );
    T.hold(
      {
        ...dl,
        hot: "download",
        show: ["v-releases", "p-download"],
        text: { "dl-state": "Done" },
        cursor: link,
      },
      1800,
    );

    // 2. Unzip it in Finder.
    T.scene();
    const c2 = caption(2, "Unzip it: <em>double-click</em> the file");
    const fin = {
      tabs: gh,
      url: rel.url,
      tools: [],
      show: ["v-finder", "f-zip"],
      caption: c2,
    };
    T.hold(fin, 1100);
    const zip = at((await stage.hits(fin))["f-zip"]);
    T.glide(fin, { x: 640, y: 400 }, zip, 800);
    T.click({ ...fin, show: ["v-finder", "f-zip-sel", "f-zip"] }, zip);
    T.click({ ...fin, show: ["v-finder", "f-zip-sel", "f-zip"] }, zip);
    T.hold(
      { ...fin, show: ["v-finder", "f-zip", "f-folder"], cursor: zip },
      2200,
    );

    // 3. chrome://extensions, Developer mode on.
    T.scene();
    const c3 = caption(
      3,
      "Open <em>chrome://extensions</em>, turn on <em>Developer mode</em>",
    );
    const ex = (over) => ({
      tabs: ext,
      url: "chrome://extensions",
      secure: false,
      tools: [],
      caption: c3,
      ...over,
    });
    const off = ex({ show: ["v-ext-off"] });
    T.hold(off, 1400);
    const toggle = at({
      x: WHERE.x + cap.devModeBox.x,
      y: WHERE.y + cap.devModeBox.y,
      w: cap.devModeBox.w,
      h: cap.devModeBox.h,
    });
    T.glide(off, { x: 560, y: 300 }, toggle, 1000);
    T.click(off, toggle);
    T.hold({ ...ex({ show: ["v-ext-on"] }), cursor: toggle }, 1100);

    // 4. Load unpacked, pick the folder.
    const c4 = caption(
      4,
      "Click <em>Load unpacked</em>, choose the unzipped folder",
    );
    const on = ex({ show: ["v-ext-on"], caption: c4 });
    const load = at({
      x: WHERE.x + cap.loadUnpackedBox.x,
      y: WHERE.y + cap.loadUnpackedBox.y,
      w: cap.loadUnpackedBox.w,
      h: cap.loadUnpackedBox.h,
    });
    T.glide(on, toggle, load, 900);
    T.click(on, load);
    const pick = ex({ show: ["v-ext-on", "p-picker"], caption: c4 });
    T.hold({ ...pick, cursor: load }, 900);
    const hp = await stage.hits(pick);
    const folder = at(hp["pk-folder"], -40);
    T.glide(pick, load, folder, 800);
    T.click(pick, folder);
    const picked = ex({ show: ["v-ext-on", "p-picker-sel"], caption: c4 });
    T.hold({ ...picked, cursor: folder }, 700);
    const select = at((await stage.hits(picked))["pk-select"]);
    T.glide(picked, folder, select, 600);
    T.click(picked, select);

    // 5. The card appears; pin it to the toolbar.
    const c5 = caption(
      5,
      "<em>SplitSession</em> is installed. Pin it to the toolbar",
    );
    const card = ex({ show: ["v-ext-card"], caption: c5 });
    T.hold({ ...card, cursor: select }, 1800);
    const puzzle = at(
      (await stage.hits({ ...card, tools: ["puzzle"] }))["tool-puzzle"],
    );
    const withPuzzle = { ...card, tools: ["puzzle"] };
    T.glide(withPuzzle, select, puzzle, 900);
    T.click(withPuzzle, puzzle);
    const menu = {
      ...withPuzzle,
      hot: "puzzle",
      show: ["v-ext-card", "p-menu"],
    };
    T.hold({ ...menu, cursor: puzzle }, 800);
    const pin = at((await stage.hits(menu))["pin"]);
    T.glide(menu, puzzle, pin, 700);
    T.click(menu, pin);
    T.hold(
      {
        ...card,
        tools: ["ext", "puzzle"],
        hot: "puzzle",
        show: ["v-ext-card", "p-menu-pinned"],
        cursor: pin,
      },
      1300,
    );
    const done = { ...card, tools: ["ext", "puzzle"] };
    const extBtn = at((await stage.hits(done))["tool-ext"]);
    T.glide(done, pin, extBtn, 700);
    T.hold({ ...done, cursor: extBtn }, 700);
    const rest = { x: extBtn.x - 70, y: extBtn.y + 90 };
    T.glide(done, extBtn, rest, 500);
    T.hold({ ...done, cursor: rest }, 2800);
    return await stage.render(T.items);
  } finally {
    await stage.close();
  }
}
