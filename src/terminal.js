// Integrated terminal panel backed by a real pseudo-terminal (node-pty).

const os = require('os');
const cli = require('./claude-cli');

let pty = null;
try {
  pty = require('@lydell/node-pty');
} catch {
  pty = null; // the panel shows an error instead of crashing the app
}

const terms = new Map(); // id -> pty process

function defaultShell() {
  if (process.platform === 'win32') return { file: 'powershell.exe', args: ['-NoLogo'] };
  return { file: process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'), args: ['-l'] };
}

// shell: another program to run instead of the login shell (ssh into an SSH folder's host).
async function create(id, cwd, cols, rows, { onData, onExit }, extraEnv = {}, shell = null) {
  if (!pty) throw new Error('Terminal support failed to load on this system.');
  const { file, args } = shell ? { file: shell.command, args: shell.args } : defaultShell();
  const env = await cli.childEnv({ ...extraEnv, TERM: 'xterm-256color', COLORTERM: 'truecolor' });
  const p = pty.spawn(file, args, { name: 'xterm-256color', cols: cols || 80, rows: rows || 24, cwd: shell ? os.homedir() : cwd || os.homedir(), env });
  terms.set(id, p);
  p.onData((d) => onData(d));
  p.onExit(({ exitCode }) => {
    terms.delete(id);
    onExit(exitCode);
  });
}

function write(id, data) {
  terms.get(id)?.write(data);
}

function resize(id, cols, rows) {
  try {
    terms.get(id)?.resize(Math.max(2, cols), Math.max(1, rows));
  } catch {
    /* already gone */
  }
}

function kill(id) {
  const p = terms.get(id);
  if (p) {
    terms.delete(id);
    try {
      p.kill();
    } catch {
      /* already gone */
    }
  }
}

function killAll() {
  for (const id of [...terms.keys()]) kill(id);
}

// Closes the terminals whose ids start with prefix (one window's).
function killWhere(prefix) {
  for (const id of [...terms.keys()]) if (id.startsWith(prefix)) kill(id);
}

module.exports = { create, write, resize, kill, killAll, killWhere };
