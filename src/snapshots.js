// Before/after snapshots of the workspace for each Claude turn.
//
// In a git repo the snapshot is a git tree written through a throwaway index, so it
// captures every file (including ones changed by shell commands) without touching
// your branch, staging area or history. Outside git, the app falls back to copies of
// the files Claude's edit tools touch.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function git(cwd, args, { env, encoding = 'utf8', input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      { cwd, env: { ...process.env, ...env }, encoding, maxBuffer: 256 * 1024 * 1024, timeout: 60000, windowsHide: true },
      (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr: String(stderr || '') })) : resolve(stdout))
    );
    if (input != null) child.stdin.end(input);
  });
}

async function isGitRepo(cwd) {
  try {
    return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch {
    return false;
  }
}

async function gitRoot(cwd) {
  return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
}

// Writes the current working tree (tracked + untracked, minus .gitignore) as a tree object.
async function writeTree(root) {
  const index = path.join(os.tmpdir(), `claude-desk-index-${crypto.randomUUID()}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    try {
      await git(root, ['read-tree', 'HEAD'], { env }); // speeds up `add` on big repos
    } catch {
      /* no commits yet */
    }
    await git(root, ['add', '-A', '--', '.'], { env });
    return (await git(root, ['write-tree'], { env })).trim();
  } finally {
    fs.rm(index, { force: true }, () => {});
  }
}

async function diffTrees(root, a, b) {
  const out = await git(root, ['diff-tree', '-r', '-z', '--no-renames', '--name-status', a, b]);
  const parts = out.split('\0').filter(Boolean);
  const changes = [];
  for (let i = 0; i + 1 < parts.length; i += 2) changes.push({ status: parts[i], rel: parts[i + 1] });
  return changes;
}

async function blob(root, tree, rel) {
  try {
    return await git(root, ['cat-file', 'blob', `${tree}:${rel}`], { encoding: 'buffer' });
  } catch {
    return null;
  }
}

function isBinary(buf) {
  return buf && buf.subarray(0, 8000).includes(0);
}

class TurnSnapshot {
  constructor(workspace) {
    this.workspace = workspace;
    this.root = null; // git root, when in a repo
    this.before = null; // tree hash
    this.files = new Map(); // abs -> { existed, content } for non-git fallback
  }

  async begin() {
    if (await isGitRepo(this.workspace)) {
      try {
        this.root = await gitRoot(this.workspace);
        this.before = await writeTree(this.root);
      } catch {
        this.root = null;
      }
    }
    return this;
  }

  // Called just before an edit tool runs, for files git can't see.
  touch(abs) {
    if (this.files.has(abs)) return;
    try {
      const st = fs.statSync(abs);
      if (st.size > 5 * 1024 * 1024) return;
      this.files.set(abs, { existed: true, content: fs.readFileSync(abs) });
    } catch {
      this.files.set(abs, { existed: false, content: Buffer.alloc(0) });
    }
  }

  // Returns [{ path, rel, before, after, created, deleted, binary }].
  async changes() {
    const out = new Map();
    if (this.root && this.before) {
      const after = await writeTree(this.root);
      for (const c of await diffTrees(this.root, this.before, after)) {
        const abs = path.join(this.root, c.rel);
        const before = c.status === 'A' ? Buffer.alloc(0) : (await blob(this.root, this.before, c.rel)) || Buffer.alloc(0);
        let now = null;
        try {
          now = fs.readFileSync(abs);
        } catch {
          now = null;
        }
        out.set(abs, { path: abs, before, after: now || Buffer.alloc(0), created: c.status === 'A', deleted: now === null });
      }
    }
    for (const [abs, snap] of this.files) {
      if (out.has(abs)) continue;
      let now = null;
      try {
        now = fs.readFileSync(abs);
      } catch {
        now = null;
      }
      if (snap.existed === (now !== null) && (now || Buffer.alloc(0)).equals(snap.content)) continue;
      out.set(abs, { path: abs, before: snap.content, after: now || Buffer.alloc(0), created: !snap.existed, deleted: snap.existed && now === null });
    }
    this.result = out;
    return [...out.values()].map((c) => {
      const binary = isBinary(c.before) || isBinary(c.after);
      return {
        path: c.path,
        rel: path.relative(this.workspace, c.path).split(path.sep).join('/'),
        before: binary ? '' : c.before.toString('utf8'),
        after: binary ? '' : c.after.toString('utf8'),
        created: c.created,
        deleted: c.deleted,
        binary,
      };
    });
  }

  // Puts files back the way they were before the turn.
  async undo(absPaths) {
    for (const abs of absPaths) {
      const c = this.result && this.result.get(abs);
      if (!c) continue;
      if (c.created) fs.rmSync(abs, { force: true });
      else {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, c.before);
      }
    }
  }
}

module.exports = { TurnSnapshot, git, isGitRepo };
