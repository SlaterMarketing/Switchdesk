const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, Menu, nativeTheme } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { execFile } = require('child_process');
const cli = require('./claude-cli');
const { ChatSession } = require('./session');
const { TurnSnapshot, MultiSnapshot, git, writeTree, diffTrees, blob } = require('./snapshots');
const gitops = require('./gitops');
const terminal = require('./terminal');
const config = require('./config');
const updater = require('./updater');
const search = require('./search');
const worktrees = require('./worktrees');
const accounts = require('./accounts');
const usage = require('./usage');
const webpage = require('./webpage');
const agents = require('./agents');
const { CodexSession, codexStatus, codexModels, codexSessions, codexHistory } = require('./codex-session');
const { AcpSession, acpStatus, acpSessions, acpHistory } = require('./acp-session');
const { stripAppNotes } = require('./agent-events');

const APP_ROOT = path.join(__dirname, '..');
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'out', '.venv', 'venv', '__pycache__', '.cache', '.turbo', 'target', '.idea', 'coverage']);

let loginHandle = null;
let loginCtx = null; // the window that started the Claude sign-in
let quitting = false;
let lastUpdate = null; // the updater's latest news, for windows opened later

// The app used to be called Claude Desk. Keep using that data folder if it exists, so settings,
// extra accounts and parallel-agent copies carry over.
const legacyData = path.join(app.getPath('appData'), 'Claude Desk');
if (fs.existsSync(legacyData)) app.setPath('userData', legacyData);

// ---------- settings ----------

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { recentFolders: [], claudePath: '', model: '', effort: '', mode: 'agent', theme: 'system', accounts: [], accountRules: {}, defaultAccount: accounts.MAIN };

