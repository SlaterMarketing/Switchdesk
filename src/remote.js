// SSH folders: a folder on another machine, opened over SSH. One `ssh` connection runs
// remote-helper.py on the host for files, search, git and snapshots; agents and terminals each run
// over their own `ssh` connection, on the host, in the folder. Uses the system's own OpenSSH client,
// so ~/.ssh/config, keys and ssh-agent work as they do in a terminal. No passwords: it signs in
// with your keys.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const EventEmitter = require('events');

const isWin = process.platform === 'win32';
const HELPER = fs.readFileSync(path.join(__dirname, 'remote-helper.py'), 'utf8');
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`; // for the host's shell

// "ssh://user@host:2222/home/me/app" -> { spec: 'user@host:2222', dir: '/home/me/app' }
function parseUrl(url) {
  const m = /^ssh:\/\/([^/]+)(\/.*)?$/.exec(url || '');
  return m ? { spec: decodeURIComponent(m[1]), dir: m[2] ? decodeURI(m[2]) : '' } : null;
}
const urlOf = (spec, dir) => `ssh://${spec}${encodeURI(dir)}`;

// The hosts in ~/.ssh/config, to offer in the dialog.
function configHosts() {
  try {
    const text = fs.readFileSync(path.join(os.homedir(), '.ssh', 'config'), 'utf8');
    const out = new Set();
    for (const m of text.matchAll(/^\s*Host\s+(.+)$/gim)) for (const h of m[1].split(/\s+/)) if (h && !/[*?!]/.test(h)) out.add(h);
    return [...out];
  } catch {
    return [];
  }
}

function sshBin() {
  if (isWin) {
    const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
    if (fs.existsSync(sys)) return sys;
  }
  return 'ssh';
}

// "user@host:2222" -> ['-p', '2222', 'user@host'], with options that fail fast instead of asking.
function target(spec) {
  const m = /^(.*?)(?::(\d+))?$/.exec(spec.trim());
  const opts = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30', '-o', 'StrictHostKeyChecking=accept-new'];
  if (process.env.SWITCHDESK_SSH_CONFIG) opts.unshift('-F', process.env.SWITCHDESK_SSH_CONFIG); // the app's tests
  return [...opts, ...(m[2] ? ['-p', m[2]] : []), m[1]];
}

// A command run on the host in the folder, through a login shell so PATH has the user's tools.
function hostCommand(dir, argv) {
  const inner = `export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/bin:$PATH"; ${argv.map(q).join(' ')}`;
  return `cd ${q(dir)} && exec "\${SHELL:-/bin/sh}" -lc ${q(inner)}`;
}

function explain(stderr, spec) {
  const s = String(stderr || '');
  if (/Permission denied|publickey/i.test(s)) return `${spec} didn't accept your SSH key. Switchdesk signs in with your keys (or ssh-agent), not a password: set one up with \`ssh-copy-id ${spec}\` and check \`ssh ${spec}\` works in a terminal.`;
  if (/Could not resolve|Name or service not known|nodename nor servname/i.test(s)) return `Couldn't find the host ${spec}. Check the name, or add it to ~/.ssh/config.`;
  if (/Connection refused|timed out|No route/i.test(s)) return `Couldn't connect to ${spec}: ${s.trim().split('\n').pop()}`;
  if (/python3: (command )?not found|No such file or directory.*python3/i.test(s)) return `${spec} needs Python 3 for Switchdesk to open folders there. Install python3 on it and try again.`;
  if (/Host key verification failed/i.test(s)) return `The host key for ${spec} has changed. If that's expected, remove the old one with \`ssh-keygen -R ${spec.split(':')[0]}\`.`;
  return s.trim().split('\n').slice(-3).join(' ') || `Couldn't connect to ${spec}.`;
}

class Remote extends EventEmitter {
  constructor(spec) {
    super();
    this.spec = spec;
    this.seq = 0;
    this.pending = new Map();
    this.alive = false;
  }

