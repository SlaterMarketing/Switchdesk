// An MCP server (stdio) that lets an agent use Switchdesk's Preview: open a page, look at it, click,
// type, read the console. Each agent starts it as a child process; the tool calls go over HTTP to
// the Switchdesk window that started the chat (preview-bridge.js), which drives its Preview tab.
//
// Runs under Electron as plain Node (ELECTRON_RUN_AS_NODE), with SWITCHDESK_PREVIEW_URL set.
'use strict';

const URL = process.env.SWITCHDESK_PREVIEW_URL;

const TOOLS = [
  {
    name: 'preview_open',
    description:
      "Open the user's Preview (the browser pane inside Switchdesk, next to the code) at a URL, such as the local dev server (http://localhost:5173). Leave url out to show the page it's on now. Use this to check your changes in the running app.",
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'The address to open. Optional.' } } },
  },
  {
    name: 'preview_screenshot',
    description: 'Take a screenshot of the page in the Preview, to see what the user sees.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'preview_page',
    description: "The page in the Preview as text: its address, title, visible text, and the buttons, links and fields on it (with a CSS selector for each, for preview_click and preview_type).",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'preview_click',
    description: 'Click something on the page in the Preview, by CSS selector or by its visible text.',
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string', description: 'Visible text of the button or link, if there is no good selector.' } } },
  },
  {
    name: 'preview_type',
    description: 'Type into a field on the page in the Preview (found by CSS selector), replacing what is there. Set submit to press Enter afterwards.',
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' } }, required: ['selector', 'text'] },
  },
  {
    name: 'preview_console',
    description: "The page's recent console output and errors, newest last, since the page last loaded.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'preview_eval',
    description: 'Run a JavaScript expression in the page in the Preview and get its result (as JSON). For reading state the other tools do not show.',
    inputSchema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] },
  },
];

const write = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

async function call(name, args) {
  if (!URL) return { content: [{ type: 'text', text: 'The Preview is not available (Switchdesk did not pass its address).' }], isError: true };
  try {
    const res = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, args: args || {} }) });
    const r = await res.json();
    if (r.error) return { content: [{ type: 'text', text: r.error }], isError: true };
    const content = [];
    if (r.text) content.push({ type: 'text', text: r.text });
    if (r.image) content.push({ type: 'image', data: r.image, mimeType: 'image/png' });
    return { content: content.length ? content : [{ type: 'text', text: 'Done.' }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Couldn't reach Switchdesk: ${err.message}. Is the window still open?` }], isError: true };
  }
}

async function handle(m) {
  if (m.method === 'initialize')
    return write({ id: m.id, result: { protocolVersion: (m.params && m.params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'switchdesk-preview', version: '1.0.0' } } });
  if (m.method === 'tools/list') return write({ id: m.id, result: { tools: TOOLS } });
  if (m.method === 'tools/call') return write({ id: m.id, result: await call(m.params.name, m.params.arguments) });
  if (m.method === 'ping') return write({ id: m.id, result: {} });
  if (m.id !== undefined && m.method) write({ id: m.id, error: { code: -32601, message: `Unknown method ${m.method}` } });
}

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    handle(m).catch((err) => m.id !== undefined && write({ id: m.id, error: { code: -32000, message: String(err.message || err) } }));
  }
});
process.stdin.on('end', () => process.exit(0));
