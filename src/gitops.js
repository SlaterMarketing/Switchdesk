// Source-control panel: status, diffs against HEAD, commit, branches, push and pull.
// Everything shells out to your own git, so it uses your existing credentials.

const { spawn } = require('child_process');
const { git, isGitRepo } = require('./snapshots');
const cli = require('./claude-cli');

async function status(cwd) {
  if (!(await isGitRepo(cwd))) return { repo: false };
  const out = await git(cwd, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all']);
  const parts = out.split('\0').filter(Boolean);
  let branch = '';
  let ahead = 0;
  let behind = 0;
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.startsWith('## ')) {
      const m = /^## (?:No commits yet on )?([^.\s]+)(?:\.\.\.\S+)?(?: \[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\])?/.exec(p);
      if (m) {
        branch = m[1];
        ahead = Number(m[2] || 0);
        behind = Number(m[3] || 0);
      }
      continue;
    }
    const xy = p.slice(0, 2);
    const file = p.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // skip the original name
    files.push({ xy, rel: file, status: xy.includes('?') ? 'U' : xy.includes('D') ? 'D' : xy.includes('A') ? 'A' : 'M' });
  }
  let branches = [];
  try {
    branches = (await git(cwd, ['branch', '--format=%(refname:short)'])).split('\n').filter(Boolean);
  } catch {
    /* no commits yet */
  }
  let hasRemote = false;
  try {
    hasRemote = (await git(cwd, ['remote'])).trim().length > 0;
  } catch {
    /* ignore */
  }
  return { repo: true, branch, ahead, behind, files, branches, hasRemote };
}

async function headContent(cwd, rel) {
  try {
    return await git(cwd, ['show', `HEAD:${rel}`]);
  } catch {
    return '';
  }
}

async function commitAll(cwd, message) {
  await git(cwd, ['add', '-A']);
  return git(cwd, ['commit', '-m', message]);
}

async function checkout(cwd, branch, create) {
  return git(cwd, create ? ['checkout', '-b', branch] : ['checkout', branch]);
}

async function sync(cwd, action) {
  const args = action === 'push' ? ['push', '-u', 'origin', 'HEAD'] : ['pull', '--ff-only'];
  return git(cwd, args, { env: { GIT_TERMINAL_PROMPT: '0' } });
}

// Asks Claude (Haiku, one shot) for a commit message describing the current changes.
async function suggestMessage(cwd, bin, extraEnv = {}) {
  let diff = await git(cwd, ['diff', 'HEAD', '--stat', '--patch', '--no-color']).catch(() => '');
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard']).catch(() => '')).trim();
  if (untracked) diff += `\n\nNew files:\n${untracked}`;
  if (!diff.trim()) return '';
  const prompt =
    'Write a git commit message for this diff. First line: imperative summary under 72 characters. ' +
    'Then, only if useful, a blank line and up to 3 short bullet points. Reply with the message only, no code fences.\n\n' +
    diff.slice(0, 60000);
  const env = await cli.childEnv(extraEnv);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-p', '--model', 'haiku', '--tools', '', '--no-session-persistence'], {
      cwd,
      env,
      shell: process.platform === 'win32' && bin.endsWith('.cmd'),
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('close', (code) => (code === 0 ? resolve(out.trim().replace(/^```\w*\n?|```$/g, '').trim()) : reject(new Error(err || out || `exit ${code}`))));
    child.on('error', reject);
    child.stdin.end(prompt);
  });
}

module.exports = { status, headContent, commitAll, checkout, sync, suggestMessage };
