'use strict';
// Signing in to MCP servers (src/mcp-connect.js), against the fake Claude Code CLI.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { connect, loginInTerminal, findServer } = require('../src/mcp-connect');
const { ChatSession } = require('../src/session');

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

test("an open chat's Claude Code signs in first, and a server only the list shows signs in through a terminal", { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchdesk-mcp-'));
  const servers = [
    { name: 'tracker', url: 'https://tracker.example.com/mcp', status: 'needs-auth' },
    { name: 'claude.ai Notion', url: 'https://mcp.notion.com/mcp', status: 'needs-auth', hidden: true },
  ];
  fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify(servers));
  const env = { FAKE_AGENT_DIR: dir };
  const chat = new ChatSession({ bin: BIN, cwd: dir, env, mode: 'ask', onEvent: () => {}, onPermission: async () => ({}), onExit: () => {} });
  await chat.start();
  try {
    const r = await connect({ bin: BIN, cwd: dir, env, name: 'tracker', openUrl: (u) => fetch(u), sessions: [chat] });
    assert.strictEqual(r.ok, true);
    const log = () => fs.readFileSync(path.join(dir, 'claude.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(log()[0].pid, chat.child.pid, 'signed in through the open chat');
    const missing = await connect({ bin: BIN, cwd: dir, env, name: 'notion', openUrl: () => {}, sessions: [chat], timeoutMs: 1000 });
    assert.strictEqual(missing.missing, true);
    const t = await loginInTerminal({ bin: BIN, cwd: dir, env: { ...process.env, ...env }, name: 'claude.ai Notion' });
    assert.strictEqual(t.ok, true);
    assert.deepStrictEqual(log()[1], { mcp: 'login', server: 'claude.ai Notion', tty: true });
  } finally {
    chat.dispose();
  }
});
