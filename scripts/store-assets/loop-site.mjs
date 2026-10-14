// "Loop" (loop.example): a small invented social network for the README animations (scripts/readme-media.mjs) and the
// Chrome Web Store pictures (scripts/store-assets.mjs).
// Neutral on purpose: its own name and logo, no resemblance to a real service. Two demo accounts, a personal one
// (@dana) and a brand one (@northwind_studio), each with its own feed. Signing in is a cookie, so the two accounts
// only stay apart because SplitSession gives each container tab its own cookies. The sign-in form and the composer
// are real forms (GET, so no body parsing), which lets the animation type into them.
const ACCENT = "#0b7a75";

const PROFILES = {
  dana: {
    name: "Dana W.",
    handle: "dana",
    followers: "312",
    initials: "DW",
    avatar: "#a2557a",
    feed: [
      [
        "Sam Okafor",
        "samok",
        "9m",
        "Finally sorted the trip photos. The mountain ones turned out better than I hoped.",
        14,
        3,
      ],
      [
        "Riverside Library",
        "riverside",
        "32m",
        "Five long reads for the weekend are on the front table. One is about lighthouses.",
        41,
        6,
      ],
      [
        "Luca",
        "luca_k",
        "1h",
        "Football on Saturday, we are one short. Anyone?",
        5,
        9,
      ],
      [
        "Mei Tanaka",
        "meitanaka",
        "3h",
        "New sketchbook, first page already ruined.",
        22,
        2,
      ],
    ],
  },
  northwind_studio: {
    name: "Northwind Studio",
    handle: "northwind_studio",
    followers: "12.4K",
    initials: "NS",
    avatar: "#3b5b8c",
    feed: [
      [
        "Priya Nair",
        "priya_n",
        "12m",
        "The new onboarding screens are lovely. Small thing: can the empty state say what to do next?",
        18,
        4,
      ],
      [
        "Tomas Berg",
        "tberg",
        "40m",
        "Launch checklist is down to two items. Support macros, then we ship.",
        9,
        2,
      ],
      [
        "Northwind Studio",
        "northwind_studio",
        "2h",
        "Spring collection ships Thursday. Preorders are open until Wednesday night.",
        86,
        12,
      ],
      [
        "Ops Weekly",
        "opsweekly",
        "5h",
        "Uptime report: 99.98 percent this week. Nothing to see here, which is the point.",
        33,
        1,
      ],
    ],
  },
};

const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

/** Two linked rings on a rounded square. */
const LOGO = `<svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true"><rect width="28" height="28" rx="8" fill="${ACCENT}"/><g fill="none" stroke="#fff" stroke-width="2"><circle cx="10.5" cy="14" r="5.5"/><circle cx="17.5" cy="14" r="5.5"/></g></svg>`;

const FIELD =
  "display:block;width:100%;height:42px;font:inherit;border:0;box-shadow:inset 0 0 0 1px #d3d9d9;border-radius:8px;padding:0 11px;color:#1b2121;outline:none;background:#fff";

