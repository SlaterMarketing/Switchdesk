// A chat running on an agent that speaks the Agent Client Protocol (ACP): Kimi Code, Gemini CLI
// and Qwen Code (which also runs DeepSeek and other OpenAI-compatible models). The agent runs as
// the user's own CLI, signed in its own way; this app never handles its login.
// Spec: https://agentclientprotocol.com

const { spawn } = require('child_process');
const os = require('os');
const cli = require('./claude-cli');
const { RpcPeer } = require('./jsonrpc');
const { ClaudeShape } = require('./agent-events');

const isWin = process.platform === 'win32';
const NOT_SIGNED_IN = -32000;

// App modes → the agent's own mode ids, best match first.
const MODE_PREFS = {
  ask: ['default', 'ask'],
  plan: ['plan', 'default'],
  agent: ['auto-edit', 'autoedit', 'accept-edits', 'acceptedits', 'default'],
  auto: ['auto', 'yolo', 'auto-edit', 'autoedit'],
};
const PLAN_PREFIX = '[Plan mode: research the code, then reply with a step-by-step plan. Do not edit files or run commands that change anything.]\n\n';

function spawnAgent(bin, args, opts) {
  return spawn(bin, args, { ...opts, shell: isWin && /\.(cmd|bat)$/i.test(bin), windowsHide: true });
}

const CLIENT = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'switchdesk', title: 'Switchdesk', version: '1' } };

// ACP tool calls → the tool rows the chat panel knows.
function toolFor(tc) {
  const raw = tc.rawInput || {};
  const loc = (tc.locations || [])[0];
  const file = (loc && loc.path) || raw.file_path || raw.path || raw.absolute_path || '';
  switch (tc.kind) {
    case 'execute':
      return { name: 'Bash', input: { command: raw.command || (Array.isArray(raw.cmd) ? raw.cmd.join(' ') : raw.cmd) || tc.title || '' } };
    case 'edit':
    case 'delete':
    case 'move':
      return { name: 'Edit', input: { file_path: file || tc.title || '' } };
    case 'read':
      return { name: 'Read', input: { file_path: file || tc.title || '' } };
    case 'search':
      return { name: 'Grep', input: { pattern: raw.pattern || raw.query || tc.title || '' } };
    case 'fetch':
      return { name: raw.url ? 'WebFetch' : 'WebSearch', input: { url: raw.url, query: raw.query || tc.title || '' } };
    default:
      return { name: tc.title || 'Tool', input: raw };
  }
}

function contentText(items) {
  return (items || [])
    .map((c) => (c.type === 'content' && c.content && c.content.type === 'text' ? c.content.text : c.type === 'diff' ? `Changed ${c.path}` : ''))
    .filter(Boolean)
    .join('\n');
}

// A rough +/- line list for the changes row (ACP gives whole-file before and after).
function diffLines(items) {
  const lines = [];
  for (const c of items || []) {
    if (c.type !== 'diff') continue;
    const before = (c.oldText || '').split('\n');
    const after = (c.newText || '').split('\n');
    const had = new Map();
    for (const l of before) had.set(l, (had.get(l) || 0) + 1);
    for (const l of after) {
      if (had.get(l)) had.set(l, had.get(l) - 1);
      else lines.push('+' + l);
    }
    for (const [l, n] of had) for (let i = 0; i < n; i++) lines.push('-' + l);
  }
  return lines.length ? lines.join('\n') : null;
}

class AcpSession {
  constructor({ bin, args, cwd, env, sessionId, model, mode, label, onEvent, onPermission, onExit }) {
    Object.assign(this, { bin, args: args || [], cwd, extraEnv: env || {}, sessionId, model, mode, label: label || 'The agent', onEvent, onPermission, onExit });
    this.alive = false;
    this.modes = [];
    this.tools = new Map();
    this.shape = new ClaudeShape((ev) => this.onEvent(ev));
  }

