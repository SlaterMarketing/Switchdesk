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

// Resolves to { ok, name, tools } once connected, or { ok: false, error, servers }.
async function connect({ bin, cwd, env, name, openUrl, timeoutMs = 240000 }) {
  const session = new ChatSession({ bin, cwd, env, mode: 'ask', onEvent: () => {}, onPermission: async () => ({ behavior: 'deny' }), onExit: () => {} });
  await session.start();
  try {
    const status = async () => {
      const r = await session.control({ subtype: 'mcp_status' });
      if (r.error) throw new Error(r.error);
      return (r.response && r.response.mcpServers) || [];
    };
    // Servers are still connecting when the process starts. Wait for them to settle first.
    let servers = await status();
    for (let i = 0; i < 20 && servers.some((s) => s.status === 'pending'); i++) {
      await later(750);
      servers = await status();
    }
    const server = findServer(servers, name);
    const list = servers.map((s) => ({ name: s.name, status: s.status }));
    if (!server) return { ok: false, error: `There's no MCP server called "${name}".`, servers: list };
    const done = (s) => ({ ok: true, name: s.name, tools: (s.tools || []).map((t) => t.name), already: s === server });
    if (server.status === 'connected') return done(server);
    const auth = await session.control({ subtype: 'mcp_authenticate', serverName: server.name });
    if (auth.error) {
      // Not one that signs in: try connecting it again instead.
      await session.control({ subtype: 'mcp_reconnect', serverName: server.name });
      const s = (await status()).find((x) => x.name === server.name);
      return s && s.status === 'connected' ? done(s) : { ok: false, error: auth.error, servers: list };
    }
    const a = auth.response || {};
    if (a.authUrl) openUrl(a.authUrl, server.name);
    // A sign-in that comes back to Claude Code connects by itself. A claude.ai connector is
    // connected on claude.ai, so Switchdesk asks again every few seconds.
    const until = Date.now() + timeoutMs;
    for (let i = 0; Date.now() < until && session.alive; i++) {
      await later(2000);
      if (a.callbackExpected === false && i % 2) await session.control({ subtype: 'mcp_reconnect', serverName: server.name });
      const s = (await status()).find((x) => x.name === server.name);
      if (s && s.status === 'connected') return { ...done(s), already: false };
    }
    return { ok: false, error: `Signing in to ${server.name} wasn't finished in time.`, servers: list };
  } finally {
    session.dispose();
  }
}

module.exports = { connect, findServer };