function loadSettings() {
  try {
    settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {
    /* first run */
  }
}
function saveSettings() {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

// ---------- windows ----------
//
// Each window has its own workspace: a main folder, plus any extra folders added to it. Files in an
// extra folder show up in the app as "⟦name⟧/path", and agents get the folders' absolute paths.

const contexts = new Map(); // webContents id -> { id, win, workspace, extra, watchers, start }
const NO_WINDOW = { id: 0, win: null, workspace: null, extra: [], watchers: [] };
const ctxOf = (e) => contexts.get(e.sender.id) || NO_WINDOW;
const ctxOfWindow = (bw) => (bw && contexts.get(bw.webContents.id)) || null;

function sendTo(ctx, channel, payload) {
  if (ctx && ctx.win && !ctx.win.isDestroyed()) ctx.win.webContents.send(channel, payload);
}
function broadcast(channel, payload, except) {
  for (const c of contexts.values()) if (c !== except) sendTo(c, channel, payload);
}

// The folders open in a window, the main one first. key prefixes an extra folder's paths.
function roots(ctx) {
  if (!ctx.workspace) return [];
  const out = [{ key: '', dir: ctx.workspace, name: path.basename(ctx.workspace) || ctx.workspace }];
  const used = new Set([out[0].name]);
  for (const dir of ctx.extra) {
    const base = path.basename(dir) || dir;
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base} (${i})`;
    used.add(name);
    out.push({ key: `⟦${name}⟧`, dir, name });
  }
  return out;
}

const within = (dir, abs) => {
  const rel = path.relative(dir, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

function rootOf(ctx, abs) {
  abs = path.resolve(abs);
  let best = null;
  for (const r of roots(ctx)) if (within(r.dir, abs) && (!best || r.dir.length > best.dir.length)) best = r;
  return best;
}

function inWorkspace(ctx, p) {
  return !!rootOf(ctx, p);
}

function resolveInWorkspace(ctx, p) {
  let abs;
  const m = /^⟦([^⟧]+)⟧(?:\/(.*))?$/.exec(p);
  if (m) {
    const r = roots(ctx).find((x) => x.key === `⟦${m[1]}⟧`);
    if (!r) throw new Error('That folder is no longer in the workspace: ' + p);
    abs = path.join(r.dir, m[2] || '');
  } else abs = path.isAbsolute(p) ? p : path.join(ctx.workspace || '', p);
  if (!inWorkspace(ctx, abs)) throw new Error('Path is outside the open folders: ' + p);
  return abs;
}

// The path the app shows for a file: relative to its folder, with the folder's key for extra folders.
function relOf(ctx, abs) {
  const r = rootOf(ctx, abs);
  if (!r) return null;
  const rel = path.relative(r.dir, abs).split(path.sep).join('/');
  return r.key ? (rel ? `${r.key}/${rel}` : r.key) : rel;
}

function folderInfo(ctx) {
  if (!ctx.workspace) return null;
  return { root: ctx.workspace, name: path.basename(ctx.workspace), extra: roots(ctx).slice(1).map((r) => ({ key: r.key, dir: r.dir, name: r.name })) };
}

function gitFiles(root) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['ls-files', '-co', '--exclude-standard', '-z'],
      { cwd: root, maxBuffer: 64 * 1024 * 1024, timeout: 15000 },
      (err, stdout) => resolve(err ? null : stdout.split('\0').filter(Boolean))
    );
  });
}

async function walkFiles(root, limit = 20000) {
  const out = [];
  async function walk(dir, rel) {
    if (out.length >= limit) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) await walk(path.join(dir, e.name), r);
      } else if (e.isFile()) out.push(r);
    }
  }
  await walk(root, '');
  return out;
}

async function listFiles(ctx) {
  const out = [];
  for (const r of roots(ctx)) {
    const files = (await gitFiles(r.dir)) || (await walkFiles(r.dir));
    for (const f of files.slice(0, 50000)) out.push(r.key ? `${r.key}/${f}` : f);
  }
  return out.sort();
}

function stopWatchers(ctx) {
  for (const w of ctx.watchers) w.close();
  ctx.watchers = [];
}

function startWatchers(ctx) {
  stopWatchers(ctx);
  let pending = new Set();
  let timer = null;
  for (const r of roots(ctx)) {
    try {
      ctx.watchers.push(
        fs.watch(r.dir, { recursive: true }, (_evt, file) => {
          if (!file) return;
          const rel = file.split(path.sep).join('/');
          if (rel.split('/').some((seg) => IGNORED_DIRS.has(seg))) return;
          pending.add(r.key ? `${r.key}/${rel}` : rel);
          clearTimeout(timer);
          timer = setTimeout(() => {
            sendTo(ctx, 'fs-changed', [...pending]);
            pending = new Set();
          }, 250);
        })
      );
    } catch {
      /* recursive watch unsupported: the renderer still refreshes after each turn */
    }
  }
}

// The window that already has this folder open, if any.
function windowWith(dir, except) {
  for (const c of contexts.values()) if (c !== except && c.workspace && path.resolve(c.workspace) === path.resolve(dir) && c.win && !c.win.isDestroyed()) return c;
  return null;
}

function focusWindow(ctx) {
  if (ctx.win.isMinimized()) ctx.win.restore();
  ctx.win.focus();
}

function setTitle(ctx) {
  if (!ctx.win || ctx.win.isDestroyed()) return;
  const extra = ctx.extra.length ? ` (+${ctx.extra.length} folder${ctx.extra.length > 1 ? 's' : ''})` : '';
  ctx.win.setTitle(ctx.workspace ? `${path.basename(ctx.workspace)}${extra} — Switchdesk` : 'Switchdesk');
}

async function openFolder(ctx, dir) {
  dir = path.resolve(dir);
  // Already open in another window: go to it, the way Cursor does.
  const other = windowWith(dir, ctx);
  if (other) {
    focusWindow(other);
    return { elsewhere: true, root: dir, name: path.basename(dir) };
  }
  closeWindowChats(ctx);
  ctx.workspace = dir;
  ctx.extra = ((settings.extraFolders || {})[dir] || []).filter((d) => fs.existsSync(d));
  settings.recentFolders = [dir, ...settings.recentFolders.filter((f) => f !== dir)].slice(0, 10);
  rememberWindows();
  startWatchers(ctx);
  setTitle(ctx);
  buildMenu();
  return folderInfo(ctx);
}

// Adds a folder to the window's workspace, remembered for the next time its main folder opens.
function addFolder(ctx, dir) {
  if (!ctx.workspace) throw new Error('Open a folder first.');
  dir = path.resolve(dir);
  if (within(ctx.workspace, dir) || within(dir, ctx.workspace)) throw new Error(`${path.basename(dir)} is already part of ${path.basename(ctx.workspace)}.`);
  if (ctx.extra.some((d) => within(d, dir) || within(dir, d))) throw new Error(`${path.basename(dir)} is already in this workspace.`);
  ctx.extra = [...ctx.extra, dir];
  saveExtra(ctx);
  return folderInfo(ctx);
}

function removeFolder(ctx, dir) {
  ctx.extra = ctx.extra.filter((d) => d !== dir);
  saveExtra(ctx);
  return folderInfo(ctx);
}

function saveExtra(ctx) {
  const all = { ...(settings.extraFolders || {}) };
  if (ctx.extra.length) all[ctx.workspace] = ctx.extra;
  else delete all[ctx.workspace];
  settings.extraFolders = all;
  saveSettings();
  startWatchers(ctx);
  setTitle(ctx);
  buildMenu();
}

// The folders open in windows, so the app reopens them all next time.
function rememberWindows() {
  if (quitting) return;
  settings.openWindows = [...contexts.values()].map((c) => c.workspace).filter(Boolean);
  saveSettings();
}

// ---------- sessions (Claude Code's own transcripts) ----------

// The account the open folder uses, and what the settings page needs to know about it.
const folderAccount = (ctx) => accounts.forFolder(settings, ctx.workspace);
function folderAcct(ctx) {
  const id = folderAccount(ctx);
  const a = accounts.list(settings).find((x) => x.id === id);
  return { id, name: a ? a.name : '', dir: accounts.dirFor(id), env: accounts.envFor(id), main: accounts.isMain(id) };
}

// A message's text, without the context the app added to it.
function textOf(content) {
  if (typeof content === 'string') return stripAppNotes(content);
  if (Array.isArray(content)) return stripAppNotes(content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
  return '';
}

// Past chats in the open folder, from every account. A conversation that moved between accounts
// has a copy under each; the newest one is listed.
async function listSessions(ctx) {
  if (!ctx.workspace) return [];
  const byId = new Map();
  for (const a of accounts.list(settings)) for (const row of await listSessionsIn(a.id, ctx.workspace)) {
    const seen = byId.get(row.id);
    if (!seen || row.updatedAt > seen.updatedAt) byId.set(row.id, row);
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100);
}

async function listSessionsIn(account, workspace) {
  const dir = accounts.projectDir(account, workspace);
  let names;
  try {
    names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const stat = await fsp.stat(file);
      const fh = await fsp.open(file, 'r');
      const { buffer, bytesRead } = await fh.read(Buffer.alloc(128 * 1024), 0, 128 * 1024, 0);
      await fh.close();
      let title = '';
      let customTitle = '';
      for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'custom-title' && ev.customTitle) customTitle = ev.customTitle;
          if (!title && ev.type === 'user' && !ev.isMeta && !ev.isSidechain) {
            const t = textOf(ev.message?.content).trim();
            if (t && !t.startsWith('<')) title = t;
          }
        } catch {
          /* partial line */
        }
      }
      if (!title && !customTitle) continue;
      rows.push({
        id: name.replace(/\.jsonl$/, ''),
        title: (customTitle || title).replace(/^\[Ask mode:[^\]]*\]\s*/, '').slice(0, 120),
        updatedAt: stat.mtimeMs,
        account,
      });
    } catch {
      /* unreadable */
    }
  }
  return rows.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100);
}

// A chat's working folder: the open folder, or its own copy (a worktree) for parallel agents.
function chatCwd(ctx, cwd) {
  return cwd && worktrees.isUnder(cwd) && fs.existsSync(cwd) ? cwd : ctx.workspace;
}

async function loadSession(ctx, id, cwd, account) {
  const dir = chatCwd(ctx, cwd);
  if (!accounts.exists(settings, account)) account = folderAccount(ctx);
  await accounts.ensureTranscript(settings, account, dir, id);
  const file = path.join(accounts.projectDir(account, dir), id + '.jsonl');
  const lines = (await fsp.readFile(file, 'utf8')).split('\n');
  const messages = [];
  let lastReply = null; // uuid of the latest assistant message, which Rewind resumes from
  for (const line of lines) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.isSidechain || ev.isMeta) continue;
    if (ev.type === 'user') {
      const t = textOf(ev.message?.content).trim();
      if (t && !t.startsWith('<')) messages.push({ role: 'user', text: t.replace(/^\[Ask mode:[^\]]*\]\s*/, ''), after: lastReply });
    } else if (ev.type === 'assistant') {
      if (ev.uuid) lastReply = ev.uuid;
      for (const b of ev.message?.content || []) {
        if (b.type === 'text' && b.text.trim()) messages.push({ role: 'assistant', text: b.text, uuid: ev.uuid });
        else if (b.type === 'tool_use') messages.push({ role: 'tool', name: b.name, input: b.input, uuid: ev.uuid });
      }
    }
  }
  return messages;
}

// ---------- chats (one persistent Claude Code process each) ----------

const chats = new Map(); // `${window id}:${chatId}` -> { ctx, session, effort, turn, approvals: Map(reqId -> resolve) }
const chatKey = (ctx, chatId) => `${ctx.id}:${chatId}`;
const turnSnapshots = new Map(); // turnId -> TurnSnapshot, kept for Undo

function editTarget(input) {
  return input?.file_path || input?.notebook_path || null;
}

function touchForSnapshot(ctx, turn, filePath) {
  if (!turn || !filePath) return;
  try {
    turn.snap.touch(resolveInWorkspace(ctx, filePath));
  } catch {
    /* outside the workspace */
  }
}

// Snapshot a file as soon as Claude finishes writing an edit call, before it runs.
function trackStream(ctx, turn, ev) {
  if (!turn || ev.type !== 'stream_event' || ev.parent_tool_use_id) return;
  const e = ev.event || {};
  if (e.type === 'message_start') turn.blocks.clear();
  else if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use' && EDIT_TOOLS.has(e.content_block.name)) turn.blocks.set(e.index, '');
  else if (e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta' && turn.blocks.has(e.index)) turn.blocks.set(e.index, turn.blocks.get(e.index) + e.delta.partial_json);
  else if (e.type === 'content_block_stop' && turn.blocks.has(e.index)) {
    try {
      touchForSnapshot(ctx, turn, editTarget(JSON.parse(turn.blocks.get(e.index) || '{}')));
    } catch {
      /* partial JSON */
    }
    turn.blocks.delete(e.index);
  }
}

async function finishTurn(chatId, chat) {
  const turn = chat.turn;
  if (!turn) return;
  chat.turn = null;
  let changes = [];
  try {
    changes = await turn.snap.changes();
  } catch (err) {
    console.error('snapshot diff failed', err);
  }
  turnSnapshots.set(turn.id, turn.snap);
  sendTo(chat.ctx, 'chat-turn-end', { chatId, turnId: turn.id, changes });
}

// Rewind: puts the workspace back how it was before the first of these turns (oldest first).
// Returns the files that differ, and restores them when apply is set. A turn in a workspace with
// several folders has a snapshot per folder; each folder is rewound on its own.
async function rewindFiles(turnIds, apply) {
  const snaps = turnIds.map((id) => turnSnapshots.get(id));
  if (!snaps.length || !snaps[0]) return { available: false, files: [] };
  const byFolder = new Map(); // folder -> its snapshots, oldest first
  for (const s of snaps) for (const p of s ? s.parts || [s] : []) byFolder.set(p.workspace, [...(byFolder.get(p.workspace) || []), p]);
  const files = new Set();
  for (const list of byFolder.values()) {
    const r = await rewindFolder(list, false);
    if (!r) return { available: false, files: [] };
    r.forEach((f) => files.add(f));
  }
  if (apply) for (const list of byFolder.values()) await rewindFolder(list, true);
  return { available: true, files: [...files] };
}

async function rewindFolder(snaps, apply) {
  const first = snaps[0];
  const relOf = (abs) => (first.prefix ? first.prefix + '/' : '') + path.relative(first.workspace, abs).split(path.sep).join('/');
  const allowed = (abs) => within(first.workspace, abs);
  if (first.root && first.before) {
    // A git snapshot covers the whole folder, including later edits.
    const now = await writeTree(first.root);
    const diffs = (await diffTrees(first.root, first.before, now)).map((c) => ({ ...c, abs: path.join(first.root, c.rel) })).filter((c) => allowed(c.abs));
    if (apply)
      for (const c of diffs) {
        if (c.status === 'A') await fsp.rm(c.abs, { force: true });
        else {
          await fsp.mkdir(path.dirname(c.abs), { recursive: true });
          await fsp.writeFile(c.abs, (await blob(first.root, first.before, c.rel)) || Buffer.alloc(0));
        }
      }
    return diffs.map((c) => relOf(c.abs));
  }
  // No git: undo each turn's own edits, newest first.
  if (snaps.some((s) => !s.result)) return null;
  const files = new Set();
  for (const s of [...snaps].reverse()) {
    const paths = [...s.result.keys()].filter((p) => allowed(p));
    paths.forEach((p) => files.add(relOf(p)));
    if (apply) await s.undo(paths);
  }
  return [...files];
}

function denyPending(chat, message) {
  for (const resolve of chat.approvals.values()) resolve({ behavior: 'deny', message });
  chat.approvals.clear();
}

async function openChat(ctx, chatId, { sessionId, resumeAt, model, effort, mode, cwd, account, agent }) {
  const a = agents.AGENTS[agent] ? agents.AGENTS[agent] : agents.AGENTS.claude;
  agent = agents.AGENTS[agent] ? agent : 'claude';
  const bin = await agents.findBin(agent, settings);
  if (!bin) throw new Error(agent === 'claude' ? 'Claude Code is not installed. Open Settings → Setup to install it.' : `${a.label} isn't installed yet. Open Settings → Agents to install it.`);
  if (a.key && !agents.readKey(settings, agent)) throw new Error(`Add your ${a.key.name} in Settings → Agents first.`);
  const dirs = [...ctx.extra];
  const chat = { ctx, session: null, effort: effort || '', model: model || '', turn: null, approvals: new Map(), cwd: chatCwd(ctx, cwd), account, agent, dirs };
  const key = chatKey(ctx, chatId);
  // Picking up a conversation another account had: give this account the latest transcript.
  if (sessionId && agent === 'claude') await accounts.ensureTranscript(settings, account, chat.cwd, sessionId);
  const Session = a.kind === 'codex' ? CodexSession : a.kind === 'acp' ? AcpSession : ChatSession;
  chat.session = new Session({
    bin,
    args: [...(a.args || []), ...(a.dirsArg ? dirs.flatMap((d) => [a.dirsArg, d]) : [])],
    label: a.label,
    authMethod: a.authMethod,
    cwd: chat.cwd,
    dirs,
    rules: a.ownRulesFile ? projectRules(chat.cwd) : '',
    env: agent === 'claude' ? accounts.envFor(account) : agents.envFor(settings, agent, model),
    sessionId,
    resumeAt: agent === 'claude' ? resumeAt : null,
    model,
    effort,
    mode,
    onEvent: (ev) => {
      trackStream(ctx, chat.turn, ev);
      sendTo(ctx, 'chat-event', { chatId, ev });
      if (ev.type === 'result') finishTurn(chatId, chat);
    },
    onPermission: (req) =>
      new Promise((resolve) => {
        if (EDIT_TOOLS.has(req.toolName)) touchForSnapshot(ctx, chat.turn, editTarget(req.input));
        const reqId = crypto.randomUUID();
        chat.approvals.set(reqId, resolve);
        sendTo(ctx, 'approval-request', { chatId, reqId, toolName: req.toolName, input: req.input, description: req.description });
      }),
    onExit: async ({ code, stderr }) => {
      denyPending(chat, 'Claude Code stopped.');
      if (chats.get(key) === chat) chats.delete(key);
      if (chat.turn) await finishTurn(chatId, chat);
      if (!chat.closing) sendTo(ctx, 'chat-exit', { chatId, code, stderr });
    },
  });
  await chat.session.start();
  chats.set(key, chat);
  return chat;
}

// "@⟦api⟧/src/x.js" in a message means the extra folder's file: agents get its real path.
function withRealPaths(ctx, content) {
  const keyed = roots(ctx).slice(1);
  if (!keyed.length) return content;
  const swap = (text) => keyed.reduce((t, r) => t.split(r.key).join(r.dir.split(path.sep).join('/')), text);
  return content.map((b) => (b.type === 'text' ? { ...b, text: swap(b.text) } : b));
}

// AGENTS.md, for agents that read their own rules file instead.
function projectRules(dir) {
  try {
    return fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8').slice(0, 20000).trim();
  } catch {
    return '';
  }
}

// A snapshot of every folder the chat can change, taken before each turn.
function beginSnapshot(ctx, chat) {
  const extra = chat.cwd === ctx.workspace ? roots(ctx).slice(1) : [];
  if (!extra.length) return new TurnSnapshot(chat.cwd).begin();
  return new MultiSnapshot([new TurnSnapshot(chat.cwd), ...extra.map((r) => new TurnSnapshot(r.dir, r.key))]).begin();
}

async function chatSend(ctx, chatId, { content, mode, model, effort, sessionId, resumeAt, cwd, account, agent }) {
  if (!ctx.workspace) throw new Error('Open a folder first.');
  if (!accounts.exists(settings, account)) account = folderAccount(ctx);
  agent = agents.AGENTS[agent] ? agent : 'claude';
  const key = chatKey(ctx, chatId);
  let chat = chats.get(key);
  const restart =
    chat &&
    chat.session.alive &&
    (resumeAt ||
      agent !== chat.agent ||
      chat.dirs.join('\n') !== ctx.extra.join('\n') ||
      (agent === 'claude' && ((effort || '') !== chat.effort || account !== chat.account)) ||
      (agents.AGENTS[agent].kind === 'acp' && (model || '') !== chat.model));
  if (restart) {
    // Effort, account, the workspace's folders and (for ACP agents) model are fixed per process:
    // restart it on the same conversation.
    if (!resumeAt) sessionId = chat.session.sessionId || sessionId;
    chat.closing = true;
    chat.session.dispose();
    chats.delete(key);
    chat = null;
  }
  if (!chat || !chat.session.alive) chat = await openChat(ctx, chatId, { sessionId, resumeAt, model, effort, mode, cwd, account, agent });
  else await chat.session.setModel(model);
  const turn = { id: crypto.randomUUID(), snap: await beginSnapshot(ctx, chat), blocks: new Map() };
  chat.turn = turn;
  await chat.session.send(withRealPaths(ctx, content), mode);
  return { turnId: turn.id };
}

async function chatInterrupt(ctx, chatId) {
  const chat = chats.get(chatKey(ctx, chatId));
  if (!chat) return;
  denyPending(chat, 'The user stopped this turn.');
  const r = await chat.session.interrupt();
  // If the CLI doesn't acknowledge, stop the process; the conversation can be resumed.
  if (r.error && chat.session.alive) chat.session.dispose();
}

function closeChat(key) {
  const chat = chats.get(key);
  if (!chat) return;
  chat.closing = true;
  denyPending(chat, 'Chat closed.');
  chat.session.dispose();
  chats.delete(key);
}

// Ends the chats running in a window, when it closes or opens another folder.
function closeWindowChats(ctx) {
  for (const [key, c] of [...chats]) if (c.ctx === ctx) closeChat(key);
}

function answerApproval(ctx, chatId, reqId, decision) {
  const chat = chats.get(chatKey(ctx, chatId));
  const resolve = chat && chat.approvals.get(reqId);
  if (!resolve) return;
  chat.approvals.delete(reqId);
  resolve(decision);
}

// ---------- IPC ----------

function registerIpc() {
  // Every handler gets the window it was called from.
  const handle = (channel, fn) => ipcMain.handle(channel, (e, ...args) => fn(ctxOf(e), ...args));
  handle('settings:get', (ctx) => settings);
  handle('settings:set', (ctx, patch) => {
    if (patch.workspaces) {
      // Each window saves its own folder's tabs: merge, so windows don't overwrite each other.
      const all = Object.entries({ ...(settings.workspaces || {}), ...patch.workspaces });
      patch = { ...patch, workspaces: Object.fromEntries(all.sort((x, y) => (y[1].savedAt || 0) - (x[1].savedAt || 0)).slice(0, 30)) };
    }
    settings = { ...settings, ...patch };
    saveSettings();
    if (patch.theme) nativeTheme.themeSource = patch.theme;
    broadcast('settings-changed', settings, ctx); // other windows keep their copy current
    return settings;
  });
  handle('cli:status', (ctx, account) => cli.cliStatus(settings.claudePath, accounts.envFor(accounts.exists(settings, account) ? account : folderAccount(ctx))));

  // Agents: Claude, Codex, Kimi, and API-key models through Gemini CLI and Qwen Code.
  handle('agents:list', (ctx) =>
    Object.entries(agents.AGENTS).map(([id, a]) => ({
      id,
      label: a.label,
      vendor: a.vendor,
      kind: a.kind,
      help: a.help || '',
      key: a.key || null,
      hasKey: a.key ? !!agents.readKey(settings, id) : false,
      options: a.key ? agents.options(settings, id) : {},
      canLogin: !!a.login,
    }))
  );
  handle('agents:status', async (ctx, id) => {
    const a = agents.AGENTS[id];
    if (!a) return null;
    if (id === 'claude') {
      const s = await cli.cliStatus(settings.claudePath, accounts.envFor(folderAccount(ctx)));
      return { installed: s.found, path: s.path, version: s.version, loggedIn: !!(s.found && (s.auth ? s.auth.loggedIn : true)), detail: s.auth && s.auth.email ? s.auth.email : '' };
    }
    const bin = await agents.findBin(id, settings);
    if (!bin) return { installed: false };
    const version = await agents.version(bin);
    if (a.key && !agents.readKey(settings, id)) return { installed: true, path: bin, version, loggedIn: false, detail: `Needs your ${a.key.name}` };
    try {
      if (a.kind === 'codex') {
        const r = await codexStatus(bin, {});
        return { installed: true, path: bin, version, loggedIn: r.loggedIn, detail: r.loggedIn ? [r.email || (r.method === 'apiKey' ? 'API key' : 'ChatGPT'), r.plan].filter(Boolean).join(' · ') : 'Not signed in' };
      }
      if (a.statusArgs) {
        const r = await agents.cliStatus(bin, a.statusArgs);
        return { installed: true, path: bin, version, loggedIn: r.loggedIn, detail: r.loggedIn ? r.detail.slice(0, 80) || 'Signed in' : 'Not signed in' };
      }
      const r = await acpStatus(bin, a.args, agents.envFor(settings, id));
      return { installed: true, path: bin, version: version || r.version, loggedIn: r.loggedIn, detail: r.loggedIn ? (a.key ? 'API key saved' : 'Signed in') : a.key ? 'The key was not accepted' : 'Not signed in' };
    } catch (err) {
      return { installed: true, path: bin, version, loggedIn: false, detail: String(err.message || err).slice(0, 200) };
    }
  });
  // API key, base URL and default model for an API-key agent. A key of undefined keeps the saved one.
  handle('agents:set-key', (ctx, id, { key, baseUrl, model } = {}) => {
    const a = agents.AGENTS[id];
    if (!a || !a.key) return false;
    const prev = (settings.apiKeys || {})[id] || {};
    const sealed = key === undefined ? { key: prev.key, enc: prev.enc } : agents.sealKey(String(key).trim()) || { key: '', enc: false };
    settings.apiKeys = { ...(settings.apiKeys || {}), [id]: { ...sealed, baseUrl: (baseUrl || '').trim(), model: (model || '').trim() } };
    saveSettings();
    return true;
  });
  // Install and sign-in commands, which the app runs in its own terminal so you see everything.
  handle('agents:command', async (ctx, id, what) => {
    const a = agents.AGENTS[id];
    if (!a) return null;
    if (what === 'install') return a.install ? a.install() : null;
    const bin = await agents.findBin(id, settings);
    if (what === 'login' && a.login) return bin ? agents.commandLine(bin, a.login) : null;
    return null;
  });
  handle('agents:models', async (ctx, id) => {
    if (id !== 'codex') return [];
    const bin = await agents.findBin('codex', settings);
    return bin ? codexModels(bin).catch(() => []) : [];
  });
  // Past conversations an agent keeps for this folder, and one of them as messages.
  handle('agents:sessions', async (ctx, id) => {
    const a = agents.AGENTS[id];
    if (!a || id === 'claude' || !ctx.workspace) return [];
    const bin = await agents.findBin(id, settings);
    if (!bin || (a.key && !agents.readKey(settings, id))) return [];
    const env = agents.envFor(settings, id);
    const rows = a.kind === 'codex' ? await codexSessions(bin, env, ctx.workspace) : await acpSessions(bin, a.args, env, ctx.workspace, a.authMethod);
    return rows.map((r) => ({ ...r, agent: id }));
  });
  handle('agents:history', async (ctx, id, sessionId) => {
    const a = agents.AGENTS[id];
    if (!a || id === 'claude') return null;
    const bin = await agents.findBin(id, settings);
    if (!bin) return null;
    const env = agents.envFor(settings, id);
    return a.kind === 'codex' ? codexHistory(bin, env, sessionId) : acpHistory(bin, a.args, env, ctx.workspace, a.authMethod, sessionId);
  });
  // Codex can use an OpenAI API key instead of a ChatGPT sign-in; Codex stores it itself.
  handle('agents:codex-key', async (ctx, key) => {
    const bin = await agents.findBin('codex', settings);
    if (!bin) throw new Error("Codex isn't installed.");
    const env = await cli.childEnv();
    return new Promise((resolve) => {
      const child = require('child_process').spawn(bin, ['login', '--with-api-key'], { env, windowsHide: true, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin) });
      let out = '';
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (out += c));
      child.on('error', (e) => resolve({ ok: false, out: String(e) }));
      child.on('close', (code) => resolve({ ok: code === 0, out: out.trim() }));
      child.stdin.end(String(key).trim() + '\n');
    });
  });

  // Accounts: several Claude logins side by side, a default per folder, and a pick per chat.
  const accountsInfo = (ctx) => ({ accounts: accounts.list(settings), rules: settings.accountRules || {}, defaultAccount: accounts.forFolder(settings, null), folderAccount: folderAccount(ctx) });
  handle('accounts:list', (ctx) => accountsInfo(ctx));
  handle('accounts:add', async (ctx, name) => {
    const a = await accounts.create(name);
    settings.accounts = [...(settings.accounts || []), a];
    saveSettings();
    return { ...accountsInfo(ctx), added: a.id };
  });
  handle('accounts:rename', (ctx, id, name) => {
    name = String(name || '').trim().slice(0, 40);
    if (!name) return accountsInfo(ctx);
    if (accounts.isMain(id)) settings.mainAccountName = name;
    else settings.accounts = (settings.accounts || []).map((a) => (a.id === id ? { ...a, name } : a));
    saveSettings();
    return accountsInfo(ctx);
  });
  handle('accounts:remove', async (ctx, id) => {
    for (const [key, c] of [...chats]) if (c.account === id) closeChat(key);
    await accounts.remove(id);
    settings.accounts = (settings.accounts || []).filter((a) => a.id !== id);
    settings.accountRules = Object.fromEntries(Object.entries(settings.accountRules || {}).filter(([, v]) => v !== id));
    if (settings.defaultAccount === id) settings.defaultAccount = accounts.MAIN;
    saveSettings();
    return accountsInfo(ctx);
  });
  // Ties a folder to an account (null clears the rule).
  handle('accounts:set-rule', (ctx, folder, id) => {
    const rules = { ...(settings.accountRules || {}) };
    folder = path.resolve(folder || ctx.workspace);
    if (id && accounts.exists(settings, id)) rules[folder] = id;
    else delete rules[folder];
    settings.accountRules = rules;
    saveSettings();
    return accountsInfo(ctx);
  });
  handle('accounts:set-default', (ctx, id) => {
    if (accounts.exists(settings, id)) settings.defaultAccount = id;
    saveSettings();
    return accountsInfo(ctx);
  });

  // First-run setup: install the CLI and sign in.
  handle('setup:install', (ctx) => cli.installClaude((text) => sendTo(ctx, 'setup-log', text)));
  handle('setup:login', async (ctx, account) => {
    const bin = await cli.findClaude(settings.claudePath);
    if (!bin) throw new Error('Install Claude Code first.');
    if (loginHandle) loginHandle.cancel();
    if (!accounts.exists(settings, account)) account = folderAccount(ctx);
    loginCtx = ctx;
    loginHandle = await cli.startLogin(bin, {
      onLog: (text) => sendTo(ctx, 'setup-log', text),
      onUrl: (url) => sendTo(ctx, 'setup-login-url', url),
      onExit: (r) => {
        loginHandle = null;
        loginCtx = null;
        sendTo(ctx, 'setup-login-exit', { ...r, account });
      },
    }, accounts.envFor(account));
    return true;
  });
  handle('setup:login-code', (ctx, code) => loginHandle && loginHandle.sendCode(code));
  handle('setup:login-cancel', (ctx) => loginHandle && loginHandle.cancel());
  // Menus drawn in the app's own title bar (Windows and Linux).
  handle('menu:labels', (ctx) => (Menu.getApplicationMenu()?.items || []).map((i) => i.label.replace(/&/g, '')));
  handle('menu:popup', (ctx, index, x, y) => {
    const item = Menu.getApplicationMenu()?.items[index];
    if (!item || !item.submenu) return;
    return new Promise((resolve) => item.submenu.popup({ window: ctx.win, x: Math.round(x), y: Math.round(y), callback: resolve }));
  });
  handle('window:titlebar-colors', (ctx, color, symbolColor) => {
    if (ctx.win && process.platform !== 'darwin' && ctx.win.setTitleBarOverlay) ctx.win.setTitleBarOverlay({ color, symbolColor, height: 38 });
  });
  handle('update:install', (ctx) => updater.installNow());
  handle('update:check', (ctx) => updater.checkNow());
  // Flash the taskbar button (bounce the Dock on macOS) until you come back to the app.
  handle('window:flash', (ctx) => {
    if (!ctx.win || ctx.win.isDestroyed() || ctx.win.isFocused()) return;
    if (process.platform === 'darwin') app.dock?.bounce('informational');
    else ctx.win.flashFrame(true);
  });
  // Preview pane: screenshots for the chat, and "open in your browser".
  handle('preview:capture', async (ctx, id, rect) => {
    const wc = require('electron').webContents.fromId(id);
    if (!wc || wc.getType() !== 'webview') return null;
    const img = await (rect ? wc.capturePage(rect) : wc.capturePage());
    let out = img;
    if (out.getSize().width > 1600) out = out.resize({ width: 1600 });
    return out.isEmpty() ? null : out.toPNG().toString('base64');
  });
  handle('preview:open-external', (ctx, url) => /^https?:\/\//.test(url) && shell.openExternal(url));
  handle('app:version', (ctx) => app.getVersion());
  handle('open-external', (ctx, url) => {
    if (/^https:\/\/([a-z0-9-]+\.)*(claude\.ai|claude\.com|anthropic\.com|git-scm\.com)\//i.test(url)) shell.openExternal(url);
  });

  handle('folder:pick', async (ctx) => {
    const dir = await pickDir(ctx);
    return dir ? openFolder(ctx, dir) : null;
  });
  handle('folder:open', (ctx, dir) => (fs.existsSync(dir) ? openFolder(ctx, dir) : null));
  handle('folder:current', (ctx) => folderInfo(ctx));
  // What a window shows when it first loads: its folder, the one it was opened for, or nothing.
  handle('folder:start', async (ctx) => {
    if (ctx.workspace) return folderInfo(ctx);
    const dir = ctx.start;
    ctx.start = null;
    return dir && fs.existsSync(dir) ? openFolder(ctx, dir) : null;
  });
  // Workspaces: more folders in one window.
  handle('folder:add', async (ctx, dir) => {
    dir = dir || (await pickDir(ctx, 'Add Folder to Workspace'));
    return dir ? addFolder(ctx, dir) : null;
  });
  handle('folder:remove', (ctx, dir) => removeFolder(ctx, dir));
  handle('window:new', (ctx, dir) => newWindow(dir));
  handle('files:list', (ctx) => listFiles(ctx));
  handle('files:search', async (ctx, query, opts) => (ctx.workspace ? search.search((rel) => resolveInWorkspace(ctx, rel), await listFiles(ctx), query, { ...opts, group: ctx.id }) : { results: [] }));
  handle('file:read', async (ctx, rel) => {
    const abs = resolveInWorkspace(ctx, rel);
    const st = await fsp.stat(abs);
    if (st.size > 10 * 1024 * 1024) return { tooLarge: true };
    const buf = await fsp.readFile(abs);
    if (buf.subarray(0, 8000).includes(0)) return { binary: true };
    return { content: buf.toString('utf8') };
  });
  handle('file:write', async (ctx, rel, content) => {
    const abs = resolveInWorkspace(ctx, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, 'utf8');
    return true;
  });
  handle('file:reveal', (ctx, rel) => shell.showItemInFolder(resolveInWorkspace(ctx, rel)));

  handle('sessions:list', (ctx) => listSessions(ctx));
  handle('sessions:load', (ctx, id, cwd, account) => loadSession(ctx, id, cwd, account));
  // Parallel agents: chats working in their own copy of the project.
  const ownCopy = (wt) => {
    if (!worktrees.exists(wt)) throw new Error('This copy no longer exists.');
    return wt;
  };
  handle('worktree:create', (ctx, name) => worktrees.create(ctx.workspace, name));
  handle('worktree:changes', (ctx, wt) => worktrees.changes(ownCopy(wt)));
  handle('worktree:diff', (ctx, wt, rel) => worktrees.fileDiff(ownCopy(wt), rel));
  handle('worktree:merge', (ctx, wt) => worktrees.merge(ownCopy(wt), ctx.workspace));
  handle('worktree:remove', (ctx, wt) => (worktrees.exists(wt) ? worktrees.remove(wt) : true));
  handle('worktree:exists', (ctx, wt) => worktrees.exists(wt));

  handle('chat:send', (ctx, chatId, opts) => chatSend(ctx, chatId, opts));
  handle('chat:interrupt', (ctx, chatId) => chatInterrupt(ctx, chatId));
  handle('chat:close', (ctx, chatId) => closeChat(chatKey(ctx, chatId)));
  handle('chat:set-mode', (ctx, chatId, mode) => chats.get(chatKey(ctx, chatId))?.session.setMode(mode));
  handle('approval:answer', (ctx, chatId, reqId, decision) => answerApproval(ctx, chatId, reqId, decision));
  handle('rewind:files', (ctx, turnIds) => rewindFiles(turnIds, false));
  handle('rewind:apply', (ctx, turnIds) => rewindFiles(turnIds, true));
  handle('changes:undo', async (ctx, turnId, absPaths) => {
    const snap = turnSnapshots.get(turnId);
    if (!snap) return false;
    await snap.undo(absPaths.filter((p) => inWorkspace(ctx, p) || worktrees.isUnder(p)));
    return true;
  });

  // Source control
  handle('git:status', (ctx) => (ctx.workspace ? gitops.status(ctx.workspace) : { repo: false }));
  handle('git:head', (ctx, rel) => gitops.headContent(ctx.workspace, rel));
  handle('git:commit', (ctx, message) => gitops.commitAll(ctx.workspace, message));
  handle('git:checkout', (ctx, branch, create) => gitops.checkout(ctx.workspace, branch, create));
  handle('git:sync', (ctx, action) => gitops.sync(ctx.workspace, action));
  handle('git:discard', async (ctx, rel, wasUntracked) => {
    const abs = resolveInWorkspace(ctx, rel);
    if (wasUntracked) {
      await git(ctx.workspace, ['rm', '--cached', '--ignore-unmatch', '-q', '--', rel]).catch(() => {});
      await fsp.rm(abs, { force: true });
    }
    else await git(ctx.workspace, ['checkout', 'HEAD', '--', rel]);
  });
  handle('git:init', (ctx) => git(ctx.workspace, ['init']));
  handle('git:suggest', async (ctx) => gitops.suggestMessage(ctx.workspace, await cli.findClaude(settings.claudePath), accounts.envFor(folderAccount(ctx))));

  // Terminal
  // Terminal ids are per window in the app, so they're prefixed with the window's here.
  const termId = (ctx, id) => `${ctx.id}:${id}`;
  handle('term:create', (ctx, id, cols, rows) =>
    // `claude` typed in the terminal signs in as the folder's account too.
    terminal.create(termId(ctx, id), ctx.workspace, cols, rows, { onData: (d) => sendTo(ctx, 'term-data', { id, data: d }), onExit: (code) => sendTo(ctx, 'term-exit', { id, code }) }, accounts.envFor(folderAccount(ctx)))
  );
  handle('term:write', (ctx, id, data) => terminal.write(termId(ctx, id), data));
  handle('term:resize', (ctx, id, cols, rows) => terminal.resize(termId(ctx, id), cols, rows));
  handle('term:kill', (ctx, id) => terminal.kill(termId(ctx, id)));

  // Settings page
  handle('usage:record', (ctx, key, turn) => usage.record(key, turn));
  handle('usage:limits', (ctx, key, windows) => usage.setLimits(key, windows));
  handle('usage:summary', () => usage.summary());
  handle('git:diff', async (ctx) => {
    if (!ctx.workspace) return '';
    let diff = await git(ctx.workspace, ['diff', 'HEAD', '--no-color']).catch(() => '');
    const untracked = await git(ctx.workspace, ['ls-files', '--others', '--exclude-standard']).catch(() => '');
    if (untracked.trim()) diff += `\n\nNew files, not yet tracked:\n${untracked.trim()}`;
    return diff.trim();
  });
  handle('web:fetch', (ctx, url) => webpage.fetchPage(net.fetch.bind(net), url));
  handle('cfg:memory', (ctx) => config.memoryFiles(ctx.workspace, folderAcct(ctx)));
  handle('cfg:rules-shared', (ctx) => config.rulesShared(ctx.workspace));
  handle('cfg:share-rules', (ctx) => (ctx.workspace ? config.shareRules(ctx.workspace) : null));
  handle('cfg:save-memory', (ctx, id, content) => config.saveMemory(ctx.workspace, id, content, folderAcct(ctx)));
  handle('cfg:permissions', (ctx) => config.permissions(ctx.workspace, folderAcct(ctx)));
  handle('cfg:rule', (ctx, scope, rule, add) => config.editRule(ctx.workspace, scope, rule, add, folderAcct(ctx)));
  handle('cfg:mcp-list', async (ctx) => config.mcpList(await cli.findClaude(settings.claudePath), ctx.workspace || os.homedir(), folderAcct(ctx)));
  handle('cfg:mcp-remove', async (ctx, name) => config.mcpRemove(await cli.findClaude(settings.claudePath), ctx.workspace || os.homedir(), name, folderAcct(ctx)));
  handle('cfg:mcp-add', async (ctx, spec) => config.mcpAdd(await cli.findClaude(settings.claudePath), ctx.workspace || os.homedir(), spec, folderAcct(ctx)));
}

// ---------- app ----------

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

// A new window. start is the folder it opens with; null opens an empty window.
function createWindow(start) {
  const focused = BrowserWindow.getFocusedWindow();
  const at = focused && !focused.isMaximized() ? focused.getBounds() : null;
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    ...(at ? { x: at.x + 28, y: at.y + 28, width: at.width, height: at.height } : {}),
    minWidth: 900,
    minHeight: 560,
    title: 'Switchdesk',
    backgroundColor: '#1e1f22',
    icon: path.join(APP_ROOT, 'build', 'icon.png'),
    // macOS keeps its traffic lights; Windows and Linux get one combined bar: the app draws the
    // menus and the OS draws only the minimise/maximise/close buttons on top of it.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin' ? {} : { titleBarOverlay: { color: '#1b1b1b', symbolColor: '#d6d6d6', height: 38 } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true, // the preview pane
    },
  });
  const ctx = { id: win.webContents.id, win, workspace: null, extra: [], watchers: [], start: start || null };
  contexts.set(ctx.id, ctx);
  win.loadURL('app://desk/renderer/index.html');
  win.on('focus', () => win.flashFrame(false));
  win.on('page-title-updated', (e) => e.preventDefault()); // the title names the window's folder
  win.webContents.on('did-finish-load', () => lastUpdate && sendTo(ctx, 'update-status', lastUpdate));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });
  win.on('closed', () => {
    closeWindowChats(ctx);
    terminal.killWhere(`${ctx.id}:`);
    stopWatchers(ctx);
    if (loginCtx === ctx && loginHandle) loginHandle.cancel();
    contexts.delete(ctx.id);
    ctx.win = null;
    rememberWindows();
    buildMenu();
  });
  buildMenu();
  return ctx;
}

