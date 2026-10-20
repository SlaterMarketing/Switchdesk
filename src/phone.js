// Checking in from your phone: a small web page Switchdesk serves on your network, so a phone on
// the same Wi-Fi (or Tailscale) can see each chat, answer what an agent is waiting on, and send it a
// message. It's off until you turn it on in Settings → Phone. The phone signs in once, with the
// QR code's link or by typing a short code from Settings (10 minutes, 5 tries), and then keeps a
// cookie.
'use strict';

const http = require('http');
const os = require('os');
const crypto = require('crypto');

// The addresses a phone can reach this computer at: private networks, and Tailscale's 100.64/10.
function addresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list || []) {
      if (a.internal || a.family !== 'IPv4' && a.family !== 4) continue;
      const [x, y] = a.address.split('.').map(Number);
      const lan = x === 10 || (x === 172 && y >= 16 && y < 32) || (x === 192 && y === 168);
      const tailscale = x === 100 && y >= 64 && y < 128;
      if (lan || tailscale) out.push({ address: a.address, tailscale });
    }
  return out.sort((a, b) => a.tailscale - b.tailscale);
}

const same = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const cookieOf = (req) => (/(?:^|;\s*)sd=([^;]+)/.exec(req.headers.cookie || '') || [])[1];

// ask(what, args) answers from the windows: 'state', 'send' { chat, text }, 'answer' { chat, card, choice }, 'new' { text }.
function createPhoneServer({ ask, token, port = 0, host = '0.0.0.0' }) {
  let pair = null; // { code, until, tries }
  const signInCookie = `sd=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://phone');
    // Typing the short code instead of scanning.
    if (url.pathname === '/pair' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body.length < 1000 ? (body += c) : req.destroy()));
      req.on('end', () => {
        const typed = String(new URLSearchParams(body).get('code') || '').replace(/\D/g, '');
        const live = pair && pair.until > Date.now() && pair.tries < 5;
        if (live && same(typed, pair.code)) {
          pair = null; // one phone per code
          return res.writeHead(302, { location: '/', 'set-cookie': signInCookie }).end();
        }
        if (pair) pair.tries++;
        res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' }).end(pairPage(live && pair.tries < 5 ? "That code isn't right. Check it in Switchdesk and try again." : 'That code has run out. Make a new one in Switchdesk → Settings → Phone.'));
      });
      return;
    }
    const json = (code, body) => res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
    // Signing in: the QR code's link carries the code once, then it's a cookie.
    if (url.pathname === '/' && url.searchParams.has('t')) {
      if (!same(url.searchParams.get('t'), token)) return res.writeHead(403, { 'content-type': 'text/plain' }).end('That code is out of date. Scan the QR code in Switchdesk → Settings → Phone again.');
      return res.writeHead(302, { location: '/', 'set-cookie': signInCookie }).end();
    }
    const signedIn = same(cookieOf(req), token);
    if (url.pathname === '/') {
      if (!signedIn) return res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' }).end(pairPage(''));
      return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:" }).end(PAGE);
    }
    if (!url.pathname.startsWith('/api/')) return res.writeHead(404).end();
    if (!signedIn) return json(403, { error: 'Scan the QR code in Switchdesk again.' });
    // Only the page itself may make changes (a header another site's form can't send).
    if (req.method === 'POST' && req.headers['x-switchdesk'] !== '1') return json(403, { error: 'Not allowed.' });
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 65536) req.destroy();
    });
    req.on('end', async () => {
      try {
        const args = body ? JSON.parse(body) : {};
        if (req.method === 'GET' && url.pathname === '/api/state') return json(200, await ask('state'));
        if (req.method === 'POST' && url.pathname === '/api/send') return json(200, await ask('send', { chat: String(args.chat || ''), text: String(args.text || '').slice(0, 20000) }));
        if (req.method === 'POST' && url.pathname === '/api/new') return json(200, await ask('new', { text: String(args.text || '').slice(0, 20000) }));
        if (req.method === 'POST' && url.pathname === '/api/answer') return json(200, await ask('answer', { chat: String(args.chat || ''), card: String(args.card || ''), choice: String(args.choice || ''), text: String(args.text || '').slice(0, 4000) }));
        json(404, { error: 'Not found.' });
      } catch (e) {
        json(500, { error: String(e.message || e) });
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () =>
      resolve({
        port: server.address().port,
        // A new six-digit code to type on the phone, good for 10 minutes.
        pairCode() {
          pair = { code: String(crypto.randomInt(0, 1e6)).padStart(6, '0'), until: Date.now() + 10 * 60e3, tries: 0 };
          return { code: pair.code, until: pair.until };
        },
        close: () => new Promise((r) => (server.closeAllConnections && server.closeAllConnections(), server.close(() => r()))),
      })
    );
  });
}

const pairPage = (error) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Switchdesk</title>
<style>body{font:16px system-ui;padding:24px;max-width:420px;margin:auto;background:#f6f6f4;color:#1d1d1f}@media (prefers-color-scheme:dark){body{background:#16161a;color:#ececef}}
input{font:28px ui-monospace,monospace;letter-spacing:6px;width:100%;padding:12px;border-radius:10px;border:1px solid #bbb;box-sizing:border-box;text-align:center}button{font:inherit;width:100%;margin-top:12px;padding:14px;border-radius:10px;border:none;background:#d97757;color:#fff}.err{color:#c0392b}</style>
<h2>Switchdesk</h2><p>Type the code from Switchdesk → Settings → Phone on your computer, or scan its QR code.</p>${error ? `<p class="err">${error}</p>` : ''}
<form method="post" action="/pair"><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123456" autofocus><button>Sign in</button></form>`;

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#16161a"><title>Switchdesk</title>
<style>
:root{--bg:#f6f6f4;--card:#fff;--text:#1d1d1f;--dim:#6b6b70;--line:#e3e3df;--accent:#d97757;--good:#2f8f5b;--warn:#b7791f;--bad:#c0392b}
@media (prefers-color-scheme:dark){:root{--bg:#16161a;--card:#202026;--text:#ececef;--dim:#9a9aa3;--line:#2e2e36;--good:#4cc28a;--warn:#e0a84a;--bad:#e5675a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.45 -apple-system,system-ui,sans-serif;padding:16px 16px calc(16px + env(safe-area-inset-bottom))}
h1{font-size:20px;margin:4px 0 12px;display:flex;align-items:center;gap:8px}h1 small{font-weight:400;color:var(--dim);font-size:13px;margin-left:auto}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 14px;margin:0 0 10px}
.row{display:flex;align-items:center;gap:8px}.title{font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pill{font-size:12px;border-radius:99px;padding:2px 8px;border:1px solid var(--line);color:var(--dim);white-space:nowrap}
.pill.working{color:var(--warn);border-color:var(--warn)}.pill.waiting{color:#fff;background:var(--accent);border-color:var(--accent)}.pill.done{color:var(--good);border-color:var(--good)}
.meta{color:var(--dim);font-size:13px;margin-top:2px}.last{margin-top:6px;font-size:14px;color:var(--dim);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
button{font:inherit;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--text);padding:10px 14px;min-height:44px}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.danger{color:var(--bad)}
.ask{border-color:var(--accent)}.ask h3{margin:0 0 6px;font-size:15px}pre{white-space:pre-wrap;word-break:break-word;background:var(--bg);border-radius:8px;padding:8px;font-size:13px;margin:6px 0;max-height:200px;overflow:auto}
.btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}.btns button{flex:1}
.msg{margin:8px 0;white-space:pre-wrap;word-break:break-word}.msg.user{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:8px 10px;margin-left:15%}
.msg .who{font-size:12px;color:var(--dim)}
form{display:flex;gap:8px;position:sticky;bottom:0;background:var(--bg);padding:8px 0}textarea{flex:1;font:inherit;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--text);padding:10px;min-height:44px;resize:none}
.back{border:none;background:none;padding:0 4px;color:var(--accent);min-height:0}.empty{color:var(--dim);text-align:center;padding:24px}.err{color:var(--bad);font-size:14px}
</style></head><body>
<div id="app"><div class="empty">Loading…</div></div>
<script>
let open = null, data = null, typing = false;
const $app = document.getElementById('app');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const api = (path, body) => fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-switchdesk': '1' }, body: JSON.stringify(body) } : {}).then((r) => r.json());
const pill = (c) => c.waiting ? '<span class="pill waiting">Needs you</span>' : c.busy ? '<span class="pill working">Working</span>' : '<span class="pill done">Done</span>';
function askCard(c, a) {
  const btns = a.choices.map((x, i) => '<button data-chat="' + esc(c.id) + '" data-card="' + esc(a.id) + '" data-choice="' + esc(x.id) + '" class="' + (i === 0 ? 'primary' : x.id === 'deny' ? 'danger' : '') + '">' + esc(x.label) + '</button>').join('');
  return '<div class="card ask"><h3>' + esc(a.title) + '</h3>' + (a.detail ? '<pre>' + esc(a.detail) + '</pre>' : '') + (a.choices.length ? '<div class="btns">' + btns + '</div>' : '<div class="meta">Answer this one on your computer.</div>') + '</div>';
}
function render() {
  if (typing) return;
  if (!data) return;
  if (data.error) return ($app.innerHTML = '<div class="card err">' + esc(data.error) + '</div>');
  const c = open && data.chats.find((x) => x.id === open);
  if (!c) {
    open = null;
    const list = data.chats.map((c) => '<div class="card" data-open="' + esc(c.id) + '"><div class="row"><span class="title">' + esc(c.title) + '</span>' + pill(c) + '</div><div class="meta">' + esc(c.agent) + (c.folder ? ' · ' + esc(c.folder) : '') + '</div>' + (c.last ? '<div class="last">' + esc(c.last) + '</div>' : '') + '</div>' + c.asks.map((a) => askCard(c, a)).join('')).join('');
    $app.innerHTML = '<h1>Switchdesk<small>' + esc(data.computer) + '</small></h1>' + (list || '<div class="empty">No chats open.</div>') + '<form data-new="1"><textarea rows="1" placeholder="Start a new chat…"></textarea><button class="primary">Send</button></form>';
    return;
  }
  const msgs = c.messages.map((m) => '<div class="msg ' + m.role + '">' + (m.role === 'agent' ? '<div class="who">' + esc(c.agent) + '</div>' : '') + esc(m.text) + '</div>').join('');
  $app.innerHTML = '<h1><button class="back" data-back="1">‹ Chats</button><span class="title">' + esc(c.title) + '</span>' + pill(c) + '</h1><div class="meta">' + esc(c.agent) + (c.folder ? ' · ' + esc(c.folder) : '') + '</div>' + msgs + c.asks.map((a) => askCard(c, a)).join('') + '<form data-chat="' + esc(c.id) + '"><textarea rows="1" placeholder="' + (c.busy ? 'Queue a message…' : 'Message ' + esc(c.agent) + '…') + '"></textarea><button class="primary">Send</button></form>';
  if (c.messages.length && !render.scrolled) (render.scrolled = true), window.scrollTo(0, document.body.scrollHeight);
}
async function refresh() {
  try { data = await api('/api/state'); } catch (e) { data = { error: "Can't reach Switchdesk. Is your computer awake and on the same network?" }; }
  render();
}
document.addEventListener('focusin', (e) => { if (e.target.tagName === 'TEXTAREA') typing = true; });
document.addEventListener('focusout', (e) => { if (e.target.tagName === 'TEXTAREA' && !e.target.value) typing = false; });
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-open],[data-back],[data-choice]');
  if (!t) return;
  if (t.dataset.open) { open = t.dataset.open; render.scrolled = false; return render(); }
  if (t.dataset.back) { open = null; return render(); }
  if (t.dataset.choice) { t.disabled = true; const r = await api('/api/answer', { chat: t.dataset.chat, card: t.dataset.card, choice: t.dataset.choice }); if (r.error) alert(r.error); refresh(); }
});
document.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target, box = f.querySelector('textarea'), text = box.value.trim();
  if (!text) return;
  f.querySelector('button').disabled = true;
  const r = f.dataset.new ? await api('/api/new', { text }) : await api('/api/send', { chat: f.dataset.chat, text });
  typing = false;
  if (r.error) alert(r.error);
  if (r.chat) open = r.chat;
  render.scrolled = false;
  refresh();
});
refresh();
setInterval(refresh, 3000);
</script></body></html>`;

module.exports = { createPhoneServer, addresses };
