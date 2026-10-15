// Parallel agents: a chat can work in its own copy of the project (a git worktree on its own
// branch), so several Claudes can build different things at once without overwriting each other.
// The copy starts from your folder as it is now, uncommitted changes included. "Merge" brings the
// copy's changes back into your folder as normal uncommitted edits, three-way merging any file
// you've changed in the meantime.

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

function isUnder(p) {
  const rel = path.relative(baseDir, path.resolve(p));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function slugify(name) {
  return (
    String(name || 'task')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30) || 'task'
  );
}

async function create(workspace, name) {
  let root;
  try {
    root = (await git(workspace, ['rev-parse', '--show-toplevel'])).trim();
    await git(root, ['rev-parse', '--verify', 'HEAD']);
  } catch {
    throw new Error('Own copies need a git repository with at least one commit. Use the Git panel to set one up.');
  }
  const sub = path.relative(root, workspace); // the open folder may be inside the repo
  const id = `${slugify(name)}-${crypto.randomBytes(3).toString('hex')}`;
  const branch = `desk/${id}`;
  const dir = path.join(baseDir, `${path.basename(root)}-${crypto.createHash('sha1').update(root).digest('hex').slice(0, 6)}`, id);
  await fsp.mkdir(path.dirname(dir), { recursive: true });
  await git(root, ['worktree', 'add', '-q', '-b', branch, dir, 'HEAD']);

  // Bring over uncommitted work: tracked changes as a patch, untracked files as copies.
  const patch = await git(root, ['diff', 'HEAD', '--binary'], { encoding: 'buffer' });
  if (patch.length) await git(dir, ['apply', '--whitespace=nowarn', '-'], { input: patch }).catch(() => {});
  const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  for (const rel of untracked) {
    try {
      const src = path.join(root, rel);
      if ((await fsp.stat(src)).size > 20 * 1024 * 1024) continue;
      await fsp.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fsp.copyFile(src, path.join(dir, rel));
    } catch {
      /* skip */
    }
  }
  const base = await writeTree(dir);
  return { id, branch, path: path.join(dir, sub), root: dir, repo: root, sub: sub.split(path.sep).join('/'), base };
}

// Files the copy has changed since it was made: [{ rel, status }], rel relative to the open folder.
async function changes(wt) {
  const now = await writeTree(wt.root);
  const prefix = wt.sub ? wt.sub + '/' : '';
  return (await diffTrees(wt.root, wt.base, now))
    .filter((c) => c.rel.startsWith(prefix))
    .map((c) => ({ status: c.status, rel: c.rel.slice(prefix.length), repoRel: c.rel }));
}

async function readOr(file, fallback) {
  try {
    return await fsp.readFile(file);
  } catch {
    return fallback;
  }
}

async function fileDiff(wt, rel) {
  const repoRel = (wt.sub ? wt.sub + '/' : '') + rel;
  const before = (await blob(wt.root, wt.base, repoRel)) || Buffer.alloc(0);
  const after = await readOr(path.join(wt.root, repoRel), Buffer.alloc(0));
  return { before: before.toString('utf8'), after: after.toString('utf8') };
}

function mergeFile(current, base, other) {
  // git merge-file exits with the number of conflicts, so a non-zero code isn't a failure.
  return new Promise((resolve, reject) => {
    execFile('git', ['merge-file', '-p', '-L', 'your folder', '-L', 'start of copy', '-L', 'Claude\'s copy', current, base, other], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err && typeof err.code !== 'number') return reject(err);
      resolve({ content: stdout, conflicts: err ? err.code : 0 });
    });
  });
}

// Applies the copy's changes to the open folder. Returns what changed there, for review.
async function merge(wt, workspace) {
  const list = await changes(wt);
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'desk-merge-'));
  const merged = [];
  let conflicts = 0;
  try {
    for (const c of list) {
      const dest = path.join(workspace, c.rel);
      const base = c.status === 'A' ? null : await blob(wt.root, wt.base, c.repoRel);
      const theirs = c.status === 'D' ? null : await readOr(path.join(wt.root, c.repoRel), null);
      const mine = await readOr(dest, null);
      let next;
      let fileConflicts = 0;
      const same = (a, b) => (a === null && b === null) || (a !== null && b !== null && a.equals(b));
      if (same(mine, base)) next = theirs; // you haven't touched it: take Claude's version
      else if (same(mine, theirs)) continue; // already the same
      else if (mine !== null && theirs !== null) {
        const f = (n, buf) => {
          const p = path.join(tmp, `${n}-${merged.length}`);
          fs.writeFileSync(p, buf || Buffer.alloc(0));
          return p;
        };
        const r = await mergeFile(f('mine', mine), f('base', base), f('theirs', theirs));
        next = r.content;
        fileConflicts = r.conflicts;
      } else {
        // One side deleted it and the other changed it: keep the changed version.
        next = theirs || mine;
        fileConflicts = 1;
      }
      if (next === null) await fsp.rm(dest, { force: true });
      else {
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.writeFile(dest, next);
      }
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
  } finally {
    fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
  // From now on, only changes made after this merge count as new.
  return { merged, conflicts, base: await writeTree(wt.root) };
}

async function remove(wt) {
  if (!isUnder(wt.root)) throw new Error('Not a Switchdesk copy.');
  try {
    await git(wt.repo, ['worktree', 'remove', '--force', wt.root]);
  } catch {
    await fsp.rm(wt.root, { recursive: true, force: true });
    await git(wt.repo, ['worktree', 'prune']).catch(() => {});
  }
  await git(wt.repo, ['branch', '-D', wt.branch]).catch(() => {});
  return true;
}

function exists(wt) {
  return !!(wt && wt.root && isUnder(wt.root) && fs.existsSync(wt.root));
}

module.exports = { setBaseDir, isUnder, create, changes, fileDiff, merge, remove, exists };