// Opens a window, or goes to the one that already has the folder.
function newWindow(dir) {
  const open = dir && windowWith(dir);
  if (open) return focusWindow(open);
  createWindow(dir || null);
}

async function pickDir(ctx, title) {
  const r = await dialog.showOpenDialog(ctx && ctx.win ? ctx.win : undefined, { title, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
}

// Asks a window's page to do something from the menu.
const menuCmd = (cmd) => (_item, bw) => {
  const ctx = ctxOfWindow(bw) || ctxOfWindow(BrowserWindow.getFocusedWindow());
  if (ctx) sendTo(ctx, 'menu', cmd);
  else if (cmd === 'open-folder') newWindowWithPicker();
};

async function newWindowWithPicker() {
  const dir = await pickDir(null);
  if (dir) newWindow(dir);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const recents = (settings.recentFolders || []).filter((f) => fs.existsSync(f));
  const open = [...contexts.values()].filter((c) => c.win && !c.win.isDestroyed());
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => newWindow(null) },
        { type: 'separator' },
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: menuCmd('open-folder') },
        { label: 'Open Folder in New Window…', click: newWindowWithPicker },
        {
          label: 'Open Recent',
          submenu: recents.length
            ? [
                ...recents.map((f) => ({
                  label: f,
                  click: (_i, bw) => {
                    const ctx = ctxOfWindow(bw);
                    const other = windowWith(f, ctx);
                    if (other) focusWindow(other);
                    else if (ctx) sendTo(ctx, 'menu-open-folder', f);
                    else newWindow(f);
                  },
                })),
                { type: 'separator' },
                { label: 'Clear Recent', click: () => ((settings.recentFolders = []), saveSettings(), buildMenu()) },
              ]
            : [{ label: 'No recent folders', enabled: false }],
        },
        { type: 'separator' },
        { label: 'Add Folder to Workspace…', click: menuCmd('add-folder') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: menuCmd('save') },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: menuCmd('close-tab') },
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', click: (_i, bw) => bw && bw.close() },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Command Palette…', accelerator: 'CmdOrCtrl+Shift+P', click: menuCmd('palette') },
        { label: 'Quick Open File', accelerator: 'CmdOrCtrl+P', click: menuCmd('quick-open') },
        { label: 'Search in Files', accelerator: 'CmdOrCtrl+Shift+F', click: menuCmd('search') },
        { label: 'New Chat', accelerator: 'CmdOrCtrl+N', click: menuCmd('new-chat') },
        { label: 'New Chat in Its Own Copy', accelerator: 'CmdOrCtrl+Alt+N', click: menuCmd('new-copy-chat') },
        { label: 'Add Selection to Chat', accelerator: 'CmdOrCtrl+L', click: menuCmd('add-selection') },
        { label: 'Edit Selection with Claude', accelerator: 'CmdOrCtrl+K', click: menuCmd('inline-edit') },
        { label: 'Cycle Mode', accelerator: 'CmdOrCtrl+.', click: menuCmd('cycle-mode') },
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: menuCmd('toggle-sidebar') },
        { label: 'Toggle Terminal', accelerator: 'CmdOrCtrl+`', click: menuCmd('toggle-terminal') },
        { label: 'Source Control', accelerator: 'CmdOrCtrl+Shift+G', click: menuCmd('source-control') },
        { label: 'Preview', accelerator: 'CmdOrCtrl+Shift+V', click: menuCmd('preview') },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: menuCmd('settings') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
    isMac
      ? { role: 'windowMenu' }
      : {
          label: 'Window',
          submenu: [
            { role: 'minimize' },
            { label: 'New Window', click: () => newWindow(null) },
            ...(open.length > 1
              ? [
                  { type: 'separator' },
                  ...open.map((c) => ({
                    label: c.workspace ? path.basename(c.workspace) + (c.extra.length ? ` (+${c.extra.length})` : '') : 'Empty window',
                    type: 'checkbox',
                    checked: c.win.isFocused(),
                    click: () => focusWindow(c),
                  })),
                ]
              : []),
          ],
        },
    {
      label: 'Help',
      submenu: [
        { label: `Switchdesk ${app.getVersion()}`, enabled: false },
        { label: 'Check for Updates…', click: () => updater.checkNow() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// The preview pane is a <webview>: no preload or Node in it, and links that open new windows stay inside it.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (ev, prefs, params) => {
    delete prefs.preload;
    prefs.nodeIntegration = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    if (!/^(https?:|file:|about:blank)/.test(params.src || '')) ev.preventDefault();
  });
  if (contents.getType() === 'webview') {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) contents.loadURL(url);
      return { action: 'deny' };
    });
  }
});

