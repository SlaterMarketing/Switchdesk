// A chat running on OpenAI's Codex CLI, through `codex app-server`: the JSON-RPC mode OpenAI
// provides for apps that embed Codex. Codex runs signed in with the user's own ChatGPT plan or
// API key; this app never sees the login.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cli = require('./claude-cli');
const { RpcPeer } = require('./jsonrpc');
const { ClaudeShape, plainCommand, dirsNote } = require('./agent-events');

const isWin = process.platform === 'win32';

// App modes → Codex sandbox and approval policy.
//   Ask: read-only. Plan: read-only, and told to propose a plan. Agent: edits in the folder, asks
//   before running commands it doesn't trust. Auto: edits and runs, asking only when it needs to
//   leave the sandbox.
const MODE = {
  ask: { sandbox: 'read-only', approval: 'never' },
  plan: { sandbox: 'read-only', approval: 'never' },
  agent: { sandbox: 'workspace-write', approval: 'untrusted' },
  auto: { sandbox: 'workspace-write', approval: 'on-request' },
};
const PLAN_PREFIX = '[Plan mode: research the code, then reply with a step-by-step plan. Do not edit files or run commands that change anything.]\n\n';

function sandboxPolicy(mode, cwd, dirs = []) {
  return MODE[mode]?.sandbox === 'read-only'
    ? { type: 'readOnly', networkAccess: false }
    : { type: 'workspaceWrite', writableRoots: [cwd, ...dirs], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
}

function spawnCodex(bin, args, opts) {
  return spawn(bin, args, { ...opts, shell: isWin && /\.(cmd|bat)$/i.test(bin), windowsHide: true });
}

class CodexSession {
  constructor({ bin, cwd, dirs, env, sessionId, model, effort, mode, onEvent, onPermission, onExit }) {
    Object.assign(this, { bin, cwd, dirs: dirs || [], extraEnv: env || {}, sessionId, model, effort, mode, onEvent, onPermission, onExit });
    this.alive = false;
    this.items = new Map(); // itemId -> item, for approvals that only name the item
    this.turnId = null;
    this.shape = new ClaudeShape((ev) => this.onEvent(ev));
  }

  async start() {
    const env = await cli.childEnv(this.extraEnv);
    this.child = spawnCodex(this.bin, ['app-server'], { cwd: this.cwd, env });
    this.alive = true;
    let stderr = '';
    this.child.stderr.on('data', (c) => (stderr = (stderr + c.toString('utf8')).slice(-8000)));
    this.rpc = new RpcPeer(this.child, { onRequest: (m, p) => this.request(m, p), onNotification: (m, p) => this.notification(m, p) });
    this.child.on('error', (err) => {
      this.alive = false;
      this.onExit({ code: -1, stderr: String(err) });
    });
    this.child.on('close', (code) => {
      this.alive = false;
      this.rpc.failAll('Codex exited.');
      if (this.turnStarted) this.shape.result({ sessionId: this.sessionId, error: stderr.trim().split('\n').pop() || 'Codex stopped.', started: this.turnStarted });
      this.onExit({ code, stderr });
    });
    await this.rpc.request('initialize', { clientInfo: { name: 'switchdesk', title: 'Switchdesk', version: '1' }, capabilities: { experimentalApi: false, requestAttestation: false } }, 30000);
    this.rpc.notify('initialized');
    const m = MODE[this.mode] || MODE.agent;
    const common = { cwd: this.cwd, approvalPolicy: m.approval, sandbox: m.sandbox, model: this.model || null, ...(this.dirs.length ? { developerInstructions: dirsNote(this.dirs) } : {}) };
    let r;
    if (this.sessionId) {
      try {
        r = await this.rpc.request('thread/resume', { threadId: this.sessionId, ...common, excludeTurns: true }, 60000);
      } catch {
        r = null; // the thread is gone: start a new one
      }
    }
    if (!r) r = await this.rpc.request('thread/start', common, 60000);
    this.sessionId = r.thread.id;
    this.shape.init(this.sessionId, r.model);
  }

  async send(content, mode) {
    this.mode = mode || this.mode;
    const input = [];
    for (const b of content) {
      if (b.type === 'text') input.push({ type: 'text', text: (this.mode === 'plan' ? PLAN_PREFIX : '') + b.text, text_elements: [] });
      else if (b.type === 'image') {
        const file = path.join(os.tmpdir(), `switchdesk-img-${Date.now()}-${input.length}.png`);
        fs.writeFileSync(file, Buffer.from(b.source.data, 'base64'));
        input.push({ type: 'localImage', path: file });
      }
    }
    const m = MODE[this.mode] || MODE.agent;
    this.turnStarted = Date.now();
    try {
      const r = await this.rpc.request('turn/start', {
        threadId: this.sessionId,
        input,
        approvalPolicy: m.approval,
        sandboxPolicy: sandboxPolicy(this.mode, this.cwd, this.dirs),
        model: this.model || null,
        effort: this.effort || null,
      });
      this.turnId = r && r.turn ? r.turn.id : this.turnId;
    } catch (err) {
      this.finish(String(err.message || err));
    }
  }

  finish(error) {
    if (!this.turnStarted) return;
    const started = this.turnStarted;
    this.turnStarted = null;
    this.turnId = null;
    this.shape.result({ sessionId: this.sessionId, error, started });
  }

  notification(method, p) {
    const s = this.shape;
    switch (method) {
      case 'turn/started':
        this.turnId = p.turn?.id || this.turnId;
        break;
      case 'item/agentMessage/delta':
        s.text(p.delta, p.itemId);
        break;
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        s.thinking(p.delta, p.itemId);
        break;
      case 'item/started':
        this.itemStarted(p.item);
        break;
      case 'item/completed':
        this.itemCompleted(p.item);
        break;
      case 'thread/tokenUsage/updated': {
        const last = p.tokenUsage?.last;
        if (last) s.usage({ input: last.inputTokens + (last.cachedInputTokens || 0), output: last.outputTokens });
        break;
      }
      case 'account/rateLimits/updated': {
        const r = p.rateLimits || {};
        s.limits(r.primary ? r.primary.usedPercent : null, r.secondary ? r.secondary.usedPercent : null);
        break;
      }
      case 'error':
        if (p.willRetry) s.notice(`${p.error?.message || 'Error'}. Retrying…`);
        break;
      case 'turn/completed': {
        const t = p.turn || {};
        this.finish(t.status === 'failed' ? (t.error && t.error.message) || 'Codex hit an error.' : null);
        break;
      }
    }
  }

  itemStarted(item) {
    if (!item) return;
    this.items.set(item.id, item);
    const s = this.shape;
    if (item.type === 'commandExecution') s.tool(item.id, 'Bash', { command: plainCommand(item.command) });
    else if (item.type === 'fileChange') {
      for (const [i, c] of (item.changes || []).entries()) s.tool(`${item.id}:${i}`, c.kind?.type === 'add' ? 'Write' : 'Edit', { file_path: c.path });
    } else if (item.type === 'mcpToolCall') s.tool(item.id, `mcp__${item.server}__${item.tool}`, item.arguments || {});
    else if (item.type === 'webSearch') s.tool(item.id, 'WebSearch', { query: item.query || '' });
  }

  itemCompleted(item) {
    if (!item) return;
    this.items.set(item.id, item);
    const s = this.shape;
    if (item.type === 'commandExecution') {
      s.toolResult(item.id, item.aggregatedOutput || (item.status === 'declined' ? 'Declined.' : ''), { isError: item.status === 'failed' || item.status === 'declined' || (item.exitCode != null && item.exitCode !== 0) });
    } else if (item.type === 'fileChange') {
      for (const [i, c] of (item.changes || []).entries()) s.toolResult(`${item.id}:${i}`, '', { isError: item.status === 'failed' || item.status === 'declined', diff: c.diff });
    } else if (item.type === 'mcpToolCall') {
      s.toolResult(item.id, item.error ? item.error.message : JSON.stringify(item.result?.content || '').slice(0, 4000), { isError: !!item.error });
    } else if (item.type === 'webSearch') s.toolResult(item.id, '');
    else if (item.type === 'agentMessage' && item.text && !this.sawText(item.id)) s.text(item.text, item.id);
  }

  sawText(id) {
    return this.shape.open && this.shape.open.key === id;
  }

  // Codex asking the app: approvals. Anything else is declined.
  async request(method, p) {
    if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
      const command = p.command || (Array.isArray(p.command) ? p.command.join(' ') : '') || (this.items.get(p.itemId) || {}).command || '';
      const d = await this.onPermission({ toolName: 'Bash', input: { command: plainCommand(Array.isArray(command) ? command.join(' ') : command) }, description: p.reason || undefined });
      if (method === 'execCommandApproval') return { decision: d.behavior === 'allow' ? 'approved' : { denied: { rejection: d.message || 'The user declined.' } } };
      return { decision: d.behavior === 'allow' ? 'accept' : 'decline' };
    }
    if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
      const item = this.items.get(p.itemId) || {};
      const files = item.changes ? item.changes.map((c) => c.path) : Object.keys(p.fileChanges || {});
      const diff = item.changes ? item.changes.map((c) => c.diff).join('\n') : '';
      const d = await this.onPermission({ toolName: 'Edit', input: { file_path: files.join(', '), content: diff }, description: p.reason || undefined });
      if (method === 'applyPatchApproval') return { decision: d.behavior === 'allow' ? 'approved' : { denied: { rejection: d.message || 'The user declined.' } } };
      return { decision: d.behavior === 'allow' ? 'accept' : 'decline' };
    }
    if (method === 'item/tool/requestUserInput') return { answers: {} };
    throw new Error(`Not supported: ${method}`);
  }

  async setMode(mode) {
    this.mode = mode; // applies from the next turn
  }

  async setModel(model) {
    this.model = model || '';
  }

  async interrupt() {
    if (!this.turnId) return {};
    try {
      await this.rpc.request('turn/interrupt', { threadId: this.sessionId, turnId: this.turnId }, 10000);
      return {};
    } catch (err) {
      return { error: String(err.message || err) };
    }
  }

  dispose() {
    if (!this.child) return;
    const child = this.child;
    try {
      child.stdin.end();
    } catch {
      /* closed */
    }
    setTimeout(() => child.exitCode === null && child.kill(), 2000);
  }
}

