// Tab autocomplete in the editor. The main engine is GitHub's Copilot language server, signed in
// with the user's own GitHub account (Copilot Free works). The fallback is a fill-in-the-middle
// request to DeepSeek or Qwen with the user's saved API key.
'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const cli = require('./claude-cli');
const { Lsp } = require('./lsp-client');

const isWin = process.platform === 'win32';
const PKG = '@github/copilot-language-server';
const INSTALL = `npm install -g ${PKG}`;

// ---------- finding the language server

let npmRoot = null;
function globalRoot() {
  if (npmRoot) return Promise.resolve(npmRoot);
  return cli.childEnv().then(
    (env) =>
      new Promise((resolve) => {
        execFile(isWin ? 'npm.cmd' : 'npm', ['root', '-g'], { env, timeout: 15000, windowsHide: true, shell: isWin }, (err, out) => {
          npmRoot = err ? '' : String(out).trim();
          resolve(npmRoot);
        });
      })
  );
}

async function findServer(override) {
  const tries = [];
  if (override) tries.push(override.endsWith('.js') ? override : path.join(override, 'dist', 'language-server.js'));
  const home = os.homedir();
  if (isWin) tries.push(path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm', 'node_modules', PKG, 'dist', 'language-server.js'));
  else tries.push(path.join(home, '.npm-global', 'lib', 'node_modules', PKG, 'dist', 'language-server.js'), path.join('/usr/local/lib/node_modules', PKG, 'dist', 'language-server.js'), path.join('/opt/homebrew/lib/node_modules', PKG, 'dist', 'language-server.js'));
  for (const p of tries) if (fs.existsSync(p)) return p;
  const root = await globalRoot();
  const p = root && path.join(root, PKG, 'dist', 'language-server.js');
  return p && fs.existsSync(p) ? p : null;
}

// ---------- the Copilot engine

const copilot = {
  lsp: null,
  starting: null,
  status: { signedIn: false, user: '', message: '' },
  docs: new Map(), // uri -> { version, text }
  folders: new Set(),
  onStatus: () => {},
};

function proxySettings() {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  return proxy ? { http: { proxy, proxyStrictSSL: true } } : {};
}

async function startCopilot(settings, version) {
  if (copilot.lsp && !copilot.lsp.closed) return copilot.lsp;
  if (copilot.starting) return copilot.starting;
  copilot.starting = (async () => {
    const script = await findServer((settings.agentPaths || {})['copilot-language-server']);
    if (!script) throw Object.assign(new Error('The Copilot language server is not installed.'), { notInstalled: true });
    // Electron runs it as plain Node, so the user doesn't need a particular Node version.
    const lsp = new Lsp(process.execPath, [script, '--stdio'], { ...(await cli.childEnv()), ELECTRON_RUN_AS_NODE: '1' }, 'The Copilot language server');
    lsp.onRequest = (method, p) => (method === 'workspace/configuration' ? ((p && p.items) || []).map(() => ({})) : null);
    lsp.onNote = (method, p) => {
      if (method === 'didChangeStatus' && p) {
        if (p.kind === 'Error' && /not signed/i.test(p.message || '')) setStatus({ signedIn: false, message: p.message });
        else if (p.kind === 'Normal' && !copilot.status.signedIn) checkCopilot().catch(() => {});
      }
    };
    await lsp.request('initialize', {
      processId: process.pid,
      capabilities: { workspace: { workspaceFolders: true } },
      workspaceFolders: [...copilot.folders].map((d) => ({ uri: pathToFileURL(d).href, name: path.basename(d) })),
      initializationOptions: { editorInfo: { name: 'Switchdesk', version }, editorPluginInfo: { name: 'switchdesk-autocomplete', version } },
    });
    lsp.notify('initialized', {});
    lsp.notify('workspace/didChangeConfiguration', { settings: proxySettings() });
    copilot.docs.clear();
    copilot.lsp = lsp;
    lsp.proc.on('exit', () => {
      if (copilot.lsp === lsp) copilot.lsp = null;
    });
    await checkCopilot();
    return lsp;
  })().finally(() => (copilot.starting = null));
  return copilot.starting;
}

function setStatus(s) {
  copilot.status = { ...copilot.status, ...s };
  copilot.onStatus(copilot.status);
}

async function checkCopilot() {
  const r = await copilot.lsp.request('checkStatus', {});
  const signedIn = r && (r.status === 'OK' || r.status === 'AlreadySignedIn' || r.status === 'MaybeOk');
  setStatus({ signedIn: !!signedIn, user: (r && r.user) || '', message: signedIn ? '' : r && r.status === 'NotAuthorized' ? "This GitHub account doesn't have Copilot. Copilot Free is available at github.com/features/copilot." : '' });
  return copilot.status;
}

// GitHub's device sign-in: the user enters the code on github.com/login/device.
async function signInStart(settings, version) {
  const lsp = await startCopilot(settings, version);
  const r = await lsp.request('signIn', {});
  if (r && (r.status === 'AlreadySignedIn' || r.status === 'OK')) {
    await checkCopilot();
    return { done: true, user: copilot.status.user };
  }
  return { userCode: r.userCode, verificationUri: r.verificationUri || 'https://github.com/login/device', command: r.command };
}

async function signInFinish(command) {
  const lsp = copilot.lsp;
  if (!lsp) throw new Error('The Copilot language server stopped.');
  if (command) await lsp.request('workspace/executeCommand', { command: command.command, arguments: command.arguments || [] }, 15 * 60000);
  return checkCopilot();
}

async function signOut() {
  if (!copilot.lsp) return copilot.status;
  await copilot.lsp.request('signOut', {}).catch(() => {});
  setStatus({ signedIn: false, user: '' });
  return copilot.status;
}

function syncDoc(lsp, doc) {
  const known = copilot.docs.get(doc.uri);
  if (!known) {
    copilot.docs.set(doc.uri, { version: 1, text: doc.text });
    lsp.notify('textDocument/didOpen', { textDocument: { uri: doc.uri, languageId: doc.languageId || 'plaintext', version: 1, text: doc.text } });
  } else if (known.text !== doc.text) {
    known.version++;
    known.text = doc.text;
    lsp.notify('textDocument/didChange', { textDocument: { uri: doc.uri, version: known.version }, contentChanges: [{ text: doc.text }] });
  }
  if (copilot.focused !== doc.uri) {
    copilot.focused = doc.uri;
    lsp.notify('textDocument/didFocus', { textDocument: { uri: doc.uri } });
  }
  return copilot.docs.get(doc.uri).version;
}

function addFolder(dir) {
  if (!dir || copilot.folders.has(dir)) return;
  copilot.folders.add(dir);
  if (copilot.lsp) copilot.lsp.notify('workspace/didChangeWorkspaceFolders', { event: { added: [{ uri: pathToFileURL(dir).href, name: path.basename(dir) }], removed: [] } });
}

async function copilotComplete(settings, version, doc) {
  const lsp = await startCopilot(settings, version);
  if (!copilot.status.signedIn) return { items: [], reason: 'signed-out' };
  const v = syncDoc(lsp, doc);
  const r = await lsp.request(
    'textDocument/inlineCompletion',
    {
      textDocument: { uri: doc.uri, version: v },
      position: { line: doc.line, character: doc.character },
      context: { triggerKind: doc.explicit ? 1 : 2 },
      formattingOptions: { tabSize: doc.tabSize || 4, insertSpaces: doc.insertSpaces !== false },
    },
    15000
  );
  const items = ((r && r.items) || []).map((it) => ({ insertText: typeof it.insertText === 'string' ? it.insertText : (it.insertText && it.insertText.value) || '', range: it.range, command: it.command || null }));
  if (items.length) lsp.notify('textDocument/didShowCompletion', { item: r.items[0] });
  return { items, engine: 'copilot' };
}

function accepted(command) {
  if (copilot.lsp && command && command.command) copilot.lsp.request('workspace/executeCommand', { command: command.command, arguments: command.arguments || [] }).catch(() => {});
}

function closeDoc(uri) {
  if (!copilot.docs.has(uri)) return;
  copilot.docs.delete(uri);
  if (copilot.lsp) copilot.lsp.notify('textDocument/didClose', { textDocument: { uri } });
}

// ---------- the API-key fallback: fill in the middle

const PREFIX_CHARS = 6000;
const SUFFIX_CHARS = 2000;

function splitAt(doc) {
  const lines = doc.text.split('\n');
  let offset = 0;
  for (let i = 0; i < doc.line && i < lines.length; i++) offset += lines[i].length + 1;
  offset += Math.min(doc.character, (lines[doc.line] || '').length);
  return { prefix: doc.text.slice(Math.max(0, offset - PREFIX_CHARS), offset), suffix: doc.text.slice(offset, offset + SUFFIX_CHARS) };
}

// The model may run on past the gap; keep the completion to what fits before the suffix starts.
function trimToGap(text, suffix) {
  const lines = text.replace(/\r/g, '').split('\n');
  const next = (suffix.split('\n').find((l) => l.trim()) || '').trim();
  if (next) {
    const at = lines.findIndex((l, i) => i > 0 && l.trim() && next.startsWith(l.trim()));
    if (at > 0) lines.length = at;
  }
  while (lines.length > 1 && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n');
}

async function fimComplete(provider, doc, signal) {
  const { prefix, suffix } = splitAt(doc);
  if (!prefix.trim()) return { items: [] };
  let url, body;
  const base = (provider.baseUrl || '').replace(/\/+$/, '');
  if (provider.id === 'deepseek') {
    url = `${base.replace(/\/v1$/, '')}/beta/completions`;
    body = { model: 'deepseek-chat', prompt: prefix, suffix, max_tokens: 160, temperature: 0, stop: ['\n\n\n'] };
  } else {
    url = `${base}/completions`;
    body = { model: provider.fimModel || 'qwen2.5-coder-32b-instruct', prompt: `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`, max_tokens: 160, temperature: 0, stop: ['<|endoftext|>', '<|fim_pad|>', '\n\n\n'] };
  }
  const r = await provider.fetch(url, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.key}` }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${provider.label} answered ${r.status}`);
  const j = await r.json();
  const text = trimToGap((j.choices && j.choices[0] && (j.choices[0].text || '')) || '', suffix);
  if (!text.trim()) return { items: [] };
  return { items: [{ insertText: text, range: { start: { line: doc.line, character: doc.character }, end: { line: doc.line, character: doc.character } } }], engine: provider.id };
}

module.exports = { INSTALL, findServer, startCopilot, signInStart, signInFinish, signOut, checkCopilot, copilotComplete, accepted, closeDoc, addFolder, fimComplete, copilot, trimToGap };
