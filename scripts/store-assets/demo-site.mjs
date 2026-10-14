// The fake sites of the Chrome Web Store pictures (scripts/store-assets.mjs): neutral, invented products on *.example
// names (no real brand, logo or trademark). One plain-Node server answers for all of them by Host header; Chromium is
// pointed at it with --host-resolver-rules, so the popup shows "mail.example" and not a port number.
//
// "Postline" (mail.example) is a small webmail with two demo accounts. Signing in is a cookie, so the two accounts only
// stay apart because SplitSession gives each container tab its own cookies: that is the thing the pictures show.
// "Loop" (loop.example, loop-site.mjs) is a small social network: the demo of the README animations and of the Chrome Web
// Store pictures. The pictures no longer use Postline; it stays as a second demo site.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";

// eslint-disable-next-line import/extensions -- local .mjs module, run directly by node
import { createLoop } from "./loop-site.mjs";

const require = createRequire(import.meta.url);
const INTER = readFileSync(
  require.resolve("@fontsource-variable/inter/files/inter-latin-wght-normal.woff2"),
);

const ACCOUNTS = {
  work: {
    name: "Dana Whitfield",
    email: "dana@northwind.example",
    initials: "DW",
    avatar: "#3b5b8c",
    mails: [
      [
        "Priya Nair",
        "Q4 roadmap review, agenda attached",
        "Hi all, here is the plan for Thursday and the open",
        "9:41",
        1,
      ],
      [
        "Northwind Finance",
        "Invoice 2041 approved",
        "Your invoice was approved and will be paid on",
        "9:12",
        1,
      ],
      [
        "Tomas Berg",
        "Re: Launch checklist",
        "Two items left: the support macros and the",
        "8:30",
        1,
      ],
      [
        "Mei Tanaka",
        "Design handoff: onboarding screens",
        "Everything is in the shared folder. The new empty",
        "Yesterday",
        0,
      ],
      [
        "Ops Alerts",
        "Weekly uptime report",
        "All services ran at 99.98 percent this week.",
        "Yesterday",
        0,
      ],
      [
        "People Team",
        "Benefits enrolment closes Friday",
        "A reminder that the enrolment window ends on",
        "Mon",
        0,
      ],
    ],
  },
  personal: {
    name: "Dana W.",
    email: "dana.w@homebox.example",
    initials: "DW",
    avatar: "#a2557a",
    mails: [
      [
        "Mum",
        "Sunday lunch?",
        "Are you coming at one? Dad is making the soup",
        "10:05",
        1,
      ],
      [
        "Riverside Library",
        "Your hold is ready",
        "The book you reserved is waiting at the front desk",
        "9:20",
        1,
      ],
      [
        "Sam Okafor",
        "Photos from the trip",
        "Finally sorted them. The mountain ones turned out",
        "8:47",
        1,
      ],
      [
        "Greenfield Gym",
        "Your class is booked",
        "See you Saturday at 9:30 for Open Studio.",
        "Yesterday",
        0,
      ],
      [
        "Luca",
        "Football on Saturday",
        "We are one short, any chance you can come?",
        "Yesterday",
        0,
      ],
      [
        "Weekend Reads",
        "Five long articles worth your time",
        "This week: a history of lighthouses, why bread",
        "Mon",
        0,
      ],
    ],
  },
};

const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

const FONT_CSS = `@font-face{font-family:"Demo Inter";font-weight:100 900;src:url(/_inter.woff2) format("woff2")}`;
const LOGO = (fill) =>
  `<svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true"><rect width="28" height="28" rx="8" fill="${fill}"/><path d="M6 9.5h16v9.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 6 19z" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"/><path d="m7 10 7 5.5 7-5.5" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>`;

