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
