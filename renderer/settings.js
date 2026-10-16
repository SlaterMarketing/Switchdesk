/* global $, h, state, desk, toast, applyTheme, checkCli, showSetup */
'use strict';

// ------------------------------------------------------------------ settings page
//
// Instructions, permissions and MCP servers are Claude Code's own files, so whatever is set here
// also applies when you run `claude` in a terminal.

const SETTINGS_SECTIONS = [
  ['general', 'General'],
  ['agents', 'Agents'],
  ['accounts', 'Claude accounts'],
  ['instructions', 'Instructions'],
  ['permissions', 'Permissions'],
  ['mcp', 'MCP servers'],
  ['autocomplete', 'Autocomplete'],
  ['usage', 'Usage'],
];

function openSettings(section = 'general') {
  if ($('.settings-backdrop')) return;
  const body = h('div', { class: 'settings-body' });
  const nav = h('nav', { class: 'settings-nav' });
  const close = () => {
    root.remove();
    removeEventListener('keydown', onKey);
  };
  const onKey = (e) => e.key === 'Escape' && !e.defaultPrevented && close();
  const root = h(
    'div',
    { class: 'settings-backdrop', onmousedown: (e) => e.target === root && close() },
    h('div', { class: 'settings-card' }, h('div', { class: 'settings-top' }, h('b', {}, 'Settings'), h('span', { class: 'spacer' }), h('button', { class: 'icon-btn', title: 'Close', onclick: close }, '✕')), h('div', { class: 'settings-main' }, nav, body))
  );
  const show = (id) => {
    nav.replaceChildren(...SETTINGS_SECTIONS.map(([k, label]) => h('button', { class: k === id ? 'active' : '', 'data-section': k, onclick: () => show(k) }, label)));
    body.replaceChildren(h('div', { class: 'muted small' }, 'Loading…'));
    const render = { general: settingsGeneral, agents: settingsAgents, accounts: settingsAccounts, instructions: settingsInstructions, permissions: settingsPermissions, mcp: settingsMcp, autocomplete: settingsAutocomplete, usage: settingsUsage }[id];
    render(body, close).catch((e) => body.replaceChildren(h('div', { class: 'turn-error' }, String(e.message || e))));
  };
  document.body.append(root);
  addEventListener('keydown', onKey);
  show(section);
}

const field = (label, control, hint) => h('label', { class: 'set-field' }, h('span', {}, label), control, hint ? h('span', { class: 'muted small' }, hint) : null);

async function settingsGeneral(body, close) {
  const s = await desk.getSettings();
  const status = await desk.cliStatus();
  const pathInput = h('input', { type: 'text', value: s.claudePath || '', placeholder: status.found ? status.path : 'Auto-detect', spellcheck: 'false' });
  const theme = h('select', {}, ...['system', 'dark', 'light'].map((t) => h('option', { value: t, selected: (s.theme || 'system') === t }, t[0].toUpperCase() + t.slice(1))));
  const save = async () => {
    state.settings = await desk.setSettings({ claudePath: pathInput.value.trim(), theme: theme.value });
    applyTheme();
    if (typeof retheme === 'function') retheme();
    await checkCli();
    toast('Saved.');
  };
  theme.addEventListener('change', save);
  pathInput.addEventListener('change', save);
  const signedIn = status.found && (status.auth ? status.auth.loggedIn : true);
  body.replaceChildren(
    h('h3', {}, 'General'),
    field('Theme', theme),
    field('Claude Code location', pathInput, 'Leave blank and Switchdesk finds it for you.'),
    h(
      'div',
      { class: 'set-box' },
      h('div', {}, status.found ? `Claude Code ${status.version}` : 'Claude Code is not installed.'),
      h('div', { class: 'muted small' }, signedIn ? `Signed in${status.auth && status.auth.authMethod === 'claude.ai' ? ' with your Claude subscription' : ''}.` : 'Not signed in.'),
      h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => (close(), showSetup()) }, signedIn ? 'Open setup again' : 'Set up now'))
    )
  );
}

