// Parallel agents: a chat can work in its own copy of the project (a git worktree on its own
// branch), so several Claudes can build different things at once without overwriting each other.
// The copy starts from your folder as it is now, uncommitted changes included. "Merge" brings the
// copy's changes back into your folder as normal uncommitted edits, three-way merging any file
// you've changed in the meantime.
//
// In an SSH folder the copies live on the host, under ~/.switchdesk/worktrees: the same code runs
// through `onHost(remote)`, which does its file and git work over the connection.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { git, writeTree, diffTrees, blob } = require('./snapshots');

let baseDir = path.join(os.tmpdir(), 'claude-desk-worktrees');
function setBaseDir(dir) {
  baseDir = dir;
}

const under = (base, p, P) => {
  const rel = P.relative(base, P.resolve(p));
  return rel !== '' && !rel.startsWith('..') && !P.isAbsolute(rel);
};
const isUnder = (p) => under(baseDir, p, path);

function slugify(name) {
  return (
    String(name || 'task')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30) || 'task'
  );
}

// Where the copies are and how to read and write there: this computer's files.
const local = {
  P: path,
  base: () => baseDir,
  at: (dir) => dir, // what git() runs in
  isUnder,
  mkdirp: (dir) => fsp.mkdir(dir, { recursive: true }),
  read: (file) => fsp.readFile(file).catch(() => null),
  write: async (file, buf) => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, buf);
  },
  rm: (p) => fsp.rm(p, { recursive: true, force: true }),
  exists: async (dir) => fs.existsSync(dir),
  size: (file) => fsp.stat(file).then((s) => s.size),
  copy: async (from, to) => {
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.copyFile(from, to);
  },
  mergeFile: async (mine, base, theirs) => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'desk-merge-'));
    try {
      const f = (n, buf) => {
        const p = path.join(tmp, n);
        fs.writeFileSync(p, buf || Buffer.alloc(0));
        return p;
      };
      // git merge-file exits with the number of conflicts, so a non-zero code isn't a failure.
      return await new Promise((resolve, reject) => {
        execFile('git', ['merge-file', '-p', ...MERGE_LABELS, f('mine', mine), f('base', base), f('theirs', theirs)], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
          if (err && typeof err.code !== 'number') return reject(err);
          resolve({ content: stdout, conflicts: err ? err.code : 0 });
        });
      });
    } finally {
      fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  },
};
const MERGE_LABELS = ['-L', 'your folder', '-L', 'start of copy', '-L', "Claude's copy"];

// The same for an SSH folder's host. remote.home is the host's home folder.
function onHost(remote) {
  if (remote.worktrees) return remote.worktrees;
  const P = path.posix;
  const base = () => P.join(remote.home, '.switchdesk', 'worktrees');
  const run = async (argv, cwd, opts) => {
    const r = await remote.exec(argv, cwd || remote.home, opts);
    if (r.code !== 0) throw new Error(r.stderr.trim() || `${argv[0]} failed`);
    return r.stdout;
  };
  const io = {
    P,
    base,
    at: (dir) => ({ remote, dir }),
    isUnder: (p) => under(base(), p, P),
    mkdirp: (dir) => run(['mkdir', '-p', dir]),
    read: async (file) => {
      const r = await remote.call('read', { path: file, binary: true }).catch(() => null);
      if (!r) return null;
      if (r.b64 != null) return Buffer.from(r.b64, 'base64');
      return r.content != null ? Buffer.from(r.content, 'utf8') : null;
    },
    write: (file, buf) => remote.call('write', { path: file, b64: Buffer.from(buf).toString('base64') }),
    rm: (p) => run(['rm', '-rf', p]),
    exists: (dir) => remote.exec(['test', '-d', dir], remote.home).then((r) => r.code === 0, () => false),
    size: async () => 0,
    copy: (from, to) => run(['sh', '-c', 'mkdir -p "$(dirname "$2")" && cp -p "$1" "$2"', 'sh', from, to]),
    mergeFile: async (mine, baseBuf, theirs) => {
      const tmp = String(await run(['mktemp', '-d'])).trim();
      try {
        const names = ['mine', 'base', 'theirs'];
        await Promise.all([mine, baseBuf, theirs].map((b, i) => io.write(P.join(tmp, names[i]), b || Buffer.alloc(0))));
        const r = await remote.exec(['git', 'merge-file', '-p', ...MERGE_LABELS, ...names], tmp);
        if (r.code < 0 || r.code > 127) throw new Error(r.stderr.trim() || 'git merge-file failed');
        return { content: r.stdout, conflicts: r.code };
      } finally {
        run(['rm', '-rf', tmp]).catch(() => {});
      }
    },
  };
  remote.worktrees = bind(io);
  return remote.worktrees;
}

