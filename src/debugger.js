// Run and debug a file: breakpoints, stepping, the call stack, variables and a console.
//   Node (JavaScript, and TypeScript with Node's type stripping): Node's own inspector, spoken to
//     directly over the Chrome DevTools Protocol, so nothing else needs installing.
//   Python: debugpy, the debugger VS Code uses, over the Debug Adapter Protocol.
// Both look the same to the window: events out (output, stopped, continued, terminated) and the
// same few calls in.
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');

const INSPECTOR_NOISE = /^(Debugger listening on ws:|For help, see: https:\/\/nodejs\.org|Debugger attached\.|Waiting for the debugger to disconnect\.\.\.)/;

// Values shown in the Variables list, one line each.
function preview(v) {
  if (!v) return 'undefined';
  if (v.type === 'undefined') return 'undefined';
  if (v.type === 'string') return JSON.stringify(v.value);
  if (v.unserializableValue) return v.unserializableValue;
  if (v.type === 'object' && v.subtype === 'null') return 'null';
  if ('value' in v && v.type !== 'object') return String(v.value);
  if (v.type === 'function') return `ƒ ${v.description ? v.description.split('\n')[0].replace(/^function\s*/, '').slice(0, 60) : ''}`;
  if (v.preview && v.preview.properties) {
    const props = v.preview.properties.map((p) => (v.subtype === 'array' ? p.value : `${p.name}: ${p.type === 'string' ? JSON.stringify(p.value) : p.value}`));
    const body = props.join(', ') + (v.preview.overflow ? ', …' : '');
    return v.subtype === 'array' ? `${v.description.replace(/\(\d+\)$/, '')}(${v.description.match(/\((\d+)\)/)?.[1] || ''}) [${body}]` : `${v.className && v.className !== 'Object' ? v.className + ' ' : ''}{${body}}`;
  }
  return v.description || v.className || v.type;
}

// Runs the program here, or (host: an SSH folder's connection) on that machine, in the same folder.
function launch(host, bin, args, { cwd, env }) {
  if (!host) return spawn(bin, args, { cwd, env, windowsHide: true });
  const via = host.spawnArgs(cwd, [bin, ...args]);
  return spawn(via.command, via.args, { windowsHide: true });
}

// File URLs for this machine's paths, or a host's POSIX ones.
const urlOf = (file, host) => (host ? 'file://' + file.split('/').map(encodeURIComponent).join('/') : pathToFileURL(file).href);
const fileOfUrl = (url, host) => (host ? decodeURIComponent(new URL(url).pathname) : fileURLToPath(url));

class NodeDebug {
  constructor({ program, args, cwd, env, node, onEvent, host }) {
    Object.assign(this, { program, args: args || [], cwd, env, node, onEvent, host: host || null });
    this.seq = 0;
    this.waits = new Map();
    this.scripts = new Map(); // scriptId -> url
    this.breakpoints = new Map(); // abs path -> [cdp breakpoint ids]
    this.refs = new Map(); // variables reference -> objectId
    this.nextRef = 1;
    this.frames = [];
    this.paused = false;
    this.pauseOnExceptions = 'uncaught';
  }

