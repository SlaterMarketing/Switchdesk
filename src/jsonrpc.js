// JSON-RPC over a child process's stdin/stdout, one message per line. Codex's app-server and
// ACP agents (Kimi, Gemini, Qwen) both talk this way, in both directions.

class RpcPeer {
  constructor(child, { onRequest, onNotification, onLine } = {}) {
    this.child = child;
    this.onRequest = onRequest || (async () => {
      throw new Error('Not supported');
    });
    this.onNotification = onNotification || (() => {});
    this.nextId = 1;
    this.pending = new Map();
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        if (onLine) onLine(line);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // not ours (some CLIs print logs to stdout)
        }
        this.handle(msg);
      }
    });
  }

  handle(msg) {
    if (msg.method && msg.id !== undefined && msg.id !== null) {
      Promise.resolve()
        .then(() => this.onRequest(msg.method, msg.params || {}))
        .then((result) => this.write({ jsonrpc: '2.0', id: msg.id, result: result === undefined ? null : result }))
        .catch((err) => this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String((err && err.message) || err) } }));
    } else if (msg.method) {
      this.onNotification(msg.method, msg.params || {});
    } else if (this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(Object.assign(new Error(msg.error.message || 'Request failed'), { code: msg.error.code, data: msg.error.data }));
      else resolve(msg.result);
    }
  }

  write(obj) {
    if (this.child.stdin.writable) this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params, timeoutMs = 0) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params: params || {} });
      if (timeoutMs)
        setTimeout(() => {
          if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
        }, timeoutMs);
    });
  }

  notify(method, params) {
    this.write({ jsonrpc: '2.0', method, params: params || {} });
  }

  // The process ended: fail anything still waiting.
  failAll(message) {
    for (const { reject } of this.pending.values()) reject(new Error(message));
    this.pending.clear();
  }
}

module.exports = { RpcPeer };
