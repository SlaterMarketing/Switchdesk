// An MCP server (stdio) for other apps, such as Claude Desktop or Cursor: it lets them hand work to
// Switchdesk, check on it and get the result back. The app starts it from its own MCP settings
// (Settings → Other apps writes that entry). The calls go over HTTP to the running Switchdesk,
// whose address and token are in a file in Switchdesk's data folder; if Switchdesk isn't open,
// this starts it.
//
// Runs under Electron as plain Node (ELECTRON_RUN_AS_NODE), with SWITCHDESK_HANDOFF set.
'use strict';

const fs = require('fs');

const FILE = process.env.SWITCHDESK_HANDOFF;
let client = 'another app'; // who is asking, from initialize

const chatId = { type: 'string', description: 'The chat id, from switchdesk_start or switchdesk_chats.' };
const TOOLS = [
  {
    name: 'switchdesk_folders',
    description: 'The folders open in Switchdesk (the coding app on this computer) and the ones opened recently. Use it to find the folder to hand work to.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'switchdesk_start',
    description:
      "Hand a coding task to Switchdesk: it starts a chat with a coding agent (Claude Code, Codex, Cursor and others) in that folder on this computer, where the user can watch it, and you get the chat's id back. Write the task as a complete brief: the agent sees only this, not your conversation. Then use switchdesk_read to wait for the result.",
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'The absolute path of the project folder.' },
        task: { type: 'string', description: 'What to do, with everything the agent needs to know.' },
        agent: { type: 'string', description: 'Which agent does it, such as Claude, Codex or Cursor. Leave it out for the one the user last used.' },
        mode: { type: 'string', enum: ['agent', 'plan', 'ask'], description: 'agent (default) makes the changes; plan writes a plan for the user to approve first; ask only answers, changing nothing.' },
        own_copy: { type: 'boolean', description: "Work in a copy of the folder on a branch of its own, so the user's folder is untouched until they merge. Needs a git repository." },
        title: { type: 'string', description: 'A short title for the chat. Optional.' },
      },
      required: ['folder', 'task'],
    },
  },
  {
    name: 'switchdesk_chats',
    description: "Switchdesk's chats: what each is doing, whether it's waiting for the user, and its latest message.",
    inputSchema: { type: 'object', properties: { folder: { type: 'string', description: 'Only the chats in this folder. Optional.' } } },
  },
  {
    name: 'switchdesk_read',
    description: "A chat's messages and whether it's still working. Pass wait_seconds (up to 50) to wait for it to finish first; call again if it's still working. When the agent is waiting for the user (an approval), the user answers in Switchdesk or on their phone.",
    inputSchema: { type: 'object', properties: { chat: chatId, wait_seconds: { type: 'number', description: 'How long to wait for the chat to finish, 0 to 50. Default 0.' } }, required: ['chat'] },
  },
  {
    name: 'switchdesk_send',
    description: 'Send a follow-up message to a chat, such as a correction or the next step. If it is working, the message goes after its current step.',
    inputSchema: { type: 'object', properties: { chat: chatId, message: { type: 'string' } }, required: ['chat', 'message'] },
  },
  {
    name: 'switchdesk_stop',
    description: 'Stop a chat that is working, at once.',
    inputSchema: { type: 'object', properties: { chat: chatId }, required: ['chat'] },
  },
];

const write = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function where() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function post(name, args) {
  const w = where();
  if (!w) throw Object.assign(new Error('not running'), { down: true });
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${w.port}/handoff/${w.token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, args: args || {}, from: client }) });
  } catch {
    throw Object.assign(new Error('not running'), { down: true });
  }
  if (res.status === 404) throw Object.assign(new Error('not running'), { down: true }); // an old file from an earlier run
  return res.json();
}

// Switchdesk isn't open: open it, and wait for it to be ready.
async function launch() {
  let cmd;
  try {
    cmd = JSON.parse(process.env.SWITCHDESK_LAUNCH || '[]');
  } catch {
    cmd = [];
  }
  if (!cmd.length) return false;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SWITCHDESK_HANDOFF;
  delete env.SWITCHDESK_LAUNCH;
  require('child_process').spawn(cmd[0], cmd.slice(1), { detached: true, stdio: 'ignore', env }).unref();
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await post('ping').then(() => true, () => false)) return true;
  }
  return false;
}

async function ask(name, args) {
  try {
    return await post(name, args);
  } catch (err) {
    if (!err.down) throw err;
    if (!(await launch())) throw new Error("Switchdesk isn't open on this computer, and it couldn't be started. Ask the user to open it.");
    return post(name, args);
  }
}

async function call(name, args) {
  if (!TOOLS.some((t) => t.name === name)) return { content: [{ type: 'text', text: `There's no tool called ${name}.` }], isError: true };
  try {
    const r = await ask(name.replace(/^switchdesk_/, ''), args);
    if (r.error) return { content: [{ type: 'text', text: r.error }], isError: true };
    return { content: [{ type: 'text', text: JSON.stringify(r, null, 1) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: String(err.message || err) }], isError: true };
  }
}

async function handle(m) {
  if (m.method === 'initialize') {
    const info = (m.params && m.params.clientInfo) || {};
    const names = { 'claude-ai': 'Claude Desktop', 'claude-code': 'Claude Code', cursor: 'Cursor', 'cursor-vscode': 'Cursor' };
    if (info.name) client = names[info.name] || String(info.name).replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 40);
    return write({ id: m.id, result: { protocolVersion: (m.params && m.params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'switchdesk', version: '1.0.0' } } });
  }
  if (m.method === 'tools/list') return write({ id: m.id, result: { tools: TOOLS } });
  if (m.method === 'tools/call') return write({ id: m.id, result: await call(m.params.name, m.params.arguments || {}) });
  if (m.method === 'ping') return write({ id: m.id, result: {} });
  if (m.id !== undefined && m.method) write({ id: m.id, error: { code: -32601, message: `Unknown method ${m.method}` } });
}

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    handle(m).catch((err) => m.id !== undefined && write({ id: m.id, error: { code: -32000, message: String(err.message || err) } }));
  }
});
process.stdin.on('end', () => process.exit(0));
