// Jupyter kernels for the notebook view: one Python process per open notebook, running
// kernel-bridge.py, which starts the kernel with jupyter_client and speaks JSON lines to us.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const cli = require('./claude-cli');
const agents = require('./agents');

const isWin = process.platform === 'win32';
const BRIDGE = path.join(__dirname, 'kernel-bridge.py').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const kernels = new Map(); // `${ctx.id}:${rel}` -> { child, ready }

// The folder's own virtual environment first, then the Python you picked, then the one on PATH.
async function findPython(root, settings) {
  const local = isWin ? ['.venv\\Scripts\\python.exe', 'venv\\Scripts\\python.exe', 'env\\Scripts\\python.exe'] : ['.venv/bin/python', 'venv/bin/python', 'env/bin/python'];
  for (const rel of local) if (root && fs.existsSync(path.join(root, rel))) return path.join(root, rel);
  if (settings.pythonPath && fs.existsSync(settings.pythonPath)) return settings.pythonPath;
  // PATH first, the way a terminal would pick it (an activated env, pyenv, conda), then the usual places.
  const env = await cli.childEnv();
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  for (const dir of (env[pathKey] || '').split(path.delimiter))
    for (const name of isWin ? ['python.exe'] : ['python3', 'python']) {
      const p = dir && path.join(dir, name);
      // Skip Windows' Microsoft Store placeholder, which only offers to install Python.
      if (p && fs.existsSync(p) && !/WindowsApps/i.test(p)) return p;
    }
  return agents.findCommand(isWin ? ['python', 'py'] : ['python3', 'python']);
}

// An SSH folder's Python, on its host: the folder's virtual environment, else the one on PATH.
async function hostPython(remote, root) {
  for (const rel of ['.venv/bin/python', 'venv/bin/python', 'env/bin/python']) {
    const p = path.posix.join(root, rel);
    const r = await remote.exec(['test', '-x', p], root).catch(() => null);
    if (r && r.code === 0) return p;
  }
  const r = await remote.exec(['sh', '-lc', 'command -v python3 || command -v python'], root).catch(() => null);
  return (r && r.code === 0 && r.stdout.toString().trim().split('\n').pop()) || null;
}

// Starts (or reuses) the notebook's kernel. send(msg) gets everything the kernel says.
// remote: an SSH folder's connection; the kernel then runs on its host, bridge and all.
async function start(ctx, rel, { abs, root, kernel, settings, send, remote }) {
  const key = `${ctx.id}:${rel}`;
  const had = kernels.get(key);
  if (had) return had.ready;
  const python = remote ? await hostPython(remote, root) : await findPython(root, settings);
  if (!python) return { error: remote ? `No Python found on ${remote.spec}. Install Python 3 there.` : 'No Python found. Install Python 3, or set its path in Settings → Editor.', missing: 'python' };
  let child;
  if (remote) {
    const code = fs.readFileSync(BRIDGE).toString('base64');
    const via = remote.spawnArgs(path.posix.dirname(abs), [python, '-u', '-c', `import base64,sys;exec(base64.b64decode('${code}'))`, kernel || 'python3']);
    child = spawn(via.command, via.args, { windowsHide: true });
  } else {
    const env = await cli.childEnv({ PYTHONUNBUFFERED: '1' });
    child = spawn(python, [BRIDGE, kernel || 'python3'], { cwd: path.dirname(abs), env, windowsHide: true });
  }
  const k = { child, python };
  kernels.set(key, k);
  k.ready = new Promise((resolve) => {
    let buf = '';
    let stderr = '';
    let started = false;
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (!started && m.type === 'ready') {
          started = true;
          resolve({ ok: true, display: m.display, language: m.language, python });
        } else if (!started && m.type === 'error') {
          started = true;
          resolve(m.message === 'missing-jupyter' ? { error: `Jupyter isn't installed for ${python}.`, missing: 'jupyter', python } : { error: m.message });
        } else send(m);
      }
    });
    child.stderr.on('data', (c) => (stderr = (stderr + c.toString('utf8')).slice(-4000)));
    child.on('error', (e) => !started && ((started = true), resolve({ error: String(e.message || e) })));
    child.on('close', () => {
      kernels.delete(key);
      if (!started) resolve({ error: stderr.trim().split('\n').filter((l) => !/WARNING/.test(l)).pop() || 'The kernel stopped.' });
      else send({ type: 'status', state: 'stopped' });
    });
  });
  const r = await k.ready;
  if (r.error) stop(ctx, rel);
  return r;
}

function command(ctx, rel, cmd) {
  const k = kernels.get(`${ctx.id}:${rel}`);
  if (!k || !k.child.stdin.writable) return false;
  k.child.stdin.write(JSON.stringify(cmd) + '\n');
  return true;
}

function stop(ctx, rel) {
  const key = `${ctx.id}:${rel}`;
  const k = kernels.get(key);
  if (!k) return;
  kernels.delete(key);
  try {
    k.child.stdin.write(JSON.stringify({ op: 'shutdown' }) + '\n');
  } catch {
    /* already gone */
  }
  setTimeout(() => k.child.exitCode === null && k.child.kill(), 3000);
}

function stopAll(ctx) {
  for (const key of [...kernels.keys()]) if (key.startsWith(`${ctx.id}:`)) stop(ctx, key.slice(String(ctx.id).length + 1));
}

// The command that installs what the kernel needs, for the app's terminal.
function installCommand(python) {
  const q = /\s/.test(python) ? `"${python}"` : python;
  return `${isWin ? '& ' : ''}${q} -m pip install ipykernel jupyter_client`;
}

module.exports = { start, command, stop, stopAll, installCommand, findPython, hostPython };
