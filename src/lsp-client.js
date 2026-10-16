// A small Language Server Protocol client: Content-Length framed JSON-RPC over a child's stdio.
'use strict';

const { spawn } = require('child_process');

const isWin = process.platform === 'win32';

class Lsp {
  constructor(bin, args, env, name = 'The language server', cwd) {
    this.name = name;
    this.proc = spawn(bin, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: isWin && /\.(cmd|bat)$/i.test(bin) });
    this.buf = Buffer.alloc(0);
    this.next = 1;
    this.pending = new Map();
    this.onNote = () => {};
    this.onExit = () => {};
    this.onRequest = () => null;
    this.closed = false;
    this.proc.stdout.on('data', (d) => this.read(d));
    this.proc.stderr.on('data', () => {});
    this.proc.on('exit', () => {
      this.closed = true;
      this.onExit();
      for (const p of this.pending.values()) p.reject(new Error(`${this.name} stopped.`));
      this.pending.clear();
    });
    this.proc.on('error', () => {});
    this.proc.stdin.on('error', () => {});
  }
  read(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const sep = this.buf.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const m = /Content-Length: *(\d+)/i.exec(this.buf.slice(0, sep).toString());
      if (!m) return (this.buf = this.buf.slice(sep + 4));
      const len = Number(m[1]);
      if (this.buf.length < sep + 4 + len) return;
      let msg;
      try {
        msg = JSON.parse(this.buf.slice(sep + 4, sep + 4 + len).toString());
      } catch {}
      this.buf = this.buf.slice(sep + 4 + len);
      if (msg) this.dispatch(msg);
    }
  }
  dispatch(msg) {
    if (msg.id != null && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      return msg.error ? p.reject(Object.assign(new Error(msg.error.message || 'Copilot error'), { code: msg.error.code })) : p.resolve(msg.result);
    }
    if (msg.method && msg.id != null) {
      // Requests from the server: settings and UI requests get empty answers unless onRequest has one.
      let result = this.onRequest(msg.method, msg.params);
      if (result === undefined || result === null) result = msg.method === 'workspace/configuration' ? ((msg.params && msg.params.items) || []).map(() => null) : null;
      return this.write({ jsonrpc: '2.0', id: msg.id, result });
    }
    if (msg.method) this.onNote(msg.method, msg.params);
  }
  write(m) {
    if (this.closed) return;
    const s = JSON.stringify(m);
    this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`);
  }
  request(method, params, timeout = 30000) {
    if (this.closed) return Promise.reject(new Error(`${this.name} stopped.`));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => (this.pending.delete(id), reject(new Error(`${method} timed out`))), timeout) : null;
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }
  notify(method, params) {
    this.write({ jsonrpc: '2.0', method, params });
  }
  kill() {
    try {
      this.proc.kill();
    } catch {}
  }
}

module.exports = { Lsp };