function shell(title, body, extraCss = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><style>@font-face{font-family:"Demo Inter";font-weight:100 900;src:url(/_inter.woff2) format("woff2")}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{font:14px/1.4 "Demo Inter",system-ui,sans-serif;color:#1b2121;background:#fff;overflow:hidden}
input::placeholder{color:#6f7a7a;opacity:1}input:focus{box-shadow:inset 0 0 0 2px ${ACCENT}!important}
${extraCss}</style></head><body>${body}</body></html>`;
}

function signInPage() {
  return shell(
    "Sign in – Loop",
    `<div style="display:grid;place-items:center;height:100%"><form action="/signin" method="get" autocomplete="off" style="width:300px;text-align:center">
<div style="height:28px;display:flex;justify-content:center">${LOGO}</div><h1 style="font-size:20px;line-height:28px;margin:12px 0 18px">Sign in to Loop</h1>
<input name="handle" type="text" placeholder="Handle" autocomplete="off" spellcheck="false" style="${FIELD};margin-bottom:10px">
<button type="submit" style="display:block;width:100%;height:40px;font:inherit;border:0;background:${ACCENT};color:#fff;border-radius:8px;padding:0 10px;font-weight:600">Continue</button></form></div>`,
  );
}

function feedPage(p) {
  const posts = p.feed
    .map(
      ([name, handle, time, text, likes, replies]) => `<li>
<span class="av">${esc(name[0])}</span><div class="txt"><div class="top"><b>${esc(name)}</b><span class="h">@${esc(handle)}</span><time>${esc(time)}</time></div>
<div class="body">${esc(text)}</div><div class="acts">${likes} likes · ${replies} replies</div></div></li>`,
    )
    .join("");
  const body = `<div class="app">
<header>${LOGO}<b class="brand">Loop</b><span class="search">Search Loop</span></header>
<div class="cols"><nav>
<div class="me"><span class="avatar" style="background:${p.avatar}">${esc(p.initials)}</span><b>${esc(p.name)}</b><small>@${esc(p.handle)}</small><small class="fol"><b>${esc(p.followers)}</b> followers</small></div>
<ul class="menu"><li class="on">Home</li><li>Explore</li><li>Messages <i>3</i></li><li>Saved</li><li>Settings</li></ul></nav>
<main><form class="comp" action="/post" method="get" autocomplete="off"><span class="avatar sm" style="background:${p.avatar}">${esc(p.initials)}</span>
<input name="text" type="text" placeholder="What's new?" autocomplete="off" spellcheck="false" style="${FIELD};flex:1;min-width:0"><button type="submit">Post</button></form>
<ul class="list">${posts}</ul></main></div></div>`;
  return shell(
    "Home – Loop",
    body,
    `.app{display:flex;flex-direction:column;height:100%}
header{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid #dfe5e5;background:#fff}
.brand{font-size:18px;font-weight:700;color:${ACCENT};letter-spacing:-.01em}
.search{margin-left:18px;flex:1;max-width:340px;background:#eef2f2;border-radius:999px;padding:7px 14px;color:#6f7a7a}
.cols{flex:1;display:flex;min-height:0;background:#f4f7f7}
nav{width:176px;flex:none;padding:14px 10px;border-right:1px solid #dfe5e5;background:#fff}
.me{padding:4px 6px 14px}
.me b{display:block;font-size:14px;line-height:20px;margin-top:8px}.me small{display:block;font-size:12px;color:#566060;line-height:17px}
.me .fol{margin-top:6px}.me .fol b{display:inline;margin:0;font-size:12px;color:#1b2121}
.avatar{width:34px;height:34px;flex:none;border-radius:50%;color:#fff;display:grid;place-items:center;font-weight:600;font-size:13px}
.avatar.sm{width:32px;height:32px;font-size:12px}
.menu{list-style:none;margin:0;padding:0}.menu li{display:flex;justify-content:space-between;padding:7px 10px;border-radius:8px;color:#333c3c}
.menu li.on{background:#d9efed;color:#075a56;font-weight:600}.menu i{font-style:normal;font-size:12px}
main{flex:1;min-width:0}
.comp{display:flex;align-items:center;gap:10px;padding:12px 16px;background:#fff;border-bottom:1px solid #dfe5e5}
.comp button{flex:none;width:72px;height:40px;font:inherit;border:0;background:${ACCENT};color:#fff;border-radius:20px;padding:0;font-weight:600}
.list{list-style:none;margin:0;padding:0}.list li{display:flex;gap:10px;padding:10px 16px;border-bottom:1px solid #e3e9e9;background:#fff}
.av{width:34px;height:34px;flex:none;border-radius:50%;background:#dfe7e7;color:#4a5555;display:grid;place-items:center;font-weight:600;font-size:12px}
.txt{min-width:0;flex:1}.top{display:flex;gap:6px;align-items:baseline;white-space:nowrap;overflow:hidden}.top b{font-weight:650;overflow:hidden;text-overflow:ellipsis}
.top .h{color:#6f7a7a;font-size:13px;overflow:hidden;text-overflow:ellipsis}.top time{margin-left:auto;color:#6f7a7a;font-size:12px;flex:none}
.body{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-top:1px}
.acts{color:#6f7a7a;font-size:12px;margin-top:3px}
@media (min-width:1000px){main{flex:none;width:580px}}`,
  );
}

/** The request handler of loop.example: `(req, res, url, send, sid) => response`. State lives in this closure. */
export function createLoop() {
  const sessions = new Map(); // sid -> profile key
  const feeds = Object.fromEntries(
    Object.entries(PROFILES).map(([k, p]) => [k, [...p.feed]]),
  );
  let next = 0;
  const start = (send, key) => {
    const sid = `loop${++next}`;
    sessions.set(sid, key);
    return send(302, "", {
      location: "/",
      "set-cookie": `sid=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`,
    });
  };
  return (req, res, url, send, sid) => {
    const key = sessions.get(sid ?? "");
    if (url.pathname === "/login")
      return start(
        send,
        PROFILES[url.searchParams.get("user")]
          ? url.searchParams.get("user")
          : "dana",
      );
    if (url.pathname === "/signin") {
      const handle = (url.searchParams.get("handle") ?? "")
        .trim()
        .toLowerCase()
        .replace(/^@/, "");
      if (PROFILES[handle]) return start(send, handle);
      return send(200, signInPage());
    }
    if (!key) return send(200, signInPage());
    if (url.pathname === "/post") {
      const text = (url.searchParams.get("text") ?? "").trim().slice(0, 140);
      if (text)
        feeds[key].unshift([
          PROFILES[key].name,
          PROFILES[key].handle,
          "now",
          text,
          0,
          0,
        ]);
      return send(302, "", { location: "/" });
    }
    return send(200, feedPage({ ...PROFILES[key], feed: feeds[key] }));
  };
}