  connect() {
    const code = Buffer.from(HELPER).toString('base64');
    const cmd = `python3 -u -c "import base64,sys;exec(base64.b64decode(sys.argv[1]))" ${code}`;
    this.child = spawn(sshBin(), [...target(this.spec), cmd], { windowsHide: true });
    let buf = '';
    let stderr = '';
    return new Promise((resolve, reject) => {
      let started = false;
      this.child.stdout.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          let m;
          try {
            m = JSON.parse(line);
          } catch {
            continue; // a login banner or the like
          }
          if (m.event === 'ready' && !started) {
            started = true;
            this.alive = true;
            resolve(this);
          } else if (m.event) this.emit(m.event, m);
          else if (this.pending.has(m.id)) {
            const p = this.pending.get(m.id);
            this.pending.delete(m.id);
            if (m.error) p.reject(new Error(m.error));
            else p.resolve(m.ok);
          }
        }
      });
      this.child.stderr.on('data', (c) => (stderr = (stderr + c.toString('utf8')).slice(-4000)));
      this.child.on('error', (e) => !started && ((started = true), reject(new Error(String(e.code === 'ENOENT' ? 'No ssh command found. Install OpenSSH (on Windows: Settings → Apps → Optional features → OpenSSH Client).' : e.message)))));
      this.child.on('close', () => {
        this.alive = false;
        for (const p of this.pending.values()) p.reject(new Error(`The connection to ${this.spec} closed.`));
        this.pending.clear();
        if (!started) {
          started = true;
          reject(new Error(explain(stderr, this.spec)));
        } else this.emit('closed', explain(stderr, this.spec));
      });
    });
  }

  call(op, params = {}, timeout = 120000) {
    if (!this.alive) return Promise.reject(new Error(`Not connected to ${this.spec}.`));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.pending.has(id) && (this.pending.delete(id), reject(new Error(`${this.spec} didn't answer (${op}).`))), timeout);
      this.pending.set(id, { resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) });
      this.child.stdin.write(JSON.stringify({ id, op, ...params }) + '\n');
    });
  }

  // Runs a command on the host: { code, stdout (Buffer), stderr }.
  async exec(argv, cwd, { input, env, timeout } = {}) {
    const r = await this.call('exec', { argv, cwd, input: input ? Buffer.from(input).toString('base64') : undefined, env, timeout: timeout ? timeout / 1000 : 120 }, (timeout || 120000) + 10000);
    return { ...r, stdout: Buffer.from(r.stdout, 'base64') };
  }

  // spawn() arguments for a program run on the host in dir: an agent's CLI, over its own connection.
  spawnArgs(dir, argv, { tty = false } = {}) {
    return { command: sshBin(), args: [...(tty ? ['-tt'] : ['-T']), ...target(this.spec), hostCommand(dir, argv)] };
  }

  // A login shell on the host, in the folder, for the terminal.
  shellArgs(dir) {
    return { command: sshBin(), args: ['-tt', ...target(this.spec), `cd ${q(dir)} && exec "\${SHELL:-/bin/sh}" -l`] };
  }

  // A port on this machine that reaches port on the host (for the debugger): { port, close }.
  async forward(port) {
    const local = await new Promise((resolve, reject) => {
      const srv = require('net').createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const p = srv.address().port;
        srv.close(() => resolve(p));
      });
    });
    const child = spawn(sshBin(), ['-N', '-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${local}:127.0.0.1:${port}`, ...target(this.spec)], { windowsHide: true });
    const close = () => {
      try {
        child.kill();
      } catch {
        /* gone */
      }
    };
    // Ready once something answers on the local port.
    for (let i = 0; i < 100; i++) {
      if (child.exitCode != null) throw new Error(`Couldn't forward the debugger's port from ${this.spec}.`);
      const ok = await new Promise((resolve) => {
        const s = require('net').connect(local, '127.0.0.1', () => (s.end(), resolve(true)));
        s.on('error', () => resolve(false));
      });
      if (ok) return { port: local, close };
      await new Promise((r) => setTimeout(r, 100));
    }
    close();
    throw new Error(`Couldn't forward the debugger's port from ${this.spec}.`);
  }

  close() {
    this.alive = false;
    try {
      this.child.kill();
    } catch {
      /* gone */
    }
  }
}

// A snapshot of the folder before an agent's turn, kept on the host (a git tree when it's a repo),
// plus the files the agent is about to edit, read first. Used like snapshots.js's TurnSnapshot.
class RemoteSnapshot {
  constructor(remote, workspace) {
    this.remote = remote;
    this.workspace = workspace;
    this.snap = null;
    this.touched = new Map(); // abs -> Promise<base64 | null>
  }

  async begin() {
    try {
      this.snap = await this.remote.call('snapshot', { root: this.workspace }, 60000);
    } catch {
      this.snap = null;
    }
    return this;
  }

  touch(abs) {
    if (this.touched.has(abs)) return;
    this.touched.set(
      abs,
      this.remote.call('read', { path: abs }).then(
        (r) => (r.content != null ? Buffer.from(r.content).toString('base64') : r.b64 || null),
        () => null
      )
    );
  }

  async changes() {
    const touched = {};
    for (const [abs, p] of this.touched) touched[abs] = await p;
    const list = await this.remote.call('changes', { root: this.workspace, snap: this.snap, touched }, 120000);
    this.result = new Map(list.map((c) => [c.path, c]));
    return list.map((c) => ({ path: c.path, rel: path.posix.relative(this.workspace, c.path), before: c.before, after: c.after, created: c.created, deleted: c.deleted, binary: c.binary }));
  }

  async undo(absPaths) {
    for (const abs of absPaths) {
      const c = this.result && this.result.get(abs);
      if (!c) continue;
      if (c.created) await this.remote.call('remove', { path: abs });
      else if (c.beforeB64 != null) await this.remote.call('write', { path: abs, b64: c.beforeB64 });
    }
  }
}

// Checks a host answers, for the dialog's "Connect" before anything else happens.
function test(spec) {
  return new Promise((resolve) => {
    execFile(sshBin(), [...target(spec), 'echo ok'], { timeout: 25000, windowsHide: true }, (err, out, errOut) => resolve(err ? { error: explain(errOut || err.message, spec) } : { ok: true }));
  });
}

module.exports = { Remote, RemoteSnapshot, parseUrl, urlOf, configHosts, test, q };
