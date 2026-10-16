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
  return agents.findCommand(isWin ? ['python', 'py'] : ['python3', 'python']);
}

// Starts (or reuses) the notebook's kernel. send(msg) gets everything the kernel says.
async function start(ctx, rel, { abs, root, kernel, settings, send }) {
  const key = `${ctx.id}:${rel}`;
  const had = kernels.get(key);
  if (had) return had.ready;
  const python = await findPython(root, settings);
  if (!python) return { error: 'No Python found. Install Python 3, or set its path in Settings → Editor.', missing: 'python' };
  const env = await cli.childEnv({ PYTHONUNBUFFERED: '1' });
  const child = spawn(python, [BRIDGE, kernel || 'python3'], { cwd: path.dirname(abs), env, windowsHide: true });
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

module.exports = { start, command, stop, stopAll, installCommand, findPython };