  send(method, params = {}) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('The program has stopped.'));
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.waits.set(id, { resolve, reject }));
  }

  async start(breakpoints) {
    const flags = [`--inspect-brk=127.0.0.1:0`];
    if (/\.(ts|mts|cts)$/.test(this.program)) flags.push('--experimental-strip-types', '--no-warnings=ExperimentalWarning');
    this.child = launch(this.host, this.node, [...flags, this.program, ...this.args], { cwd: this.cwd, env: this.env });
    this.child.stdout.on('data', (d) => this.onEvent({ type: 'output', category: 'stdout', text: d.toString('utf8') }));
    let wsUrl = null;
    const found = new Promise((resolve, reject) => {
      let buf = '';
      this.child.stderr.on('data', (d) => {
        const text = d.toString('utf8');
        if (!wsUrl) {
          buf += text;
          const m = /Debugger listening on (ws:\/\/\S+)/.exec(buf);
          if (m) resolve((wsUrl = m[1]));
        }
        const shown = text.split(/(?<=\n)/).filter((l) => !INSPECTOR_NOISE.test(l.trim())).join('');
        if (shown) this.onEvent({ type: 'output', category: 'stderr', text: shown });
      });
      this.child.on('error', reject);
      this.child.on('exit', (code) => reject(new Error(`Node exited (${code}) before the debugger could connect.`)));
    });
    this.child.on('exit', (code) => this.finish(code));
    await found;
    if (this.host) {
      // The inspector listens on the host: reach it through a forwarded port.
      const u = new URL(wsUrl);
      this.tunnel = await this.host.forward(Number(u.port));
      u.port = String(this.tunnel.port);
      wsUrl = u.href;
    }
    this.ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error("Couldn't connect to Node's debugger."));
    });
    this.ws.onmessage = (e) => this.message(JSON.parse(e.data));
    this.ws.onclose = () => this.child && this.child.exitCode == null && this.child.kill();
    await this.send('Runtime.enable');
    await this.send('Debugger.enable');
    await this.send('Debugger.setBlackboxPatterns', { patterns: ['^node:', '/node_modules/'] }).catch(() => {});
    await this.send('Debugger.setPauseOnExceptions', { state: this.pauseOnExceptions });
    for (const [file, lines] of Object.entries(breakpoints || {})) await this.setBreakpoints(file, lines);
    this.starting = true; // the pause on the first line is ours, not the user's
    await this.send('Runtime.runIfWaitingForDebugger');
  }

  message(msg) {
    if (msg.id) {
      const w = this.waits.get(msg.id);
      if (!w) return;
      this.waits.delete(msg.id);
      return msg.error ? w.reject(new Error(msg.error.message)) : w.resolve(msg.result);
    }
    const p = msg.params || {};
    if (msg.method === 'Debugger.scriptParsed') this.scripts.set(p.scriptId, p.url);
    else if (msg.method === 'Debugger.paused') this.onPaused(p);
    else if (msg.method === 'Debugger.resumed') {
      this.paused = false;
      this.refs.clear();
      this.onEvent({ type: 'continued' });
    } else if (msg.method === 'Runtime.executionContextDestroyed') this.ws.close(); // the program ended: let Node exit
    else if (msg.method === 'Runtime.exceptionThrown' && !this.paused) this.onEvent({ type: 'output', category: 'stderr', text: (p.exceptionDetails.exception?.description || p.exceptionDetails.text) + '\n' });
  }

  onPaused(p) {
    if (this.starting) {
      this.starting = false;
      if (p.reason === 'Break on start' || p.reason === 'other') return this.send('Debugger.resume').catch(() => {});
    }
    this.paused = true;
    this.frames = p.callFrames.map((f, i) => {
      const url = f.url || this.scripts.get(f.location.scriptId) || '';
      let file = null;
      try {
        file = url.startsWith('file:') ? fileOfUrl(url, this.host) : null;
      } catch {}
      return { id: i, cdp: f, name: f.functionName || '(anonymous)', file, url, line: f.location.lineNumber + 1, column: (f.location.columnNumber || 0) + 1, internal: !file };
    });
    const reason = p.reason === 'exception' || p.reason === 'promiseRejection' ? 'exception' : p.hitBreakpoints && p.hitBreakpoints.length ? 'breakpoint' : this.stepping ? 'step' : p.reason === 'other' ? 'pause' : p.reason;
    this.stepping = false;
    const exception = reason === 'exception' && p.data ? preview(p.data) : null;
    this.onEvent({ type: 'stopped', reason, exception: exception && p.data.description ? p.data.description.split('\n')[0] : exception, frames: this.frames.map(({ cdp, ...f }) => f) });
  }

  async setBreakpoints(file, lines) {
    for (const id of this.breakpoints.get(file) || []) await this.send('Debugger.removeBreakpoint', { breakpointId: id }).catch(() => {});
    const ids = [];
    const url = urlOf(file, this.host);
    for (const line of lines) {
      try {
        const r = await this.send('Debugger.setBreakpointByUrl', { url, lineNumber: line - 1, columnNumber: 0 });
        ids.push(r.breakpointId);
      } catch {}
    }
    this.breakpoints.set(file, ids);
  }

  setExceptions(mode) {
    this.pauseOnExceptions = mode;
    return this.send('Debugger.setPauseOnExceptions', { state: mode }).catch(() => {});
  }

  cont() {
    return this.send('Debugger.resume');
  }
  next() {
    this.stepping = true;
    return this.send('Debugger.stepOver');
  }
  stepIn() {
    this.stepping = true;
    return this.send('Debugger.stepInto');
  }
  stepOut() {
    this.stepping = true;
    return this.send('Debugger.stepOut');
  }
  pause() {
    return this.send('Debugger.pause');
  }

  ref(objectId) {
    const r = this.nextRef++;
    this.refs.set(r, objectId);
    return r;
  }

  async scopes(frameId) {
    const f = this.frames[frameId];
    if (!f) return [];
    return f.cdp.scopeChain
      .filter((s) => s.type !== 'global' || f.cdp.scopeChain.length === 1)
      .map((s) => ({ name: s.type === 'local' ? 'Local' : s.type === 'closure' ? `Closure${s.name ? ' (' + s.name + ')' : ''}` : s.type === 'block' ? 'Block' : s.type === 'module' ? 'Module' : s.type[0].toUpperCase() + s.type.slice(1), ref: this.ref(s.object.objectId), expensive: s.type === 'global' }));
  }

  async variables(ref) {
    const objectId = this.refs.get(ref);
    if (!objectId) return [];
    const r = await this.send('Runtime.getProperties', { objectId, ownProperties: true, generatePreview: true });
    return (r.result || [])
      .filter((p) => p.value || p.get)
      .filter((p) => p.name !== '__proto__')
      .map((p) => ({ name: p.name, value: p.value ? preview(p.value) : '(getter)', type: p.value ? p.value.subtype || p.value.type : 'accessor', ref: p.value && p.value.objectId && p.value.type === 'object' && p.value.subtype !== 'null' ? this.ref(p.value.objectId) : 0 }));
  }

  async evaluate(expression, frameId) {
    const f = this.paused ? this.frames[frameId ?? 0] : null;
    const r = f
      ? await this.send('Debugger.evaluateOnCallFrame', { callFrameId: f.cdp.callFrameId, expression, generatePreview: true })
      : await this.send('Runtime.evaluate', { expression, generatePreview: true, replMode: true });
    if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description?.split('\n')[0] || r.exceptionDetails.text };
    return { value: preview(r.result), ref: r.result.objectId && r.result.type === 'object' ? this.ref(r.result.objectId) : 0 };
  }

  stop() {
    try {
      this.ws && this.ws.close();
    } catch {}
    if (this.child && this.child.exitCode == null) this.child.kill();
    if (this.tunnel) this.tunnel.close();
  }

  finish(code) {
    if (this.done) return;
    this.done = true;
    try {
      this.ws && this.ws.close();
    } catch {}
    if (this.tunnel) this.tunnel.close();
    this.onEvent({ type: 'terminated', code });
  }
}