// A short-lived app-server for one question.
async function ask(bin, extraEnv, fn) {
  const env = await cli.childEnv(extraEnv);
  const child = spawnCodex(bin, ['app-server'], { env, cwd: os.homedir() });
  const rpc = new RpcPeer(child);
  child.on('error', () => rpc.failAll('Codex could not start.'));
  child.on('close', () => rpc.failAll('Codex stopped.'));
  try {
    await rpc.request('initialize', { clientInfo: { name: 'switchdesk', title: 'Switchdesk', version: '1' }, capabilities: { experimentalApi: false, requestAttestation: false } }, 20000);
    rpc.notify('initialized');
    return await fn(rpc);
  } finally {
    child.kill();
  }
}

// The models this Codex offers: [{ id, label }].
function codexModels(bin) {
  return ask(bin, {}, async (rpc) => {
    const r = await rpc.request('model/list', {}, 20000);
    return (r.data || []).filter((m) => !m.hidden).map((m) => ({ id: m.model || m.id, label: m.displayName || m.id, isDefault: !!m.isDefault }));
  });
}

// Sign-in state without starting a chat: { loggedIn, email, plan, method }.
function codexStatus(bin, extraEnv) {
  return ask(bin, extraEnv, async (rpc) => {
    const r = await rpc.request('account/read', {}, 20000);
    const a = r.account;
    return { loggedIn: !!a, method: a ? a.type : null, email: a && a.email ? a.email : '', plan: a && a.planType ? a.planType : '' };
  });
}

module.exports = { CodexSession, codexStatus, codexModels };
