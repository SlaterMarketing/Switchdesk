// Debug mode's log collector. The agent adds temporary logging to the code that sends each event
// here (an HTTP POST, so it works from Node, Python, a browser page or anything else), you reproduce
// the bug, and the chat sends what came in back to the agent. One channel per chat.
'use strict';

const http = require('http');
const crypto = require('crypto');

const MAX = 2 * 1024 * 1024; // per channel
let server = null;
let port = 0;
const channels = new Map(); // token -> { chatKey, lines, bytes, onLine }

function start() {
  if (server) return Promise.resolve(port);
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
      if (req.method === 'OPTIONS') return res.writeHead(204).end();
      const m = /^\/log\/([\w-]+)/.exec(req.url || '');
      const ch = m && channels.get(m[1]);
      if (!ch) return res.writeHead(404).end();
      if (req.method === 'GET') {
        // GET /log/<token>?msg=… for code that can only make a simple request.
        const msg = new URL(req.url, 'http://x').searchParams.get('msg');
        if (msg) add(ch, msg);
        return res.writeHead(204).end();
      }
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 64 * 1024) req.destroy();
      });
      req.on('end', () => {
        add(ch, body);
        res.writeHead(204).end();
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve(port);
    });
  });
}

function add(ch, body) {
  let text = String(body || '').trim();
  try {
    const j = JSON.parse(text);
    text = typeof j === 'string' ? j : JSON.stringify(j);
  } catch {
    /* plain text */
  }
  if (!text) return;
  const line = `${new Date().toISOString().slice(11, 23)} ${text.slice(0, 4000)}`;
  if (ch.bytes + line.length > MAX) return;
  ch.lines.push(line);
  ch.bytes += line.length;
  ch.onLine(ch.lines.length);
}

// The URL a chat's instrumentation posts to. Reuses the chat's channel.
async function open(chatKey, onLine) {
  await start();
  let token = [...channels].find(([, c]) => c.chatKey === chatKey)?.[0];
  if (!token) {
    token = crypto.randomBytes(6).toString('hex');
    channels.set(token, { chatKey, lines: [], bytes: 0, onLine });
  } else channels.get(token).onLine = onLine;
  return `http://127.0.0.1:${port}/log/${token}`;
}

// What came in since last time, and clears it.
function take(chatKey) {
  const entry = [...channels].find(([, c]) => c.chatKey === chatKey);
  if (!entry) return [];
  const lines = entry[1].lines;
  entry[1].lines = [];
  entry[1].bytes = 0;
  return lines;
}

function close(chatKey) {
  for (const [t, c] of channels) if (c.chatKey === chatKey) channels.delete(t);
}

module.exports = { open, take, close };