// rev: start from that commit (a pull request's head) instead of your folder as it is now.
async function create(io, workspace, name, { rev } = {}) {
  const P = io.P;
  let root;
  try {
    root = (await git(io.at(workspace), ['rev-parse', '--show-toplevel'])).trim();
    await git(io.at(root), ['rev-parse', '--verify', 'HEAD']);
  } catch {
    throw new Error('Own copies need a git repository with at least one commit. Use the Git panel to set one up.');
  }
  const sub = P.relative(root, workspace); // the open folder may be inside the repo
  const id = `${slugify(name)}-${crypto.randomBytes(3).toString('hex')}`;
  const branch = `desk/${id}`;
  const dir = P.join(io.base(), `${P.basename(root)}-${crypto.createHash('sha1').update(root).digest('hex').slice(0, 6)}`, id);
  await io.mkdirp(P.dirname(dir));
  await git(io.at(root), ['worktree', 'add', '-q', '-b', branch, dir, rev || 'HEAD']);
  const copy = { id, branch, path: P.join(dir, sub), root: dir, repo: root, sub: sub.split(P.sep).join('/') };
  if (rev) return { ...copy, base: await writeTree(io.at(dir)) };

  // Bring over uncommitted work: tracked changes as a patch, untracked files as copies.
  const patch = await git(io.at(root), ['diff', 'HEAD', '--binary'], { encoding: 'buffer' });
  if (patch.length) await git(io.at(dir), ['apply', '--whitespace=nowarn', '-'], { input: patch }).catch(() => {});
  const untracked = (await git(io.at(root), ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  for (const rel of untracked) {
    try {
      const src = P.join(root, rel);
      if ((await io.size(src)) > 20 * 1024 * 1024) continue;
      await io.copy(src, P.join(dir, rel));
    } catch {
      /* skip */
    }
  }
  return { ...copy, base: await writeTree(io.at(dir)) };
}

// Files the copy has changed since it was made: [{ rel, status }], rel relative to the open folder.
async function changes(io, wt) {
  const now = await writeTree(io.at(wt.root));
  const prefix = wt.sub ? wt.sub + '/' : '';
  return (await diffTrees(io.at(wt.root), wt.base, now))
    .filter((c) => c.rel.startsWith(prefix))
    .map((c) => ({ status: c.status, rel: c.rel.slice(prefix.length), repoRel: c.rel }));
}

async function fileDiff(io, wt, rel) {
  const repoRel = (wt.sub ? wt.sub + '/' : '') + rel;
  const before = (await blob(io.at(wt.root), wt.base, repoRel)) || Buffer.alloc(0);
  const after = (await io.read(io.P.join(wt.root, repoRel))) || Buffer.alloc(0);
  return { before: before.toString('utf8'), after: after.toString('utf8') };
}

// Applies the copy's changes to the open folder. Returns what changed there, for review.
async function merge(io, wt, workspace) {
  const list = await changes(io, wt);
  const merged = [];
  let conflicts = 0;
  for (const c of list) {
    const dest = io.P.join(workspace, c.rel);
    const base = c.status === 'A' ? null : await blob(io.at(wt.root), wt.base, c.repoRel);
    const theirs = c.status === 'D' ? null : await io.read(io.P.join(wt.root, c.repoRel));
    const mine = await io.read(dest);
    let next;
    let fileConflicts = 0;
    const same = (a, b) => (a === null && b === null) || (a !== null && b !== null && a.equals(b));
    if (same(mine, base)) next = theirs; // you haven't touched it: take Claude's version
    else if (same(mine, theirs)) continue; // already the same
    else if (mine !== null && theirs !== null) {
      const r = await io.mergeFile(mine, base, theirs);
      next = r.content;
      fileConflicts = r.conflicts;
    } else {
      // One side deleted it and the other changed it: keep the changed version.
      next = theirs || mine;
      fileConflicts = 1;
    }
    if (next === null) await io.rm(dest);
    else await io.write(dest, next);
    conflicts += fileConflicts;
    merged.push({
      rel: c.rel,
      path: dest,
      before: mine ? mine.toString('utf8') : '',
      after: next ? next.toString('utf8') : '',
      created: mine === null,
      deleted: next === null,
      binary: [mine, next].some((b) => b && b.subarray(0, 8000).includes(0)),
      conflicts: fileConflicts,
    });
  }
  // From now on, only changes made after this merge count as new.
  return { merged, conflicts, base: await writeTree(io.at(wt.root)) };
}

async function remove(io, wt) {
  if (!io.isUnder(wt.root)) throw new Error('Not a Switchdesk copy.');
  try {
    await git(io.at(wt.repo), ['worktree', 'remove', '--force', wt.root]);
  } catch {
    await io.rm(wt.root);
    await git(io.at(wt.repo), ['worktree', 'prune']).catch(() => {});
  }
  await git(io.at(wt.repo), ['branch', '-D', wt.branch]).catch(() => {});
  return true;
}

// Commits what's left uncommitted in the copy, then pushes it to `to` on the remote (origin, or the
// address given, such as a fork's). pushUrl, when given, is tried if that's refused (a GitHub token
// Switchdesk holds).
async function push(io, wt, to, { message, pushUrl, remote = 'origin' } = {}) {
  const at = io.at(wt.root);
  const env = { GIT_TERMINAL_PROMPT: '0' };
  if ((await git(at, ['status', '--porcelain'])).trim()) {
    await git(at, ['add', '-A']);
    await git(at, ['commit', '-q', '-m', message || 'Changes from Switchdesk'], { env });
  }
  const ref = `HEAD:refs/heads/${to}`;
  try {
    await git(at, ['push', remote, ref], { env });
  } catch (err) {
    if (!pushUrl) throw new Error(String(err.stderr || err.message).trim().split('\n').slice(-3).join('\n'));
    await git(at, ['push', pushUrl, ref], { env }).catch((e) => {
      throw new Error(String(e.stderr || e.message).replace(pushUrl, 'GitHub').trim().split('\n').slice(-3).join('\n'));
    });
  }
  return { sha: (await git(at, ['rev-parse', 'HEAD'])).trim() };
}

// The copy's latest commit, and whether anything is left uncommitted.
async function head(io, wt) {
  const at = io.at(wt.root);
  return { sha: (await git(at, ['rev-parse', 'HEAD'])).trim(), dirty: !!(await git(at, ['status', '--porcelain'])).trim() };
}

async function exists(io, wt) {
  return !!(wt && wt.root && io.isUnder(wt.root) && (await io.exists(wt.root)));
}

// The functions above, for one place the copies live.
function bind(io) {
  const fns = { create, changes, fileDiff, merge, remove, push, head, exists };
  return { isUnder: io.isUnder, ...Object.fromEntries(Object.entries(fns).map(([k, f]) => [k, (...a) => f(io, ...a)])) };
}

module.exports = { setBaseDir, onHost, ...bind(local), isUnder };
