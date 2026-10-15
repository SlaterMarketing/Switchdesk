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
const { TurnSnapshot, git, writeTree, diffTrees, blob } = require('./snapshots');
const gitops = require('./gitops');
const terminal = require('./terminal');
const config = require('./config');
const updater = require('./updater');
const search = require('./search');
const worktrees = require('./worktrees');

const APP_ROOT = path.join(__dirname, '..');
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'out', '.venv', 'venv', '__pycache__', '.cache', '.turbo', 'target', '.idea', 'coverage']);

let win = null;
let loginHandle = null;

// ---------- settings ----------

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { recentFolders: [], claudePath: '', model: '', effort: '', mode: 'agent', theme: 'system' };

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

// ---------- workspace ----------

let workspace = null; // absolute path of the open folder
let watcher = null;

function inWorkspace(p) {
  if (!workspace) return false;
  const rel = path.relative(workspace, path.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveInWorkspace(p) {
  const abs = path.isAbsolute(p) ? p : path.join(workspace, p);
  if (!inWorkspace(abs)) throw new Error('Path is outside the open folder: ' + p);
  return abs;
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

async function listFiles() {
  if (!workspace) return [];
  const files = (await gitFiles(workspace)) || (await walkFiles(workspace));
  return files.slice(0, 50000).sort();
}

function startWatcher() {
  if (watcher) watcher.close();
  watcher = null;
  if (!workspace) return;
  let pending = new Set();
  let timer = null;
  try {
    watcher = fs.watch(workspace, { recursive: true }, (_evt, file) => {
      if (!file) return;
      const rel = file.split(path.sep).join('/');
      if (rel.split('/').some((seg) => IGNORED_DIRS.has(seg))) return;
      pending.add(rel);
      clearTimeout(timer);
      timer = setTimeout(() => {
        send('fs-changed', [...pending]);
        pending = new Set();
      }, 250);
    });
  } catch {
    /* recursive watch unsupported: the renderer still refreshes after each turn */
  }
}

async function openFolder(dir) {
  workspace = path.resolve(dir);
  settings.recentFolders = [workspace, ...settings.recentFolders.filter((f) => f !== workspace)].slice(0, 10);
  saveSettings();
  startWatcher();
  if (win) win.setTitle(`${path.basename(workspace)} — Claude Desk`);
  return { root: workspace, name: path.basename(workspace) };
}

// ---------- sessions (Claude Code's own transcripts) ----------

function projectDirFor(cwd) {
  return path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return '';
}

async function listSessions() {
  if (!workspace) return [];
  const dir = projectDirFor(workspace);
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
      });
    } catch {
      /* unreadable */
    }
  }
  return rows.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100);
}

// A chat's working folder: the open folder, or its own copy (a worktree) for parallel agents.
function chatCwd(cwd) {
  return cwd && worktrees.isUnder(cwd) && fs.existsSync(cwd) ? cwd : workspace;
}

