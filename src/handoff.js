// Other apps handing work to Switchdesk (handoff-mcp.js is their end): a local HTTP endpoint whose
// address and token are written to a file only this user can read, and the entries that add
// Switchdesk to Claude Desktop's and Cursor's MCP settings.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

let server = null;
let file = '';

// ask(name, args, from) answers each call.
function start(dataDir, ask) {
  if (server) return Promise.resolve();
  file = path.join(dataDir, 'handoff.json');
  const token = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== `/handoff/${token}`) return res.writeHead(404).end();
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 1024 * 1024) req.destroy();
      });
      req.on('end', async () => {
        let out;
        try {
          const { name, args, from } = JSON.parse(body || '{}');
          out = name === 'ping' ? { ok: true } : await ask(String(name), args || {}, String(from || 'another app'));
        } catch (err) {
          out = { error: String(err.message || err) };
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out || {}));
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      fs.writeFileSync(file, JSON.stringify({ port: server.address().port, token, pid: process.pid }), { mode: 0o600 });
      resolve();
    });
  });
}

function stop() {
  if (!server) return;
  server.close();
  server = null;
  try {
    fs.unlinkSync(file);
  } catch {
    /* gone */
  }
}

// How another app starts the MCP server: this app's own executable, running as Node, and how it
// opens Switchdesk when it isn't running. Packaged, the script is unpacked from the asar.
function serverSpec({ execPath, appRoot, packaged, dataDir }) {
  const script = path.join(__dirname, 'handoff-mcp.js').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  return {
    command: execPath,
    args: [script],
    env: { ELECTRON_RUN_AS_NODE: '1', SWITCHDESK_HANDOFF: path.join(dataDir, 'handoff.json'), SWITCHDESK_LAUNCH: JSON.stringify(packaged ? [execPath] : [execPath, appRoot]) },
  };
}

// Where each app keeps its MCP servers.
function configFile(appName, home = os.homedir()) {
  if (appName === 'cursor') return path.join(home, '.cursor', 'mcp.json');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  return path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
}

// Claude Desktop from the Microsoft Store keeps its settings in its own package folder, not the
// usual one. Both get the entry, so it works whichever is installed.
function configFiles(appName, home = os.homedir()) {
  const files = [configFile(appName, home)];
  if (appName !== 'cursor' && process.platform === 'win32') {
    const pkgs = path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Packages');
    let names = [];
    try {
      names = fs.readdirSync(pkgs).filter((n) => /^Claude_/i.test(n));
    } catch {
      /* no Store apps */
    }
    for (const n of names) files.push(path.join(pkgs, n, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'));
  }
  return files;
}

// Adds (or updates) Switchdesk in an app's MCP settings, keeping everything else in the file.
function addTo(appName, spec, home) {
  const files = configFiles(appName, home);
  for (const f of files) addToFile(f, spec);
  return files[files.length - 1];
}

function addToFile(f, spec) {
  let cfg = {};
  if (fs.existsSync(f)) {
    const text = fs.readFileSync(f, 'utf8');
    try {
      cfg = text.trim() ? JSON.parse(text) : {};
    } catch {
      throw new Error(`${f} isn't valid JSON, so Switchdesk left it alone. Fix it or add the entry by hand.`);
    }
  }
  cfg.mcpServers = { ...(cfg.mcpServers || {}), switchdesk: spec };
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n');
  return f;
}

function addedTo(appName, home) {
  return configFiles(appName, home).every((f) => {
    try {
      return !!JSON.parse(fs.readFileSync(f, 'utf8')).mcpServers.switchdesk;
    } catch {
      return false;
    }
  });
}

module.exports = { start, stop, serverSpec, configFile, addTo, addedTo };