app.whenReady().then(() => {
  worktrees.setBaseDir(path.join(app.getPath('userData'), 'worktrees'));
  accounts.setBaseDir(path.join(app.getPath('userData'), 'accounts'));
  usage.setBaseDir(app.getPath('userData'));
  loadSettings();
  nativeTheme.themeSource = settings.theme || 'system';
  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url);
    const file = path.normalize(path.join(APP_ROOT, decodeURIComponent(pathname)));
    if (!file.startsWith(APP_ROOT)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  registerIpc();
  buildMenu();
  updater.start((status) => {
    lastUpdate = status;
    broadcast('update-status', status);
  });
  // Reopen every window that was open last time, else the last folder.
  const last = (settings.openWindows || []).filter((d) => fs.existsSync(d));
  const starts = last.length ? [...new Set(last)] : [(settings.recentFolders || [])[0] || null];
  for (const dir of starts) createWindow(dir);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow((settings.recentFolders || [])[0] || null);
  });
});

// Quitting keeps the list of open windows; closing windows one by one doesn't.
app.on('before-quit', () => {
  rememberWindows();
  quitting = true;
});

app.on('window-all-closed', () => {
  for (const key of [...chats.keys()]) closeChat(key);
  terminal.killAll();
  if (process.platform !== 'darwin') app.quit();
});

// Rebuild the window list in the menu when focus moves.
app.on('browser-window-focus', () => process.platform !== 'darwin' && buildMenu());