async function loadSession(id, cwd) {
  const file = path.join(projectDirFor(chatCwd(cwd)), id + '.jsonl');
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

const chats = new Map(); // chatId -> { session, effort, turn, approvals: Map(reqId -> resolve) }
const turnSnapshots = new Map(); // turnId -> TurnSnapshot, kept for Undo

function editTarget(input) {
  return input?.file_path || input?.notebook_path || null;
}

function touchForSnapshot(turn, filePath) {
  if (!turn || !filePath) return;
  try {
    turn.snap.touch(resolveInWorkspace(filePath));
  } catch {
    /* outside the workspace */
  }
}

// Snapshot a file as soon as Claude finishes writing an edit call, before it runs.
function trackStream(turn, ev) {
  if (!turn || ev.type !== 'stream_event' || ev.parent_tool_use_id) return;
  const e = ev.event || {};
  if (e.type === 'message_start') turn.blocks.clear();
  else if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use' && EDIT_TOOLS.has(e.content_block.name)) turn.blocks.set(e.index, '');
  else if (e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta' && turn.blocks.has(e.index)) turn.blocks.set(e.index, turn.blocks.get(e.index) + e.delta.partial_json);
  else if (e.type === 'content_block_stop' && turn.blocks.has(e.index)) {
    try {
      touchForSnapshot(turn, editTarget(JSON.parse(turn.blocks.get(e.index) || '{}')));
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
  send('chat-turn-end', { chatId, turnId: turn.id, changes });
}

// Rewind: puts the workspace back how it was before the first of these turns (oldest first).
// Returns the files that differ, and restores them when apply is set.
async function rewindFiles(turnIds, apply) {
  const snaps = turnIds.map((id) => turnSnapshots.get(id));
  if (!snaps.length || !snaps[0]) return { available: false, files: [] };
  const first = snaps[0];
  const relOf = (abs) => path.relative(first.workspace, abs).split(path.sep).join('/');
  const allowed = (abs) => (first.workspace === workspace ? inWorkspace(abs) : worktrees.isUnder(abs));
  if (first.root && first.before) {
    // A git snapshot covers the whole folder, including later edits.
    const now = await writeTree(first.root);
    const diffs = (await diffTrees(first.root, first.before, now)).map((c) => ({ ...c, abs: path.join(first.root, c.rel) })).filter((c) => allowed(c.abs) && !relOf(c.abs).startsWith('..'));
    if (apply)
      for (const c of diffs) {
        if (c.status === 'A') await fsp.rm(c.abs, { force: true });
        else {
          await fsp.mkdir(path.dirname(c.abs), { recursive: true });
          await fsp.writeFile(c.abs, (await blob(first.root, first.before, c.rel)) || Buffer.alloc(0));
        }
      }
    return { available: true, files: diffs.map((c) => relOf(c.abs)) };
  }
  // No git: undo each turn's own edits, newest first.
  if (snaps.some((s) => !s || !s.result)) return { available: false, files: [] };
  const files = new Set();
  for (const s of [...snaps].reverse()) {
    const paths = [...s.result.keys()].filter((p) => allowed(p));
    paths.forEach((p) => files.add(relOf(p)));
    if (apply) await s.undo(paths);
  }
  return { available: true, files: [...files] };
}

function denyPending(chat, message) {
  for (const resolve of chat.approvals.values()) resolve({ behavior: 'deny', message });
  chat.approvals.clear();
}

async function openChat(chatId, { sessionId, resumeAt, model, effort, mode, cwd }) {
  const bin = await cli.findClaude(settings.claudePath);
  if (!bin) throw new Error('Claude Code is not installed. Open Settings → Setup to install it.');
  const chat = { session: null, effort: effort || '', turn: null, approvals: new Map(), cwd: chatCwd(cwd) };
  chat.session = new ChatSession({
    bin,
    cwd: chat.cwd,
    sessionId,
    resumeAt,
    model,
    effort,
    mode,
    onEvent: (ev) => {
      trackStream(chat.turn, ev);
      send('chat-event', { chatId, ev });
      if (ev.type === 'result') finishTurn(chatId, chat);
    },
    onPermission: (req) =>
      new Promise((resolve) => {
        if (EDIT_TOOLS.has(req.toolName)) touchForSnapshot(chat.turn, editTarget(req.input));
        const reqId = crypto.randomUUID();
        chat.approvals.set(reqId, resolve);
        send('approval-request', { chatId, reqId, toolName: req.toolName, input: req.input, description: req.description });
      }),
    onExit: async ({ code, stderr }) => {
      denyPending(chat, 'Claude Code stopped.');
      if (chats.get(chatId) === chat) chats.delete(chatId);
      if (chat.turn) await finishTurn(chatId, chat);
      if (!chat.closing) send('chat-exit', { chatId, code, stderr });
    },
  });
  await chat.session.start();
  chats.set(chatId, chat);
  return chat;
}

async function chatSend(chatId, { content, mode, model, effort, sessionId, resumeAt, cwd }) {
  if (!workspace) throw new Error('Open a folder first.');
  let chat = chats.get(chatId);
  if (chat && chat.session.alive && (resumeAt || (effort || '') !== chat.effort)) {
    // Effort is fixed per process: restart it on the same conversation.
    if (!resumeAt) sessionId = chat.session.sessionId || sessionId;
    chat.closing = true;
    chat.session.dispose();
    chats.delete(chatId);
    chat = null;
  }
  if (!chat || !chat.session.alive) chat = await openChat(chatId, { sessionId, resumeAt, model, effort, mode, cwd });
  else await chat.session.setModel(model);
  chat.turn = { id: crypto.randomUUID(), snap: await new TurnSnapshot(chat.cwd).begin(), blocks: new Map() };
  await chat.session.send(content, mode);
  return { turnId: chat.turn.id };
}

async function chatInterrupt(chatId) {
  const chat = chats.get(chatId);
  if (!chat) return;
  denyPending(chat, 'The user stopped this turn.');
  const r = await chat.session.interrupt();
  // If the CLI doesn't acknowledge, stop the process; the conversation can be resumed.
  if (r.error && chat.session.alive) chat.session.dispose();
}

function chatClose(chatId) {
  const chat = chats.get(chatId);
  if (!chat) return;
  chat.closing = true;
  denyPending(chat, 'Chat closed.');
  chat.session.dispose();
  chats.delete(chatId);
}

function answerApproval(chatId, reqId, decision) {
  const chat = chats.get(chatId);
  const resolve = chat && chat.approvals.get(reqId);
  if (!resolve) return;
  chat.approvals.delete(reqId);
  resolve(decision);
}

// ---------- IPC ----------

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function registerIpc() {
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:set', (_e, patch) => {
    settings = { ...settings, ...patch };
    saveSettings();
    if (patch.theme) nativeTheme.themeSource = patch.theme;
    return settings;
  });
  ipcMain.handle('cli:status', () => cli.cliStatus(settings.claudePath));

  // First-run setup: install the CLI and sign in.
  ipcMain.handle('setup:install', () => cli.installClaude((text) => send('setup-log', text)));
  ipcMain.handle('setup:login', async () => {
    const bin = await cli.findClaude(settings.claudePath);
    if (!bin) throw new Error('Install Claude Code first.');
    if (loginHandle) loginHandle.cancel();
    loginHandle = await cli.startLogin(bin, {
      onLog: (text) => send('setup-log', text),
      onUrl: (url) => send('setup-login-url', url),
      onExit: (r) => {
        loginHandle = null;
        send('setup-login-exit', r);
      },
    });
    return true;
  });
  ipcMain.handle('setup:login-code', (_e, code) => loginHandle && loginHandle.sendCode(code));
  ipcMain.handle('setup:login-cancel', () => loginHandle && loginHandle.cancel());
  // Menus drawn in the app's own title bar (Windows and Linux).
  ipcMain.handle('menu:labels', () => (Menu.getApplicationMenu()?.items || []).map((i) => i.label.replace(/&/g, '')));
  ipcMain.handle('menu:popup', (_e, index, x, y) => {
    const item = Menu.getApplicationMenu()?.items[index];
    if (!item || !item.submenu) return;
    return new Promise((resolve) => item.submenu.popup({ window: win, x: Math.round(x), y: Math.round(y), callback: resolve }));
  });
  ipcMain.handle('window:titlebar-colors', (_e, color, symbolColor) => {
    if (win && process.platform !== 'darwin' && win.setTitleBarOverlay) win.setTitleBarOverlay({ color, symbolColor, height: 38 });
  });
  ipcMain.handle('update:install', () => updater.installNow());
  // Preview pane: screenshots for the chat, and "open in your browser".
  ipcMain.handle('preview:capture', async (_e, id, rect) => {
    const wc = require('electron').webContents.fromId(id);
    if (!wc || wc.getType() !== 'webview') return null;
    const img = await (rect ? wc.capturePage(rect) : wc.capturePage());
    let out = img;
    if (out.getSize().width > 1600) out = out.resize({ width: 1600 });
    return out.isEmpty() ? null : out.toPNG().toString('base64');
  });
  ipcMain.handle('preview:open-external', (_e, url) => /^https?:\/\//.test(url) && shell.openExternal(url));
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('open-external', (_e, url) => {
    if (/^https:\/\/([a-z0-9-]+\.)*(claude\.ai|claude\.com|anthropic\.com|git-scm\.com)\//i.test(url)) shell.openExternal(url);
  });

  ipcMain.handle('folder:pick', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return openFolder(r.filePaths[0]);
  });
  ipcMain.handle('folder:open', (_e, dir) => (fs.existsSync(dir) ? openFolder(dir) : null));
  ipcMain.handle('folder:current', () => (workspace ? { root: workspace, name: path.basename(workspace) } : null));
  ipcMain.handle('files:list', () => listFiles());
  ipcMain.handle('files:search', async (_e, query, opts) => (workspace ? search.search(workspace, await listFiles(), query, opts) : { results: [] }));
  ipcMain.handle('file:read', async (_e, rel) => {
    const abs = resolveInWorkspace(rel);
    const st = await fsp.stat(abs);
    if (st.size > 10 * 1024 * 1024) return { tooLarge: true };
    const buf = await fsp.readFile(abs);
    if (buf.subarray(0, 8000).includes(0)) return { binary: true };
    return { content: buf.toString('utf8') };
  });
  ipcMain.handle('file:write', async (_e, rel, content) => {
    const abs = resolveInWorkspace(rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, 'utf8');
    return true;
  });
  ipcMain.handle('file:reveal', (_e, rel) => shell.showItemInFolder(resolveInWorkspace(rel)));

  ipcMain.handle('sessions:list', () => listSessions());
  ipcMain.handle('sessions:load', (_e, id, cwd) => loadSession(id, cwd));
  // Parallel agents: chats working in their own copy of the project.
  const ownCopy = (wt) => {
    if (!worktrees.exists(wt)) throw new Error('This copy no longer exists.');
    return wt;
  };
  ipcMain.handle('worktree:create', (_e, name) => worktrees.create(workspace, name));
  ipcMain.handle('worktree:changes', (_e, wt) => worktrees.changes(ownCopy(wt)));
  ipcMain.handle('worktree:diff', (_e, wt, rel) => worktrees.fileDiff(ownCopy(wt), rel));
  ipcMain.handle('worktree:merge', (_e, wt) => worktrees.merge(ownCopy(wt), workspace));
  ipcMain.handle('worktree:remove', (_e, wt) => (worktrees.exists(wt) ? worktrees.remove(wt) : true));
  ipcMain.handle('worktree:exists', (_e, wt) => worktrees.exists(wt));

  ipcMain.handle('chat:send', (_e, chatId, opts) => chatSend(chatId, opts));
  ipcMain.handle('chat:interrupt', (_e, chatId) => chatInterrupt(chatId));
  ipcMain.handle('chat:close', (_e, chatId) => chatClose(chatId));
  ipcMain.handle('chat:set-mode', (_e, chatId, mode) => chats.get(chatId)?.session.setMode(mode));
  ipcMain.handle('approval:answer', (_e, chatId, reqId, decision) => answerApproval(chatId, reqId, decision));
  ipcMain.handle('rewind:files', (_e, turnIds) => rewindFiles(turnIds, false));
  ipcMain.handle('rewind:apply', (_e, turnIds) => rewindFiles(turnIds, true));
  ipcMain.handle('changes:undo', async (_e, turnId, absPaths) => {
    const snap = turnSnapshots.get(turnId);
    if (!snap) return false;
    await snap.undo(absPaths.filter((p) => inWorkspace(p) || worktrees.isUnder(p)));
    return true;
  });

  // Source control
  ipcMain.handle('git:status', () => (workspace ? gitops.status(workspace) : { repo: false }));
  ipcMain.handle('git:head', (_e, rel) => gitops.headContent(workspace, rel));
  ipcMain.handle('git:commit', (_e, message) => gitops.commitAll(workspace, message));
  ipcMain.handle('git:checkout', (_e, branch, create) => gitops.checkout(workspace, branch, create));
  ipcMain.handle('git:sync', (_e, action) => gitops.sync(workspace, action));
  ipcMain.handle('git:discard', async (_e, rel, wasUntracked) => {
    const abs = resolveInWorkspace(rel);
    if (wasUntracked) {
      await git(workspace, ['rm', '--cached', '--ignore-unmatch', '-q', '--', rel]).catch(() => {});
      await fsp.rm(abs, { force: true });
    }
    else await git(workspace, ['checkout', 'HEAD', '--', rel]);
  });
  ipcMain.handle('git:init', () => git(workspace, ['init']));
  ipcMain.handle('git:suggest', async () => gitops.suggestMessage(workspace, await cli.findClaude(settings.claudePath)));

  // Terminal
  ipcMain.handle('term:create', (_e, id, cols, rows) =>
    terminal.create(id, workspace, cols, rows, { onData: (d) => send('term-data', { id, data: d }), onExit: (code) => send('term-exit', { id, code }) })
  );
  ipcMain.handle('term:write', (_e, id, data) => terminal.write(id, data));
  ipcMain.handle('term:resize', (_e, id, cols, rows) => terminal.resize(id, cols, rows));
  ipcMain.handle('term:kill', (_e, id) => terminal.kill(id));

  // Settings page
  ipcMain.handle('cfg:memory', () => config.memoryFiles(workspace));
  ipcMain.handle('cfg:save-memory', (_e, id, content) => config.saveMemory(workspace, id, content));
  ipcMain.handle('cfg:permissions', () => config.permissions(workspace));
  ipcMain.handle('cfg:rule', (_e, scope, rule, add) => config.editRule(workspace, scope, rule, add));
  ipcMain.handle('cfg:mcp-list', async () => config.mcpList(await cli.findClaude(settings.claudePath), workspace || os.homedir()));
  ipcMain.handle('cfg:mcp-remove', async (_e, name) => config.mcpRemove(await cli.findClaude(settings.claudePath), workspace || os.homedir(), name));
  ipcMain.handle('cfg:mcp-add', async (_e, spec) => config.mcpAdd(await cli.findClaude(settings.claudePath), workspace || os.homedir(), spec));
}

// ---------- app ----------

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    title: 'Claude Desk',
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
  win.loadURL('app://desk/renderer/index.html');
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
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: () => send('menu', 'open-folder') },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('menu', 'save') },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => send('menu', 'close-tab') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Quick Open File', accelerator: 'CmdOrCtrl+P', click: () => send('menu', 'quick-open') },
        { label: 'Search in Files', accelerator: 'CmdOrCtrl+Shift+F', click: () => send('menu', 'search') },
        { label: 'New Chat', accelerator: 'CmdOrCtrl+N', click: () => send('menu', 'new-chat') },
        { label: 'New Chat in Its Own Copy', accelerator: 'CmdOrCtrl+Shift+N', click: () => send('menu', 'new-copy-chat') },
        { label: 'Add Selection to Chat', accelerator: 'CmdOrCtrl+L', click: () => send('menu', 'add-selection') },
        { label: 'Edit Selection with Claude', accelerator: 'CmdOrCtrl+K', click: () => send('menu', 'inline-edit') },
        { label: 'Cycle Mode', accelerator: 'CmdOrCtrl+.', click: () => send('menu', 'cycle-mode') },
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: () => send('menu', 'toggle-sidebar') },
        { label: 'Toggle Terminal', accelerator: 'CmdOrCtrl+`', click: () => send('menu', 'toggle-terminal') },
        { label: 'Source Control', accelerator: 'CmdOrCtrl+Shift+G', click: () => send('menu', 'source-control') },
        { label: 'Preview', accelerator: 'CmdOrCtrl+Shift+V', click: () => send('menu', 'preview') },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => send('menu', 'settings') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
    { role: 'windowMenu' },
    {
      label: 'Help',
      submenu: [
        { label: `Claude Desk ${app.getVersion()}`, enabled: false },
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
  updater.start((status) => send('update-status', status));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  for (const id of [...chats.keys()]) chatClose(id);
  terminal.killAll();
  if (process.platform !== 'darwin') app.quit();
});
