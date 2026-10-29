const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, Menu, nativeTheme, screen, safeStorage, powerSaveBlocker } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { execFile } = require('child_process');
const cli = require('./claude-cli');
const jupyter = require('./jupyter');
const remote = require('./remote');
const { ChatSession } = require('./session');
const { TurnSnapshot, MultiSnapshot, git, writeTree, diffTrees, blob, isGitRepo, gitRoot } = require('./snapshots');
const gitops = require('./gitops');
const terminal = require('./terminal');
const config = require('./config');
const updater = require('./updater');
const search = require('./search');
const worktrees = require('./worktrees');
const linear = require('./linear');
const github = require('./github');
const accounts = require('./accounts');
const debuglog = require('./debuglog');
const report = require('./report');
const previewBridge = require('./preview-bridge');
const handoff = require('./handoff');
const mcpConnect = require('./mcp-connect');
const { createGateway, known: knownMcp } = require('./mcp-gateway');
const phone = require('./phone');
const tests = require('./tests');
const usage = require('./usage');
const codebase = require('./codebase');
const debug = require('./debugger');
const isWin = process.platform === 'win32';
const webpage = require('./webpage');
const { extract } = require('./extract');
const { listCommands } = require('./commands');
const permissions = require('./permissions');
const autocomplete = require('./autocomplete');
const { LangServers, fileOf: fileOfUri } = require('./langservers');
const agents = require('./agents');
const { CodexSession, codexStatus, codexModels, codexSessions, codexHistory } = require('./codex-session');
const { AcpSession, acpStatus, acpSessions, acpHistory } = require('./acp-session');
const { stripAppNotes } = require('./agent-events');

const APP_ROOT = path.join(__dirname, '..');
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'out', '.venv', 'venv', '__pycache__', '.cache', '.turbo', 'target', '.idea', 'coverage']);
// Folders that tools rewrite all the time (build caches, game engines' generated files): changes in
// them don't refresh anything, so a dev server or an engine running doesn't keep Switchdesk busy.
const UNWATCHED_DIRS = new Set([...IGNORED_DIRS, '.svelte-kit', '.nuxt', '.output', '.expo', '.gradle', '.parcel-cache', '.vercel', '.angular', '.vite', '.yarn', '.pnpm-store', 'Pods', '.terraform', '.mypy_cache', '.pytest_cache', '.tox', '.godot', '.import', 'Intermediate', 'DerivedDataCache', 'Saved', 'Binaries', 'Library', 'Temp', 'obj']);

let loginHandle = null;
let loginCtx = null; // the window that started the Claude sign-in
let quitting = false;
let lastUpdate = null; // the updater's latest news, for windows opened later

// The app used to be called Claude Desk. Keep using that data folder if it exists, so settings,
// extra accounts and parallel-agent copies carry over.
const legacyData = path.join(app.getPath('appData'), 'Claude Desk');
if (fs.existsSync(legacyData)) app.setPath('userData', legacyData);
// The app's own tests run with a fresh data folder.
if (process.env.SWITCHDESK_USER_DATA) app.setPath('userData', process.env.SWITCHDESK_USER_DATA);
// One Switchdesk at a time: opening it again opens a new window in the one that's running, so every
// window shares settings, usage and your phone's view.
const firstInstance = app.requestSingleInstanceLock();
if (!firstInstance) app.exit(0);
app.on('second-instance', () => app.isReady() && newWindow(null));

// ---------- settings ----------

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { recentFolders: [], claudePath: '', model: '', effort: '', mode: 'agent', theme: 'system', accounts: [], accountRules: {}, defaultAccount: accounts.MAIN };

function loadSettings() {
  try {
    settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {
    /* first run */
  }
  // Older versions saved lines of code (from here-documents) and bare "rm" as allowed commands.
  const allow = settings.permissions && settings.permissions.allow;
  if (Array.isArray(allow) && !settings.permissions.cleaned) {
    settings.permissions = { ...settings.permissions, allow: allow.filter((r) => !permissions.junkRule(r)), cleaned: 1 };
    try {
      saveSettings();
    } catch {
      /* read-only for now */
    }
  }
}
// Settings are saved a moment after they change, in the background: they hold every folder's
// tabs and chats, so saving on every change kept the disk and CPU busy. Quitting saves at once.
let settingsTimer = null;
let settingsWriting = Promise.resolve();
function saveSettings() {
  if (settingsTimer) return;
  settingsTimer = setTimeout(() => {
    settingsTimer = null;
    const text = JSON.stringify(settings, null, 2);
    const tmp = `${settingsFile()}.tmp`;
    settingsWriting = settingsWriting
      .then(() => fs.promises.mkdir(path.dirname(settingsFile()), { recursive: true }))
      .then(() => fs.promises.writeFile(tmp, text))
      .then(() => fs.promises.rename(tmp, settingsFile()))
      .catch(() => fs.promises.writeFile(settingsFile(), text).catch(() => {}));
  }, 1000);
}
function saveSettingsNow() {
  clearTimeout(settingsTimer);
  settingsTimer = null;
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

// ---------- long run checks ----------

// Runs a command through the shell in `cwd`, stopping it (and what it started) at the time limit.
function runCheck(cwd, command, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const win = process.platform === 'win32';
    let out = '';
    let timedOut = false;
    const child = require('child_process').spawn(command, { cwd, shell: true, windowsHide: true, detached: !win, env: { ...process.env, CI: process.env.CI || '1' } });
    const keep = (b) => (out = (out + b.toString('utf8')).slice(-8000));
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (win) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    const done = (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? null : code, ok: !timedOut && code === 0, timedOut, output: out.trim(), ms: Date.now() - started });
    };
    child.on('error', (err) => ((out += `\n${err.message}`), done(127)));
    child.on('close', (code) => done(code));
  });
}

// ---------- windows ----------
//
// Each window has its own workspace: a main folder, plus any extra folders added to it. Files in an
// extra folder show up in the app as "⟦name⟧/path", and agents get the folders' absolute paths.

const codeIndexes = new Set();
let langServers = null; // set once IPC is wired; stopped on quit
const contexts = new Map(); // webContents id -> { id, win, workspace, extra, watchers, start }
const NO_WINDOW = { id: 0, win: null, workspace: null, extra: [], watchers: [] };
const ctxOf = (e) => contexts.get(e.sender.id) || NO_WINDOW;
const ctxOfWindow = (bw) => (bw && contexts.get(bw.webContents.id)) || null;

// A Preview tool call from an agent, answered by the window's renderer (preview.js).
const previewCalls = new Map(); // id -> resolve
function previewTool(ctx, name, args, agent) {
  if (name === 'connect_mcp_server') return agent && agent !== 'claude' ? connectGateway(ctx, args) : connectMcp(ctx, args);
  if (name === 'gateway_tools') return gateway().tools().then((tools) => ({ tools }));
  if (name === 'gateway_call')
    return gateway()
      .call(args.tool, args.arguments)
      .then((mcp) => ({ mcp }), (err) => ({ mcp: { content: [{ type: 'text', text: String(err.message || err) }], isError: true } }));
  if (!ctx.win || ctx.win.isDestroyed()) return Promise.resolve({ error: 'The Switchdesk window was closed.' });
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => previewCalls.delete(id) && resolve({ error: 'The Preview took too long to answer.' }), 90000);
    previewCalls.set(id, (r) => (clearTimeout(timer), resolve(r)));
    sendTo(ctx, 'preview-tool', { id, name, args });
  });
}

// ---------- checking in from your phone (phone.js)
// The page on your phone asks the windows: each answers for its own chats (phone-request in
// phone-link.js). A chat's id on the phone is "<window>:<chat>".
let phoneServer = null;
let phoneError = '';
const phoneCalls = new Map(); // id -> resolve
function askWindow(ctx, what, args) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => phoneCalls.delete(id) && reject(new Error('Switchdesk took too long to answer.')), 15000);
    phoneCalls.set(id, (r) => (clearTimeout(timer), resolve(r || {})));
    sendTo(ctx, 'phone-request', { id, what, args });
  });
}
const liveWindows = () => [...contexts.values()].filter((c) => c.win && !c.win.isDestroyed());
async function phoneAsk(what, args = {}) {
  const wins = liveWindows();
  if (!wins.length) return { error: 'No Switchdesk window is open on your computer.' };
  if (what === 'state') {
    const parts = await Promise.all(wins.map((c) => askWindow(c, 'state').then((r) => ({ c, r }), () => null)));
    const chats = parts.flatMap((x) => (x && x.r && x.r.chats ? x.r.chats.map((ch) => ({ ...ch, id: `${x.c.id}:${ch.id}`, workspace: String(x.c.id) })) : []));
    const rank = (ch) => (ch.waiting ? 0 : ch.busy ? 1 : 2);
    chats.sort((a, b) => rank(a) - rank(b));
    // Every window, chats or not, so the phone can start a chat in any of them.
    const workspaces = parts.filter((x) => x && x.r && !x.r.error).map((x) => ({ id: String(x.c.id), name: x.r.folder || 'No folder', waiting: chats.some((ch) => ch.workspace === String(x.c.id) && ch.waiting) }));
    return { computer: os.hostname().replace(/\.local$/, ''), workspaces, chats };
  }
  if (what === 'new') {
    const focused = wins.find((c) => String(c.id) === String(args.workspace)) || ctxOfWindow(BrowserWindow.getFocusedWindow()) || wins[0];
    const r = await askWindow(focused, 'new', args);
    return r.chat ? { chat: `${focused.id}:${r.chat}` } : r;
  }
  const at = String(args.chat).indexOf(':');
  const ctx = wins.find((c) => String(c.id) === String(args.chat).slice(0, at));
  if (!ctx) return { error: 'That chat was closed.' };
  return askWindow(ctx, what, { ...args, chat: String(args.chat).slice(at + 1) });
}
// ---------- other apps handing work over (handoff.js, handoff-mcp.js)
// Claude Desktop, Cursor or any app with Switchdesk in its MCP settings can start a chat in a
// folder, check on it, follow up and stop it. The chat's id is "<window>:<chat>", as for the phone.
async function handoffAsk(name, args, from) {
  const wins = liveWindows();
  if (name === 'folders') return { open: wins.filter((c) => c.workspace && !c.remote).map((c) => c.workspace), recent: (settings.recentFolders || []).filter((f) => !remote.parseUrl(f) && fs.existsSync(f)) };
  if (name === 'chats') {
    const parts = await Promise.all(wins.map((c) => askWindow(c, 'state').then((r) => ({ c, r }), () => null)));
    const want = args.folder && path.resolve(String(args.folder));
    const list = parts
      .filter((x) => x && x.r && x.r.chats && (!want || (x.c.workspace && !x.c.remote && path.resolve(x.c.workspace) === want)))
      .flatMap((x) => x.r.chats.map((ch) => ({ chat: `${x.c.id}:${ch.id}`, title: ch.title, agent: ch.agent, folder: x.c.workspace, working: ch.busy, waiting_for_user: ch.waiting, last: ch.last })));
    return { chats: list };
  }
  if (name === 'start') {
    const dir = path.resolve(String(args.folder || ''));
    if (!args.folder || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { error: `There's no folder at ${args.folder || '(no folder given)'}. switchdesk_folders lists the ones Switchdesk knows.` };
    let ctx = windowWith(dir);
    if (!ctx) {
      // A window of its own for the folder, ready once its page has opened it.
      ctx = createWindow(dir);
      for (let i = 0; i < 60 && !(ctx.workspace && path.resolve(ctx.workspace) === dir); i++) await new Promise((r) => setTimeout(r, 500));
      if (!ctx.workspace) return { error: "Switchdesk opened a window for the folder but it didn't finish opening. Try again." };
      await new Promise((r) => setTimeout(r, 1500));
    }
    const r = await askWindow(ctx, 'start', { ...args, from });
    return r.chat ? { ...r, chat: `${ctx.id}:${r.chat}`, next: 'Use switchdesk_read with wait_seconds to wait for its result.' } : r;
  }
  const id = String(args.chat || '');
  const at = id.indexOf(':');
  const ctx = wins.find((c) => String(c.id) === id.slice(0, at));
  if (!ctx || !['read', 'send', 'stop'].includes(name)) return { error: ctx ? `Not something Switchdesk knows: ${name}` : "That chat is closed, or the id isn't right. switchdesk_chats lists them." };
  const a = { ...args, chat: id.slice(at + 1) };
  if (name === 'send') a.text = String(args.message || '');
  if (name !== 'read') return askWindow(ctx, name, a);
  const until = Date.now() + Math.min(Math.max(Number(args.wait_seconds) || 0, 0), 50) * 1000;
  for (;;) {
    const r = await askWindow(ctx, 'read', a);
    if (r.error || !r.working || r.waiting_for_user || Date.now() >= until) return r;
    await new Promise((res) => setTimeout(res, 1500));
  }
}
const handoffSpec = () => handoff.serverSpec({ execPath: process.execPath, appRoot: APP_ROOT, packaged: app.isPackaged, dataDir: app.getPath('userData') });

async function startPhone() {
  if (phoneServer) return;
  const p = (settings.phone = { ...(settings.phone || {}) });
  if (!p.token) p.token = crypto.randomBytes(24).toString('base64url');
  // Tailscale only: listen on this computer's Tailscale address alone, so no other network sees it.
  const tailscale = phone.addresses().find((a) => a.tailscale);
  if (p.tailscaleOnly && !tailscale && !process.env.SWITCHDESK_PHONE_HOST) throw new Error("Tailscale isn't running on this computer. Start it, or turn off Tailscale only.");
  const host = process.env.SWITCHDESK_PHONE_HOST || (p.tailscaleOnly ? tailscale.address : '0.0.0.0');
  const tryPort = (port) => phone.createPhoneServer({ ask: phoneAsk, token: p.token, port, host });
  phoneServer = await tryPort(p.port || 47821).catch(() => tryPort(0));
  p.port = phoneServer.port;
  saveSettings();
}
async function stopPhone() {
  const s = phoneServer;
  phoneServer = null;
  if (s) await s.close();
}
async function phoneStatus() {
  const p = settings.phone || {};
  if (!phoneServer) return { on: false, error: phoneError, tailscaleOnly: !!p.tailscaleOnly, tailscale: phone.addresses().some((a) => a.tailscale) };
  const host = process.env.SWITCHDESK_PHONE_HOST;
  const urls = (host ? [{ address: host, tailscale: false }] : phone.addresses().filter((a) => a.tailscale || !p.tailscaleOnly)).map((a) => ({ url: `http://${a.address}:${phoneServer.port}/?t=${p.token}`, tailscale: a.tailscale }));
  const qr = urls.length ? await require('qrcode').toDataURL(urls[0].url, { margin: 1, width: 240 }) : null;
  return { on: true, port: phoneServer.port, urls, qr, tailscaleOnly: !!p.tailscaleOnly, tailscale: phone.addresses().some((a) => a.tailscale) };
}

// Signs the user in to an MCP server (adding it first when there's a URL and it isn't set up yet),
// for the agent's connect_mcp_server tool and Settings → MCP servers. The browser does the sign-in.
// Open Claude chats then reconnect to it, or pick it up with their next message.
// Switchdesk's own MCP connections, for the agents that aren't Claude Code. Sign-ins are sealed
// with the system's keychain, like API keys.
let mcpGateway = null;
function gateway() {
  if (!mcpGateway) {
    const enc = () => safeStorage.isEncryptionAvailable();
    mcpGateway = createGateway({
      file: path.join(app.getPath('userData'), 'mcp-servers.json'),
      seal: (s) => (enc() ? 'enc:' + safeStorage.encryptString(s).toString('base64') : s),
      unseal: (s) => (s.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(s.slice(4), 'base64')) : s),
    });
  }
  return mcpGateway;
}

