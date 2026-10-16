// A stand-in for an ACP agent (Cursor's `cursor-agent acp`, Copilot's `copilot --acp`) for the app's
// tests. It answers without a model:
//   - in plan mode it runs a read-only command (asking permission) and saves a plan with Create Plan;
//   - "compare-test" in Agent mode writes fake.txt in the session's folder;
//   - a second-opinion request gets a findings block about cart.js;
//   - anything else is echoed back as "[<agent>] [<mode>] got: …".
// Every message it receives is appended to $FAKE_AGENT_DIR/log.jsonl.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const NAME = process.env.FAKE_AGENT_NAME || 'fake';
const DIR = process.env.FAKE_AGENT_DIR || path.join(os.tmpdir(), 'switchdesk-fake-agent');
fs.mkdirSync(DIR, { recursive: true });

if (process.argv[2] === 'status') {
  console.log('Logged in as test@example.com');
  process.exit(0);
}
if (process.argv[2] === '--version') {
  console.log('2026.10.1');
  process.exit(0);
}

const log = (x) => fs.appendFileSync(path.join(DIR, 'log.jsonl'), JSON.stringify({ agent: NAME, ...x }) + '\n');
const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');
const MODES = { currentModeId: 'agent', availableModes: [{ id: 'agent', name: 'Agent' }, { id: 'plan', name: 'Plan' }, { id: 'ask', name: 'Ask' }] };
let SID = `${NAME}-${process.pid}`;
let mode = 'agent';
let cwd = process.cwd();
let nextId = 1000;
const pending = new Map();
const up = (update) => send({ method: 'session/update', params: { sessionId: SID, update } });
const say = (text) => up({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const ask = (params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ id, method: 'session/request_permission', params: { sessionId: SID, ...params } });
  });

const PLAN = `---
name: Tidy the cart
overview: Make the cart total handle an empty cart.
todos:
  - id: a
    content: Guard the empty cart
---

# Tidy the cart

Make the cart total handle an empty cart, in \`cart.js\`.

## Steps

- Return 0 for an empty cart
- Keep the rest as it is
`;

async function prompt(m) {
  const text = m.params.prompt.map((p) => p.text || '').join('');
  if (/giving a second opinion/.test(text)) {
    say('Mostly fine, one thing to check.\n\n```findings\n[{"file": "cart.js", "line": 1, "severity": "warning", "title": "Empty cart not handled", "detail": "total() of [] is fine, but null throws."}]\n```\n');
  } else if (mode === 'plan') {
    const cmd = 'ls plans';
    up({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'ls', kind: 'execute', status: 'pending', rawInput: { command: cmd } });
    const r = await ask({ toolCall: { toolCallId: 't1', title: 'ls', kind: 'execute', rawInput: { command: cmd } }, options: [{ optionId: 'y', name: 'Allow', kind: 'allow_once' }, { optionId: 'n', name: 'Reject', kind: 'reject_once' }] });
    log({ permission: r });
    up({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '' } }] });
    const file = path.join(DIR, 'plans', 'Tidy the cart-0a1b2c3d.plan.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, PLAN);
    up({ sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Create Plan', kind: 'other', status: 'pending', rawInput: { name: 'Tidy the cart' } });
    up({ sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'Plan saved to file://' + encodeURI(file.replace(/\\/g, '/')) } }] });
    say("I've written the plan.");
  } else if (/compare-test/.test(text)) {
    fs.writeFileSync(path.join(cwd, 'fake.txt'), `from ${NAME}\n`);
    say(`Wrote fake.txt in ${cwd}`);
  } else say(`[${NAME}] [${mode}] got: ${text.slice(0, 200)}`);
  send({ id: m.id, result: { stopReason: 'end_turn' } });
}

require('readline')
  .createInterface({ input: process.stdin })
  .on('line', (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    log(m);
    if (m.id != null && !m.method && pending.has(m.id)) {
      pending.get(m.id)(m.result);
      pending.delete(m.id);
    } else if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
    else if (m.method === 'session/new') (cwd = m.params.cwd || cwd), send({ id: m.id, result: { sessionId: SID, modes: MODES } });
    else if (m.method === 'session/load' || m.method === 'session/resume') (SID = m.params.sessionId), (cwd = m.params.cwd || cwd), send({ id: m.id, result: { modes: MODES } });
    else if (m.method === 'session/set_mode') (mode = m.params.modeId), send({ id: m.id, result: {} });
    else if (m.method === 'session/prompt') prompt(m);
    else if (m.method === 'session/cancel') {
      /* nothing to stop */
    } else if (m.id != null) send({ id: m.id, result: {} });
  });
