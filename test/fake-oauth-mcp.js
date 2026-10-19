// A stand-in for a remote MCP server that needs signing in (like Jira's): an OAuth server that
// approves at once, and one tool that only works with the token it gave out. For the tests.
// Run with a port (0 picks one); prints the port it listens on.
'use strict';

const http = require('http');
const crypto = require('crypto');

const TOKEN = 'fake-token-' + crypto.randomUUID();
let base = '';

const json = (res, code, body, headers = {}) => res.writeHead(code, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));

const server = http.createServer((req, res) => {
  const url = new URL(req.url, base);
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const p = url.pathname;
    if (p.startsWith('/.well-known/oauth-protected-resource')) return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
    if (p.startsWith('/.well-known/oauth-authorization-server') || p.startsWith('/.well-known/openid-configuration'))
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    if (p === '/register') {
      const r = JSON.parse(body || '{}');
      return json(res, 201, { ...r, client_id: 'fake-client', token_endpoint_auth_method: 'none' });
    }
    // Approves straight away: back to the app's callback with a code.
    if (p === '/authorize') {
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('code', 'fake-code');
      if (url.searchParams.get('state')) back.searchParams.set('state', url.searchParams.get('state'));
      return res.writeHead(302, { location: back.toString() }).end();
    }
    if (p === '/token') return json(res, 200, { access_token: TOKEN, token_type: 'Bearer', expires_in: 3600, refresh_token: 'fake-refresh' });
    if (p === '/mcp') {
      if (req.headers.authorization !== `Bearer ${TOKEN}`)
        return json(res, 401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` });
      if (req.method !== 'POST') return res.writeHead(405).end();
      const m = JSON.parse(body || '{}');
      if (m.id === undefined) return res.writeHead(202).end();
      const result =
        m.method === 'initialize'
          ? { protocolVersion: (m.params && m.params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-tracker', version: '1.0.0' } }
          : m.method === 'tools/list'
            ? { tools: [{ name: 'list_tickets', description: 'List open tickets.', inputSchema: { type: 'object', properties: {} } }] }
            : m.method === 'tools/call'
              ? { content: [{ type: 'text', text: 'TICKET-1: Fix the login page' }] }
              : {};
      return json(res, 200, { jsonrpc: '2.0', id: m.id, result });
    }
    res.writeHead(404).end();
  });
});

server.listen(Number(process.argv[2] || 0), '127.0.0.1', () => {
  base = `http://127.0.0.1:${server.address().port}`;
  console.log(server.address().port);
});