async function settingsInstructions(body) {
  const files = await desk.cfg.memory();
  const shared = await desk.cfg.rulesShared();
  const project = files.find((f) => f.id === 'project');
  const share = state.folder
    ? h(
        'div',
        { class: `set-box${shared ? '' : ' warn-box'}` },
        shared
          ? h('div', { class: 'small' }, '✓ Every agent follows AGENTS.md. CLAUDE.md starts with "@AGENTS.md", so Claude reads it too.')
          : h(
              'div',
              { class: 'row' },
              h('div', { class: 'small', style: 'flex:1' }, project && project.content.trim() ? 'Only Claude reads CLAUDE.md. Share its rules with every agent: they move into AGENTS.md, and CLAUDE.md points Claude at it.' : 'Claude reads CLAUDE.md and the other agents read AGENTS.md. Have Claude read AGENTS.md too, so one file holds the rules for every agent.'),
              h('button', {
                class: 'btn small primary',
                onclick: async () => {
                  const r = await desk.cfg.shareRules();
                  toast(r && r.moved ? 'Moved your rules into AGENTS.md. Every agent follows them now.' : 'Claude reads AGENTS.md too now.');
                  settingsInstructions(body);
                },
              }, 'Use one file for every agent')
            )
      )
    : null;
  body.replaceChildren(
    h('h3', {}, 'Instructions'),
    h('p', { class: 'muted small' }, 'Agents read these at the start of every chat. Use them for house rules, like "use British English" or "run npm test after changes". Codex, Cursor, Copilot and Kimi read AGENTS.md themselves; Switchdesk passes it to Gemini, Qwen and DeepSeek.'),
    ...(share ? [share] : []),
    ...files.map((f) => {
      const ta = h('textarea', { class: 'set-md', spellcheck: 'false', placeholder: 'Empty. Write instructions in plain English or Markdown.' });
      ta.value = f.content;
      const saveBtn = h('button', { class: 'btn small primary', disabled: true }, 'Save');
      ta.addEventListener('input', () => (saveBtn.disabled = ta.value === f.content));
      saveBtn.addEventListener('click', async () => {
        await desk.cfg.saveMemory(f.id, ta.value);
        f.content = ta.value;
        saveBtn.disabled = true;
        toast(`Saved ${f.label.split(' (')[0].toLowerCase()} instructions. New chats pick them up.`);
      });
      return h('div', { class: 'set-box' }, h('div', { class: 'row' }, h('b', {}, f.label), h('span', { class: 'spacer' }), saveBtn), ta);
    })
  );
}

async function settingsPermissions(body) {
  const scopes = await desk.cfg.permissions();
  const ruleInput = h('input', { type: 'text', placeholder: 'e.g. Bash(npm test *)  or  WebFetch(domain:github.com)', spellcheck: 'false' });
  const scopeSel = h('select', {}, ...scopes.map((s) => h('option', { value: s.id }, s.label)));
  const add = async () => {
    const rule = ruleInput.value.trim();
    if (!rule) return;
    await desk.cfg.rule(scopeSel.value, rule, true);
    settingsPermissions(body);
  };
  ruleInput.addEventListener('keydown', (e) => e.key === 'Enter' && add());
  body.replaceChildren(
    h('h3', {}, 'Permissions'),
    h('p', { class: 'muted small' }, 'Actions Claude may take without asking. "Always allow" on an approval adds a rule here.'),
    ...scopes.map((s) =>
      h(
        'div',
        { class: 'set-box' },
        h('b', {}, s.label),
        s.allow.length
          ? h(
              'div',
              { class: 'rules' },
              ...s.allow.map((r) =>
                h('div', { class: 'rule' }, h('code', {}, r), h('span', { class: 'spacer' }), h('button', { class: 'icon-btn', title: 'Remove', onclick: async () => (await desk.cfg.rule(s.id, r, false), settingsPermissions(body)) }, '✕'))
              )
            )
          : h('div', { class: 'muted small' }, 'Nothing pre-approved.'),
        s.deny.length ? h('div', { class: 'muted small' }, `Always blocked: ${s.deny.join(', ')}`) : null
      )
    ),
    h('div', { class: 'set-box' }, h('b', {}, 'Add a rule'), h('div', { class: 'row' }, ruleInput, scopeSel, h('button', { class: 'btn small primary', onclick: add }, 'Add')))
  );
}

async function settingsMcp(body) {
  body.replaceChildren(h('h3', {}, 'MCP servers'), h('div', { class: 'muted small' }, 'Checking your servers…'));
  const { servers, raw } = await desk.cfg.mcpList();
  const name = h('input', { type: 'text', placeholder: 'Name, e.g. github', spellcheck: 'false' });
  const transport = h('select', {}, h('option', { value: 'http' }, 'URL (HTTP)'), h('option', { value: 'sse' }, 'URL (SSE)'), h('option', { value: 'stdio' }, 'Command'));
  const target = h('input', { type: 'text', placeholder: 'https://example.com/mcp', spellcheck: 'false' });
  transport.addEventListener('change', () => (target.placeholder = transport.value === 'stdio' ? 'npx -y some-mcp-server' : 'https://example.com/mcp'));
  const out = h('pre', { class: 'setup-log hidden' });
  const addBtn = h('button', { class: 'btn small primary' }, 'Add');
  addBtn.addEventListener('click', async () => {
    if (!name.value.trim() || !target.value.trim()) return toast('Give the server a name and a URL or command.');
    addBtn.disabled = true;
    const r = await desk.cfg.mcpAdd({ name: name.value.trim(), target: target.value.trim(), transport: transport.value });
    addBtn.disabled = false;
    if (!r.ok) {
      out.textContent = r.out;
      out.classList.remove('hidden');
    } else settingsMcp(body);
  });
  body.replaceChildren(
    h('h3', {}, 'MCP servers'),
    h('p', { class: 'muted small' }, 'Tools Claude can use, like GitHub, Linear or a database. New chats pick up changes.'),
    h(
      'div',
      { class: 'set-box' },
      servers.length
        ? h(
            'div',
            { class: 'rules' },
            ...servers.map((s) =>
              h(
                'div',
                { class: 'rule' },
                h('b', {}, s.name),
                h('span', { class: 'muted small mcp-detail', title: s.detail }, s.detail),
                h('span', { class: 'spacer' }),
                h(
                  'button',
                  {
                    class: 'icon-btn',
                    title: 'Remove',
                    onclick: async () => {
                      if (!confirm(`Remove the ${s.name} MCP server?`)) return;
                      const r = await desk.cfg.mcpRemove(s.name);
                      if (!r.ok) toast(r.out.split('\n')[0]);
                      settingsMcp(body);
                    },
                  },
                  '✕'
                )
              )
            )
          )
        : h('div', { class: 'muted small' }, raw && !/No MCP servers/i.test(raw) ? raw.slice(0, 400) : 'No MCP servers yet.')
    ),
    h('div', { class: 'set-box' }, h('b', {}, 'Add a server'), h('div', { class: 'row' }, name, transport), target, h('div', { class: 'row' }, h('span', { class: 'spacer' }), addBtn), out)
  );
}

