// Facet e2e stand: one plain-Node HTTP server answering for several hosts on loopback.
// Chrome resolves every *.localhost name to 127.0.0.1 without DNS, so a.localhost, sub.a.localhost, b.localhost,
// sso.localhost and cdn.localhost are distinct sites (registrable domains) on one port.
//
//   node test-server/server.mjs [port]        (default 47321, or $FACET_TEST_PORT)
//
// Every dynamic response is `Cache-Control: no-store`. GET /__log returns every request seen (host, path, Cookie
// header), GET /__log?clear=1 empties it; the e2e tests use it to check what the FIRST request of a flow carried.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const PORT = Number(process.argv[2] ?? process.env.FACET_TEST_PORT ?? 47321);
const sessions = new Map(); // sid -> user (per host family: a.localhost and sub.a.localhost share)
const ssoSessions = new Map(); // sso_sid -> user
const codes = new Map(); // oauth code -> user
let log = [];

const token = () => randomBytes(9).toString('base64url');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const parseCookies = (header = '') =>
  Object.fromEntries(
    header
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const i = p.indexOf('=');
        return i === -1 ? ['', p] : [p.slice(0, i), p.slice(i + 1)];
      }),
  );

/** A solid-colour square PNG (the "page with a PNG favicon" of the activity tests). */
function solidPng(size, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b, 255]).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PNG_ICON = solidPng(32, [0, 120, 255]);