// The connect_mcp_server tool for the other agents: adds the service (from its address, or one
// Switchdesk knows) and signs in in the browser. Their chats load its tools with the next message.
// Some agents give up on a tool call after a minute, so a sign-in still open by then carries on
// in the background.
const GATEWAY_WAIT = Number(process.env.SWITCHDESK_MCP_GATEWAY_WAIT_MS) || 50000;
async function connectGateway(ctx, { name, url } = {}) {
  name = String(name || '').trim();
  if (!name) return { error: 'Say which service to connect, by name.' };
  const gw = gateway();
  let server = gw.find(name);
  if (!server || url) {
    const k = knownMcp(name);
    const address = String(url || (k && k.url) || '').trim();
    if (!address)
      return {
        error: `Switchdesk doesn't know the MCP address for ${name}. If its provider has an official remote MCP server, call this again with its url. If ${name} is a claude.ai connector (such as Gmail, Google Drive or Google Sheets), it only works in Claude chats: the user can switch this chat to Claude in the agent menu under the chat box, then ask again.`,
      };
    if (!/^https:\/\//.test(address) && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(address)) return { error: 'The address must start with https://.' };
    server = gw.add(server ? server.name : k && !url ? k.name : name, address);
  }
  let opened = false;
  const openUrl = (u) => {
    if (!/^https?:\/\//.test(u)) return;
    opened = true;
    sendTo(ctx, 'mcp-signing-in', { name: server.name });
    shell.openExternal(u);
  };
  const run = gw.signIn(server.name, openUrl);
  run.then(
    () => {
      for (const c of chats.values()) if (c.ctx === ctx && c.agent !== 'claude' && c.session.alive) c.mcpStale = true;
      if (opened) sendTo(ctx, 'mcp-signed-in', { name: server.name, ok: true });
    },
    () => opened && sendTo(ctx, 'mcp-signed-in', { name: server.name, ok: false })
  );
  const r = await Promise.race([run.then((entry) => ({ entry }), (err) => ({ err })), new Promise((res) => setTimeout(() => res({ waiting: true }), GATEWAY_WAIT))]);
  if (r.err) return { error: `Couldn't connect to ${server.name}: ${r.err.message}` };
  if (r.waiting) return { text: `The sign-in page for ${server.name} is open in the user's browser. Tell them to finish signing in there; its tools load with their next message once they have.` };
  const tools = r.entry.tools.map((t) => t.name);
  return { text: `Connected to ${server.name}.${tools.length ? ` Its tools: ${tools.join(', ')}.` : ''} They load when the user sends their next message, so tell them it's ready and ask them to say go.` };
}

const CONNECTORS_URL = 'https://claude.ai/customize/connectors';
const MCP_WAIT = Number(process.env.SWITCHDESK_MCP_WAIT_MS) || 240000;
const MCP_POLL = Number(process.env.SWITCHDESK_MCP_POLL_MS) || 4000;
async function connectMcp(ctx, { name, url } = {}) {
  name = String(name || '').trim();
  if (!name) return { error: 'Say which MCP server to connect, by name.' };
  if (ctx.remote) return { error: "MCP servers can't be connected from an SSH folder yet." };
  const bin = await cli.findClaude(settings.claudePath);
  if (!bin) return { error: "Claude Code isn't installed." };
  const acct = folderAcct(ctx);
  const cwd = ctx.workspace || os.homedir();
  const { servers: listed } = await config.mcpList(bin, cwd, acct);
  if (url) {
    if (!mcpConnect.findServer(listed, name)) {
      const r = await config.mcpAdd(bin, cwd, { name, target: url, transport: /\/sse\/?$/.test(url) ? 'sse' : 'http', scope: 'user' }, acct);
      if (!r.ok) return { error: `Couldn't add ${name}: ${r.out.trim().split('\n').pop()}` };
    }
  }
  let opened = false;
  const openUrl = (u, server) => {
    if (!/^https?:\/\//.test(u)) return;
    opened = true;
    sendTo(ctx, 'mcp-signing-in', { name: server });
    shell.openExternal(u);
  };
  // This window's Claude chats, the one at work (the one asking) first.
  const open = [...chats.values()].filter((c) => c.ctx === ctx && c.agent === 'claude' && c.session.alive && c.session.control).sort((a, b) => !!b.turn - !!a.turn);
  let r = await mcpConnect.connect({ bin, cwd, env: acct.env, name, openUrl, sessions: open.map((c) => c.session) });
  let known = r.missing && mcpConnect.findServer(listed, name);
  // Not set up anywhere: claude.ai's connector directory, in the browser, where most services are
  // a click and a sign-in away. Connectors added there show up in Claude Code by themselves.
  const added = r.missing && !known && !url;
  if (added) {
    sendTo(ctx, 'mcp-finding', { name });
    shell.openExternal(CONNECTORS_URL);
    for (const until = Date.now() + MCP_WAIT; !known && Date.now() < until; ) {
      await new Promise((res) => setTimeout(res, MCP_POLL));
      known = mcpConnect.findServer((await config.mcpList(bin, cwd, acct)).servers, name);
    }
    if (!known) return { error: `${name} wasn't added at ${CONNECTORS_URL} (opened in the user's browser) in time. If claude.ai has no connector for it, call this again with the service's official MCP address as url, if it has one.` };
  }
  // Connected already (a connector turned on after these chats started, say): nothing to sign in to.
  if (known && /connected$/i.test(known.detail.trim())) r = { ok: true, name: known.name, tools: [], already: !added };
  else if (known) {
    sendTo(ctx, 'mcp-signing-in', { name: known.name });
    opened = true;
    r = await mcpConnect.loginInTerminal({ bin, cwd, env: await cli.childEnv(acct.env), name: known.name });
  }
  if (opened) sendTo(ctx, 'mcp-signed-in', { name: r.name || name, ok: r.ok });
  if (!r.ok) {
    const list = (r.servers && r.servers.length ? r.servers : listed.map((s) => ({ name: s.name, status: s.detail.split(' - ').pop() }))).map((s) => `${s.name} (${s.status})`).join(', ');
    return { error: `${r.error}${list ? ` The servers set up are: ${list}.` : ' No MCP servers are set up.'}${url ? '' : " To add a new one, call this again with its URL."}` };
  }
  let later = false;
  for (const chat of chats.values()) {
    if (chat.ctx !== ctx || chat.agent !== 'claude' || !chat.session.alive) continue;
    await chat.session.control({ subtype: 'mcp_reconnect', serverName: r.name });
    const st = await chat.session.control({ subtype: 'mcp_status' });
    const here = st.ok && ((st.response && st.response.mcpServers) || []).find((x) => x.name === r.name);
    if (!here || here.status !== 'connected') (chat.mcpStale = true), (later = true);
  }
  const tools = r.tools.length ? ` Its tools: ${r.tools.join(', ')}.` : '';
  return {
    text: `${r.already ? `${r.name} was already connected.` : `Connected to ${r.name}.`}${tools}${later ? " This chat loads its tools when the user sends their next message, so tell them it's ready and ask them to say go." : ''}`,
  };
}

function sendTo(ctx, channel, payload) {
  if (ctx && ctx.win && !ctx.win.isDestroyed()) ctx.win.webContents.send(channel, payload);
}
function broadcast(channel, payload, except) {
  for (const c of contexts.values()) if (c !== except) sendTo(c, channel, payload);
}

// Paths in an SSH folder are the host's (POSIX), whatever this machine uses.
const P = (ctx) => (ctx && ctx.remote ? path.posix : path);
// The folder's identity for settings, recent folders and windows: its path, or ssh://host/path.
const folderKey = (ctx) => (ctx.remote ? remote.urlOf(ctx.remote.spec, ctx.workspace) : ctx.workspace);

// The folders open in a window, the main one first. key prefixes an extra folder's paths.
function roots(ctx) {
  if (!ctx.workspace) return [];
  const out = [{ key: '', dir: ctx.workspace, name: P(ctx).basename(ctx.workspace) || ctx.workspace }];
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

const within = (dir, abs, p = path) => {
  const rel = p.relative(dir, abs);
  return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
};

function rootOf(ctx, abs) {
  const p = P(ctx);
  abs = p.resolve(abs);
  let best = null;
  for (const r of roots(ctx)) if (within(r.dir, abs, p) && (!best || r.dir.length > best.dir.length)) best = r;
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
    abs = P(ctx).join(r.dir, m[2] || '');
  } else abs = P(ctx).isAbsolute(p) ? p : P(ctx).join(ctx.workspace || '', p);
  if (!inWorkspace(ctx, abs)) throw new Error('Path is outside the open folders: ' + p);
  return abs;
}

// The path the app shows for a file: relative to its folder, with the folder's key for extra folders.
function relOf(ctx, abs) {
  const r = rootOf(ctx, abs);
  if (!r) return null;
  const rel = P(ctx).relative(r.dir, abs).split(P(ctx).sep).join('/');
  return r.key ? (rel ? `${r.key}/${rel}` : r.key) : rel;
}

function folderInfo(ctx) {
  if (!ctx.workspace) return null;
  const info = { root: ctx.workspace, name: P(ctx).basename(ctx.workspace) || ctx.workspace, extra: roots(ctx).slice(1).map((r) => ({ key: r.key, dir: r.dir, name: r.name })) };
  return ctx.remote ? { ...info, key: folderKey(ctx), remote: ctx.remote.spec, name: `${info.name} [${ctx.remote.spec}]` } : info;
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
  if (ctx.remote) return (await ctx.remote.call('list', { root: ctx.workspace })).sort();
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
          if (rel.split('/').some((seg) => UNWATCHED_DIRS.has(seg))) return;
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
  if (remote.parseUrl(dir)) {
    for (const c of contexts.values()) if (c !== except && c.workspace && folderKey(c) === dir && c.win && !c.win.isDestroyed()) return c;
    return null;
  }
  for (const c of contexts.values()) if (c !== except && c.workspace && !c.remote && path.resolve(c.workspace) === path.resolve(dir) && c.win && !c.win.isDestroyed()) return c;
  return null;
}

function focusWindow(ctx) {
  if (ctx.win.isMinimized()) ctx.win.restore();
  ctx.win.focus();
}

function setTitle(ctx) {
  if (!ctx.win || ctx.win.isDestroyed()) return;
  const extra = ctx.extra.length ? ` (+${ctx.extra.length} folder${ctx.extra.length > 1 ? 's' : ''})` : '';
  ctx.win.setTitle(ctx.workspace ? `${P(ctx).basename(ctx.workspace)}${ctx.remote ? ` [${ctx.remote.spec}]` : ''}${extra} — Switchdesk` : 'Switchdesk');
}

async function openFolder(ctx, dir) {
  if (remote.parseUrl(dir)) return openSsh(ctx, dir);
  dropRemote(ctx);
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

// An SSH folder: connect, find the folder on the host, and use it like a local one from here on.
async function openSsh(ctx, url) {
  const { spec, dir } = remote.parseUrl(url);
  const other = [...contexts.values()].find((c) => c !== ctx && c.workspace && folderKey(c) === url && c.win && !c.win.isDestroyed());
  if (other) {
    focusWindow(other);
    return { elsewhere: true, root: dir, name: path.posix.basename(dir) };
  }
  const conn = ctx.remote && ctx.remote.spec === spec && ctx.remote.alive ? ctx.remote : await new remote.Remote(spec).connect();
  const where = await conn.call('resolve', { path: dir || '~' });
  if (!conn.home) conn.home = (await conn.call('hello')).home; // copies of the folder go under it
  if (!where.isDir) {
    if (conn !== ctx.remote) conn.close();
    throw new Error(where.exists ? `${where.path} on ${spec} is a file, not a folder.` : `There's no folder ${where.path} on ${spec}.`);
  }
  closeWindowChats(ctx);
  stopWatchers(ctx);
  if (ctx.remote && ctx.remote !== conn) dropRemote(ctx);
  ctx.remote = conn;
  ctx.workspace = where.path;
  ctx.extra = [];
  conn.removeAllListeners('changed');
  conn.removeAllListeners('closed');
  conn.on('changed', (m) => m.root === ctx.workspace && sendTo(ctx, 'fs-changed', m.rels));
  conn.on('closed', (why) => ctx.remote === conn && sendTo(ctx, 'remote-closed', { spec, message: why }));
  await conn.call('watch', { root: where.path });
  const key = folderKey(ctx);
  settings.recentFolders = [key, ...settings.recentFolders.filter((f) => f !== key)].slice(0, 10);
  rememberWindows();
  setTitle(ctx);
  buildMenu();
  return folderInfo(ctx);
}

function dropRemote(ctx) {
  if (!ctx.remote) return;
  if (ctx.remote.langs) ctx.remote.langs.stopAll();
  ctx.remote.removeAllListeners();
  ctx.remote.close();
  ctx.remote = null;
}

// Adds a folder to the window's workspace, remembered for the next time its main folder opens.
function addFolder(ctx, dir) {
  if (!ctx.workspace) throw new Error('Open a folder first.');
  if (ctx.remote) throw new Error("An SSH folder can't have other folders added to its window yet.");
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
  for (const c of contexts.values()) noteBounds(c);
  settings.openWindows = [...contexts.values()].filter((c) => c.workspace).map(folderKey);
  saveSettings();
}

// Where each folder's window was (size, position, maximised), so it reopens there after a restart
// or an update instead of stacked on top of the others.
function noteBounds(ctx) {
  const win = ctx.win;
  if (!win || win.isDestroyed() || win.isMinimized() || !ctx.workspace) return;
  const maximized = win.isMaximized() || win.isFullScreen();
  const prev = (settings.windowBounds || {})[folderKey(ctx)];
  // A maximised window keeps the size it had before, for when it's restored.
  const b = maximized && prev ? prev : win.getNormalBounds ? win.getNormalBounds() : win.getBounds();
  const all = { ...(settings.windowBounds || {}) };
  delete all[folderKey(ctx)];
  all[folderKey(ctx)] = { x: b.x, y: b.y, width: b.width, height: b.height, maximized };
  // The 50 folders used most recently.
  settings.windowBounds = Object.fromEntries(Object.entries(all).slice(-50));
}

// Saved bounds for a folder, if they're still on a connected screen.
function savedBounds(dir) {
  const b = dir && (settings.windowBounds || {})[dir];
  if (!b || !(b.width > 0 && b.height > 0)) return null;
  const visible = screen.getAllDisplays().some(({ workArea: a }) => b.x < a.x + a.width - 80 && b.x + b.width > a.x + 80 && b.y >= a.y - 10 && b.y < a.y + a.height - 60);
  return visible ? b : null;
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
  const byId = new Map();
  for (const a of accounts.list(settings)) for (const row of await listSessionsIn(a.id, chatHome(ctx))) {
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
// With no folder open, chats still work, like a plain AI chat: they run in a folder of their own,
// so anything an agent writes lands there rather than somewhere of yours.
function chatHome(ctx) {
  if (ctx.workspace) return ctx.workspace;
  const dir = path.join(os.homedir(), '.switchdesk', 'chats');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function chatCwd(ctx, cwd) {
  if (ctx.remote) return cwd && ctx.remote.home && worktrees.onHost(ctx.remote).isUnder(cwd) ? cwd : ctx.workspace;
  return cwd && worktrees.isUnder(cwd) && fs.existsSync(cwd) ? cwd : chatHome(ctx);
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
      // A subagent's tool result names its own transcript, which its row opens.
      const agentId = ev.toolUseResult && ev.toolUseResult.agentId;
      if (agentId) for (const b of ev.message?.content || []) if (b.type === 'tool_result') messages.push({ role: 'tool-result', id: b.tool_use_id, agentId, text: ev.toolUseResult.isAsync ? '' : textOf(b.content) });
      const t = textOf(ev.message?.content).trim();
      if (t && !t.startsWith('<')) messages.push({ role: 'user', text: t.replace(/^\[Ask mode:[^\]]*\]\s*/, ''), after: lastReply });
    } else if (ev.type === 'assistant') {
      if (ev.uuid) lastReply = ev.uuid;
      for (const b of ev.message?.content || []) {
        if (b.type === 'text' && b.text.trim()) messages.push({ role: 'assistant', text: b.text, uuid: ev.uuid });
        else if (b.type === 'tool_use') messages.push({ role: 'tool', id: b.id, name: b.name, input: b.input, uuid: ev.uuid });
      }
    }
  }
  return messages;
}

// What a subagent of a past chat did, from its own transcript, as the events a live one sends.
async function loadSubagent(ctx, sessionId, agentId, cwd, account) {
  if (!/^[\w-]+$/.test(sessionId || '') || !/^[\w-]+$/.test(agentId || '')) return [];
  if (!accounts.exists(settings, account)) account = folderAccount(ctx);
  const file = path.join(accounts.projectDir(account, chatCwd(ctx, cwd)), sessionId, 'subagents', `agent-${agentId}.jsonl`);
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    try {
      const ev = JSON.parse(line);
      if ((ev.type === 'assistant' || ev.type === 'user') && ev.message) out.push({ type: ev.type, message: ev.message, tool_use_result: ev.toolUseResult });
    } catch {
      /* partial line */
    }
  }
  return out;
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
  // Claude ended its turn with background subagents still running: it carries on by itself when
  // they finish (backgroundTurn).
  if (chat.background) chat.backgroundOwed = true;
  let changes = [];
  try {
    if (turn.snapReady) turn.snap = await turn.snapReady;
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

// Background subagents: Claude's turn can end while they run, and when they finish Claude starts a
// new turn of its own, with nobody having sent anything. That turn gets a snapshot like any other,
// so its edits show and its approvals (the plan, in Plan mode) reach the chat.
function backgroundTurn(ctx, chatId, chat, ev) {
  if (ev.parent_tool_use_id) return;
  if (ev.type === 'system' && ev.subtype === 'background_tasks_changed') chat.background = (ev.tasks || []).length;
  const starts = (ev.type === 'system' && ev.subtype === 'init') || ev.type === 'stream_event' || ev.type === 'assistant';
  if (chat.turn || !chat.backgroundOwed || !starts) return;
  chat.backgroundOwed = false;
  const touched = [];
  const turn = { id: crypto.randomUUID(), snap: { touch: (abs) => touched.push(abs) }, blocks: new Map() };
  // Edits made before the snapshot is ready are read first, as with any turn.
  turn.snapReady = beginSnapshot(ctx, chat).then((snap) => {
    touched.forEach((abs) => snap.touch(abs));
    turn.snap = snap;
    return snap;
  });
  chat.turn = turn;
  sendTo(ctx, 'chat-event', { chatId, ev: { type: 'system', subtype: 'background_turn', turnId: turn.id } });
}

function denyPending(chat, message) {
  for (const resolve of chat.approvals.values()) resolve({ behavior: 'deny', message });
  chat.approvals.clear();
}

async function openChat(ctx, chatId, { sessionId, resumeAt, model, effort, mode, cwd, account, agent, agentAccount }) {
  const a = agents.AGENTS[agent] ? agents.AGENTS[agent] : agents.AGENTS.claude;
  agent = agents.AGENTS[agent] ? agent : 'claude';
  // In an SSH folder the agent's CLI is the host's, found on its PATH there.
  const bin = ctx.remote ? (agent === 'claude' ? 'claude' : a.bins[0]) : await agents.findBin(agent, settings);
  if (!bin) throw new Error(agent === 'claude' ? 'Claude Code is not installed. Open Settings → Setup to install it.' : `${a.label} isn't installed yet. Open Settings → Agents to install it.`);
  if (a.key && !agents.readKey(settings, agent, agentAccount)) throw new Error(`Add your ${a.key.name} in Settings → Agents first.`);
  const dirs = [...ctx.extra];
  const chat = { ctx, session: null, effort: effort || '', model: model || '', mode, turn: null, approvals: new Map(), cwd: chatCwd(ctx, cwd), account, agent, agentAccount, dirs };
  const key = chatKey(ctx, chatId);
  // Picking up a conversation another account had: give this account the latest transcript.
  if (sessionId && agent === 'claude' && !ctx.remote) await accounts.ensureTranscript(settings, account, chat.cwd, sessionId);
  const Session = a.kind === 'codex' ? CodexSession : a.kind === 'acp' ? AcpSession : ChatSession;
  // The Preview tools (preview-mcp.js), so the agent can open and check the running app itself.
  const mcp = settings.previewTools === false || ctx.remote ? null : previewBridge.serverSpec(await previewBridge.urlFor(ctx, (name, args, agent) => previewTool(ctx, name, args, agent)), agent);
  const hostArgs = (args) => ctx.remote.spawnArgs(chat.cwd, [bin, ...args]);
  chat.session = new Session({
    mcp,
    bin,
    via: ctx.remote ? hostArgs : null,
    args: [...(a.args || []), ...(a.dirsArg ? dirs.flatMap((d) => [a.dirsArg, d]) : [])],
    label: a.label,
    authMethod: a.authMethod,
    cwd: chat.cwd,
    dirs,
    rules: a.ownRulesFile && !ctx.remote ? projectRules(chat.cwd) : '',
    env: ctx.remote ? {} : agent === 'claude' ? accounts.envFor(account) : agents.envFor(settings, agent, model, agentAccount),
    sessionId,
    resumeAt: agent === 'claude' ? resumeAt : null,
    model,
    effort,
    mode,
    unrestricted: permissions.policyOf(settings).skipAll,
    askRules: permissions.claudeAskRules(settings),
    holdAuto: permissions.policyOf(settings).ask.length > 0,
    onEvent: (ev) => {
      chat.lastActive = Date.now();
      backgroundTurn(ctx, chatId, chat, ev);
      trackStream(ctx, chat.turn, ev);
      sendTo(ctx, 'chat-event', { chatId, ev });
      if (ev.type === 'result') finishTurn(chatId, chat);
    },
    onPermission: (req) =>
      new Promise((resolve) => {
        if (EDIT_TOOLS.has(req.toolName)) touchForSnapshot(ctx, chat.turn, editTarget(req.input));
        // Switchdesk's own rules answer first, the same way for every agent.
        const inFolders = (f) => {
          const abs = P(ctx).resolve(chat.cwd || ctx.workspace || '', f);
          return (chat.cwd && within(chat.cwd, abs, P(ctx))) || inWorkspace(ctx, abs);
        };
        // Other agents asked in Auto mode only because of the always-ask rules (holdAuto): the rest is yes.
        const autoApprove = chat.mode === 'auto' && agent !== 'claude' && chat.session.holdAuto;
        const auto = permissions.decide(settings, req, { mode: chat.mode, inWorkspace: inFolders, autoApprove });
        if (auto && auto.behavior === 'ask') req = { ...req, askRule: auto.rule, description: `It matches your always-ask rule "${auto.rule}" (Settings → Permissions).` };
        else if (auto) {
          if (auto.behavior === 'deny' && auto.rule) {
            const what = permissions.SHELL_TOOLS.has(req.toolName) ? `\`${String(req.input.command || '').slice(0, 200)}\`` : req.toolName;
            sendTo(ctx, 'chat-event', { chatId, ev: { type: 'system', subtype: 'notice', text: `Blocked ${what}: it matches your rule "${auto.rule}" (Settings → Permissions).` } });
          }
          return resolve(auto.behavior === 'allow' ? { behavior: 'allow', updatedInput: req.input } : { behavior: 'deny', message: auto.message });
        }
        const reqId = crypto.randomUUID();
        chat.approvals.set(reqId, resolve);
        const allowRules = permissions.SHELL_TOOLS.has(req.toolName) ? permissions.allowRulesFor(req.input && (req.input.command || req.input.cmd)) : undefined;
        sendTo(ctx, 'approval-request', { chatId, reqId, toolName: req.toolName, input: req.input, description: req.description, askRule: req.askRule, allowRules });
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

// One reply from an agent, outside any chat: it gets the prompt in Ask mode, may not use tools, and
// is closed once it answers. For ✨ commit messages and pull requests with agents other than Claude.
async function askOnce(ctx, agent, agentAccount, prompt) {
  const a = agents.AGENTS[agent] || agents.AGENTS.claude;
  agent = agents.AGENTS[agent] ? agent : 'claude';
  const bin = ctx.remote ? a.bins[0] : await agents.findBin(agent, settings);
  if (!bin) throw new Error(`${a.label} isn't installed yet. Open Settings → Agents to install it.`);
  if (a.key && !agents.readKey(settings, agent, agentAccount)) throw new Error(`Add your ${a.key.name} in Settings → Agents first.`);
  const Session = a.kind === 'codex' ? CodexSession : a.kind === 'acp' ? AcpSession : ChatSession;
  const cwd = ctx.workspace;
  let streamed = '';
  let whole = '';
  let settle;
  const done = new Promise((resolve, reject) => (settle = { resolve, reject }));
  const session = new Session({
    bin,
    via: ctx.remote ? (args) => ctx.remote.spawnArgs(cwd, [bin, ...args]) : null,
    args: a.args || [],
    label: a.label,
    authMethod: a.authMethod,
    cwd,
    dirs: [],
    rules: '',
    env: ctx.remote ? {} : agent === 'claude' ? accounts.envFor(folderAccount(ctx)) : agents.envFor(settings, agent, '', agentAccount),
    model: agent === 'claude' ? 'haiku' : '',
    mode: 'ask',
    onEvent: (ev) => {
      const e = ev.type === 'stream_event' && ev.event;
      if (e && e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') streamed += e.delta.text;
      else if (e && e.type === 'message_start' && streamed) streamed += '\n\n';
      if (ev.type === 'assistant') for (const b of (ev.message && ev.message.content) || []) if (b.type === 'text') whole += (whole ? '\n\n' : '') + b.text;
      if (ev.type === 'result') ev.is_error ? settle.reject(new Error(ev.result || `${a.label} couldn't answer.`)) : settle.resolve((typeof ev.result === 'string' && ev.result.trim()) || whole || streamed);
    },
    onPermission: async () => ({ behavior: 'deny', message: 'Reply with the text only. No tools are needed.' }),
    onExit: ({ code, stderr }) => settle.reject(new Error(String(stderr || '').trim().split('\n').pop() || `${a.label} stopped (${code}).`)),
  });
  const timer = setTimeout(() => settle.reject(new Error(`${a.label} took too long to answer.`)), 180000);
  try {
    await session.start();
    await session.send([{ type: 'text', text: prompt }], 'ask');
    return await done;
  } finally {
    clearTimeout(timer);
    try {
      session.dispose ? session.dispose() : session.close && session.close();
    } catch {
      /* gone */
    }
  }
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
  if (ctx.remote) return new remote.RemoteSnapshot(ctx.remote, chat.cwd).begin();
  const extra = chat.cwd === ctx.workspace ? roots(ctx).slice(1) : [];
  if (!extra.length) return new TurnSnapshot(chat.cwd).begin();
  return new MultiSnapshot([new TurnSnapshot(chat.cwd), ...extra.map((r) => new TurnSnapshot(r.dir, r.key))]).begin();
}

async function chatSend(ctx, chatId, { content, mode, model, effort, sessionId, resumeAt, cwd, account, agent, agentAccount }) {
  if (!accounts.exists(settings, account)) account = folderAccount(ctx);
  agent = agents.AGENTS[agent] ? agent : 'claude';
  agentAccount = agent !== 'claude' && agents.findAccount(settings, agent, agentAccount) ? agentAccount || agents.MAIN : agents.MAIN;
  const key = chatKey(ctx, chatId);
  let chat = chats.get(key);
  const restart =
    chat &&
    chat.session.alive &&
    (resumeAt ||
      chat.mcpStale ||
      agent !== chat.agent ||
      chat.dirs.join('\n') !== ctx.extra.join('\n') ||
      (agent === 'claude' && ((effort || '') !== chat.effort || account !== chat.account)) ||
      (agent !== 'claude' && agentAccount !== (chat.agentAccount || agents.MAIN)) ||
      (agents.AGENTS[agent].kind === 'acp' && (model || '') !== chat.model));
  if (restart) {
    // Effort, account, the workspace's folders, (for ACP agents) model and the MCP servers it
    // loaded are fixed per process: restart it on the same conversation.
    if (!resumeAt) sessionId = chat.session.sessionId || sessionId;
    chat.closing = true;
    chat.session.dispose();
    chats.delete(key);
    chat = null;
  }
  // A chat that was put to sleep picks up its conversation where it left off.
  if (!sessionId && asleep.has(key)) sessionId = asleep.get(key);
  asleep.delete(key);
  if (!chat || !chat.session.alive) chat = await openChat(ctx, chatId, { sessionId, resumeAt, model, effort, mode, cwd, account, agent, agentAccount });
  else await chat.session.setModel(model);
  const turn = { id: crypto.randomUUID(), snap: await beginSnapshot(ctx, chat), blocks: new Map() };
  chat.turn = turn;
  chat.lastActive = Date.now();
  chat.mode = mode;
  chat.session.unrestricted = permissions.policyOf(settings).skipAll;
  chat.session.holdAuto = permissions.policyOf(settings).ask.length > 0;
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

// Each chat's agent is a long-lived process (and, for Claude Code, every MCP server it starts), so
// a day of chats left dozens running, using memory and waking up for nothing. One left alone for
// a while is stopped; your next message starts it again on the same conversation, a few seconds
// slower. Not while it's working, waiting on you, or has something running in the background.
const SLEEP_AFTER = Number(process.env.SWITCHDESK_SLEEP_AFTER) || 10 * 60e3;
const asleep = new Map(); // chat key -> the conversation to pick up
function sleepIdleChats() {
  const now = Date.now();
  for (const [key, c] of [...chats]) {
    if (!c.session || !c.session.alive || c.turn || c.approvals.size || c.background || c.backgroundOwed) continue;
    if (now - (c.lastActive || now) < SLEEP_AFTER || !c.session.sessionId) continue;
    const caps = c.session.caps || {};
    if (agents.AGENTS[c.agent].kind === 'acp' && !caps.loadSession && !(caps.sessionCapabilities && caps.sessionCapabilities.resume)) continue; // it couldn't pick up again
    asleep.set(key, c.session.sessionId);
    c.closing = true;
    c.session.dispose();
    chats.delete(key);
  }
}
setInterval(sleepIdleChats, Math.min(60e3, SLEEP_AFTER)).unref();

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

// Git in an SSH folder: the same commands, run on the host.
const remoteGit = {
  cwd: (ctx) => ({ remote: ctx.remote, dir: ctx.workspace }),
  async status(ctx) {
    const s = await gitops.status(this.cwd(ctx));
    if (s.files) for (const f of s.files) f.path = f.rel;
    return s;
  },
  head: (ctx, rel) => gitops.headContent(remoteGit.cwd(ctx), './' + rel),
  run: (ctx, args) => git(remoteGit.cwd(ctx), args, { env: { GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' } }),
  async commit(ctx, message) {
    return gitops.commitAll(this.cwd(ctx), message);
  },
  sync: (ctx, action) => gitops.sync(remoteGit.cwd(ctx), action),
  async discard(ctx, rel, wasUntracked) {
    if (wasUntracked) return ctx.remote.call('remove', { path: resolveInWorkspace(ctx, rel) });
    return git(this.cwd(ctx), ['checkout', 'HEAD', '--', rel]);
  },
  async diff(ctx) {
    const diff = await git(this.cwd(ctx), ['diff', 'HEAD', '--no-color']).catch(() => '');
    const untracked = await git(this.cwd(ctx), ['ls-files', '--others', '--exclude-standard']).catch(() => '');
    return (untracked.trim() ? `${diff}\n\nNew files, not yet tracked:\n${untracked.trim()}` : diff).trim();
  },
};

// ---------- IPC ----------

function registerIpc() {
  // Every handler gets the window it was called from.
  // In an SSH folder, what works on the host has its own handler (REMOTE below); what only works on
  // this machine's files gives an empty answer instead of touching a local path of the same name.
  const handle = (channel, fn) =>
    ipcMain.handle(channel, (e, ...args) => {
      const ctx = ctxOf(e);
      if (ctx && ctx.remote) {
        if (REMOTE[channel]) return REMOTE[channel](ctx, ...args);
        if (channel in LOCAL_ONLY) {
          const v = LOCAL_ONLY[channel];
          if (v instanceof Error) throw v;
          return typeof v === 'function' ? v(ctx, ...args) : v;
        }
      }
      return fn(ctx, ...args);
    });
  const notOverSsh = (what) => new Error(`${what} isn't available in SSH folders yet.`);
  const LOCAL_ONLY = {
    'file:reveal': null,
    'file:preview': null,
    'file:open-default': null,
    'sessions:list': [],
    'sessions:load': [],
    'sessions:subagent': [],
    'agents:sessions': [],
    'agents:history': [],
    'rewind:files': { available: false, files: [] },
    'rewind:apply': { available: false, files: [] },
    'git:repos': [],
    'git:use': null,
    'git:blame': null,
    'git:log': [],
    'git:commit-files': [],
    'git:file-at': null,
    'git:init': notOverSsh('Making a git repository'),
    'git:abort': notOverSsh('That git action'),
    'git:continue': notOverSsh('That git action'),
    'git:resolved': notOverSsh('That git action'),
    'git:checkout': notOverSsh('Switching branches here'),
    'complete:request': { items: [] },
    'codebase:status': { model: false, files: 0, chunks: 0, embedded: 0, remote: true },
    'codebase:scan': { model: false, files: 0, chunks: 0, embedded: 0, remote: true },
    'codebase:pending': [],
    'codebase:put': null,
    'codebase:search': [],
    'commands:list': [],
    'cfg:memory': [],
    'cfg:rules-shared': false,
    'cfg:share-rules': notOverSsh('Sharing rules'),
    'cfg:save-memory': notOverSsh('Editing memory files'),
    'cfg:permissions': { rules: [] },
    'cfg:rule': notOverSsh('Editing these rules'),
    'folder:add': notOverSsh('Adding folders'),
    'cfg:mcp-list': [],
    'cfg:mcp-add': notOverSsh('Adding MCP servers'),
    'cfg:mcp-remove': notOverSsh('Removing MCP servers'),
    'cfg:mcp-login': notOverSsh('Signing in to MCP servers'),
  };
  const REMOTE = {
    'file:read': async (ctx, rel) => {
      const r = await ctx.remote.call('read', { path: resolveInWorkspace(ctx, rel) });
      return r.content != null ? { content: r.content } : r;
    },
    'file:write': (ctx, rel, content) => ctx.remote.call('write', { path: resolveInWorkspace(ctx, rel), content }),
    'files:search': async (ctx, query, opts) => {
      let re;
      try {
        re = search.buildRegex(query, opts || {});
      } catch (err) {
        return { error: `Invalid regular expression: ${err.message}` };
      }
      // The host finds the files that might match; the matching itself is the same as for local files.
      const found = await ctx.remote.call('search', { root: ctx.workspace, files: await listFiles(ctx), pattern: re.source, caseSensitive: !!(opts && opts.caseSensitive) });
      const text = new Map(Object.entries(found).map(([rel, t]) => [resolveInWorkspace(ctx, rel), t]));
      const io = { stat: async () => ({ isFile: () => true, size: 0 }), readFile: async (abs) => Buffer.from(text.get(abs) || '') };
      return search.search((rel) => resolveInWorkspace(ctx, rel), Object.keys(found).sort(), query, { ...opts, group: ctx.id, io });
    },
    'files:replace': (ctx, rels, query, replacement, opts) => {
      const io = {
        readFile: async (abs) => {
          const r = await ctx.remote.call('read', { path: abs });
          if (r.content == null) throw new Error('not text');
          return r.content;
        },
        writeFile: (abs, content) => ctx.remote.call('write', { path: abs, content }),
      };
      return search.replace((rel) => resolveInWorkspace(ctx, rel), rels, query, replacement, { ...(opts || {}), io });
    },
    'term:create': (ctx, id, cols, rows) =>
      terminal.create(termId(ctx, id), null, cols, rows, { onData: (d) => sendTo(ctx, 'term-data', { id, data: d }), onExit: (code) => sendTo(ctx, 'term-exit', { id, code }) }, {}, ctx.remote.shellArgs(ctx.workspace)),
    'changes:undo': async (ctx, turnId, absPaths) => {
      const snap = turnSnapshots.get(turnId);
      if (!snap) return false;
      await snap.undo(absPaths.filter((p) => inWorkspace(ctx, p) || worktrees.onHost(ctx.remote).isUnder(p)));
      return true;
    },
    'git:status': (ctx) => remoteGit.status(ctx),
    'git:head': (ctx, rel) => remoteGit.head(ctx, rel),
    'git:diff': (ctx) => remoteGit.diff(ctx),
    'git:commit': (ctx, message) => remoteGit.commit(ctx, message),
    'git:sync': (ctx, action) => remoteGit.sync(ctx, action),
    'git:discard': (ctx, rel, wasUntracked) => remoteGit.discard(ctx, rel, wasUntracked),
  };
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
    if (patch.keybindings) buildMenu(); // shortcuts changed in Settings → Keyboard
    // Other windows keep their copy current. A window's own tabs and chats are only its business,
    // and they're most of the settings, so saving them doesn't send everything to every window.
    if (Object.keys(patch).some((k) => k !== 'workspaces')) broadcast('settings-changed', settings, ctx);
    return settings;
  });
  handle('cli:status', (ctx, account) => cli.cliStatus(settings.claudePath, accounts.envFor(accounts.exists(settings, account) ? account : folderAccount(ctx))));

  // Agents: Claude, Codex, Kimi, and API-key models through Gemini CLI and Qwen Code.
  // Debug mode's log collector, one channel per chat.
  handle('report:problem', (ctx, info) => reportProblem(info));
  handle('debuglog:open', (ctx, chatId) => debuglog.open(chatKey(ctx, chatId), (count) => sendTo(ctx, 'debuglog-count', { chatId, count })));
  handle('debuglog:take', (ctx, chatId) => debuglog.take(chatKey(ctx, chatId)));
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
      canAddAccounts: agents.canAddAccounts(id),
      accounts: id === 'claude' ? [] : agents.accountsOf(settings, id).map((x) => ({ ...x, hasKey: a.key ? !!agents.readKey(settings, id, x.id) : false, options: a.key ? agents.options(settings, id, x.id) : {} })),
    }))
  );
  // Extra accounts for agents other than Claude: add, rename, remove.
  handle('agents:add-account', async (ctx, id, name) => {
    if (!agents.canAddAccounts(id)) throw new Error("This agent can't have more than one account.");
    const x = await agents.createAccount(id, name);
    settings.agentAccounts = { ...(settings.agentAccounts || {}), [id]: [...((settings.agentAccounts || {})[id] || []), x] };
    saveSettings();
    return x.id;
  });
  handle('agents:rename-account', (ctx, id, account, name) => {
    name = String(name || '').trim().slice(0, 40);
    if (!name) return false;
    if (agents.isMainAccount(account)) settings.agentMainNames = { ...(settings.agentMainNames || {}), [id]: name };
    else settings.agentAccounts = { ...(settings.agentAccounts || {}), [id]: ((settings.agentAccounts || {})[id] || []).map((x) => (x.id === account ? { ...x, name } : x)) };
    saveSettings();
    return true;
  });
  handle('agents:remove-account', async (ctx, id, account) => {
    for (const [key, c] of [...chats]) if (c.agent === id && c.agentAccount === account) closeChat(key);
    await agents.removeAccount(id, account);
    settings.agentAccounts = { ...(settings.agentAccounts || {}), [id]: ((settings.agentAccounts || {})[id] || []).filter((x) => x.id !== account) };
    saveSettings();
    return true;
  });
  handle('agents:status', async (ctx, id, account) => {
    const a = agents.AGENTS[id];
    if (!a) return null;
    const env = agents.envFor(settings, id, '', account);
    if (id === 'claude') {
      const s = await cli.cliStatus(settings.claudePath, accounts.envFor(folderAccount(ctx)));
      return { installed: s.found, path: s.path, version: s.version, loggedIn: !!(s.found && (s.auth ? s.auth.loggedIn : true)), detail: s.auth && s.auth.email ? s.auth.email : '' };
    }
    const bin = await agents.findBin(id, settings);
    if (!bin) return { installed: false };
    const version = await agents.version(bin);
    if (a.key && !agents.readKey(settings, id, account)) return { installed: true, path: bin, version, loggedIn: false, detail: `Needs your ${a.key.name}` };
    try {
      if (a.kind === 'codex') {
        const r = await codexStatus(bin, env);
        return { installed: true, path: bin, version, loggedIn: r.loggedIn, detail: r.loggedIn ? [r.email || (r.method === 'apiKey' ? 'API key' : 'ChatGPT'), r.plan].filter(Boolean).join(' · ') : 'Not signed in' };
      }
      if (a.statusArgs) {
        const r = await agents.cliStatus(bin, a.statusArgs, env);
        return { installed: true, path: bin, version, loggedIn: r.loggedIn, detail: r.loggedIn ? r.detail.slice(0, 80) || 'Signed in' : 'Not signed in' };
      }
      const r = await acpStatus(bin, a.args, env);
      return { installed: true, path: bin, version: version || r.version, loggedIn: r.loggedIn, detail: r.loggedIn ? (a.key ? 'API key saved' : 'Signed in') : a.key ? 'The key was not accepted' : 'Not signed in' };
    } catch (err) {
      return { installed: true, path: bin, version, loggedIn: false, detail: String(err.message || err).slice(0, 200) };
    }
  });
  // API key, base URL and default model for an API-key agent. A key of undefined keeps the saved one.
  handle('agents:set-key', (ctx, id, { key, baseUrl, model } = {}, account) => {
    const a = agents.AGENTS[id];
    if (!a || !a.key) return false;
    const main = agents.isMainAccount(account);
    const prev = (main ? (settings.apiKeys || {})[id] : agents.findAccount(settings, id, account)) || {};
    if (!main && !prev.id) return false;
    const sealed = key === undefined ? { key: prev.key, enc: prev.enc } : agents.sealKey(String(key).trim()) || { key: '', enc: false };
    const next = { ...sealed, baseUrl: (baseUrl || '').trim(), model: (model || '').trim() };
    if (main) settings.apiKeys = { ...(settings.apiKeys || {}), [id]: next };
    else settings.agentAccounts = { ...(settings.agentAccounts || {}), [id]: settings.agentAccounts[id].map((x) => (x.id === account ? { ...x, ...next } : x)) };
    saveSettings();
    return true;
  });
  // Install and sign-in commands, which the app runs in its own terminal so you see everything.
  handle('agents:command', async (ctx, id, what, account) => {
    const a = agents.AGENTS[id];
    if (!a) return null;
    if (what === 'install') return a.install ? a.install() : null;
    const bin = await agents.findBin(id, settings);
    const home = agents.homeVar(id);
    const env = home && !agents.isMainAccount(account) ? { [home]: agents.envFor(settings, id, '', account)[home] } : {};
    if (what === 'login' && a.login) return bin ? agents.withEnv(agents.commandLine(bin, a.login), env) : null;
    return null;
  });
  handle('agents:models', async (ctx, id) => {
    if (id !== 'codex') return [];
    const bin = await agents.findBin('codex', settings);
    return bin ? codexModels(bin).catch(() => []) : [];
  });
  // Past conversations an agent keeps for this folder, and one of them as messages.
  // Each account keeps its own conversations (API-key agents share one history), so ask each one.
  handle('agents:sessions', async (ctx, id) => {
    const a = agents.AGENTS[id];
    if (!a || id === 'claude') return [];
    const bin = await agents.findBin(id, settings);
    if (!bin) return [];
    const list = agents.homeVar(id) ? agents.accountsOf(settings, id) : [agents.accountsOf(settings, id).find((x) => agents.readKey(settings, id, x.id))].filter(Boolean);
    const all = await Promise.all(
      list.map(async (x) => {
        if (a.key && !agents.readKey(settings, id, x.id)) return [];
        const env = agents.envFor(settings, id, '', x.id);
        const rows = await (a.kind === 'codex' ? codexSessions(bin, env, chatHome(ctx)) : acpSessions(bin, a.args, env, chatHome(ctx), a.authMethod)).catch(() => []);
        return rows.map((r) => ({ ...r, agent: id, agentAccount: agents.homeVar(id) ? x.id : undefined }));
      })
    );
    return all.flat();
  });
  handle('agents:history', async (ctx, id, sessionId, account) => {
    const a = agents.AGENTS[id];
    if (!a || id === 'claude') return null;
    const bin = await agents.findBin(id, settings);
    if (!bin) return null;
    const env = agents.envFor(settings, id, '', account);
    return a.kind === 'codex' ? codexHistory(bin, env, sessionId) : acpHistory(bin, a.args, env, ctx.workspace, a.authMethod, sessionId);
  });
  // Codex can use an OpenAI API key instead of a ChatGPT sign-in; Codex stores it itself.
  handle('agents:codex-key', async (ctx, key, account) => {
    const bin = await agents.findBin('codex', settings);
    if (!bin) throw new Error("Codex isn't installed.");
    const env = await cli.childEnv(agents.envFor(settings, 'codex', '', account));
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
  handle('update:install', () => {
    rememberWindows(); // installing closes every window: keep them, and where they were
    quitting = true;
    updater.installNow();
  });
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
  // Talking instead of typing: starts the system's own dictation, which types into the chat box
  // (focused first). Win+H on Windows, Edit → Start Dictation on a Mac.
  handle('dictate', (ctx) => {
    ctx.win.focus();
    ctx.win.webContents.focus();
    if (process.env.SWITCHDESK_DICTATE_LOG) return fs.appendFileSync(process.env.SWITCHDESK_DICTATE_LOG, 'start\n'), true;
    if (process.platform === 'darwin') return Menu.sendActionToFirstResponder('startDictation:'), true;
    if (process.platform !== 'win32') return false;
    const winH =
      "Add-Type -Name K -Namespace W -MemberDefinition '[DllImport(\"user32.dll\")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);';" +
      '[W.K]::keybd_event(0x5B,0,0,[UIntPtr]::Zero);[W.K]::keybd_event(0x48,0,0,[UIntPtr]::Zero);[W.K]::keybd_event(0x48,0,2,[UIntPtr]::Zero);[W.K]::keybd_event(0x5B,0,2,[UIntPtr]::Zero)';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', winH], { windowsHide: true }, () => {});
    return true;
  });
  handle('open-external', (ctx, url) => {
    if (/^https:\/\/([a-z0-9-]+\.)*(claude\.ai|claude\.com|anthropic\.com|git-scm\.com)\//i.test(url)) shell.openExternal(url);
  });

  handle('folder:pick', async (ctx) => {
    const dir = await pickDir(ctx);
    return dir ? openFolder(ctx, dir) : null;
  });
  handle('folder:open', (ctx, dir) => (remote.parseUrl(dir) || fs.existsSync(dir) ? openFolder(ctx, dir) : null));
  // SSH folders: the hosts in ~/.ssh/config, a quick check that one answers, and its folders.
  handle('ssh:hosts', () => remote.configHosts());
  handle('ssh:test', (ctx, spec) => remote.test(spec));
  handle('ssh:dirs', async (ctx, spec, dir) => {
    const conn = ctx.browse && ctx.browse.spec === spec && ctx.browse.alive ? ctx.browse : (ctx.browse = await new remote.Remote(spec).connect());
    return conn.call('dirs', { path: dir || '~' });
  });
  handle('ssh:done-browsing', (ctx) => ctx.browse && (ctx.browse.close(), (ctx.browse = null)));
  handle('folder:current', (ctx) => folderInfo(ctx));
  // What a window shows when it first loads: its folder, the one it was opened for, or nothing.
  handle('folder:start', async (ctx) => {
    if (ctx.workspace) return folderInfo(ctx);
    const dir = ctx.start;
    ctx.start = null;
    return dir && (remote.parseUrl(dir) || fs.existsSync(dir)) ? openFolder(ctx, dir).catch(() => null) : null;
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
  // Notebooks: one kernel per open notebook (jupyter.js).
  handle('nb:start', (ctx, rel, kernel) =>
    jupyter.start(ctx, rel, { abs: resolveInWorkspace(ctx, rel), root: ctx.workspace, kernel, settings, remote: ctx.remote, send: (m) => sendTo(ctx, 'nb-event', { rel, ...m }) })
  );
  handle('nb:send', (ctx, rel, cmd) => jupyter.command(ctx, rel, cmd));
  handle('nb:stop', (ctx, rel) => jupyter.stop(ctx, rel));
  handle('nb:install-command', async (ctx) => jupyter.installCommand((await (ctx.remote ? jupyter.hostPython(ctx.remote, ctx.workspace) : jupyter.findPython(ctx.workspace, settings))) || (process.platform === 'win32' && !ctx.remote ? 'python' : 'python3')));
  handle('files:replace', async (ctx, rels, query, replacement, opts) => (ctx.workspace ? search.replace((rel) => resolveInWorkspace(ctx, rel), rels, query, replacement, opts || {}) : { files: [] }));
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
  // The Desk view's previews: a document as its text, an image as itself, anything else as just its path.
  handle('file:preview', (ctx, rel) => extract(resolveInWorkspace(ctx, rel)));
  handle('file:open-default', async (ctx, rel) => {
    const err = await shell.openPath(resolveInWorkspace(ctx, rel));
    if (err) throw new Error(err);
  });

  handle('sessions:list', (ctx) => listSessions(ctx));
  handle('sessions:load', (ctx, id, cwd, account) => loadSession(ctx, id, cwd, account));
  handle('sessions:subagent', (ctx, id, agentId, cwd, account) => loadSubagent(ctx, id, agentId, cwd, account));
  // Parallel agents: chats working in their own copy of the project. In an SSH folder the copies are
  // on the host.
  const copies = (ctx) => (ctx.remote ? worktrees.onHost(ctx.remote) : worktrees);
  const folderAt = (ctx) => (ctx.remote ? { remote: ctx.remote, dir: ctx.workspace } : ctx.workspace);
  const ownCopy = async (ctx, wt) => {
    if (!(await copies(ctx).exists(wt))) throw new Error('This copy no longer exists.');
    return wt;
  };
  handle('worktree:create', (ctx, name) => copies(ctx).create(ctx.workspace, name));
  // A copy at a pull request's latest commit, to fix it there and push to its branch.
  handle('worktree:for-pr', async (ctx, n, name) => {
    const repo = await ghRepo(ctx);
    const pushUrl = await github.pushUrl(settings, repo);
    const fetchHead = (from) => git(folderAt(ctx), ['fetch', '-q', from, `pull/${n}/head`], { env: { GIT_TERMINAL_PROMPT: '0' } });
    await fetchHead('origin').catch((err) => (pushUrl ? fetchHead(pushUrl) : Promise.reject(err)));
    const sha = (await git(folderAt(ctx), ['rev-parse', 'FETCH_HEAD'])).trim();
    return copies(ctx).create(ctx.workspace, name || `pr ${n}`, { rev: sha });
  });
  handle('worktree:head', async (ctx, wt) => copies(ctx).head(await ownCopy(ctx, wt)));
  handle('worktree:commit', async (ctx, wt, message) => copies(ctx).commit(await ownCopy(ctx, wt), message));
  // A long run's check for a milestone: a command (the tests, a build) run in the run's copy.
  // Passes when it exits 0. Only the end of what it printed comes back.
  handle('worktree:run', async (ctx, wt, command, timeoutMs) => {
    if (ctx.remote) throw new Error("Checks don't run in SSH folders yet.");
    await ownCopy(ctx, wt);
    return runCheck(wt.path, String(command), Math.min(Math.max(timeoutMs || 20 * 60e3, 10e3), 2 * 3600e3));
  });
  handle('worktree:set-aside', async (ctx, wt, name, sha) => copies(ctx).setAside(await ownCopy(ctx, wt), name, sha));
  // Long runs keep the computer awake while they work. Each window says whether it has one going.
  const awake = new Set();
  let awakeId = null;
  const syncAwake = () => {
    if (awake.size && awakeId === null) awakeId = powerSaveBlocker.start('prevent-app-suspension');
    if (!awake.size && awakeId !== null) (powerSaveBlocker.stop(awakeId), (awakeId = null));
    return awakeId !== null;
  };
  handle('keep-awake', (ctx, on) => {
    const id = ctx.win.id;
    if (on && !awake.has(id)) ctx.win.once('closed', () => (awake.delete(id), syncAwake()));
    if (on) awake.add(id);
    else awake.delete(id);
    return syncAwake();
  });
  // headRepo: the fork a pull request comes from, which its fixes are pushed to.
  handle('worktree:push', async (ctx, wt, to, message, headRepo) => {
    const repo = await ghRepo(ctx);
    const fork = headRepo && (headRepo.owner !== repo.owner || headRepo.name !== repo.name) ? headRepo : null;
    const origin = fork ? await git(folderAt(ctx), ['remote', 'get-url', 'origin']).catch(() => '') : '';
    return copies(ctx).push(await ownCopy(ctx, wt), to, { message, remote: fork ? github.remoteFor(origin, fork) : 'origin', pushUrl: await github.pushUrl(settings, fork || repo).catch(() => null) });
  });

  // GitHub: pull requests and issues for the open folder's repository (github.js).
  const ghCwd = (ctx) => (ctx.remote ? { remote: ctx.remote, dir: ctx.workspace } : gitCwd(ctx));
  const ghRepo = async (ctx) => {
    const repo = ctx.workspace && (await github.repoOf(ghCwd(ctx)));
    if (!repo) throw new Error("This folder's git repository isn't on GitHub (its origin remote doesn't point to github.com).");
    return repo;
  };
  handle('gh:status', (ctx) => (ctx.workspace ? github.status(settings, ghCwd(ctx)) : { repo: null }));
  handle('gh:set-token', (ctx, token) => {
    settings.github = token ? github.sealToken(token.trim()) : undefined;
    saveSettings();
    github.forgetCli();
    return ctx.workspace ? github.status(settings, ghCwd(ctx)) : null;
  });
  handle('gh:prs', async (ctx) => github.listPrs(settings, await ghRepo(ctx)));
  handle('gh:pr', async (ctx, n) => github.getPr(settings, await ghRepo(ctx), n));
  handle('gh:check-log', async (ctx, check) => github.checkLog(settings, await ghRepo(ctx), check));
  handle('gh:issues', async (ctx) => github.listIssues(settings, await ghRepo(ctx)));
  handle('gh:issue', async (ctx, n) => github.getIssue(settings, await ghRepo(ctx), n));
  handle('gh:review', async (ctx, n, review) => github.postReview(settings, await ghRepo(ctx), n, review));
  handle('gh:create-pr', async (ctx, p) => {
    const repo = await ghRepo(ctx);
    return github.createPr(settings, repo, { ...p, base: p.base || (await github.defaultBranch(settings, repo)) });
  });
  handle('gh:file-at', async (ctx, file, ref) => github.fileAt(settings, await ghRepo(ctx), file, ref));
  handle('gh:comment', async (ctx, n, c) => github.comment(settings, await ghRepo(ctx), n, c));
  handle('gh:reply', async (ctx, n, id, body) => github.reply(settings, await ghRepo(ctx), n, id, body));
  handle('gh:checks', async (ctx, sha) => github.checksOf(settings, await ghRepo(ctx), sha));
  handle('gh:ready', async (ctx, nodeId) => github.readyForReview(settings, nodeId));
  handle('gh:request-reviewers', async (ctx, n, logins) => github.requestReviewers(settings, await ghRepo(ctx), n, logins));
  handle('gh:approve', async (ctx, n, body) => github.approve(settings, await ghRepo(ctx), n, body));
  handle('gh:collaborators', async (ctx) => github.collaborators(settings, await ghRepo(ctx)));
  // Pushes the branch you're on, so a pull request can be opened from it.
  handle('gh:push-branch', async (ctx) => {
    const cwd = ctx.remote ? remoteGit.cwd(ctx) : gitCwd(ctx);
    const env = { GIT_TERMINAL_PROMPT: '0' };
    try {
      await git(cwd, ['push', '-u', 'origin', 'HEAD'], { env });
    } catch (err) {
      const url = await github.pushUrl(settings, await ghRepo(ctx));
      if (!url) throw new Error(String(err.stderr || err.message).trim().split('\n').slice(-3).join('\n'));
      await git(cwd, ['push', url, 'HEAD'], { env }).catch((e) => {
        throw new Error(String(e.stderr || e.message).replace(url, 'GitHub').trim().split('\n').slice(-3).join('\n'));
      });
    }
    return true;
  });
  // Merges on GitHub, then tidies up: the branch on GitHub, and your folder if it's on that branch.
  handle('gh:merge', async (ctx, n, { method, title, sha, head, base, deleteBranch }) => {
    const repo = await ghRepo(ctx);
    await github.merge(settings, repo, n, { method, title, sha });
    const out = { merged: true, branchDeleted: false, switched: false };
    if (deleteBranch && head) out.branchDeleted = await github.deleteBranch(settings, repo, head).then(() => true, () => false);
    const cwd = ctx.remote ? remoteGit.cwd(ctx) : gitCwd(ctx);
    const env = { GIT_TERMINAL_PROMPT: '0' };
    try {
      const current = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      const dirty = (await git(cwd, ['status', '--porcelain'])).trim();
      if (current === head && base && !dirty) {
        const local = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
        await git(cwd, ['checkout', '-q', base], { env });
        await git(cwd, ['pull', '-q', '--ff-only'], { env }).catch(() => {});
        // Only a branch with nothing beyond what was merged is deleted.
        if (local === sha) await git(cwd, ['branch', '-D', head]).catch(() => {});
        out.switched = true;
      }
    } catch {
      /* the folder stays as it is */
    }
    return out;
  });
  // Linear: your open issues, to start work from (linear.js).
  handle('linear:status', () => linear.status(settings));
  handle('linear:set-key', (ctx, key) => {
    settings.linear = key ? linear.sealKey(key.trim()) : undefined;
    saveSettings();
    return linear.status(settings);
  });
  handle('linear:issues', () => linear.issues(settings));
  handle('linear:issue', (ctx, id) => linear.issue(settings, id));
  handle('linear:comment', (ctx, id, body) => linear.comment(settings, id, body));
  handle('worktree:changes', async (ctx, wt) => copies(ctx).changes(await ownCopy(ctx, wt)));
  handle('worktree:diff', async (ctx, wt, rel) => copies(ctx).fileDiff(await ownCopy(ctx, wt), rel));
  handle('worktree:merge', async (ctx, wt) => copies(ctx).merge(await ownCopy(ctx, wt), ctx.workspace));
  handle('worktree:remove', async (ctx, wt) => ((await copies(ctx).exists(wt)) ? copies(ctx).remove(wt) : true));
  handle('worktree:exists', (ctx, wt) => copies(ctx).exists(wt));

  handle('chat:send', (ctx, chatId, opts) => chatSend(ctx, chatId, opts));
  handle('chat:interrupt', (ctx, chatId) => chatInterrupt(ctx, chatId));
  handle('chat:close', (ctx, chatId) => closeChat(chatKey(ctx, chatId)));
  handle('chat:set-mode', (ctx, chatId, mode) => {
    const chat = chats.get(chatKey(ctx, chatId));
    if (!chat) return;
    chat.mode = mode; // a plan approved mid-turn: the rest of the turn follows the new mode's rules
    return chat.session.setMode(mode);
  });
  handle('phone:answer', (ctx, id, result) => {
    const done = phoneCalls.get(id);
    phoneCalls.delete(id);
    if (done) done(result);
  });
  handle('phone:status', () => phoneStatus());
  handle('handoff:status', () => ({ claude: handoff.addedTo('claude'), cursor: handoff.addedTo('cursor'), spec: handoffSpec() }));
  handle('handoff:add', (ctx, appName) => handoff.addTo(appName === 'cursor' ? 'cursor' : 'claude', handoffSpec()));
  handle('phone:set', async (ctx, on) => {
    phoneError = '';
    settings.phone = { ...(settings.phone || {}), on: !!on };
    saveSettings();
    try {
      await (on ? startPhone() : stopPhone());
    } catch (e) {
      phoneError = `Couldn't start it: ${e.message}`;
    }
    return phoneStatus();
  });
  handle('phone:pair-code', () => (phoneServer ? phoneServer.pairCode() : null));
  handle('phone:tailscale-only', async (ctx, on) => {
    phoneError = '';
    settings.phone = { ...(settings.phone || {}), tailscaleOnly: !!on };
    saveSettings();
    if (phoneServer) await stopPhone().then(startPhone).catch((e) => (phoneError = `Couldn't start it: ${e.message}`));
    return phoneStatus();
  });
  // A new code: phones signed in with the old one have to scan again.
  handle('phone:new-code', async () => {
    settings.phone = { ...(settings.phone || {}), token: crypto.randomBytes(24).toString('base64url') };
    saveSettings();
    if (phoneServer) await stopPhone().then(startPhone);
    return phoneStatus();
  });
  handle('preview:tool-result', (ctx, id, result) => {
    const done = previewCalls.get(id);
    previewCalls.delete(id);
    if (done) done(result || {});
  });
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
  // The repository the Git panel shows: the main folder's, or another folder of the workspace
  // picked in the panel. Per-file commands take the file's workspace path and use its own repo.
  const gitCwd = (ctx) => (ctx.gitRepo && roots(ctx).some((r) => r.dir === ctx.gitRepo) ? ctx.gitRepo : ctx.workspace);
  const gitPrefix = (ctx) => {
    const r = roots(ctx).find((x) => x.dir === gitCwd(ctx));
    return r && r.key ? r.key + '/' : '';
  };
  const fileRepo = (ctx, rel) => {
    const abs = resolveInWorkspace(ctx, rel);
    return { cwd: path.dirname(abs), name: path.basename(abs), abs };
  };
  handle('git:repos', async (ctx) => {
    const out = [];
    for (const r of roots(ctx)) if (await isGitRepo(r.dir)) out.push({ dir: r.dir, name: r.name, current: r.dir === gitCwd(ctx) });
    return out;
  });
  handle('git:use', (ctx, dir) => {
    ctx.gitRepo = dir;
  });
  handle('git:status', async (ctx) => {
    if (!ctx.workspace) return { repo: false };
    const s = await gitops.status(gitCwd(ctx));
    const prefix = gitPrefix(ctx);
    if (s.files) for (const f of s.files) f.path = prefix + f.rel;
    return s;
  });
  handle('git:head', (ctx, rel) => {
    const f = fileRepo(ctx, rel);
    return gitops.headContent(f.cwd, './' + f.name);
  });
  handle('git:commit', (ctx, message) => gitops.commitAll(gitCwd(ctx), message));
  handle('git:checkout', (ctx, branch, create) => gitops.checkout(gitCwd(ctx), branch, create));
  handle('git:sync', (ctx, action) => gitops.sync(gitCwd(ctx), action));
  handle('git:discard', async (ctx, rel, wasUntracked) => {
    const f = fileRepo(ctx, rel);
    if (wasUntracked) {
      await git(f.cwd, ['rm', '--cached', '--ignore-unmatch', '-q', '--', f.name]).catch(() => {});
      await fsp.rm(f.abs, { force: true });
    } else await git(f.cwd, ['checkout', 'HEAD', '--', f.name]);
  });
  handle('git:init', (ctx) => git(gitCwd(ctx), ['init']));
  // ✨ writes commit messages and pull requests with the agent you pick: Claude Haiku for Claude here,
  // else the agent itself, asked once in Ask mode.
  const writer = async (ctx, agent, agentAccount) => {
    if ((!agent || agent === 'claude') && !ctx.remote) return gitops.askHaiku(gitCwd(ctx), await cli.findClaude(settings.claudePath), accounts.envFor(folderAccount(ctx)));
    return (prompt) => askOnce(ctx, agent || 'claude', agentAccount, prompt);
  };
  const gitHere = (ctx) => (ctx.remote ? remoteGit.cwd(ctx) : gitCwd(ctx));
  handle('git:suggest', async (ctx, agent, agentAccount) => gitops.suggestMessage(gitHere(ctx), await writer(ctx, agent, agentAccount)));
  // Merge conflicts
  handle('git:abort', (ctx) => gitops.abortOperation(gitCwd(ctx)));
  handle('git:continue', (ctx) => gitops.continueOperation(gitCwd(ctx)));
  handle('git:resolved', (ctx, rel) => {
    const f = fileRepo(ctx, rel);
    return gitops.markResolved(f.cwd, f.name);
  });
  // Blame and history
  handle('git:blame', async (ctx, rel) => {
    const f = fileRepo(ctx, rel);
    return (await isGitRepo(f.cwd)) ? gitops.blame(f.cwd, f.name) : null;
  });
  handle('git:log', async (ctx, opts = {}) => {
    if (opts.rel) {
      const f = fileRepo(ctx, opts.rel);
      return gitops.log(f.cwd, { ...opts, rel: f.name });
    }
    return gitops.log(gitCwd(ctx), opts);
  });
  // A commit's files, with paths from the top of the repository.
  handle('git:commit-files', async (ctx, sha, rel) => {
    const cwd = rel ? fileRepo(ctx, rel).cwd : gitCwd(ctx);
    return { files: await gitops.commitFiles(cwd, sha), top: await gitRoot(cwd) };
  });
  // A file as it was at a commit. top-relative paths come from git:commit-files.
  handle('git:file-at', async (ctx, rev, rel, opts = {}) => {
    if (opts.top) return gitops.fileAt(opts.near ? fileRepo(ctx, opts.near).cwd : gitCwd(ctx), rev, rel);
    const f = fileRepo(ctx, rel);
    return gitops.fileAt(f.cwd, rev, './' + f.name);
  });
  handle('git:pr', async (ctx, agent, agentAccount) => gitops.suggestPullRequest(gitHere(ctx), await writer(ctx, agent, agentAccount)));

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
  // ---------- code intelligence (language servers)
  const langs = new LangServers({
    find: agents.findCommand,
    env: () => cli.childEnv(),
    version: app.getVersion(),
    onDiagnostics: (file, diagnostics) => {
      for (const ctx of contexts.values()) if (inWorkspace(ctx, file)) sendTo(ctx, 'lsp-diagnostics', { rel: relOf(ctx, file), diagnostics });
    },
  });
  langServers = langs;
  // An SSH folder's language servers run on its host, one set per connection.
  const hostFind = async (remote, names) => {
    for (const n of names) {
      const r = await remote.exec(['sh', '-lc', `command -v ${n}`]).catch(() => null);
      const found = r && r.code === 0 && r.stdout.toString().trim().split('\n').pop();
      if (found) return found;
    }
    return null;
  };
  const langsOf = (ctx) => {
    if (!ctx.remote) return langs;
    const remote = ctx.remote;
    remote.langs ||= new LangServers({
      host: remote,
      find: (names) => hostFind(remote, names),
      env: async () => process.env,
      version: app.getVersion(),
      onDiagnostics: (file, diagnostics) => ctx.remote === remote && inWorkspace(ctx, file) && sendTo(ctx, 'lsp-diagnostics', { rel: relOf(ctx, file), diagnostics }),
    });
    return remote.langs;
  };
  const langOpts = () => [settings.langServerPaths || {}, settings.langServersOff || []];
  const fileIn = (ctx, rel) => {
    try {
      return resolveInWorkspace(ctx, rel);
    } catch {
      return null;
    }
  };
  // Locations come back as file URIs: turn them into the window's paths, or say they're outside.
  const toPlaces = (ctx, r) =>
    (Array.isArray(r) ? r : r ? [r] : [])
      .map((l) => {
        const uri = l.targetUri || l.uri;
        const range = l.targetSelectionRange || l.targetRange || l.range;
        let file;
        try {
          file = fileOfUri(uri, ctx.remote);
        } catch {
          return null;
        }
        return { rel: inWorkspace(ctx, file) ? relOf(ctx, file) : null, file, range };
      })
      .filter(Boolean);
  handle('lsp:status', (ctx) => langsOf(ctx).status(...langOpts()));
  handle('lsp:open', async (ctx, rel, languageId, text) => {
    const file = fileIn(ctx, rel);
    if (!file) return null;
    const root = rootOf(ctx, file).dir;
    return langsOf(ctx).open({ file, languageId, text, root }, ...langOpts()).catch((e) => ({ error: String(e.message || e).replace(/^Request initialize failed with message: /, '') }));
  });
  handle('lsp:change', (ctx, rel, text) => {
    const file = fileIn(ctx, rel);
    if (file) langsOf(ctx).change(file, text);
  });
  handle('lsp:close', (ctx, rel) => {
    const file = fileIn(ctx, rel);
    if (file) langsOf(ctx).close(file);
  });
  handle('lsp:request', async (ctx, rel, method, params) => {
    const file = fileIn(ctx, rel);
    if (!file) return null;
    const r = await langsOf(ctx).request(file, method, params);
    return /definition|references|implementation/i.test(method) ? toPlaces(ctx, r) : r;
  });
  handle('lsp:restart', (ctx) => langsOf(ctx).stopAll());

  // ---------- tab autocomplete
  let copilotMissingAt = 0; // don't look for the language server on every keystroke when it isn't there
  const copilotUsable = async () => {
    if (autocomplete.copilot.lsp) return autocomplete.copilot.status.signedIn;
    if (Date.now() - copilotMissingAt < 60000) return false;
    try {
      await autocomplete.startCopilot(settings, app.getVersion());
      return autocomplete.copilot.status.signedIn;
    } catch {
      copilotMissingAt = Date.now();
      return false;
    }
  };
  const fimProvider = (id) => {
    const key = agents.readKey(settings, id);
    if (!key) return null;
    return { id, label: agents.AGENTS[id].label, key, baseUrl: agents.options(settings, id).baseUrl, fetch: net.fetch.bind(net) };
  };
  const completeEngine = async () => {
    const want = (settings.autocomplete && settings.autocomplete.engine) || 'auto';
    if (want === 'off') return null;
    if (want === 'copilot') return (await copilotUsable()) ? 'copilot' : null;
    if (want === 'deepseek' || want === 'qwen') return fimProvider(want) ? want : null;
    if (await copilotUsable()) return 'copilot';
    return ['deepseek', 'qwen'].find((id) => fimProvider(id)) || null;
  };
  autocomplete.copilot.onStatus = (st) => broadcast('complete-status', st);
  handle('complete:status', async () => {
    const script = await autocomplete.findServer((settings.agentPaths || {})['copilot-language-server']);
    if (script) await autocomplete.startCopilot(settings, app.getVersion()).catch(() => {});
    return {
      engine: (settings.autocomplete && settings.autocomplete.engine) || 'auto',
      active: await completeEngine(),
      copilot: { installed: !!script, ...autocomplete.copilot.status },
      keys: { deepseek: !!agents.readKey(settings, 'deepseek'), qwen: !!agents.readKey(settings, 'qwen') },
      install: autocomplete.INSTALL,
    };
  });
  handle('complete:request', async (ctx, doc) => {
    const engine = await completeEngine();
    if (!engine) return { items: [] };
    let abs;
    try {
      abs = resolveInWorkspace(ctx, doc.rel);
    } catch {
      return { items: [] };
    }
    const full = { ...doc, uri: pathToFileURL(abs).href };
    if (engine === 'copilot') {
      autocomplete.addFolder(ctx.workspace);
      return autocomplete.copilotComplete(settings, app.getVersion(), full).catch(() => ({ items: [] }));
    }
    if (ctx.fimAbort) ctx.fimAbort.abort();
    const ctl = (ctx.fimAbort = new AbortController());
    return autocomplete.fimComplete(fimProvider(engine), full, ctl.signal).catch(() => ({ items: [] }));
  });
  handle('complete:accepted', (ctx, command) => autocomplete.accepted(command));
  handle('complete:close', (ctx, rel) => {
    try {
      autocomplete.closeDoc(pathToFileURL(resolveInWorkspace(ctx, rel)).href);
    } catch {}
  });
  handle('complete:sign-in', async () => {
    const r = await autocomplete.signInStart(settings, app.getVersion());
    if (r.verificationUri) shell.openExternal(r.verificationUri);
    return r;
  });
  handle('complete:sign-in-finish', (ctx, command) => autocomplete.signInFinish(command));
  handle('complete:sign-out', () => autocomplete.signOut());

  handle('usage:record', (ctx, key, turn) => usage.record(key, turn));
  // Every window shows the same plan limits: the latest any of them heard.
  handle('usage:limits', (ctx, key, windows) => {
    usage.setLimits(key, windows);
    broadcast('usage-limits', { key, windows }, ctx);
  });
  handle('usage:summary', () => usage.summary());
  handle('git:diff', async (ctx) => {
    if (!ctx.workspace) return '';
    let diff = await git(ctx.workspace, ['diff', 'HEAD', '--no-color']).catch(() => '');
    const untracked = await git(ctx.workspace, ['ls-files', '--others', '--exclude-standard']).catch(() => '');
    if (untracked.trim()) diff += `\n\nNew files, not yet tracked:\n${untracked.trim()}`;
    return diff.trim();
  });
  // Codebase search by meaning: main keeps the index, the window runs the model.
  const indexOf = (ctx) => {
    const key = roots(ctx).map((r) => r.dir).join('|');
    if (!ctx.codebase || ctx.codebase.key !== key) {
      if (ctx.codebase) codeIndexes.delete(ctx.codebase);
      ctx.codebase = new codebase.Index(roots(ctx));
      ctx.codebase.key = key;
      codeIndexes.add(ctx.codebase);
    }
    return ctx.codebase;
  };
  const codeStatus = (ctx) => ({ model: codebase.modelReady(), ...(ctx.workspace ? indexOf(ctx).status() : { files: 0, chunks: 0, embedded: 0 }) });
  handle('codebase:status', (ctx) => codeStatus(ctx));
  handle('codebase:download', (ctx) => codebase.downloadModel((u) => net.fetch(u), (p) => sendTo(ctx, 'codebase-progress', p)).then(() => codeStatus(ctx)));
  handle('codebase:scan', async (ctx) => {
    if (!ctx.workspace) return codeStatus(ctx);
    await indexOf(ctx).scan(() => listFiles(ctx));
    return codeStatus(ctx);
  });
  handle('codebase:pending', (ctx, n) => (ctx.workspace ? indexOf(ctx).pending(Math.min(n || 32, 256)) : []));
  handle('codebase:put', (ctx, entries) => ctx.workspace && indexOf(ctx).put(entries || []));
  handle('codebase:search', (ctx, query, vector, k) => (ctx.workspace ? indexOf(ctx).search(String(query || ''), vector, k) : []));

  // Run and debug a file (see debugger.js). One debug session per window.
  const pythonFor = async (dir) => {
    // The project's own virtual environment first, so its packages (and debugpy) are the ones used.
    for (const v of ['.venv', 'venv', 'env']) {
      const p = isWin ? path.join(dir, v, 'Scripts', 'python.exe') : path.join(dir, v, 'bin', 'python');
      if (fs.existsSync(p)) return p;
    }
    return agents.findCommand(isWin ? ['py', 'python', 'python3'] : ['python3', 'python']);
  };
  // Running a test from the editor (tests.js). One run per test at a time; a new run of the same
  // test stops the old one.
  handle('tests:run', async (ctx, { rel, name, cls, key }) => {
    const abs = resolveInWorkspace(ctx, rel);
    const root = (rootOf(ctx, abs) || { dir: P(ctx).dirname(abs) }).dir;
    ctx.testRuns = ctx.testRuns || new Map();
    const old = ctx.testRuns.get(key);
    if (old) old.kill();
    const env = ctx.remote ? {} : await cli.childEnv();
    try {
      if (ctx.remote) return await tests.runTest({ abs, root, name, cls, env, remote: ctx.remote, findNode: async () => 'node', findPython: (dir) => jupyter.hostPython(ctx.remote, dir) });
      return await tests.runTest({ abs, root, name, cls, env, findNode: () => agents.findCommand(['node']), findPython: pythonFor, onSpawn: (child) => ctx.testRuns.set(key, child) });
    } finally {
      ctx.testRuns.delete(key);
    }
  });
  const absBreakpoints = (ctx, bps) => Object.fromEntries(Object.entries(bps || {}).map(([rel, lines]) => [resolveInWorkspace(ctx, rel), lines]));
  handle('debug:start', async (ctx, { rel, args, breakpoints, exceptions }) => {
    if (ctx.debug) ctx.debug.stop();
    const abs = resolveInWorkspace(ctx, rel);
    const kind = debug.kindOf(abs);
    if (!kind) throw new Error('Switchdesk can debug JavaScript, TypeScript and Python files.');
    const cwd = (rootOf(ctx, abs) || { dir: P(ctx).dirname(abs) }).dir;
    const env = ctx.remote ? {} : await cli.childEnv();
    // In an SSH folder the program runs on the host, with the host's node or Python.
    const bin = ctx.remote ? (kind === 'node' ? 'node' : await jupyter.hostPython(ctx.remote, cwd)) : kind === 'node' ? await agents.findCommand(['node']) : await pythonFor(cwd);
    if (!bin) return { missing: kind === 'node' ? 'node' : 'python' };
    const onEvent = (e) => {
      if (e.frames) for (const f of e.frames) f.rel = f.file ? relOf(ctx, f.file) : null;
      if (e.type === 'terminated' && ctx.debug === session) ctx.debug = null;
      sendTo(ctx, 'debug-event', e);
    };
    const Session = kind === 'node' ? debug.NodeDebug : debug.PythonDebug;
    const session = new Session({ program: abs, args: args || [], cwd, env: { ...env, PYTHONUNBUFFERED: '1' }, node: bin, python: bin, onEvent, host: ctx.remote || null });
    if (exceptions) session.pauseOnExceptions = exceptions;
    if (exceptions && kind === 'python') session.exceptionFilters = exceptions === 'all' ? ['raised', 'uncaught'] : exceptions === 'none' ? [] : ['uncaught'];
    ctx.debug = session;
    try {
      await session.start(absBreakpoints(ctx, breakpoints));
    } catch (e) {
      session.stop();
      if (ctx.debug === session) ctx.debug = null;
      if (e.message === 'NO_DEBUGPY') return { missing: 'debugpy', python: bin };
      throw e;
    }
    return { kind, bin };
  });
  handle('debug:breakpoints', (ctx, rel, lines) => ctx.debug && ctx.debug.setBreakpoints(resolveInWorkspace(ctx, rel), lines));
  handle('debug:exceptions', (ctx, mode) => ctx.debug && ctx.debug.setExceptions(mode));
  handle('debug:cmd', (ctx, cmd) => {
    const d = ctx.debug;
    if (!d) return;
    const fn = { continue: 'cont', next: 'next', stepIn: 'stepIn', stepOut: 'stepOut', pause: 'pause', stop: 'stop' }[cmd];
    return fn && Promise.resolve(d[fn]()).catch(() => {});
  });
  handle('debug:scopes', (ctx, frameId) => (ctx.debug ? ctx.debug.scopes(frameId) : []));
  handle('debug:variables', (ctx, ref) => (ctx.debug ? ctx.debug.variables(ref) : []));
  handle('debug:evaluate', (ctx, expr, frameId) => (ctx.debug ? ctx.debug.evaluate(expr, frameId) : { error: 'Nothing is running. Start debugging first.' }));

  // Your custom slash commands, for agents that don't read them themselves.
  handle('commands:list', (ctx) => listCommands(roots(ctx).map((r) => r.dir)));
  // Documents attached to a chat from outside the workspace: Word, PDF, Excel, PowerPoint, text.
  handle('attach:pick', async (ctx) => {
    const r = await dialog.showOpenDialog(ctx.win, {
      title: 'Attach files to the chat',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'All files', extensions: ['*'] },
        { name: 'Documents and images', extensions: ['docx', 'pdf', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'txt', 'md', 'csv', 'json', 'html', 'htm', 'xml', 'log', 'png', 'jpg', 'jpeg', 'gif', 'webp'] },
      ],
    });
    return r.canceled ? [] : r.filePaths;
  });
  handle('attach:read', async (ctx, files) => {
    const out = [];
    for (const f of files || []) {
      try {
        out.push(await extract(f));
      } catch (e) {
        out.push({ kind: 'error', name: path.basename(f), error: String(e.message || e) });
      }
    }
    return out;
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
  handle('cfg:mcp-login', (ctx, name) => connectMcp(ctx, { name }));
  handle('cfg:gateway-list', () => gateway().status());
  handle('cfg:gateway-connect', (ctx, spec) => connectGateway(ctx, spec || {}));
  handle('cfg:gateway-remove', (ctx, name) => gateway().remove(name));
  handle('cfg:mcp-add', async (ctx, spec) => config.mcpAdd(await cli.findClaude(settings.claudePath), ctx.workspace || os.homedir(), spec, folderAcct(ctx)));
}

// ---------- app ----------

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

// A new window. start is the folder it opens with; null opens an empty window.
function createWindow(start) {
  const saved = savedBounds(start);
  const focused = saved ? null : BrowserWindow.getFocusedWindow();
  const at = saved || (focused && !focused.isMaximized() ? focused.getBounds() : null);
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    ...(at ? { x: at.x + (saved ? 0 : 28), y: at.y + (saved ? 0 : 28), width: at.width, height: at.height } : {}),
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
  if (saved && saved.maximized) win.maximize();
  const ctx = { id: win.webContents.id, win, workspace: null, extra: [], watchers: [], start: start || null };
  contexts.set(ctx.id, ctx);
  let boundsTimer = null;
  const boundsChanged = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => !quitting && (noteBounds(ctx), saveSettings()), 800);
  };
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, boundsChanged);
  win.on('close', () => (clearTimeout(boundsTimer), !quitting && noteBounds(ctx)));
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
    if (ctx.debug) ctx.debug.stop();
    previewBridge.forget(ctx);
    jupyter.stopAll(ctx);
    dropRemote(ctx);
    if (ctx.browse) ctx.browse.close();
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

// A menu item's shortcut: yours from Settings → Keyboard if you changed it ("" for none), else its own.
function accel(command, fallback) {
  const b = settings.keybindings || {};
  if (!(command in b)) return fallback;
  if (!b[command]) return undefined;
  const keys = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Esc' };
  return b[command]
    .split('+')
    .map((p) => (p === 'Meta' ? 'Super' : keys[p] || p))
    .join('+');
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const recents = (settings.recentFolders || []).filter((f) => fs.existsSync(f));
  const open = [...contexts.values()].filter((c) => c.win && !c.win.isDestroyed());
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [{ label: `About ${app.name}`, click: menuCmd('about') }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: accel('New Window', 'CmdOrCtrl+Shift+N'), click: () => newWindow(null) },
        { type: 'separator' },
        { label: 'Open Folder…', accelerator: accel('Open Folder…', 'CmdOrCtrl+O'), click: menuCmd('open-folder') },
        { label: 'Open Folder over SSH…', click: menuCmd('open-ssh') },
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
        { label: 'Save', accelerator: accel('Save', 'CmdOrCtrl+S'), click: menuCmd('save') },
        { label: 'Close Tab', accelerator: accel('Close Tab', 'CmdOrCtrl+W'), click: menuCmd('close-tab') },
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', click: (_i, bw) => bw && bw.close() },
        { type: 'separator' },
        { label: 'Settings…', accelerator: accel('Settings', 'CmdOrCtrl+,'), click: menuCmd('settings') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Command Palette…', accelerator: accel('Command Palette', 'CmdOrCtrl+Shift+P'), click: menuCmd('palette') },
        { label: 'Quick Open File', accelerator: accel('Go to File…', 'CmdOrCtrl+P'), click: menuCmd('quick-open') },
        { label: 'Search in Files', accelerator: accel('Search in Files', 'CmdOrCtrl+Shift+F'), click: menuCmd('search') },
        { label: 'Replace in Files', accelerator: accel('Replace in Files', 'CmdOrCtrl+Shift+H'), click: menuCmd('replace') },
        { label: 'New Chat', accelerator: accel('New Chat', 'CmdOrCtrl+N'), click: menuCmd('new-chat') },
        { label: 'New Chat in Its Own Copy', accelerator: accel('New Chat in Its Own Copy', 'CmdOrCtrl+Alt+N'), click: menuCmd('new-copy-chat') },
        { label: 'Add Selection to Chat', accelerator: accel('Add Selection to Chat', 'CmdOrCtrl+L'), click: menuCmd('add-selection') },
        { label: 'Edit Selection with Claude', accelerator: accel('Edit Selection with the Agent', 'CmdOrCtrl+K'), click: menuCmd('inline-edit') },
        { label: 'Cycle Mode', accelerator: accel('Cycle Mode', 'CmdOrCtrl+.'), click: menuCmd('cycle-mode') },
        { label: 'Toggle Sidebar', accelerator: accel('Toggle Sidebar', 'CmdOrCtrl+B'), click: menuCmd('toggle-sidebar') },
        { label: 'Switch Between Code and Desk View', click: menuCmd('toggle-view') },
        { label: 'Toggle Terminal', accelerator: accel('Toggle Terminal', 'CmdOrCtrl+`'), click: menuCmd('toggle-terminal') },
        { label: 'Split Editor', accelerator: accel('Split Editor', 'CmdOrCtrl+\\'), click: menuCmd('split') },
        { label: 'Compare Active File With…', click: menuCmd('compare') },
        { label: 'Source Control', accelerator: accel('Show Source Control', 'CmdOrCtrl+Shift+G'), click: menuCmd('source-control') },
        { label: 'Preview', accelerator: accel('Preview', 'CmdOrCtrl+Shift+V'), click: menuCmd('preview') },
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
        { type: 'separator' },
        { label: 'Report a Problem…', click: () => reportProblem() },
        { label: "What's New", click: () => shell.openExternal(`${report.REPO}/releases`) },
        { label: 'Read the Guide', click: () => shell.openExternal(`${report.REPO}#readme`) },
        ...(isMac ? [] : [{ type: 'separator' }, { label: 'About Switchdesk', click: menuCmd('about') }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Opens a new GitHub issue, filled in with the version, the system and the installed agents (and
// the error and agent, when it's from a chat). You read it and submit it yourself.
async function reportProblem({ agent, error } = {}) {
  const list = await Promise.all(Object.entries(agents.AGENTS).map(async ([id, a]) => ({ label: a.label, installed: !!(await agents.findBin(id, settings).catch(() => null)) })));
  const label = agent && agents.AGENTS[agent] ? agents.AGENTS[agent].label : null;
  shell.openExternal(report.issueUrl({ version: app.getVersion(), electron: process.versions.electron, agents: list, agent: label, error }));
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
  if (!firstInstance) return;
  worktrees.setBaseDir(path.join(app.getPath('userData'), 'worktrees'));
  accounts.setBaseDir(path.join(app.getPath('userData'), 'accounts'));
  agents.setAccountsBase(path.join(app.getPath('userData'), 'agent-accounts'));
  usage.setBaseDir(app.getPath('userData'));
  codebase.setBaseDir(app.getPath('userData'));
  loadSettings();
  nativeTheme.themeSource = settings.theme || 'system';
  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url);
    // The search model and its runtime, downloaded into userData (see codebase.js).
    if (pathname.startsWith('/models/')) {
      const file = path.normalize(path.join(codebase.modelsDir(), decodeURIComponent(pathname.slice(8))));
      if (!file.startsWith(codebase.modelsDir())) return new Response('Forbidden', { status: 403 });
      return net.fetch(pathToFileURL(file).toString());
    }
    const file = path.normalize(path.join(APP_ROOT, decodeURIComponent(pathname)));
    if (!file.startsWith(APP_ROOT)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  registerIpc();
  buildMenu();
  handoff.start(app.getPath('userData'), handoffAsk).catch(() => {});
  if (settings.phone && settings.phone.on) startPhone().catch((e) => (phoneError = `Couldn't start it: ${e.message}`));
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
  handoff.stop();
  for (const ix of codeIndexes) ix.saveNow().catch(() => {});
  if (langServers) langServers.stopAll();
  if (autocomplete.copilot.lsp) autocomplete.copilot.lsp.kill();
  rememberWindows();
  quitting = true;
  saveSettingsNow();
});
// Anything saved while the windows closed.
app.on('will-quit', () => settingsTimer && saveSettingsNow());

app.on('window-all-closed', () => {
  for (const key of [...chats.keys()]) closeChat(key);
  terminal.killAll();
  if (process.platform !== 'darwin') app.quit();
});

// Rebuild the window list in the menu when focus moves.
app.on('browser-window-focus', () => process.platform !== 'darwin' && buildMenu());