// ---------- Python, through debugpy's adapter (Debug Adapter Protocol over stdio)

class PythonDebug {
  constructor({ program, args, cwd, env, python, onEvent, host }) {
    Object.assign(this, { program, args: args || [], cwd, env, python, onEvent, host: host || null });
    this.seq = 0;
    this.waits = new Map();
    this.buf = Buffer.alloc(0);
    this.threadId = null;
    this.frames = [];
    this.paused = false;
    this.exceptionFilters = ['uncaught'];
  }

  send(command, args = {}) {
    if (!this.child || this.child.exitCode != null) return Promise.reject(new Error('The program has stopped.'));
    const seq = ++this.seq;
    const body = Buffer.from(JSON.stringify({ seq, type: 'request', command, arguments: args }), 'utf8');
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
    return new Promise((resolve, reject) => this.waits.set(seq, { resolve, reject }));
  }

  async start(breakpoints) {
    this.child = launch(this.host, this.python, ['-m', 'debugpy.adapter'], { cwd: this.cwd, env: this.env });
    let stderr = '';
    this.child.stderr.on('data', (d) => (stderr += d.toString('utf8')).slice(-4000));
    this.child.stdout.on('data', (d) => this.read(d));
    this.child.on('exit', (code) => {
      for (const w of this.waits.values()) w.reject(new Error(/No module named debugpy/.test(stderr) ? 'NO_DEBUGPY' : stderr.trim().split('\n').pop() || `The debugger stopped (${code}).`));
      this.waits.clear();
      this.finish(this.exitCode ?? code);
    });
    this.child.on('error', (e) => this.onEvent({ type: 'output', category: 'stderr', text: String(e.message) + '\n' }));
    await this.send('initialize', { clientID: 'switchdesk', clientName: 'Switchdesk', adapterID: 'debugpy', pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true, supportsVariableType: true });
    this.pendingBreakpoints = breakpoints || {};
    // debugpy answers launch only after configurationDone, which goes out when it says it's initialized.
    this.launched = this.send('launch', { program: this.program, args: this.args, cwd: this.cwd, console: 'internalConsole', justMyCode: true, redirectOutput: true, env: {} });
    await this.launched;
  }

