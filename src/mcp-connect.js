// Signing in to an MCP server that needs it (Jira, Linear, a claude.ai connector): Claude Code
// starts the sign-in and gives back a page to open, Switchdesk opens it in the browser, and Claude
// Code finishes it and keeps the token. This runs in a short-lived Claude Code process of its own,
// so a server added a moment ago is seen; open chats are then reconnected (main.js).
'use strict';

const { ChatSession } = require('./session');

const later = (ms) => new Promise((r) => setTimeout(r, ms));

// The configured server a name means: exact, then any case, then one name containing the other
// ("atlassian" finds "claude.ai Atlassian Rovo").
function findServer(servers, name) {
  const want = String(name || '').trim().toLowerCase();
  if (!want) return null;
  return (
    servers.find((s) => s.name === name) ||
    servers.find((s) => s.name.toLowerCase() === want) ||
    servers.find((s) => s.name.toLowerCase().replace(/^claude\.ai /, '') === want) ||
    servers.find((s) => s.name.toLowerCase().includes(want) || want.includes(s.name.toLowerCase().replace(/^claude\.ai /, ''))) ||
    null
  );
}

const statusOf = async (session) => {
  const r = await session.control({ subtype: 'mcp_status' });
  if (r.error) throw new Error(r.error);
  return (r.response && r.response.mcpServers) || [];
};

// Signs in to one server through one Claude Code process, and waits until it's connected.
async function signIn(session, server, openUrl, timeoutMs) {
  const done = (s, already) => ({ ok: true, name: s.name, tools: (s.tools || []).map((t) => t.name), already });
  if (server.status === 'connected') return done(server, true);
  const auth = await session.control({ subtype: 'mcp_authenticate', serverName: server.name });
  if (auth.error) {
    // Not one that signs in: try connecting it again instead.
    await session.control({ subtype: 'mcp_reconnect', serverName: server.name });
    const s = (await statusOf(session)).find((x) => x.name === server.name);
    return s && s.status === 'connected' ? done(s, false) : { ok: false, error: auth.error };
  }
  const a = auth.response || {};
  if (a.authUrl) openUrl(a.authUrl, server.name);
  // A sign-in that comes back to Claude Code connects by itself. A claude.ai connector is
  // connected on claude.ai, so Switchdesk asks again every few seconds.
  const until = Date.now() + timeoutMs;
  for (let i = 0; Date.now() < until && session.alive; i++) {
    await later(2000);
    if (a.callbackExpected === false && i % 2) await session.control({ subtype: 'mcp_reconnect', serverName: server.name });
    const s = (await statusOf(session)).find((x) => x.name === server.name);
    if (s && s.status === 'connected') return done(s, false);
  }
  return { ok: false, error: `Signing in to ${server.name} wasn't finished in time.` };
}

// Resolves to { ok, name, tools } once connected, or { ok: false, error, servers }. sessions are
// open chats' Claude Code processes, tried first: they already have the servers loaded (claude.ai
// connectors among them), and a sign-in there gives that chat the tools straight away.
async function connect({ bin, cwd, env, name, openUrl, sessions = [], timeoutMs = 240000 }) {
  let seen = [];
  for (const session of sessions) {
    const servers = await statusOf(session).catch(() => []);
    if (servers.length > seen.length) seen = servers;
    const server = findServer(servers, name);
    if (server) return signIn(session, server, openUrl, timeoutMs);
  }
  // Otherwise a short-lived process of its own, which also sees a server added a moment ago.
  const session = new ChatSession({ bin, cwd, env, mode: 'ask', onEvent: () => {}, onPermission: async () => ({ behavior: 'deny' }), onExit: () => {} });
  await session.start();
  try {
    // Servers are still loading and connecting when the process starts. Wait for them to settle.
    let servers = await statusOf(session);
    for (let i = 0; i < 20 && (!findServer(servers, name) || servers.some((s) => s.status === 'pending')); i++) {
      await later(1000);
      servers = await statusOf(session);
    }
    const server = findServer(servers, name);
    if (servers.length > seen.length) seen = servers;
    const list = seen.map((s) => ({ name: s.name, status: s.status }));
    if (!server) return { ok: false, missing: true, error: `There's no MCP server called "${name}".`, servers: list };
    const r = await signIn(session, server, openUrl, timeoutMs);
    return r.ok ? r : { ...r, servers: list };
  } finally {
    session.dispose();
  }
}

// The last resort, for a server `claude mcp list` shows but a Claude Code process doesn't load:
// `claude mcp login` in a terminal of its own, which opens the browser itself.
function loginInTerminal({ bin, cwd, env, name, timeoutMs = 240000 }) {
  let pty;
  try {
    pty = require('@lydell/node-pty');
  } catch {
    return Promise.resolve({ ok: false, error: "Couldn't start the sign-in." });
  }
  const viaCmd = process.platform === 'win32' && /\.cmd$/i.test(bin);
  const p = pty.spawn(viaCmd ? 'cmd.exe' : bin, [...(viaCmd ? ['/c', bin] : []), 'mcp', 'login', name], { cols: 120, rows: 30, cwd, env });
  let out = '';
  p.onData((d) => (out = (out + d).slice(-4000)));
  return new Promise((resolve) => {
    const timer = setTimeout(() => (p.kill(), resolve({ ok: false, error: `Signing in to ${name} wasn't finished in time.` })), timeoutMs);
    p.onExit(({ exitCode }) => {
      clearTimeout(timer);
      const text = out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').trim();
      const failed = exitCode !== 0 || /couldn't|could not|failed|error/i.test(text);
      resolve(failed ? { ok: false, error: text.split('\n').pop() || `Signing in to ${name} failed.` } : { ok: true, name, tools: [], already: false });
    });
  });
}

module.exports = { connect, loginInTerminal, findServer };
