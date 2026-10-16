// A chat running on an agent that speaks the Agent Client Protocol (ACP): Kimi Code, Gemini CLI
// and Qwen Code (which also runs DeepSeek and other OpenAI-compatible models). The agent runs as
// the user's own CLI, signed in its own way; this app never handles its login.
// Spec: https://agentclientprotocol.com

const { spawn } = require('child_process');
const os = require('os');
const cli = require('./claude-cli');
const { RpcPeer } = require('./jsonrpc');
const { ClaudeShape, appNote, dirsNote, stripAppNotes, chatTitle } = require('./agent-events');

const isWin = process.platform === 'win32';
const NOT_SIGNED_IN = -32000;

// App modes → the agent's own mode ids, best match first.
const MODE_PREFS = {
  ask: ['default', 'ask'],
  plan: ['plan', 'default'],
  agent: ['auto-edit', 'autoedit', 'accept-edits', 'acceptedits', 'default', 'agent'],
  auto: ['auto', 'yolo', 'auto-edit', 'autoedit', 'agent'],
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
  constructor({ bin, args, cwd, dirs, rules, env, sessionId, model, mode, label, authMethod, onEvent, onPermission, onExit }) {
    Object.assign(this, { bin, args: args || [], cwd, dirs: dirs || [], rules: rules || '', extraEnv: env || {}, sessionId, model, mode, label: label || 'The agent', authMethod, onEvent, onPermission, onExit });
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
        r = await newSession(this.rpc, this.cwd, this.authMethod, init);
        this.sessionId = r.sessionId;
      }
      this.modes = (r && r.modes && r.modes.availableModes) || [];
      this.currentMode = r && r.modes ? r.modes.currentModeId : null;
      await this.applyMode();
      this.readModels(r);
      await this.applyModel();
      this.shape.init(this.sessionId, this.model || this.currentModel || '');
      if (this.modelOptions.length) this.shape.emit({ type: 'system', subtype: 'models', models: this.modelOptions, current: this.currentModel });
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

  // The models the agent offers for this session (Cursor lists them), so the app's Model menu can show them.
  readModels(r) {
    this.modelOptions = [];
    this.currentModel = null;
    const opt = r && Array.isArray(r.configOptions) && r.configOptions.find((o) => o.category === 'model' || o.id === 'model');
    if (opt) {
      const flat = (list) => (list || []).flatMap((o) => (Array.isArray(o.options) ? flat(o.options) : [o]));
      this.modelConfigId = opt.id;
      this.modelOptions = flat(opt.options).filter((o) => o && o.value != null).map((o) => ({ id: String(o.value), label: o.name || String(o.value) }));
      this.currentModel = opt.currentValue != null ? String(opt.currentValue) : null;
    } else if (r && r.models && Array.isArray(r.models.availableModels)) {
      this.modelConfigId = null;
      this.modelOptions = r.models.availableModels.map((m) => ({ id: m.modelId, label: m.name || m.modelId }));
      this.currentModel = r.models.currentModelId || null;
    }
  }

  async applyModel() {
    const want = this.model;
    if (!want || want === this.currentModel || !this.modelOptions.some((m) => m.id === want)) return;
    try {
      if (this.modelConfigId) await this.rpc.request('session/set_config_option', { sessionId: this.sessionId, configId: this.modelConfigId, value: want }, 15000);
      else await this.rpc.request('session/set_model', { sessionId: this.sessionId, modelId: want }, 15000);
      this.currentModel = want;
    } catch {
      /* keep the agent's own default */
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
    // Once per run: the workspace's other folders, and AGENTS.md for agents that don't read it.
    // These go after the message so the agent's own chat title comes from what the user typed.
    if (!this.toldContext) {
      this.toldContext = true;
      if (this.dirs.length) prompt.push({ type: 'text', text: '\n\n' + dirsNote(this.dirs) });
      if (this.rules) prompt.push({ type: 'text', text: '\n\n' + appNote(`The project's rules, from AGENTS.md. Follow them:\n\n${this.rules}`) });
    }
    this.turnStarted = Date.now();
    // The reply to session/prompt only comes when the turn ends, so don't wait for it here.
    this.rpc
      .request('session/prompt', { sessionId: this.sessionId, prompt })
      .then((r) => {
        if (r && r.usage) this.shape.usage({ input: r.usage.inputTokens || 0, output: r.usage.outputTokens || 0 });
        this.finish(r && r.stopReason === 'refusal' ? `${this.label} declined to answer.` : null);
      })
      .catch((err) => this.finish(err.code === NOT_SIGNED_IN ? `${this.label} isn't signed in. Open Settings → Agents.` : this.explain(String(err.message || err))));
  }

  // Cursor sometimes rejects its own default model ("Auto", sent as "default[]") for an account.
  explain(message) {
    if (!/model name is not valid|model not found/i.test(message)) return message;
    const current = this.modelOptions.find((m) => m.id === this.currentModel);
    const name = current ? current.label : this.currentModel || 'the default model';
    return `${this.label} wouldn't run ${name} for your account right now (it said: ${message.trim()}). Pick another model from the Model menu below and send your message again.${this.modelOptions.length ? '' : ' If the menu is empty, choose a model in ' + this.label + ' itself first.'}${this.label === 'Cursor' ? ' If every model fails, your Cursor CLI is probably out of date: run `agent update` in the terminal.' : ''}`;
  }

  finish(error) {
    if (!this.turnStarted) return;
    // Cursor can report a rejected model as reply text rather than an error.
    const said = this.turnText || '';
    this.turnText = '';
    if (!error && said.length < 600 && /model name is not valid/i.test(said)) this.shape.notice(this.explain(said).replace(/ \(it said: [\s\S]*?\)\./, '.'));
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
        if (u.content && u.content.type === 'text') {
          s.text(u.content.text, u.messageId || 'text');
          this.turnText = (this.turnText || '') + u.content.text;
        }
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

// session/new. Some agents (Cursor) want `authenticate` with their own stored-login method first;
// that uses the login the user made with the CLI and never passes credentials through here.
async function newSession(rpc, cwd, authMethod, init) {
  const params = { cwd, mcpServers: [] };
  try {
    return await rpc.request('session/new', params, 120000);
  } catch (err) {
    const offered = (init.authMethods || []).some((m) => m.id === authMethod);
    if (err.code !== NOT_SIGNED_IN || !authMethod || !offered) throw err;
    await rpc.request('authenticate', { methodId: authMethod }, 60000);
    return rpc.request('session/new', params, 120000);
  }
}

// Signed in? Starts the agent and asks for a session, without sending anything.
async function acpStatus(bin, args, extraEnv, authMethod) {
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
      const r = await newSession(rpc, os.tmpdir(), authMethod, init);
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

// A short-lived agent for one question about its saved conversations.
async function acpAsk(bin, args, extraEnv, cwd, authMethod, fn) {
  const env = await cli.childEnv(extraEnv);
  const child = spawnAgent(bin, args, { env, cwd });
  const rpc = new RpcPeer(child, { onNotification: (m, p) => rpc.onNote && rpc.onNote(m, p), onRequest: () => ({ outcome: { outcome: 'cancelled' } }) });
  child.on('error', (e) => rpc.failAll(String(e.message || e)));
  child.on('close', () => rpc.failAll('It stopped.'));
  try {
    const init = await rpc.request('initialize', CLIENT, 60000);
    const auth = async (call) => {
      try {
        return await call();
      } catch (err) {
        if (err.code !== NOT_SIGNED_IN || !authMethod || !(init.authMethods || []).some((m) => m.id === authMethod)) throw err;
        await rpc.request('authenticate', { methodId: authMethod }, 60000);
        return call();
      }
    };
    return await fn(rpc, init.agentCapabilities || {}, auth);
  } finally {
    setTimeout(() => child.kill(), 300);
  }
}

// Past conversations in a folder, for agents that can list them: [{ id, title, updatedAt }].
function acpSessions(bin, args, extraEnv, cwd, authMethod) {
  return acpAsk(bin, args, extraEnv, cwd, authMethod, async (rpc, caps, auth) => {
    if (!(caps.sessionCapabilities && caps.sessionCapabilities.list)) return [];
    const r = await auth(() => rpc.request('session/list', { cwd }, 30000));
    return (r.sessions || [])
      .filter((x) => !x.cwd || x.cwd === cwd)
      .map((x) => ({ id: x.sessionId, title: chatTitle(x.title, 'Chat'), updatedAt: x.updatedAt ? Date.parse(x.updatedAt) || 0 : 0 }));
  });
}

// One conversation as chat messages, from the agent replaying it: [{ role, text } | { role: 'tool', name, input }].
function acpHistory(bin, args, extraEnv, cwd, authMethod, sessionId) {
  return acpAsk(bin, args, extraEnv, cwd, authMethod, async (rpc, caps, auth) => {
    if (!caps.loadSession) return null;
    const out = [];
    const add = (role, text) => {
      const last = out[out.length - 1];
      if (last && last.role === role) last.text += text;
      else out.push({ role, text });
    };
    rpc.onNote = (method, p) => {
      const u = (method === 'session/update' && p && p.update) || {};
      const text = u.content && u.content.type === 'text' ? u.content.text : '';
      if (u.sessionUpdate === 'user_message_chunk' && text) add('user', text);
      else if (u.sessionUpdate === 'agent_message_chunk' && text) add('assistant', text);
      else if (u.sessionUpdate === 'tool_call') {
        const t = toolFor(u);
        out.push({ role: 'tool', name: t.name, input: t.input });
      }
    };
    await auth(() => rpc.request('session/load', { sessionId, cwd, mcpServers: [] }, 120000));
    return out.map((m) => (m.role === 'user' ? { ...m, text: stripAppNotes(m.text).trim() } : m)).filter((m) => m.role === 'tool' || m.text.trim());
  });
}

module.exports = { AcpSession, acpStatus, acpSessions, acpHistory };
