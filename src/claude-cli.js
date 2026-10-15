// Locates the user's Claude Code CLI, prepares its environment, and handles first-run
// install and sign-in. Chat sessions themselves live in session.js.

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const isWin = process.platform === 'win32';

let shellPathCache = null;

// GUI apps on macOS/Linux don't inherit the PATH from your shell profile, so ask a
// login shell for it once. Claude's Bash tool then sees the same tools you do.
function loginShellPath() {
  if (shellPathCache !== null) return Promise.resolve(shellPathCache);
  if (isWin) return Promise.resolve((shellPathCache = process.env.PATH || ''));
  const shell = process.env.SHELL || '/bin/zsh';
  return new Promise((resolve) => {
    execFile(shell, ['-ilc', 'printf "__P__%s__P__" "$PATH"'], { timeout: 8000 }, (err, stdout) => {
      const m = /__P__(.*)__P__/s.exec(stdout || '');
      shellPathCache = m ? m[1] : process.env.PATH || '';
      resolve(shellPathCache);
    });
  });
}

function candidatePaths() {
  const home = os.homedir();
  if (isWin) {
    return [
      path.join(home, '.local', 'bin', 'claude.exe'),
      path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
    ];
  }
  return [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ];
}

async function findClaude(override) {
  if (override && fs.existsSync(override)) return override;
  for (const p of candidatePaths()) if (p && fs.existsSync(p)) return p;
  const PATH = await loginShellPath();
  for (const dir of PATH.split(path.delimiter)) {
    for (const name of isWin ? ['claude.exe', 'claude.cmd'] : ['claude']) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

async function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  // Windows spells it "Path"; reuse whatever key exists so we don't end up with two.
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const localBin = path.join(os.homedir(), '.local', 'bin');
  const parts = (await loginShellPath()).split(path.delimiter).filter(Boolean);
  if (!parts.includes(localBin)) parts.push(localBin);
  env[pathKey] = parts.join(path.delimiter);
  // Don't let a Claude Code session that launched this app leak its identity into ours.
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT']) {
    delete env[k];
  }
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function runSimple(bin, args, env) {
  return new Promise((resolve) => {
    execFile(bin, args, { env, timeout: 20000, shell: isWin && bin.endsWith('.cmd') }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') })
    );
  });
}

async function cliStatus(override) {
  const bin = await findClaude(override);
  if (!bin) return { found: false };
  const env = await childEnv();
  const ver = await runSimple(bin, ['--version'], env);
  const auth = await runSimple(bin, ['auth', 'status'], env);
  let authInfo = null;
  try {
    authInfo = JSON.parse(auth.stdout);
  } catch {
    /* older CLI */
  }
  return { found: true, path: bin, version: ver.stdout.trim(), auth: authInfo };
}

// ---------- first-run setup ----------

// Runs Anthropic's official native installer (the same one-liner the docs give).
function installClaude(onLog) {
  return new Promise((resolve) => {
    const child = isWin
      ? spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex'], { windowsHide: true })
      : spawn('/bin/bash', ['-c', 'curl -fsSL https://claude.ai/install.sh | bash']);
    const log = (c) => onLog(c.toString('utf8'));
    child.stdout.on('data', log);
    child.stderr.on('data', log);
    child.on('error', (err) => resolve({ ok: false, error: String(err) }));
    child.on('close', async (code) => {
      shellPathCache = null; // the installer may have changed PATH
      const bin = await findClaude();
      resolve({ ok: !!bin, code, path: bin });
    });
  });
}

// Runs `claude auth login`. The CLI opens the browser itself and usually finishes on
// its own; if it asks for a code instead, the app pipes the pasted code to stdin.
async function startLogin(bin, { onLog, onUrl, onExit }) {
  const env = await childEnv();
  const child = spawn(bin, ['auth', 'login', '--claudeai'], {
    env,
    shell: isWin && bin.endsWith('.cmd'),
    windowsHide: true,
  });
  let seen = '';
  const handle = (c) => {
    const text = c.toString('utf8');
    seen += text;
    onLog(text);
    const m = /https:\/\/\S+/.exec(seen);
    if (m && !handle.sentUrl) {
      handle.sentUrl = true;
      onUrl(m[0]);
    }
  };
  child.stdout.on('data', handle);
  child.stderr.on('data', handle);
  child.on('error', (err) => onExit({ code: -1, error: String(err) }));
  child.on('close', (code) => onExit({ code }));
  return {
    sendCode(code) {
      child.stdin.write(code.trim() + '\n');
    },
    cancel() {
      child.kill();
    },
  };
}

module.exports = { findClaude, cliStatus, childEnv, installClaude, startLogin };
