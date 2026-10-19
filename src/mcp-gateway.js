// Switchdesk's own connections to remote MCP servers, for the agents that aren't Claude Code
// (Codex, Cursor, Kimi, Gemini, Qwen, DeepSeek, Copilot). Switchdesk signs in to each server in the
// browser (OAuth), keeps the tokens encrypted, and offers the server's tools to those agents through
// its own MCP server (preview-mcp.js), so every agent gets them the same way. Claude Code connects
// to servers itself (mcp-connect.js).
'use strict';

const fs = require('fs');
const http = require('http');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
const { UnauthorizedError } = require('@modelcontextprotocol/sdk/client/auth.js');

// The official remote MCP servers of some well-known services, so "connect me to Linear" needs no
// address. also: other names people use for the same service.
const KNOWN = [
  { name: 'Atlassian', url: 'https://mcp.atlassian.com/v1/mcp', also: ['jira', 'confluence', 'atlassian rovo'] },
  { name: 'Linear', url: 'https://mcp.linear.app/mcp' },
  { name: 'Notion', url: 'https://mcp.notion.com/mcp' },
  { name: 'Sentry', url: 'https://mcp.sentry.dev/mcp' },
  { name: 'Asana', url: 'https://mcp.asana.com/sse' },
  { name: 'Stripe', url: 'https://mcp.stripe.com' },
  { name: 'Vercel', url: 'https://mcp.vercel.com' },
  { name: 'Supabase', url: 'https://mcp.supabase.com/mcp' },
  { name: 'Hugging Face', url: 'https://huggingface.co/mcp', also: ['huggingface'] },
];

const norm = (s) => String(s || '').trim().toLowerCase().replace(/^claude\.ai /, '');

function known(name) {
  const want = norm(name);
  return KNOWN.find((k) => norm(k.name) === want || (k.also || []).includes(want)) || null;
}

