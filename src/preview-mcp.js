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

const AGENT = process.env.SWITCHDESK_AGENT || '';

// Connecting services. Claude Code connects to them itself (and to claude.ai connectors); the other
// agents get Switchdesk's own connections, whose tools are listed alongside these (mcp-gateway.js).
TOOLS.push({
  name: 'connect_mcp_server',
  description:
    AGENT === 'claude'
      ? "Connect the user to a service or MCP server (Jira, Google Sheets, Google Drive, Gmail, Slack, Linear, Notion, GitHub or any claude.ai connector), or sign them in to one that needs authentication. Also use it when a connector's tools are missing, such as one the user turned on after this chat started. Switchdesk opens the sign-in page in the user's browser and waits (up to 4 minutes) for them to finish, then its tools are ready (straight away, or from the user's next message when this chat has to reload). Use this whenever the user asks to connect to a service or a server needs authentication, instead of telling them to run /mcp. Pass the server's name as it's listed (\"claude.ai Atlassian Rovo\", say). If it isn't set up at all, Switchdesk opens claude.ai's connector directory in the browser for the user to add it, and waits. Only pass url to add a server by its provider's official remote MCP address, when claude.ai has no connector for it. If you're not sure of the name, give your best guess: when nothing matches, the answer lists the servers that are set up."
      : "Connect the user to a service through its remote MCP server (Jira, Linear, Notion, Sentry, Asana, Stripe and others), signing them in through their browser, so you can use its tools. Use this whenever the user asks to connect to a service or its tools are missing, instead of telling them to edit config files. Pass the service's name. Switchdesk knows the address of many services; for others, also pass url: the provider's official remote MCP address. Switchdesk opens the sign-in page and, once the user has signed in, the tools load with their next message. If it says the sign-in is still open, tell the user to finish it in their browser.",
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: "The service or server's name." },
      url: { type: 'string', description: 'Only for a server Switchdesk does not know: its official remote MCP address (https://…).' },
    },
    required: ['name'],
  },
});

const write = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

const ask = (name, args) => fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, args: args || {}, agent: AGENT }) }).then((res) => res.json());

async function call(name, args) {
  if (!URL) return { content: [{ type: 'text', text: 'The Preview is not available (Switchdesk did not pass its address).' }], isError: true };
  try {
    // A connected service's tool: Switchdesk passes the call on and its answer back as it is.
    if (!TOOLS.some((t) => t.name === name)) return (await ask('gateway_call', { tool: name, arguments: args })).mcp || { content: [{ type: 'text', text: `There's no tool called ${name}.` }], isError: true };
    const r = await ask(name, args);
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
  if (m.method === 'tools/list') {
    const more = AGENT && AGENT !== 'claude' && URL ? await ask('gateway_tools').catch(() => ({})) : {};
    return write({ id: m.id, result: { tools: [...TOOLS, ...(more.tools || [])] } });
  }
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