// ------------------------------------------------------------------ usage

const fmtTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const fmtCost = (n) => (!n ? '$0' : n < 0.01 ? '<$0.01' : n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`);

function usageLabel(key) {
  if (key.startsWith('claude:')) return multiAccount() ? `Claude · ${accountName(key.slice(7))}` : 'Claude';
  return agentInfo(key).label || key;
}

function agoText(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const hrs = Math.round(m / 60);
  return hrs < 48 ? `${hrs} hour${hrs > 1 ? 's' : ''} ago` : `${Math.round(hrs / 24)} days ago`;
}

function resetText(at) {
  if (!at) return '';
  const t = typeof at === 'number' ? (at < 1e12 ? at * 1000 : at) : Date.parse(at);
  if (!t || t < Date.now()) return '';
  const d = new Date(t);
  const sameDay = d.toDateString() === new Date().toDateString();
  return `resets ${sameDay ? '' : d.toLocaleDateString(undefined, { weekday: 'short' }) + ' '}${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

async function settingsUsage(body) {
  await loadAccounts();
  const { keys, limits } = await desk.usage.summary();
  const all = [...new Set([...Object.keys(limits), ...Object.keys(keys)])].sort((a, b) => ((keys[b] && keys[b].month.input + keys[b].month.output) || 0) - ((keys[a] && keys[a].month.input + keys[a].month.output) || 0));
  const bar = (label, w) =>
    w &&
    h(
      'div',
      { class: 'usage-limit' },
      h('span', {}, label),
      h('div', { class: `usage-bar${w.pct >= 90 ? ' high' : w.pct >= 70 ? ' mid' : ''}` }, h('i', { style: `width:${Math.min(100, Math.max(0, w.pct))}%` })),
      h('span', { class: 'muted small' }, `${w.pct}% used${resetText(w.resetsAt) ? ' · ' + resetText(w.resetsAt) : ''}`)
    );
  const boxes = all.map((key) => {
    const k = keys[key];
    const lim = limits[key];
    const isClaude = key.startsWith('claude:');
    const hasCost = k && k.month.cost > 0;
    const row = (label, get) => h('tr', {}, h('th', {}, label), ...['today', 'week', 'month'].map((r) => h('td', {}, get(k[r]))));
    return h(
      'div',
      { class: 'set-box' },
      h('div', { class: 'row' }, h('b', {}, usageLabel(key)), h('span', { class: 'spacer' }), lim ? h('span', { class: 'muted small' }, `Plan limits as of ${agoText(lim.at)}`) : null),
      lim ? bar('5-hour window', lim.short) : null,
      lim ? bar('Weekly', lim.long) : null,
      k
        ? h(
            'table',
            { class: 'usage-table' },
            h('tr', {}, h('th', {}), h('th', {}, 'Today'), h('th', {}, 'Last 7 days'), h('th', {}, 'Last 30 days')),
            row('Turns', (x) => String(x.turns)),
            row('Tokens in', (x) => fmtTokens(x.input)),
            row('Tokens out', (x) => fmtTokens(x.output)),
            hasCost ? row(isClaude ? 'Cost at API prices' : 'Cost', (x) => fmtCost(x.cost)) : null
          )
        : h('div', { class: 'muted small' }, 'No chats in Switchdesk yet.'),
      hasCost && isClaude ? h('div', { class: 'muted small' }, 'On a Claude plan your plan covers this. The cost shows what the same use would come to on an API key.') : null
    );
  });
  body.replaceChildren(
    h('h3', {}, 'Usage'),
    h('p', { class: 'muted small' }, "What each agent and Claude account has used in Switchdesk. Tokens in includes the conversation each turn re-reads. Plan limits are as the agent last reported them, so they update after each chat turn."),
    ...(boxes.length ? boxes : [h('div', { class: 'muted small' }, 'Nothing yet. Usage shows here once you’ve chatted with an agent.')])
  );
}
