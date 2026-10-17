// Code intelligence: go to definition, hover, completions and errors from the language servers
// the user has installed (the same ones VS Code and other editors use). One server per language
// per folder, started the first time a file of that language opens.
'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');
const { Lsp } = require('./lsp-client');

const isWin = process.platform === 'win32';

function versionOf(bin) {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 15000, windowsHide: true, shell: isWin && /\.(cmd|bat)$/i.test(bin) }, (err, out) => resolve(err ? '' : String(out)));
  });
}

const SERVERS = {
  typescript: {
    label: 'TypeScript and JavaScript',
    languages: ['typescript', 'javascript'],
    // TypeScript 7 has its own language server (`tsc --lsp`); older versions need typescript-language-server.
    bins: ['tsc', 'typescript-language-server'],
    args: ['--stdio'],
    argsFor: { tsc: ['--lsp', '--stdio'] },
    accept: async (name, bin) => name !== 'tsc' || Number((/Version (\d+)/.exec(await versionOf(bin)) || [])[1]) >= 7,
    install: 'npm install -g typescript',
    // typescript-language-server looks for TypeScript in the project; fall back to the copy beside it.
    initOptions(bin) {
      if (!/typescript-language-server/.test(bin)) return undefined;
      const libs = [];
      try {
        let dir = path.dirname(fs.realpathSync(bin));
        while (dir !== path.dirname(dir) && path.basename(dir) !== 'node_modules') dir = path.dirname(dir);
        libs.push(path.join(dir, 'typescript', 'lib'));
      } catch {}
      // An older TypeScript elsewhere on PATH (TypeScript 7 no longer ships tsserver).
      for (const d of (process.env.PATH || '').split(path.delimiter)) {
        for (const n of isWin ? ['tsc.cmd', 'tsc'] : ['tsc']) {
          try {
            const real = fs.realpathSync(path.join(d, n));
            libs.push(path.join(path.dirname(real), '..', 'lib'));
            if (isWin) libs.push(path.join(d, 'node_modules', 'typescript', 'lib'));
          } catch {}
        }
      }
      const lib = libs.find((l) => fs.existsSync(path.join(l, 'tsserver.js')));
      return lib ? { tsserver: { fallbackPath: lib } } : undefined;
    },
  },
  python: { label: 'Python', languages: ['python'], bins: ['pyright-langserver', 'basedpyright-langserver', 'pylsp'], args: ['--stdio'], argsFor: { pylsp: [] }, install: 'npm install -g pyright' },
  go: { label: 'Go', languages: ['go'], bins: ['gopls'], args: [], install: 'go install golang.org/x/tools/gopls@latest' },
  rust: { label: 'Rust', languages: ['rust'], bins: ['rust-analyzer'], args: [], install: 'rustup component add rust-analyzer' },
  cpp: { label: 'C and C++', languages: ['c', 'cpp'], bins: ['clangd'], args: [], install: isWin ? 'winget install LLVM.LLVM' : process.platform === 'darwin' ? 'brew install llvm' : 'sudo apt install clangd' },
};

const serverFor = (languageId) => Object.keys(SERVERS).find((id) => SERVERS[id].languages.includes(languageId));

// The languageId servers expect, which for React files differs from Monaco's.
function lspLanguage(languageId, file) {
  if (/\.tsx$/i.test(file)) return 'typescriptreact';
  if (/\.jsx$/i.test(file)) return 'javascriptreact';
  return languageId;
}

const CLIENT_CAPS = {
  textDocument: {
    synchronization: { dynamicRegistration: false, didSave: false, willSave: false },
    hover: { contentFormat: ['markdown', 'plaintext'] },
    completion: { completionItem: { snippetSupport: true, documentationFormat: ['markdown', 'plaintext'], deprecatedSupport: true, labelDetailsSupport: true }, contextSupport: true },
    signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'], parameterInformation: { labelOffsetSupport: true } } },
    definition: { linkSupport: true },
    typeDefinition: { linkSupport: true },
    implementation: { linkSupport: true },
    references: {},
    publishDiagnostics: { relatedInformation: false, versionSupport: false },
    diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
  },
  workspace: { workspaceFolders: true, configuration: true },
  window: { workDoneProgress: false, showMessage: {} },
  general: { positionEncodings: ['utf-16'] },
};

// File URIs for this machine's paths, or for a host's (SSH folders), whose paths are always POSIX.
function uriOf(file, host) {
  return host ? 'file://' + file.split('/').map(encodeURIComponent).join('/') : pathToFileURL(file).href;
}
function fileOf(uri, host) {
  return host ? decodeURIComponent(new URL(uri).pathname) : fileURLToPath(uri);
}

class LangServers {
  // find(names) locates a command; env() gives the child environment; onDiagnostics(file, list).
  // host: an SSH folder's connection, to run the servers there (installed on that machine).
  constructor({ find, env, version, onDiagnostics, host }) {
    this.host = host || null;
    this.find = find;
    this.env = env;
    this.version = version;
    this.onDiagnostics = onDiagnostics;
    this.running = new Map(); // `${id}|${root}` -> { lsp, ready, docs: Map(uri -> version), caps }
    this.bins = new Map(); // id -> path or null, cached for a minute
  }

  async binFor(id, override) {
    if (override && !this.host && fs.existsSync(override)) return override;
    const hit = this.bins.get(id);
    if (hit && Date.now() - hit.at < 60000) return hit.path;
    const def = SERVERS[id];
    let p = null;
    for (const name of def.bins) {
      const found = await this.find([name]);
      if (found && (!def.accept || (await this.accepts(def, name, found)))) {
        p = found;
        break;
      }
    }
    this.bins.set(id, { path: p, at: Date.now() });
    return p;
  }