function page(title, body, head = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>${head}</head><body>${body}</body></html>`;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8', ...headers });
  res.end(body);
}

function json(res, value, headers = {}) {
  send(res, 200, JSON.stringify(value), { 'content-type': 'application/json', 'access-control-allow-origin': '*', ...headers });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if ((req.headers['content-type'] ?? '').includes('json')) {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

const server = createServer(async (req, res) => {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '');
  const origin = `http://${req.headers.host}`;
  const url = new URL(req.url ?? '/', origin);
  const cookieHeader = req.headers.cookie ?? '';
  const cookies = parseCookies(cookieHeader);
  const path = url.pathname;
  if (path !== '/__log' && path !== '/favicon.ico') log.push({ at: Date.now(), host, path: url.pathname + url.search, method: req.method, cookie: cookieHeader });
  const userOf = () => (cookies.sid && sessions.get(cookies.sid)) || null;
  const port = req.headers.host?.split(':')[1] ?? String(PORT);
  const at = (h, p) => `http://${h}:${port}${p}`;

  switch (path) {
    case '/__log':
      if (url.searchParams.has('clear')) log = [];
      return json(res, log);
    case '/favicon.ico':
      return send(res, 204, '');
    case '/':
    case '/blank':
      return send(res, 200, page(`${host} blank`, `<h1>${esc(host)}</h1><p id="path">${esc(url.pathname)}</p>`));
    case '/me':
      return json(res, { host, user: userOf(), cookie: cookieHeader });
    case '/echo':
      return send(res, 200, cookieHeader, { 'content-type': 'text/plain' });
    case '/whoami':
      return send(
        res,
        200,
        page(`${host} whoami`, `<pre id="user">${esc(userOf() ?? 'anonymous')}</pre><pre id="cookies">${esc(cookieHeader)}</pre>`),
      );
    case '/login': {
      // 302 login: HttpOnly session cookie on the redirect itself.
      const user = url.searchParams.get('user') ?? 'anon';
      const sid = token();
      sessions.set(sid, user);
      return send(res, 302, '', { location: url.searchParams.get('next') ?? '/whoami', 'set-cookie': `sid=${sid}; HttpOnly; Path=/; SameSite=Lax` });
    }
    case '/api/login': {
      // XHR / fetch login.
      const body = req.method === 'POST' ? await readBody(req) : Object.fromEntries(url.searchParams);
      const user = String(body.user ?? 'anon');
      const sid = token();
      sessions.set(sid, user);
      return json(res, { ok: true, user }, { 'set-cookie': `sid=${sid}; HttpOnly; Path=/; SameSite=Lax` });
    }
    case '/logout':
      return send(res, 302, '', { location: '/whoami', 'set-cookie': 'sid=; Max-Age=0; Path=/' });
    case '/set': {
      // /set?c=<Set-Cookie value>&c=... : arbitrary Set-Cookie headers, e.g. host-only vs Domain cookies.
      const values = url.searchParams.getAll('c');
      return send(res, 200, page('set', `<pre id="set">${esc(values.join('\n'))}</pre>`), { 'set-cookie': values });
    }
    case '/doc-cookie': {
      const v = url.searchParams.get('v') ?? 'x';
      return send(
        res,
        200,
        page(
          'doc-cookie',
          `<pre id="before"></pre><pre id="after"></pre><script>
            document.getElementById('before').textContent = document.cookie;
            document.cookie = 'pref=' + ${JSON.stringify(v)} + '; Path=/';
            document.getElementById('after').textContent = document.cookie;
          </script>`,
        ),
      );
    }
    case '/sw.js':
      return send(res, 200, `self.addEventListener('fetch', () => {});`, { 'content-type': 'text/javascript' });
    case '/sw-page':
      return send(
        res,
        200,
        page(
          'sw',
          `<pre id="sw">pending</pre><script>
            window.__sw = navigator.serviceWorker.register('/sw.js').then(() => 'registered', (e) => 'rejected: ' + e.name);
            window.__sw.then((r) => (document.getElementById('sw').textContent = r));
          </script>`,
        ),
      );
    case '/swnet.js':
      // Network-first service worker: answers every fetch (navigations included) with its own fetch(), whose
      // requests belong to no tab (tabId -1).
      return send(
        res,
        200,
        `self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', (e) => e.waitUntil(clients.claim())); self.addEventListener('fetch', (e) => e.respondWith(fetch(e.request)));`,
        { 'content-type': 'text/javascript' },
      );
    case '/swnet-page':
      return send(
        res,
        200,
        page(
          'swnet',
          `<pre id="sw">pending</pre><script>
            navigator.serviceWorker.register('/swnet.js').then(() => navigator.serviceWorker.ready).then(
              () => (document.getElementById('sw').textContent = 'active'),
              (e) => (document.getElementById('sw').textContent = 'rejected: ' + e.name),
            );
          </script>`,
        ),
      );
    case '/shared.js':
      return send(res, 200, `onconnect = (e) => { const p = e.ports[0]; fetch('/echo?from=shared').then(r => r.text()).then(t => p.postMessage(t)); };`, {
        'content-type': 'text/javascript',
      });
    case '/dedicated.js':
      return send(res, 200, `fetch('/echo?from=dedicated').then(r => r.text()).then(t => postMessage(t));`, { 'content-type': 'text/javascript' });
    case '/frame-host': {
      const child = url.searchParams.get('child') ?? at('cdn.localhost', '/frame');
      return send(res, 200, page('frame-host', `<pre id="me">${esc(cookieHeader)}</pre><iframe id="f" src="${esc(child)}"></iframe>`));
    }
    case '/frame':
      return send(
        res,
        200,
        page(
          'frame',
          `<pre id="cookies">${esc(cookieHeader)}</pre><pre id="doc"></pre><script>document.getElementById('doc').textContent = document.cookie;</script>`,
        ),
      );
    // ---- OAuth-like flow: a.localhost -> sso.localhost -> a.localhost
    case '/sso/login': {
      const user = url.searchParams.get('user') ?? 'anon';
      const sid = token();
      ssoSessions.set(sid, user);
      return send(res, 302, '', { location: url.searchParams.get('next') ?? '/whoami-sso', 'set-cookie': `sso_sid=${sid}; HttpOnly; Path=/` });
    }
    case '/whoami-sso':
      return send(res, 200, page('sso whoami', `<pre id="user">${esc((cookies.sso_sid && ssoSessions.get(cookies.sso_sid)) || 'anonymous')}</pre>`));
    case '/authorize': {
      const user = cookies.sso_sid && ssoSessions.get(cookies.sso_sid);
      const redirect = url.searchParams.get('redirect_uri') ?? '';
      if (!user) return send(res, 401, page('sso', `<pre id="user">anonymous</pre><p>not logged in at sso</p>`));
      const code = token();
      codes.set(code, user);
      return send(res, 302, '', { location: `${redirect}${redirect.includes('?') ? '&' : '?'}code=${code}` });
    }
    case '/oauth/start':
      return send(res, 302, '', { location: at('sso.localhost', `/authorize?redirect_uri=${encodeURIComponent(at(host, '/oauth/callback'))}`) });
    case '/oauth/callback':
    case '/oauth/popup-done': {
      const user = codes.get(url.searchParams.get('code') ?? '');
      codes.delete(url.searchParams.get('code') ?? '');
      if (!user) return send(res, 400, page('oauth', '<pre id="user">bad code</pre>'));
      const sid = token();
      sessions.set(sid, user);
      const setCookie = `sid=${sid}; HttpOnly; Path=/; SameSite=Lax`;
      if (path === '/oauth/callback') return send(res, 302, '', { location: '/whoami', 'set-cookie': setCookie });
      return send(
        res,
        200,
        page('popup done', `<pre id="user">${esc(user)}</pre><script>window.opener && window.opener.postMessage({ user: ${JSON.stringify(user)} }, '*');</script>`),
        { 'set-cookie': setCookie },
      );
    }
    case '/popup-login':
      return send(
        res,
        200,
        page(
          'popup login',
          `<pre id="result">waiting</pre><script>
            window.addEventListener('message', (e) => { if (e.data && e.data.user) document.getElementById('result').textContent = e.data.user; });
            window.startLogin = () => window.open(${JSON.stringify(at('sso.localhost', `/authorize?redirect_uri=${encodeURIComponent(at(host, '/oauth/popup-done'))}`))}, 'oauth', 'width=500,height=600');
          </script><button id="go" onclick="window.__popup = startLogin()">Log in with SSO</button>`,
        ),
      );
    case '/form':
      // target=_blank form: not intercepted by the shim, so the new tab takes Facet's fallback path.
      return send(
        res,
        200,
        page('form', `<form id="f" action="/whoami" method="get" target="_blank"><input name="via" value="form"><button id="submit">go</button></form>`),
      );
    case '/link': {
      // A link (optionally with a target) and a POST form to an arbitrary address (cross-site navigations from this page).
      const to = url.searchParams.get('to') ?? '/';
      const target = url.searchParams.get('target');
      return send(
        res,
        200,
        page('link', `<a id="go" href="${esc(to)}"${target ? ` target="${esc(target)}"` : ''}>go</a><form id="post" method="post" action="${esc(to)}"><input name="x" value="1"><button id="post-go">post</button></form>`),
      );
    }
    case '/links':
      return send(
        res,
        200,
        page(
          'links',
          `<a id="blank" href="${esc(at(host, '/whoami?via=blank'))}" target="_blank">blank</a>
           <a id="opener" href="${esc(at(host, '/whoami?via=opener'))}" target="_blank" rel="opener">opener</a>
           <a id="same" href="${esc(at(host, '/whoami?via=same'))}">same</a>`,
        ),
      );
    case '/spa':
      // A page whose title changes under a title-prefix observer: via document.title, via the element's text, by
      // replacing the element, and by appending to the title it just read.
      return send(
        res,
        200,
        page(
          'Inbox',
          `<button id="t-prop">prop</button><button id="t-text">text</button><button id="t-replace">replace</button><button id="t-append">append</button>
           <script>
             document.getElementById('t-prop').onclick = () => { document.title = 'Inbox (3)'; };
             document.getElementById('t-text').onclick = () => { document.querySelector('title').textContent = 'Settings'; };
             document.getElementById('t-replace').onclick = () => { const t = document.createElement('title'); t.textContent = 'Replaced'; document.querySelector('title').replaceWith(t); };
             document.getElementById('t-append').onclick = () => { document.title = document.title + ' !'; };
           </script>`,
        ),
      );
    case '/late-title':
      // No <title> at first; one is created a moment later.
      return send(res, 200, `<!doctype html><html><head><meta charset="utf-8"></head><body><script>setTimeout(() => { document.title = 'Late title'; }, 150);</script></body></html>`);
    case '/agent':
    case '/agent-csp': {
      // Page for the agent bridge tools: fields, a button, a form, a long page, a page-world variable.
      // /agent-csp forbids eval (no 'unsafe-eval'), so run_js cannot evaluate code strings there.
      const headers = path === '/agent-csp' ? { 'content-security-policy': "script-src 'self' 'unsafe-inline'" } : {};
      return send(
        res,
        200,
        page(
          'Agent page',
          `<h1 id="title">Agent page</h1><p id="user">${esc(userOf() ?? 'anonymous')}</p>
           <input id="name" type="text"><textarea id="note"></textarea>
           <button id="go">Go</button>
           <form id="f" action="/agent-submit" method="get"><input id="q" name="q"><button id="search" type="submit">Search</button></form>
           <p id="out"></p><pre id="echo"></pre>
           <div style="height:3000px"></div><p id="bottom">bottom</p>
           <script>
             window.pageVar = 42;
             document.getElementById('go').addEventListener('click', () => { document.getElementById('out').textContent = 'clicked:' + document.getElementById('name').value; });
             document.getElementById('name').addEventListener('input', (e) => { document.getElementById('echo').textContent = 'input:' + e.target.value; });
             document.getElementById('name').addEventListener('change', (e) => { document.getElementById('echo').textContent += '|change'; });
           </script>`,
        ),
        headers,
      );
    }
    case '/cdp':
      // Page for the CDP ("full hands") tools: every handler records whether the event was trusted (a real input event).
      return send(
        res,
        200,
        page(
          'CDP page',
          `<h1>CDP page</h1><p id="user">${esc(userOf() ?? 'anonymous')}</p>
           <button id="trusted">Join</button> <pre id="log"></pre>
           <label for="ctl">Controlled</label> <input id="ctl"> <pre id="ctl-state"></pre>
           <form id="kf" action="/agent-submit" method="get"><input id="kq" name="q" aria-label="Query"></form>
           <div id="hov" style="display:inline-block;padding:8px">Hover me</div> <pre id="hov-out"></pre>
           <label for="size">Size</label> <select id="size"><option value="s">Small</option><option value="m">Medium</option><option value="l">Large</option></select> <pre id="size-out"></pre>
           <label for="file">Attachment</label> <input type="file" id="file" multiple> <pre id="file-out"></pre>
           <button id="alert">Alert</button> <button id="confirm">Confirm</button> <button id="prompt">Prompt</button> <pre id="dialog-out"></pre>
           <button id="logs">Log things</button>
           <label for="keys">Keys</label> <input id="keys" value="abc"> <pre id="keys-out"></pre>
           <div id="track" style="position:relative;width:300px;height:30px;background:#ddd"><div id="handle" style="position:absolute;left:0;top:0;width:30px;height:30px;background:#333"></div></div> <pre id="drag-out"></pre>
           <div id="dragsrc" draggable="true" style="display:inline-block;width:60px;height:30px;background:#8c8">drag me</div>
           <div id="drop" style="display:inline-block;width:120px;height:40px;background:#88c">drop here</div> <pre id="drop-out"></pre>
           <button id="later">Later</button> <p id="later-out"></p>
           <style>#hov:hover { background: rgb(255, 200, 0); }</style>
           <script>
             const $ = (id) => document.getElementById(id);
             const note = (id, text) => { $(id).textContent += text + '\\n'; };
             $('trusted').addEventListener('click', (e) => note('log', 'click trusted=' + e.isTrusted + ' detail=' + e.detail + ' shift=' + e.shiftKey));
             $('trusted').addEventListener('dblclick', (e) => note('log', 'dblclick trusted=' + e.isTrusted));
             $('trusted').addEventListener('contextmenu', (e) => { e.preventDefault(); note('log', 'contextmenu trusted=' + e.isTrusted); });
             // A React-like controlled input: the instance's value setter is tracked, and an input event whose value
             // equals the tracked one is ignored (that is how React drops values set by a script).
             (() => {
               const el = $('ctl');
               const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
               let tracked = '';
               let state = '';
               Object.defineProperty(el, 'value', { configurable: true, get() { return proto.get.call(this); }, set(v) { tracked = String(v); proto.set.call(this, v); } });
               el.addEventListener('input', (e) => {
                 const now = proto.get.call(el);
                 if (now === tracked) return;
                 tracked = now;
                 state = now;
                 el.value = state; // controlled: re-render from state
                 $('ctl-state').textContent = 'state=' + state + ' trusted=' + e.isTrusted;
               });
             })();
             $('hov').addEventListener('mouseenter', (e) => { $('hov-out').textContent = 'entered trusted=' + e.isTrusted; });
             $('size').addEventListener('change', (e) => { $('size-out').textContent = 'size=' + e.target.value; });
             $('file').addEventListener('change', (e) => { $('file-out').textContent = Array.from(e.target.files).map((f) => f.name + ':' + f.size).join(','); });
             $('alert').addEventListener('click', () => { alert('hello from the page'); note('dialog-out', 'alert closed'); });
             $('confirm').addEventListener('click', () => { note('dialog-out', 'confirm=' + confirm('Sure?')); });
             $('prompt').addEventListener('click', () => { note('dialog-out', 'prompt=' + prompt('Name?', 'x')); });
             $('logs').addEventListener('click', () => { console.log('hello console', { a: 1 }); console.error('bad thing'); fetch('/api/ping?n=1'); setTimeout(() => { throw new Error('thrown later'); }, 10); });
             $('keys').addEventListener('keydown', (e) => note('keys-out', e.key + (e.metaKey ? '+meta' : '') + (e.ctrlKey ? '+ctrl' : '') + ' trusted=' + e.isTrusted));
             (() => {
               let start = null;
               $('handle').addEventListener('mousedown', (e) => { start = e.clientX; });
               addEventListener('mousemove', (e) => { if (start !== null) $('handle').style.left = Math.max(0, Math.min(270, e.clientX - start)) + 'px'; });
               addEventListener('mouseup', (e) => { if (start === null) return; $('drag-out').textContent = 'moved=' + Math.round(e.clientX - start) + ' trusted=' + e.isTrusted; start = null; });
             })();
             $('dragsrc').addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', 'payload-42'));
             $('drop').addEventListener('dragover', (e) => e.preventDefault());
             $('drop').addEventListener('drop', (e) => { e.preventDefault(); $('drop-out').textContent = 'dropped=' + e.dataTransfer.getData('text/plain'); });
             $('later').addEventListener('click', () => setTimeout(() => { $('later-out').textContent = 'Ready now'; }, 700));
           </script>`,
        ),
      );
    case '/cdp-frames':
      return send(
        res,
        200,
        page(
          'Frames',
          `<h1>Frames</h1><iframe id="same" title="Same site" src="/cdp-child" width="300" height="120"></iframe>
           <iframe id="cross" title="Other site" src="${esc(at('b.localhost', '/cdp-child'))}" width="300" height="120"></iframe>`,
        ),
      );
    case '/cdp-child':
      return send(
        res,
        200,
        page(
          `child ${host}`,
          `<button id="inside" onclick="document.getElementById('out').textContent = 'inside clicked trusted=' + event.isTrusted">Inside ${esc(host)}</button><p id="out"></p>`,
        ),
      );
    case '/cdp-csp':
      // A page that forbids eval and inline scripts: only its own files run.
      return send(res, 200, page('Strict page', `<h1>Strict page</h1><script src="/cdp-csp.js"></script>`), { 'content-security-policy': "script-src 'self'" });
    case '/cdp-csp.js':
      return send(res, 200, 'window.cspVar = 7; try { eval("1"); window.pageEval = "ran"; } catch (e) { window.pageEval = e.name; }', { 'content-type': 'text/javascript' });
    case '/api/ping':
      return json(res, { pong: true });
    case '/icon-page':
      // A page with a favicon of its own (same origin, drawable).
      return send(res, 200, page('Icon page', `<h1>Icon page</h1>`, '<link rel="icon" id="own-icon" href="/icon.svg">'));
    case '/icon-png-page':
      // Icons given as PNG: a plain one, a "shortcut icon" and an apple-touch-icon (not a favicon: never touched).
      return send(
        res,
        200,
        page(
          'PNG icon page',
          `<h1>PNG icon page</h1>`,
          '<link rel="icon" type="image/png" id="own-icon" href="/icon.png"><link rel="shortcut icon" id="shortcut" href="/icon.png?v=2"><link rel="apple-touch-icon" id="apple" href="/icon.png?v=3">',
        ),
      );
    case '/icon.png':
      return send(res, 200, PNG_ICON, { 'content-type': 'image/png' });
    case '/icon-fw-page':
      // A framework-like page: it owns its icon link and rewrites it (href, or a whole new node) whenever the app asks.
      return send(
        res,
        200,
        page(
          'Framework icon page',
          `<h1>Framework icon page</h1>
           <script>
             window.setIcon = (href) => document.getElementById('fw-icon').setAttribute('href', href);
             window.swapIcon = (href) => {
               const old = document.getElementById('fw-icon');
               const next = document.createElement('link');
               next.rel = 'icon'; next.id = 'fw-icon'; next.type = 'image/png'; next.href = href;
               old.replaceWith(next);
             };
           </script>`,
          '<link rel="icon" type="image/png" id="fw-icon" href="/icon.png">',
        ),
      );
    case '/spa-nav':
      // An app that changes address and title by itself when a button is pressed (history.pushState + document.title).
      return send(
        res,
        200,
        page(
          'SPA home',
          `<h1>SPA</h1><button id="nav">Next</button>
           <script>
             document.getElementById('nav').addEventListener('click', () => {
               history.pushState({}, '', '/spa-nav?page=2');
               window.__navAt = performance.now();
               document.title = 'SPA page 2';
             });
           </script>`,
        ),
      );
    case '/icon.svg':
      return send(res, 200, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#0a0"/></svg>', { 'content-type': 'image/svg+xml' });
    case '/agent-submit':
      return send(res, 200, page('Submitted', `<pre id="submitted">${esc(url.searchParams.get('q') ?? '')}</pre>`));
    default:
      return send(res, 404, page('404', `<p>no route ${esc(path)}</p>`));
  }
});

server.on('upgrade', (req, socket) => {
  log.push({ at: Date.now(), host: (req.headers.host ?? '').replace(/:\d+$/, ''), path: `${req.url} (websocket)`, method: 'GET', cookie: req.headers.cookie ?? '' });
  socket.destroy();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`facet test server on http://a.localhost:${PORT}/ (and sub.a., b., sso., cdn.localhost)`);
});
