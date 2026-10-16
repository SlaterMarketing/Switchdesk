// Source-control panel: status, diffs against HEAD, commit, branches, push and pull, merge
// conflicts, blame, history and pull request descriptions.
// Everything shells out to your own git, so it uses your existing credentials.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
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
    const conflict = CONFLICT.has(xy);
    files.push({ xy, rel: file, status: conflict ? 'C' : xy.includes('?') ? 'U' : xy.includes('D') ? 'D' : xy.includes('A') ? 'A' : 'M' });
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
  return { repo: true, branch, ahead, behind, files, branches, hasRemote, operation: await operation(cwd) };
}

// Both sides changed the file: git's unmerged states.
const CONFLICT = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

async function gitDir(cwd) {
  const d = (await git(cwd, ['rev-parse', '--git-dir'])).trim();
  return path.resolve(cwd, d);
}

// A merge, rebase or cherry-pick that stopped part way (usually on conflicts).
async function operation(cwd) {
  try {
    const d = await gitDir(cwd);
    const has = (f) => fs.existsSync(path.join(d, f));
    if (has('rebase-merge') || has('rebase-apply')) return 'rebase';
    if (has('MERGE_HEAD')) return 'merge';
    if (has('CHERRY_PICK_HEAD')) return 'cherry-pick';
    if (has('REVERT_HEAD')) return 'revert';
  } catch {}
  return null;
}

const NO_EDITOR = { GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0' };

async function abortOperation(cwd) {
  const op = await operation(cwd);
  if (!op) return;
  return git(cwd, [op, '--abort']);
}

// Carries on once every conflict is resolved and staged.
async function continueOperation(cwd) {
  const op = await operation(cwd);
  if (!op) return;
  await git(cwd, ['add', '-u']);
  if (op === 'merge') return git(cwd, ['commit', '--no-edit'], { env: NO_EDITOR });
  return git(cwd, [op, '--continue'], { env: NO_EDITOR });
}

const markResolved = (cwd, rel) => git(cwd, ['add', '--', rel]);

// Who last changed each line: [{ sha, author, time, summary }] indexed by line - 1.
async function blame(cwd, rel) {
  let out;
  try {
    out = await git(cwd, ['blame', '--porcelain', '--', rel]);
  } catch {
    return null;
  }
  const commits = new Map();
  const lines = [];
  let cur = null;
  for (const line of out.split('\n')) {
    const head = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line);
    if (head) {
      if (!commits.has(head[1])) commits.set(head[1], { sha: head[1] });
      cur = { c: commits.get(head[1]), line: Number(head[2]) };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('\t')) {
      lines[cur.line - 1] = cur.c;
      continue;
    }
    const sp = line.indexOf(' ');
    const key = line.slice(0, sp);
    const val = line.slice(sp + 1);
    if (key === 'author') cur.c.author = val;
    else if (key === 'author-time') cur.c.time = Number(val) * 1000;
    else if (key === 'summary') cur.c.summary = val;
  }
  return lines.map((c) => (c ? { sha: c.sha, author: c.author, time: c.time, summary: c.summary } : null));
}

const SEP = '\x1f';
const END = '\x1e';

// Recent commits, for the whole repository or one file (following renames).
async function log(cwd, { rel, limit = 50, skip = 0 } = {}) {
  const args = ['log', `--format=%H${SEP}%an${SEP}%at${SEP}%s${SEP}%b${END}`, `-n${limit}`, `--skip=${skip}`];
  if (rel) args.push('--follow', '--', rel);
  let out = '';
  try {
    out = await git(cwd, args);
  } catch {
    return [];
  }
  return out
    .split(END)
    .map((r) => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map((r) => {
      const [sha, author, at, subject, body] = r.split(SEP);
      return { sha, author, time: Number(at) * 1000, subject, body: (body || '').trim() };
    });
}

// The files a commit changed: [{ status, rel, from }].
async function commitFiles(cwd, sha) {
  const out = await git(cwd, ['show', '-M', '--name-status', '--format=', sha]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [st, a, b] = l.split('\t');
      return { status: st[0], rel: b || a, from: b ? a : null };
    });
}

async function fileAt(cwd, rev, rel) {
  try {
    return await git(cwd, ['show', `${rev}:${rel}`]);
  } catch {
    return '';
  }
}

// The branch a pull request would go into: origin's default branch, else main or master.
async function baseBranch(cwd) {
  try {
    return (await git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim();
  } catch {}
  for (const b of ['origin/main', 'origin/master', 'main', 'master']) {
    try {
      await git(cwd, ['rev-parse', '--verify', '--quiet', b]);
      return b;
    } catch {}
  }
  return null;
}

// Where to open a pull request for this branch on GitHub, if the remote is GitHub.
async function compareUrl(cwd, base, branch) {
  let url = '';
  try {
    url = (await git(cwd, ['remote', 'get-url', 'origin'])).trim();
  } catch {
    return null;
  }
  const m = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  return m ? `https://github.com/${m[1]}/${m[2]}/compare/${base.replace(/^origin\//, '')}...${encodeURIComponent(branch)}?expand=1` : null;
}

// Asks Claude (Haiku) for a pull request title and description of this branch's work.
async function suggestPullRequest(cwd, bin, extraEnv = {}) {
  const base = await baseBranch(cwd);
  if (!base) throw new Error("Couldn't find the branch to compare with (no main or master).");
  const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const commits = (await git(cwd, ['log', `${base}..HEAD`, '--format=- %s%n%b'])).trim();
  if (!commits) throw new Error(`This branch has no commits that aren't on ${base} yet.`);
  const diff = await git(cwd, ['diff', `${base}...HEAD`, '--stat', '--patch', '--no-color']).catch(() => '');
  const prompt =
    `Write a pull request for this branch (${branch}, going into ${base}). Reply with the title on the first line ` +
    '(under 72 characters, no prefix), a blank line, then the description in Markdown: what changes for someone using it, ' +
    'then briefly how it works and anything a reviewer should look at. Keep it short. No code fences around the reply.\n\n' +
    `Commits:\n${commits.slice(0, 8000)}\n\nDiff:\n${diff.slice(0, 60000)}`;
  const text = await runHaiku(cwd, bin, extraEnv, prompt);
  const [title, ...rest] = text.split('\n');
  return { title: title.replace(/^#+\s*|^title:\s*/i, '').trim(), body: rest.join('\n').trim(), base, branch, url: await compareUrl(cwd, base, branch) };
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
  return runHaiku(cwd, bin, extraEnv, prompt);
}

async function runHaiku(cwd, bin, extraEnv, prompt) {
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

module.exports = { status, headContent, commitAll, checkout, sync, suggestMessage, abortOperation, continueOperation, markResolved, blame, log, commitFiles, fileAt, suggestPullRequest };
