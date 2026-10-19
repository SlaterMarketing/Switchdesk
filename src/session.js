// One long-lived Claude Code process per chat tab.
//
// The CLI runs in headless mode with stream-json on both stdin and stdout, the same
// protocol the Agent SDK uses. Messages, mode switches, model switches and interrupts
// all go over stdin, so follow-up messages don't pay the CLI startup cost, and
// permission prompts arrive as `can_use_tool` control requests we answer directly.

const { spawn } = require('child_process');
const crypto = require('crypto');
const cli = require('./claude-cli');

const isWin = process.platform === 'win32';

// App modes → Claude Code permission modes. Ask mode runs in "default" so anything
// that would change something asks first, and the app declines those requests.
const PERMISSION_MODE = { ask: 'default', plan: 'plan', agent: 'acceptEdits', debug: 'acceptEdits', auto: 'auto' };

const CONNECT_HINT =
  "You are running inside Switchdesk, a desktop app. When the user asks to connect a service or connector (Jira, Google Sheets, Gmail, Slack, Linear and so on), when an MCP server needs authentication, or when tools you'd expect from a connector the user has turned on are missing, call the connect_mcp_server tool (from switchdesk-preview; search for it if it isn't loaded) with the service's name. It signs the user in through their browser and makes the tools available, so don't tell them to run /mcp, visit settings or start a new session until it has failed.";

class ChatSession {
  constructor({ bin, cwd, dirs, env, sessionId, resumeAt, model, effort, mode, mcp, via, onEvent, onPermission, onExit, askRules }) {
    Object.assign(this, { bin, cwd, dirs: dirs || [], extraEnv: env || {}, sessionId, resumeAt, model, effort, mode, mcp, via, onEvent, onPermission, onExit, askRules });
    this.child = null;
    this.pending = new Map(); // our control request id -> resolve
    this.alive = false;
  }

  async start() {
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-prompt-tool',
      'stdio',
      '--permission-mode',
      PERMISSION_MODE[this.mode] || 'acceptEdits',
    ];
    for (const d of this.dirs) args.push('--add-dir', d); // the workspace's other folders
    // Switchdesk's own tools (the Preview), alongside the user's MCP servers.
    if (this.mcp) args.push('--mcp-config', JSON.stringify({ mcpServers: { [this.mcp.name]: { type: 'stdio', command: this.mcp.command, args: this.mcp.args, env: this.mcp.env } } }));
    // Claude Code tells the model to send the user to /mcp, a terminal menu. Switchdesk does it itself.
    if (this.mcp) args.push('--append-system-prompt', CONNECT_HINT);
    // The always-ask rules (permissions.js), which Claude then asks about in its Auto mode too.
    if (this.askRules && this.askRules.length) args.push('--settings', JSON.stringify({ permissions: { ask: this.askRules } }));
    if (this.model) args.push('--model', this.model);
    if (this.effort) args.push('--effort', this.effort);
    if (this.sessionId) args.push('--resume', this.sessionId);
    // Rewind: carry on from an earlier reply, as a new conversation so the original stays intact.
    if (this.sessionId && this.resumeAt) args.push('--resume-session-at', this.resumeAt, '--fork-session');

    const env = await cli.childEnv(this.extraEnv); // extraEnv picks the account
    // In an SSH folder the CLI runs on the host, over ssh (remote.js).
    const run = this.via ? this.via(args) : null;
    this.child = run ? spawn(run.command, run.args, { env: process.env, windowsHide: true }) : spawn(this.bin, args, { cwd: this.cwd, env, shell: isWin && this.bin.endsWith('.cmd'), windowsHide: true });
    this.alive = true;
    let buf = '';
    let stderr = '';
    this.child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        this.handle(ev);
      }
    });
    this.child.stderr.on('data', (c) => (stderr = (stderr + c.toString('utf8')).slice(-8000)));
    this.child.on('error', (err) => {
      this.alive = false;
      this.onExit({ code: -1, stderr: String(err) });
    });
    this.child.on('close', (code) => {
      this.alive = false;
      for (const resolve of this.pending.values()) resolve({ error: 'Claude Code exited.' });
      this.pending.clear();
      this.onExit({ code, stderr });
    });
    this.control({ subtype: 'initialize', hooks: null });
  }

  handle(ev) {
    if (ev.type === 'control_response') {
      const r = ev.response || {};
      const resolve = this.pending.get(r.request_id);
      if (resolve) {
        this.pending.delete(r.request_id);
        resolve(r.subtype === 'success' ? { ok: true, response: r.response } : { error: r.error || 'Request failed' });
      }
      return;
    }
    if (ev.type === 'control_request') {
      const req = ev.request || {};
      if (req.subtype === 'can_use_tool') {
        Promise.resolve(this.onPermission({ toolName: req.tool_name, input: req.input || {}, toolUseId: req.tool_use_id, description: req.description }))
          .then((decision) => this.respond(ev.request_id, decision))
          .catch((err) => this.respond(ev.request_id, { behavior: 'deny', message: String(err) }));
      } else {
        this.write({ type: 'control_response', response: { subtype: 'error', request_id: ev.request_id, error: `Unsupported request: ${req.subtype}` } });
      }
      return;
    }
    if (ev.type === 'control_cancel_request') return;
    if (ev.session_id) this.sessionId = ev.session_id;
    this.onEvent(ev);
  }

  write(obj) {
    if (this.alive && this.child.stdin.writable) this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  respond(requestId, decision) {
    const response =
      decision && decision.behavior === 'allow'
        ? { behavior: 'allow', updatedInput: decision.updatedInput || {} }
        : { behavior: 'deny', message: (decision && decision.message) || 'The user denied this action.', interrupt: !!(decision && decision.interrupt) };
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
  }

  control(request) {
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.write({ type: 'control_request', request_id: id, request });
      setTimeout(() => {
        if (this.pending.delete(id)) resolve({ error: 'Timed out' });
      }, 15000);
    });
  }

  async setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    await this.control({ subtype: 'set_permission_mode', mode: PERMISSION_MODE[mode] || 'acceptEdits' });
  }

  async setModel(model) {
    if ((model || '') === (this.model || '')) return;
    this.model = model;
    await this.control({ subtype: 'set_model', model: model || 'default' });
  }

  async send(content, mode) {
    await this.setMode(mode);
    this.write({ type: 'user', message: { role: 'user', content } });
  }

  interrupt() {
    return this.control({ subtype: 'interrupt' });
  }

  dispose() {
    if (!this.child) return;
    const child = this.child;
    try {
      child.stdin.end();
    } catch {
      /* already closed */
    }
    setTimeout(() => {
      if (child.exitCode === null) child.kill();
    }, 3000);
  }
}

module.exports = { ChatSession, PERMISSION_MODE };
