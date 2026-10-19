// The other end of preview-mcp.js: a local HTTP endpoint per window. A tool call from an agent
// arrives here, goes to that window's renderer (which drives the Preview tab), and the answer goes
// back to the agent. The token in the address picks the window, so only agents we started can use it.
'use strict';

const http = require('http');
const path = require('path');
const crypto = require('crypto');

let server = null;
let port = 0;
const windows = new Map(); // token -> send(name, args) => Promise<result>

function start() {
  if (server) return Promise.resolve(port);
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const m = /^\/preview\/([\w-]+)$/.exec(req.url || '');
      const run = m && windows.get(m[1]);
      if (!run || req.method !== 'POST') return res.writeHead(404).end();
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 256 * 1024) req.destroy();
      });
      req.on('end', async () => {
        let out;
        try {
          const { name, args, agent } = JSON.parse(body || '{}');
          out = await run(name, args || {}, agent || '');
        } catch (err) {
          out = { error: String(err.message || err) };
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out || {}));
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve(port);
    });
  });
}

// The address for one window, made on first use.
async function urlFor(ctx, run) {
  await start();
  if (!ctx.previewToken) {
    ctx.previewToken = crypto.randomUUID();
    windows.set(ctx.previewToken, run);
  }
  return `http://127.0.0.1:${port}/preview/${ctx.previewToken}`;
}

function forget(ctx) {
  if (ctx.previewToken) windows.delete(ctx.previewToken);
}

// How an agent starts the MCP server: this app's own executable, running as Node. Packaged, the
// script is unpacked from the asar so a plain Node process can read it.
// agent is which one starts it, since some tools are only for Claude Code.
function serverSpec(url, agent) {
  const script = path.join(__dirname, 'preview-mcp.js').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  return { name: 'switchdesk-preview', command: process.execPath, args: [script], env: { ELECTRON_RUN_AS_NODE: '1', SWITCHDESK_PREVIEW_URL: url, SWITCHDESK_AGENT: agent || '' } };
}

module.exports = { urlFor, forget, serverSpec };