// A tool's name as the agents see it: server and tool, in the characters every agent accepts.
const wire = (server, tool) => `${server.replace(/[^a-zA-Z0-9]+/g, '_')}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);

const SIGNED_IN = '<!doctype html><meta charset="utf-8"><title>Signed in</title><body style="font:16px system-ui;padding:48px;text-align:center">Signed in. You can close this tab and go back to Switchdesk.</body>';

// file: where the servers and their (sealed) sign-ins are kept. seal/unseal encrypt them.
function createGateway({ file, seal = (s) => s, unseal = (s) => s }) {
  let data = { servers: [], secrets: {} };
  try {
    data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    /* none yet */
  }
  const live = new Map(); // server name -> { client, tools } once connected
  const pending = new Map(); // server name -> a sign-in in progress
  const save = () => fs.writeFileSync(file, JSON.stringify(data, null, 2));
  const secret = (name) => {
    try {
      return data.secrets[name] ? JSON.parse(unseal(data.secrets[name])) : {};
    } catch {
      return {};
    }
  };
  const keep = (name, patch) => {
    data.secrets[name] = seal(JSON.stringify({ ...secret(name), ...patch }));
    save();
  };

  const find = (name) => {
    const want = norm(name);
    const k = known(name);
    return data.servers.find((s) => norm(s.name) === want) || (k && data.servers.find((s) => s.url === k.url)) || data.servers.find((s) => norm(s.name).includes(want) || want.includes(norm(s.name))) || null;
  };

  // How the MCP SDK signs in for one server. redirect is where the browser comes back to; without
  // one, only saved sign-ins are used (redirecting means signing in again).
  function provider(server, redirect, onRedirect) {
    let verifier = '';
    return {
      get redirectUrl() {
        return redirect || 'http://127.0.0.1/callback';
      },
      get clientMetadata() {
        return { client_name: 'Switchdesk', redirect_uris: [this.redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
      },
      clientInformation: () => {
        const c = secret(server.name).client;
        return c && (!redirect || c.redirect === redirect) ? c.info : undefined;
      },
      saveClientInformation: (info) => redirect && keep(server.name, { client: { info, redirect } }),
      tokens: () => secret(server.name).tokens,
      saveTokens: (tokens) => keep(server.name, { tokens }),
      redirectToAuthorization: (url) => {
        if (!onRedirect) throw new UnauthorizedError('Needs signing in');
        onRedirect(url.toString());
      },
      saveCodeVerifier: (v) => (verifier = v),
      codeVerifier: () => verifier,
    };
  }

  const transportFor = (server, authProvider, sse) => (sse ? new SSEClientTransport(new URL(server.url), { authProvider }) : new StreamableHTTPClientTransport(new URL(server.url), { authProvider }));

  // Connects with what's saved. Throws UnauthorizedError when it needs signing in.
  async function open(server, authProvider) {
    const sse = /\/sse\/?$/.test(server.url);
    let transport = transportFor(server, authProvider, sse);
    const client = new Client({ name: 'Switchdesk', version: '1' });
    try {
      await client.connect(transport);
    } catch (err) {
      if (err instanceof UnauthorizedError || sse) throw err;
      // An older server that only speaks SSE.
      transport = transportFor(server, authProvider, true);
      await client.connect(transport);
    }
    const { tools } = await client.listTools();
    const entry = { client, tools: tools || [] };
    live.set(server.name, entry);
    return entry;
  }

  async function connect(server) {
    if (live.has(server.name)) return live.get(server.name);
    return open(server, provider(server));
  }

  // Signs in in the browser. Resolves with the tools once signed in (straight away when a saved
  // sign-in still works). The sign-in keeps waiting in the background for up to timeoutMs.
  function signIn(name, openUrl, timeoutMs = 300000) {
    const server = find(name);
    if (!server) return Promise.reject(new Error(`No server called ${name}.`));
    if (pending.has(server.name)) return pending.get(server.name);
    const run = (async () => {
      try {
        return await connect(server);
      } catch (err) {
        if (!(err instanceof UnauthorizedError)) throw err;
      }
      let got;
      const code = new Promise((resolve, reject) => (got = { resolve, reject }));
      const back = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://127.0.0.1');
        if (u.pathname !== '/callback') return res.writeHead(404).end();
        res.writeHead(200, { 'content-type': 'text/html' }).end(SIGNED_IN);
        u.searchParams.get('code') ? got.resolve(u.searchParams.get('code')) : got.reject(new Error(u.searchParams.get('error_description') || u.searchParams.get('error') || 'The sign-in was cancelled.'));
      });
      await new Promise((r) => back.listen(0, '127.0.0.1', r));
      const timer = setTimeout(() => got.reject(new Error(`Signing in to ${server.name} wasn't finished in time.`)), timeoutMs);
      try {
        const redirect = `http://127.0.0.1:${back.address().port}/callback`;
        const auth = provider(server, redirect, openUrl);
        const transport = transportFor(server, auth, /\/sse\/?$/.test(server.url));
        try {
          // Starts the sign-in: the SDK finds the server's sign-in page and opens it (openUrl).
          await new Client({ name: 'Switchdesk', version: '1' }).connect(transport);
        } catch (err) {
          if (!(err instanceof UnauthorizedError)) throw err;
        }
        await transport.finishAuth(await code);
        return await open(server, provider(server));
      } finally {
        clearTimeout(timer);
        back.close();
      }
    })();
    pending.set(server.name, run);
    run.then(
      () => pending.delete(server.name),
      () => pending.delete(server.name)
    );
    return run;
  }

  return {
    find,
    add(name, url) {
      const server = find(name) || { name, url };
      server.url = url;
      if (!data.servers.includes(server)) data.servers.push(server);
      save();
      return server;
    },
    async remove(name) {
      const server = find(name);
      if (!server) return;
      const entry = live.get(server.name);
      live.delete(server.name);
      if (entry) await entry.client.close().catch(() => {});
      data.servers = data.servers.filter((s) => s !== server);
      delete data.secrets[server.name];
      save();
    },
    signIn,
    // Every server with how it's doing: connected (with its tools), needs-auth or failed.
    async status() {
      return Promise.all(
        data.servers.map(async (s) => {
          try {
            const { tools } = await connect(s);
            return { name: s.name, url: s.url, status: 'connected', tools: tools.map((t) => t.name) };
          } catch (err) {
            return { name: s.name, url: s.url, status: err instanceof UnauthorizedError ? 'needs-auth' : 'failed', error: err.message };
          }
        })
      );
    },
    // The tools of every connected server, named for the agents.
    async tools() {
      const out = [];
      for (const s of data.servers) {
        const entry = await connect(s).catch(() => null);
        for (const t of (entry && entry.tools) || []) out.push({ name: wire(s.name, t.name), description: `${s.name}: ${t.description || t.name}`, inputSchema: t.inputSchema || { type: 'object' } });
      }
      return out;
    },
    async call(name, args) {
      for (const s of data.servers) {
        const entry = live.get(s.name);
        const tool = entry && entry.tools.find((t) => wire(s.name, t.name) === name);
        if (tool) return entry.client.callTool({ name: tool.name, arguments: args || {} });
      }
      throw new Error(`No connected server has a tool called ${name}.`);
    },
    async close() {
      for (const e of live.values()) await e.client.close().catch(() => {});
      live.clear();
    },
  };
}

module.exports = { createGateway, known, KNOWN };
