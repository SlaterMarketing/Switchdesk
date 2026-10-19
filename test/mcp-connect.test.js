'use strict';
// Signing in to MCP servers (src/mcp-connect.js), against the fake Claude Code CLI.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { connect, findServer } = require('../src/mcp-connect');

const BIN = path.join(__dirname, 'fake-claude', 'claude');

test('a server is found by its listed name or part of it', () => {
  const servers = [{ name: 'github' }, { name: 'claude.ai Atlassian Rovo' }, { name: 'claude.ai Linear' }];
  assert.strictEqual(findServer(servers, 'GitHub').name, 'github');
  assert.strictEqual(findServer(servers, 'atlassian').name, 'claude.ai Atlassian Rovo');
  assert.strictEqual(findServer(servers, 'Linear').name, 'claude.ai Linear');
  assert.strictEqual(findServer(servers, 'notion'), null);
});

test('signing in opens the page Claude Code gives, then reports the tools', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchdesk-mcp-'));
  fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify([{ name: 'claude.ai Atlassian Rovo', url: 'https://mcp.atlassian.com/v1/mcp', status: 'needs-auth' }]));
  const env = { FAKE_AGENT_DIR: dir };
  const opened = [];
  const openUrl = (u, name) => (opened.push(name), fetch(u));
  const r = await connect({ bin: BIN, cwd: dir, env, name: 'atlassian', openUrl });
  assert.deepStrictEqual(r, { ok: true, name: 'claude.ai Atlassian Rovo', tools: ['list_tickets'], already: false });
  assert.deepStrictEqual(opened, ['claude.ai Atlassian Rovo']);
  // Once connected, there's nothing to sign in to.
  assert.strictEqual((await connect({ bin: BIN, cwd: dir, env, name: 'atlassian', openUrl })).already, true);
  assert.strictEqual(opened.length, 1);
  const missing = await connect({ bin: BIN, cwd: dir, env, name: 'notion', openUrl });
  assert.strictEqual(missing.ok, false);
  assert.deepStrictEqual(missing.servers, [{ name: 'claude.ai Atlassian Rovo', status: 'connected' }]);
});