  async start() {
    const env = await cli.childEnv(this.extraEnv);
    this.child = spawnAgent(this.bin, this.args, { cwd: this.cwd, env });
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
      this.rpc.failAll(`${this.label} stopped.`);
      if (this.turnStarted) this.finish(stderr.trim().split('\n').pop() || `${this.label} stopped.`);
      this.onExit({ code, stderr });
    });
    try {
      const init = await this.rpc.request('initialize', CLIENT, 60000);
      this.caps = init.agentCapabilities || {};
      let r = null;
      if (this.sessionId) {
        const params = { sessionId: this.sessionId, cwd: this.cwd, mcpServers: [] };
        try {
          if (this.caps.sessionCapabilities && this.caps.sessionCapabilities.resume) r = await this.rpc.request('session/resume', params, 60000);
          else if (this.caps.loadSession) {
            this.replaying = true; // history comes back as updates; the chat already shows it
            r = await this.rpc.request('session/load', params, 120000);
          }
        } catch (err) {
          if (err.code === NOT_SIGNED_IN) throw err;
          r = null;
        } finally {
          this.replaying = false;
        }
        if (!r) this.sessionId = null;
      }
      if (!this.sessionId) {
        r = await this.rpc.request('session/new', { cwd: this.cwd, mcpServers: [] }, 120000);
        this.sessionId = r.sessionId;
      }
      this.modes = (r && r.modes && r.modes.availableModes) || [];
      this.currentMode = r && r.modes ? r.modes.currentModeId : null;
      await this.applyMode();
      this.shape.init(this.sessionId, this.model || '');
    } catch (err) {
      this.dispose();
      if (err.code === NOT_SIGNED_IN) throw new Error(`${this.label} isn't signed in yet. Open Settings → Agents to sign in or add an API key.`);
      throw new Error(`${this.label} couldn't start: ${err.message}${stderr ? `\n${stderr.trim().split('\n').slice(-3).join('\n')}` : ''}`);
    }
  }

  // Picks the agent's mode that best matches the app's mode.
  async applyMode() {
    if (!this.modes.length) return;
    const ids = this.modes.map((m) => m.id);
    const want = (MODE_PREFS[this.mode] || []).map((x) => ids.find((id) => id.toLowerCase().replace(/_/g, '-') === x)).find(Boolean);
    if (!want || want === this.currentMode) return;
    try {
      await this.rpc.request('session/set_mode', { sessionId: this.sessionId, modeId: want }, 15000);
      this.currentMode = want;
    } catch {
      /* keep the current mode */
    }
  }

  hasMode(id) {
    return this.modes.some((m) => m.id.toLowerCase() === id);
  }

  async send(content, mode) {
    if (mode && mode !== this.mode) {
      this.mode = mode;
      await this.applyMode();
    }
    const prompt = [];
    for (const b of content) {
      if (b.type === 'text') prompt.push({ type: 'text', text: (this.mode === 'plan' && !this.hasMode('plan') ? PLAN_PREFIX : '') + b.text });
      else if (b.type === 'image') prompt.push({ type: 'image', data: b.source.data, mimeType: b.source.media_type });
    }
    this.turnStarted = Date.now();
    // The reply to session/prompt only comes when the turn ends, so don't wait for it here.
    this.rpc
      .request('session/prompt', { sessionId: this.sessionId, prompt })
      .then((r) => {
        if (r && r.usage) this.shape.usage({ input: r.usage.inputTokens || 0, output: r.usage.outputTokens || 0 });
        this.finish(r && r.stopReason === 'refusal' ? `${this.label} declined to answer.` : null);
      })
      .catch((err) => this.finish(err.code === NOT_SIGNED_IN ? `${this.label} isn't signed in. Open Settings → Agents.` : String(err.message || err)));
  }

  finish(error) {
    if (!this.turnStarted) return;
    const started = this.turnStarted;
    this.turnStarted = null;
    this.tools.clear();
    this.shape.result({ sessionId: this.sessionId, error, started });
  }

  notification(method, p) {
    if (method !== 'session/update' || this.replaying) return;
    const u = p.update || {};
    const s = this.shape;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        if (u.content && u.content.type === 'text') s.text(u.content.text, u.messageId || 'text');
        break;
      case 'agent_thought_chunk':
        if (u.content && u.content.type === 'text') s.thinking(u.content.text, u.messageId || 'thought');
        break;
      case 'tool_call': {
        const t = toolFor(u);
        this.tools.set(u.toolCallId, { ...u, shown: t });
        s.tool(u.toolCallId, t.name, t.input);
        if (u.status === 'completed' || u.status === 'failed') this.toolDone(u.toolCallId, u);
        break;
      }
      case 'tool_call_update': {
        const prev = this.tools.get(u.toolCallId);
        const merged = { ...(prev || {}), ...Object.fromEntries(Object.entries(u).filter(([, v]) => v != null)) };
        this.tools.set(u.toolCallId, merged);
        if (!prev || u.rawInput || u.locations || u.title) s.tool(u.toolCallId, toolFor(merged).name, toolFor(merged).input); // fills in the row as details arrive
        if (u.status === 'completed' || u.status === 'failed') this.toolDone(u.toolCallId, merged);
        break;
      }
      case 'usage_update':
        if (u.used != null) s.usage({ input: u.used, output: 0 });
        break;
    }
  }

  toolDone(id, tc) {
    const t = this.tools.get(id);
    if (t && t.done) return;
    if (t) t.done = true;
    const raw = tc.rawOutput;
    const text = contentText(tc.content) || (typeof raw === 'string' ? raw : raw && (raw.output || raw.stdout) ? String(raw.output || raw.stdout) : '');
    this.shape.toolResult(id, text, { isError: tc.status === 'failed', diff: diffLines(tc.content) });
  }

  async request(method, p) {
    if (method === 'session/request_permission') {
      const tc = { ...(this.tools.get(p.toolCall && p.toolCall.toolCallId) || {}), ...(p.toolCall || {}) };
      const t = toolFor(tc);
      const input = { ...t.input };
      if (t.name === 'Edit') {
        const d = (tc.content || []).find((c) => c.type === 'diff');
        if (d) input.content = (d.newText || '').slice(0, 4000);
      }
      if (tc.toolCallId) this.shape.tool(tc.toolCallId, t.name, input);
      const decision = await this.onPermission({ toolName: t.name, input, description: tc.title || undefined });
      const options = p.options || [];
      const pick = (kinds) => options.find((o) => kinds.includes(o.kind));
      const opt = decision.behavior === 'allow' ? pick(['allow_once']) || pick(['allow_always']) : pick(['reject_once']) || pick(['reject_always']);
      return opt ? { outcome: { outcome: 'selected', optionId: opt.optionId } } : { outcome: { outcome: 'cancelled' } };
    }
    throw new Error(`Not supported: ${method}`);
  }

  async setMode(mode) {
    this.mode = mode;
    await this.applyMode();
  }

  async setModel(model) {
    this.model = model || ''; // ACP agents take the model at start; main restarts them on a change
  }

  async interrupt() {
    this.rpc.notify('session/cancel', { sessionId: this.sessionId });
    return {};
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

// Signed in? Starts the agent and asks for a session, without sending anything.
async function acpStatus(bin, args, extraEnv) {
  const env = await cli.childEnv(extraEnv);
  const child = spawnAgent(bin, args, { env, cwd: os.tmpdir() });
  const rpc = new RpcPeer(child);
  let stderr = '';
  child.stderr.on('data', (c) => (stderr = (stderr + c.toString('utf8')).slice(-2000)));
  child.on('error', (e) => rpc.failAll(String(e.message || e)));
  child.on('close', () => rpc.failAll(stderr.trim().split('\n').pop() || 'It stopped.'));
  try {
    const init = await rpc.request('initialize', CLIENT, 60000);
    try {
      const r = await rpc.request('session/new', { cwd: os.tmpdir(), mcpServers: [] }, 60000);
      if (init.agentCapabilities && init.agentCapabilities.sessionCapabilities && init.agentCapabilities.sessionCapabilities.close) rpc.request('session/close', { sessionId: r.sessionId }).catch(() => {});
      return { loggedIn: true, version: init.agentInfo ? init.agentInfo.version : '' };
    } catch (err) {
      if (err.code === NOT_SIGNED_IN) return { loggedIn: false, version: init.agentInfo ? init.agentInfo.version : '', detail: err.message };
      throw err;
    }
  } finally {
    setTimeout(() => child.kill(), 500);
  }
}

module.exports = { AcpSession, acpStatus };
