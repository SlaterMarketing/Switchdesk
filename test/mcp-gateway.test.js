'use strict';
// Switchdesk's own MCP connections (src/mcp-gateway.js), against a stand-in server that needs
// signing in (test/fake-oauth-mcp.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createGateway, known } = require('../src/mcp-gateway');

function fakeServer() {
  const child = spawn(process.execPath, [path.join(__dirname, 'fake-oauth-mcp.js'), '0']);
  return new Promise((resolve) => child.stdout.once('data', (d) => resolve({ child, url: `http://127.0.0.1:${String(d).trim()}/mcp` })));
}

test('well-known services have their official address', () => {
  assert.strictEqual(known('Jira').url, 'https://mcp.atlassian.com/v1/mcp');
  assert.strictEqual(known('linear').name, 'Linear');
  assert.strictEqual(known('Google Sheets'), null);
});

test('signs in in the browser, keeps the sign-in, and passes tool calls on', { timeout: 30000 }, async () => {
  const { child, url } = await fakeServer();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'switchdesk-gw-')), 'mcp.json');
  try {
    const gw = createGateway({ file });
    gw.add('Tracker', url);
    assert.deepStrictEqual((await gw.status()).map((s) => s.status), ['needs-auth']);
    const opened = [];
    // The "browser": the stand-in approves at once and sends it back to Switchdesk.
    await gw.signIn('tracker', (u) => (opened.push(u), fetch(u)));
    assert.strictEqual(opened.length, 1);
    const tools = await gw.tools();
    assert.deepStrictEqual(tools.map((t) => t.name), ['Tracker__list_tickets']);
    assert.match(tools[0].description, /^Tracker: List open tickets/);
    const r = await gw.call('Tracker__list_tickets', {});
    assert.strictEqual(r.content[0].text, 'TICKET-1: Fix the login page');
    await gw.close();
    // A new start (the app restarted) uses the saved sign-in.
    const again = createGateway({ file });
    assert.deepStrictEqual((await again.status()).map((s) => s.status), ['connected']);
    await again.close();
  } finally {
    child.kill();
  }
});

test("Switchdesk's MCP server lists the connected tools for the other agents and passes calls on", { timeout: 20000 }, async () => {
  const http = require('http');
  const asked = [];
  const app = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { name, args, agent } = JSON.parse(body);
      asked.push([name, agent]);
      const out = name === 'gateway_tools' ? { tools: [{ name: 'tracker__list_tickets', description: 'tracker: List open tickets.', inputSchema: { type: 'object' } }] } : { mcp: { content: [{ type: 'text', text: `called ${args.tool}` }] } };
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const run = (agent) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'preview-mcp.js')], { env: { ...process.env, SWITCHDESK_PREVIEW_URL: `http://127.0.0.1:${app.address().port}/`, SWITCHDESK_AGENT: agent } });
    let buf = '';
    const waits = new Map();
    child.stdout.on('data', (d) => {
      buf += d;
      for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
        const m = JSON.parse(buf.slice(0, i));
        waits.get(m.id)(m.result);
      }
    });
    let n = 0;
    const rpc = (method, params) => new Promise((r) => (waits.set(++n, r), child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n')));
    return { rpc, child };
  };
  try {
    const cursor = run('cursor');
    const names = (await cursor.rpc('tools/list', {})).tools.map((t) => t.name);
    assert.ok(names.includes('connect_mcp_server') && names.includes('tracker__list_tickets'));
    assert.strictEqual((await cursor.rpc('tools/call', { name: 'tracker__list_tickets', arguments: {} })).content[0].text, 'called tracker__list_tickets');
    cursor.child.kill();
    // Claude Code has its own connections, so it gets none of these.
    const claude = run('claude');
    assert.ok(!(await claude.rpc('tools/list', {})).tools.some((t) => t.name === 'tracker__list_tickets'));
    claude.child.kill();
    assert.deepStrictEqual(asked, [['gateway_tools', 'cursor'], ['gateway_call', 'cursor']]);
  } finally {
    app.close();
  }
});