  read(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const head = this.buf.indexOf('\r\n\r\n');
      if (head < 0) return;
      const m = /Content-Length: (\d+)/i.exec(this.buf.slice(0, head).toString('ascii'));
      const len = m ? Number(m[1]) : 0;
      if (this.buf.length < head + 4 + len) return;
      const msg = JSON.parse(this.buf.slice(head + 4, head + 4 + len).toString('utf8'));
      this.buf = this.buf.slice(head + 4 + len);
      this.message(msg);
    }
  }

  message(msg) {
    if (msg.type === 'response') {
      const w = this.waits.get(msg.request_seq);
      if (!w) return;
      this.waits.delete(msg.request_seq);
      return msg.success ? w.resolve(msg.body || {}) : w.reject(new Error(msg.message || 'The debugger refused that.'));
    }
    if (msg.type === 'request') {
      // debugpy may ask the client to start a terminal; we always use the internal console.
      const body = Buffer.from(JSON.stringify({ seq: ++this.seq, type: 'response', request_seq: msg.seq, success: false, command: msg.command, message: 'Not supported' }));
      this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
      return this.child.stdin.write(body);
    }
    const b = msg.body || {};
    switch (msg.event) {
      case 'initialized':
        return this.configure();
      case 'output':
        if (b.category !== 'telemetry') this.onEvent({ type: 'output', category: b.category === 'stderr' ? 'stderr' : b.category === 'console' ? 'console' : 'stdout', text: b.output });
        return;
      case 'stopped':
        this.threadId = b.threadId;
        return this.onStopped(b);
      case 'continued':
        this.paused = false;
        return this.onEvent({ type: 'continued' });
      case 'exited':
        this.exitCode = b.exitCode;
        return;
      case 'terminated':
        this.finish(this.exitCode);
        return this.stop();
    }
  }

  async configure() {
    for (const [file, lines] of Object.entries(this.pendingBreakpoints)) await this.setBreakpoints(file, lines);
    await this.send('setExceptionBreakpoints', { filters: this.exceptionFilters }).catch(() => {});
    await this.send('configurationDone');
  }

  async onStopped(b) {
    this.paused = true;
    let frames = [];
    try {
      frames = (await this.send('stackTrace', { threadId: b.threadId, levels: 50 })).stackFrames || [];
    } catch {}
    this.frames = frames.map((f) => ({ id: f.id, name: f.name, file: f.source && f.source.path ? f.source.path : null, line: f.line, column: f.column, internal: !f.source || !f.source.path || f.presentationHint === 'subtle' }));
    let exception = null;
    if (b.reason === 'exception') {
      try {
        const info = await this.send('exceptionInfo', { threadId: b.threadId });
        exception = `${info.exceptionId}: ${info.description || ''}`.trim();
      } catch {
        exception = b.text || b.description || null;
      }
    }
    this.onEvent({ type: 'stopped', reason: b.reason, exception, frames: this.frames });
  }

  setBreakpoints(file, lines) {
    return this.send('setBreakpoints', { source: { path: file }, breakpoints: lines.map((line) => ({ line })) }).catch(() => {});
  }

  setExceptions(mode) {
    this.exceptionFilters = mode === 'all' ? ['raised', 'uncaught'] : mode === 'none' ? [] : ['uncaught'];
    return this.send('setExceptionBreakpoints', { filters: this.exceptionFilters }).catch(() => {});
  }

  cont() {
    return this.send('continue', { threadId: this.threadId });
  }
  next() {
    return this.send('next', { threadId: this.threadId });
  }
  stepIn() {
    return this.send('stepIn', { threadId: this.threadId });
  }
  stepOut() {
    return this.send('stepOut', { threadId: this.threadId });
  }
  pause() {
    return this.send('pause', { threadId: this.threadId || 1 });
  }

  async scopes(frameId) {
    const r = await this.send('scopes', { frameId });
    return (r.scopes || []).map((s) => ({ name: s.name, ref: s.variablesReference, expensive: !!s.expensive }));
  }

  async variables(ref) {
    const r = await this.send('variables', { variablesReference: ref });
    return (r.variables || []).filter((v) => !/^(special|function) variables$/.test(v.name)).map((v) => ({ name: v.name, value: v.value, type: v.type || '', ref: v.variablesReference || 0 }));
  }

  async evaluate(expression, frameId) {
    try {
      const r = await this.send('evaluate', { expression, frameId: this.paused ? frameId ?? this.frames[0]?.id : undefined, context: 'repl' });
      return { value: r.result, ref: r.variablesReference || 0 };
    } catch (e) {
      return { error: e.message };
    }
  }

  stop() {
    if (!this.child || this.child.exitCode != null) return;
    this.send('disconnect', { terminateDebuggee: true }).catch(() => {});
    setTimeout(() => this.child && this.child.exitCode == null && this.child.kill(), 1500);
  }

  finish(code) {
    if (this.done) return;
    this.done = true;
    this.onEvent({ type: 'terminated', code });
  }
}

const kindOf = (file) => (/\.(py|pyw)$/i.test(file) ? 'python' : /\.(m?js|cjs|ts|mts|cts)$/i.test(file) ? 'node' : null);

module.exports = { NodeDebug, PythonDebug, kindOf, preview };