  async accepts(def, name, bin) {
    if (!this.host) return def.accept(name, bin);
    if (name !== 'tsc') return true;
    const r = await this.host.exec([bin, '--version']).catch(() => null);
    return Number((/Version (\d+)/.exec(r ? r.stdout.toString() : '') || [])[1]) >= 7;
  }

  async status(overrides = {}, disabled = []) {
    const out = [];
    for (const [id, s] of Object.entries(SERVERS)) {
      const bin = await this.binFor(id, overrides[id]);
      out.push({ id, label: s.label, bin, install: s.install, enabled: !disabled.includes(id), running: [...this.running.keys()].some((k) => k.startsWith(id + '|')) });
    }
    return out;
  }

  async server(id, root, override) {
    const key = `${id}|${root}`;
    const known = this.running.get(key);
    if (known) return known.ready;
    const bin = await this.binFor(id, override);
    if (!bin) return null;
    const def = SERVERS[id];
    const name = path.basename(bin).replace(/\.(cmd|exe)$/i, '');
    const args = (def.argsFor && def.argsFor[name]) || def.args;
    const via = this.host && this.host.spawnArgs(root, [bin, ...args]);
    const lsp = via ? new Lsp(via.command, via.args, await this.env(), `The ${def.label} language server on ${this.host.spec}`) : new Lsp(bin, args, await this.env(), `The ${def.label} language server`, root);
    const entry = { lsp, docs: new Map(), caps: {} };
    this.running.set(key, entry);
    lsp.onExit = () => {
      if (this.running.get(key) === entry) this.running.delete(key);
    };
    lsp.onNote = (method, p) => {
      if (method === 'textDocument/publishDiagnostics' && p && p.uri) {
        let file;
        try {
          file = fileOf(p.uri, this.host);
        } catch {
          return;
        }
        this.onDiagnostics(file, p.diagnostics || []);
      }
    };
    entry.ready = (async () => {
      const r = await lsp.request(
        'initialize',
        {
          processId: this.host ? null : process.pid,
          clientInfo: { name: 'Switchdesk', version: this.version },
          rootUri: uriOf(root, this.host),
          rootPath: root,
          workspaceFolders: [{ uri: uriOf(root, this.host), name: path.posix.basename(root.replace(/\\/g, '/')) }],
          capabilities: CLIENT_CAPS,
          initializationOptions: def.initOptions && !this.host ? def.initOptions(bin) : undefined,
        },
        60000
      );
      entry.caps = (r && r.capabilities) || {};
      lsp.notify('initialized', {});
      return entry;
    })().catch((e) => {
      lsp.kill();
      this.running.delete(key);
      throw e;
    });
    return entry.ready;
  }

  // doc: { file, languageId, text, root }. Returns the server entry, or null when there's none.
  async open(doc, overrides = {}, disabled = []) {
    const id = serverFor(doc.languageId);
    if (!id || disabled.includes(id)) return null;
    const entry = await this.server(id, doc.root, overrides[id]);
    if (!entry) return { missing: id, label: SERVERS[id].label, install: SERVERS[id].install };
    const uri = uriOf(doc.file, this.host);
    if (!entry.docs.has(uri)) {
      entry.docs.set(uri, 1);
      entry.lsp.notify('textDocument/didOpen', { textDocument: { uri, languageId: lspLanguage(doc.languageId, doc.file), version: 1, text: doc.text } });
      this.pull(entry, doc.file, uri);
    }
    const caps = entry.caps;
    return {
      server: id,
      label: SERVERS[id].label,
      completionTriggers: (caps.completionProvider && caps.completionProvider.triggerCharacters) || [],
      signatureTriggers: (caps.signatureHelpProvider && caps.signatureHelpProvider.triggerCharacters) || [],
    };
  }

  entryFor(file) {
    const uri = uriOf(file, this.host);
    for (const e of this.running.values()) if (e.docs.has(uri)) return { e, uri };
    return null;
  }

  change(file, text) {
    const hit = this.entryFor(file);
    if (!hit) return;
    const v = hit.e.docs.get(hit.uri) + 1;
    hit.e.docs.set(hit.uri, v);
    hit.e.lsp.notify('textDocument/didChange', { textDocument: { uri: hit.uri, version: v }, contentChanges: [{ text }] });
    this.pull(hit.e, file, hit.uri);
  }

  // Servers that wait to be asked for errors (TypeScript 7 does) instead of sending them.
  pull(entry, file, uri) {
    if (!entry.caps.diagnosticProvider) return;
    entry.pulls = entry.pulls || new Map();
    clearTimeout(entry.pulls.get(uri));
    entry.pulls.set(
      uri,
      setTimeout(async () => {
        entry.pulls.delete(uri);
        const r = await entry.lsp.request('textDocument/diagnostic', { textDocument: { uri } }, 30000).catch(() => null);
        if (r && r.kind === 'full' && entry.docs.has(uri)) this.onDiagnostics(file, r.items || []);
      }, 300)
    );
  }

  close(file) {
    const hit = this.entryFor(file);
    if (!hit) return;
    hit.e.docs.delete(hit.uri);
    hit.e.lsp.notify('textDocument/didClose', { textDocument: { uri: hit.uri } });
    this.onDiagnostics(file, []);
  }

  // A request about a position in an open file: hover, definition, references, completion, signatureHelp.
  async request(file, method, params) {
    const hit = this.entryFor(file);
    if (!hit) return null;
    return hit.e.lsp.request(method, { textDocument: { uri: hit.uri }, ...params }, 20000).catch(() => null);
  }

  stopAll() {
    for (const e of this.running.values()) {
      e.lsp.request('shutdown', null, 2000).catch(() => {}).finally(() => e.lsp.kill());
    }
    this.running.clear();
  }
}

module.exports = { LangServers, SERVERS, serverFor, fileOf };
