// Several Claude accounts signed in at once (say, a personal one and one from work).
//
// Claude Code keeps everything about an account in one config folder: its sign-in, settings,
// CLAUDE.md and conversation history. The main account uses the usual ~/.claude. Each extra
// account gets its own folder, passed to the CLI as CLAUDE_CONFIG_DIR, so they never mix.
// A folder can be tied to an account, and each chat can switch account at any time.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MAIN = 'default';
let baseDir = path.join(os.homedir(), '.claude-desk-accounts');

function setBaseDir(dir) {
  baseDir = dir;
}

function isMain(id) {
  return !id || id === MAIN;
}

// [{ id, name }], main account first.
function list(settings) {
  const extra = (settings.accounts || []).filter((a) => a && a.id && !isMain(a.id));
  return [{ id: MAIN, name: settings.mainAccountName || 'Main account' }, ...extra.map((a) => ({ id: a.id, name: a.name }))];
}

function exists(settings, id) {
  return list(settings).some((a) => a.id === id);
}

function dirFor(id) {
  if (isMain(id)) return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(baseDir, id.replace(/[^\w-]/g, ''));
}

// Extra environment for a Claude Code process running as this account.
function envFor(id) {
  return isMain(id) ? {} : { CLAUDE_CONFIG_DIR: dirFor(id) };
}

function samePath(a, b) {
  return process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// The account a folder uses: the rule for the folder (or the closest folder above it), otherwise
// the default account.
function forFolder(settings, folder) {
  const rules = settings.accountRules || {};
  let best = null;
  if (folder) {
    const target = path.resolve(folder);
    for (const [dir, id] of Object.entries(rules)) {
      const rel = path.relative(path.resolve(dir), target);
      const inside = samePath(path.resolve(dir), target) || (rel && !rel.startsWith('..') && !path.isAbsolute(rel));
      if (inside && exists(settings, id) && (!best || dir.length > best.dir.length)) best = { dir, id };
    }
  }
  if (best) return best.id;
  return exists(settings, settings.defaultAccount) ? settings.defaultAccount : MAIN;
}

// Makes the folder for a new account. Your personal instructions, settings, agents, commands and
// skills are copied over so the new account behaves the same; after that each keeps its own.
async function create(name) {
  const id = `acct-${crypto.randomBytes(4).toString('hex')}`;
  const dir = dirFor(id);
  await fsp.mkdir(dir, { recursive: true });
  const from = dirFor(MAIN);
  for (const item of ['CLAUDE.md', 'settings.json', 'agents', 'commands', 'skills']) {
    try {
      await fsp.cp(path.join(from, item), path.join(dir, item), { recursive: true, errorOnExist: false });
    } catch {
      /* not there */
    }
  }
  return { id, name: String(name || 'Account').slice(0, 40) };
}

async function remove(id) {
  if (isMain(id)) throw new Error("The main account can't be removed.");
  const dir = dirFor(id);
  const rel = path.relative(baseDir, dir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Not a Claude Desk account folder.');
  await fsp.rm(dir, { recursive: true, force: true });
}

// Where Claude Code keeps an account's conversations for a working folder.
function projectDir(id, cwd) {
  return path.join(dirFor(id), 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

// To carry on a conversation under another account, that account needs the transcript too.
// Copies the newest copy found under any account over the target's, if the target's is older.
async function ensureTranscript(settings, id, cwd, sessionId) {
  let newest = null;
  for (const a of list(settings)) {
    const file = path.join(projectDir(a.id, cwd), `${sessionId}.jsonl`);
    try {
      const st = await fsp.stat(file);
      if (!newest || st.mtimeMs > newest.mtimeMs || (st.mtimeMs === newest.mtimeMs && a.id === id)) newest = { id: a.id, file, mtimeMs: st.mtimeMs };
    } catch {
      /* not under this account */
    }
  }
  if (!newest || newest.id === id) return;
  const target = path.join(projectDir(id, cwd), `${sessionId}.jsonl`);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.copyFile(newest.file, target);
}

module.exports = { MAIN, setBaseDir, isMain, list, exists, dirFor, envFor, forFolder, create, remove, projectDir, ensureTranscript };