function shell(title, accent, body, extraCss = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><style>${FONT_CSS}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{font:14px/1.4 "Demo Inter",system-ui,sans-serif;color:#1d1f24;background:#fff;overflow:hidden}
${extraCss}</style></head><body>${body}</body></html>`;
}

function mailPage(user) {
  const a = ACCOUNTS[user];
  const unread = a.mails.filter((m) => m[4]).length;
  const rows = a.mails
    .map(
      ([
        from,
        subject,
        preview,
        time,
        isNew,
      ]) => `<li class="${isNew ? "new" : ""}">
<span class="av">${esc(from[0])}</span><div class="txt"><div class="top"><b>${esc(from)}</b><time>${esc(time)}</time></div>
<div class="sub">${esc(subject)}</div><div class="pre">${esc(preview)}</div></div></li>`,
    )
    .join("");
  const body = `<div class="app">
<header>${LOGO("#d9480f")}<b class="brand">Postline</b><span class="search">Search mail</span></header>
<div class="cols"><nav>
<div class="me"><span class="avatar" style="background:${a.avatar}">${a.initials}</span><b>${esc(a.name)}</b><small>${esc(a.email)}</small></div>
<div class="compose">Compose</div>
<ul class="folders"><li class="on">Inbox <i>${unread}</i></li><li>Starred</li><li>Sent</li><li>Drafts <i>2</i></li><li>Archive</li></ul></nav>
<main><h2>Inbox</h2><ul class="list">${rows}</ul></main></div></div>`;
  return shell(
    `Inbox (${unread}) – Postline`,
    "#d9480f",
    body,
    `.app{display:flex;flex-direction:column;height:100%}
header{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid #e6e8ec;background:#fff}
.brand{font-size:18px;font-weight:700;color:#d9480f;letter-spacing:-.01em}
.search{margin-left:18px;flex:1;max-width:340px;background:#f1f3f6;border-radius:999px;padding:7px 14px;color:#7a808c}
.cols{flex:1;display:flex;min-height:0}
nav{width:176px;flex:none;padding:14px 10px;border-right:1px solid #e6e8ec;background:#fafbfc}
.me{padding:4px 6px 14px}
.me b{display:block;font-size:14px;line-height:1.25;margin-top:8px}.me small{display:block;font-size:12px;color:#5c6370;line-height:1.3;margin-top:1px}
.avatar{width:34px;height:34px;flex:none;border-radius:50%;color:#fff;display:grid;place-items:center;font-weight:600;font-size:13px}
.compose{background:#d9480f;color:#fff;font-weight:600;border-radius:10px;text-align:center;padding:9px;margin:0 4px 12px}
.folders{list-style:none;margin:0;padding:0}.folders li{display:flex;justify-content:space-between;padding:7px 10px;border-radius:8px;color:#3a3f48}
.folders li.on{background:#ffe9df;color:#a8340a;font-weight:600}.folders i{font-style:normal;font-size:12px}
main{flex:1;min-width:0;padding:12px 0 0}main h2{font-size:15px;margin:0 16px 8px}
.list{list-style:none;margin:0;padding:0}.list li{display:flex;gap:11px;padding:9px 16px;border-top:1px solid #eef0f3}
.av{width:30px;height:30px;flex:none;border-radius:50%;background:#e6e8ec;color:#4a505c;display:grid;place-items:center;font-weight:600;font-size:12px}
.txt{min-width:0;flex:1}.top{display:flex;justify-content:space-between;gap:8px}.top b{font-weight:500}.top time{color:#7a808c;font-size:12px;flex:none}
.sub,.pre{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.pre{color:#7a808c;font-size:13px}
.list li.new{background:#fffaf7}.list li.new .top b,.list li.new .sub{font-weight:700}`,
  );
}

function signInPage() {
  return shell(
    "Sign in – Postline",
    "#d9480f",
    `<div style="display:grid;place-items:center;height:100%"><div style="width:300px;text-align:center">
${LOGO("#d9480f")}<h1 style="font-size:20px;margin:12px 0 18px">Sign in to Postline</h1>
<div style="border:1px solid #d6d9df;border-radius:8px;padding:10px;text-align:left;color:#7a808c;margin-bottom:10px">Email</div>
<div style="background:#d9480f;color:#fff;border-radius:8px;padding:10px;font-weight:600">Continue</div></div></div>`,
  );
}

/** Other neutral demo sites: a title, an accent colour and a heading are enough, they only need to be open. */
const SITES = {
  "board.example": ["Sprint board – Boardly", "#0a7d6a", "Sprint 14"],
  "invoices.example": ["Invoices – Ledgerly", "#5b3fd1", "Invoices"],
  "notes.example": ["Notes – Notely", "#b5530b", "Side project notes"],
  "social.example": ["Home – Socially", "#c2264d", "Home"],
};

function plainPage(host) {
  const [title, accent, heading] = SITES[host] ?? [host, "#555", host];
  return shell(
    title,
    accent,
    `<header style="display:flex;gap:10px;padding:12px 16px;border-bottom:1px solid #e6e8ec">${LOGO(accent)}<b style="font-size:18px;color:${accent}">${esc(title.split(" – ")[1] ?? host)}</b></header><h2 style="margin:20px 16px">${esc(heading)}</h2>`,
  );
}

const cookieOf = (req, name) =>
  (req.headers.cookie ?? "")
    .split(";")
    .map((p) => p.trim().split("="))
    .find(([k]) => k === name)?.[1];

/** Starts the demo server on `port`; resolves to the server (close() to stop it). */
export function startDemoSite(port) {
  const sessions = new Map(); // sid -> account key
  let next = 0;
  const loop = createLoop();
  const server = createServer((req, res) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    const url = new URL(req.url ?? "/", `http://${host}`);
    const send = (status, body, headers = {}) => {
      res.writeHead(status, {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
        ...headers,
      });
      res.end(body);
    };
    if (url.pathname === "/_inter.woff2")
      return send(200, INTER, { "content-type": "font/woff2" });
    if (url.pathname === "/favicon.ico") return send(204, "");
    if (host === "loop.example")
      return loop(req, res, url, send, cookieOf(req, "sid"));
    if (host !== "mail.example") return send(200, plainPage(host));
    if (url.pathname === "/login") {
      const user = url.searchParams.get("user") ?? "work";
      const sid = `demo${++next}`;
      sessions.set(sid, user);
      return send(302, "", {
        location: "/",
        "set-cookie": `sid=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`,
      });
    }
    const user = sessions.get(cookieOf(req, "sid") ?? "");
    return send(200, user ? mailPage(user) : signInPage());
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
