/* global $, h, state, desk, toast, applyTheme, checkCli, showSetup */
'use strict';

// ------------------------------------------------------------------ settings page
//
// Instructions, permissions and MCP servers are Claude Code's own files, so whatever is set here
// also applies when you run `claude` in a terminal.

const SETTINGS_SECTIONS = [
  ['general', 'General'],
  ['accounts', 'Accounts'],
  ['instructions', 'Instructions'],
  ['permissions', 'Permissions'],
  ['mcp', 'MCP servers'],
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
    const render = { general: settingsGeneral, accounts: settingsAccounts, instructions: settingsInstructions, permissions: settingsPermissions, mcp: settingsMcp }[id];
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
    field('Claude Code location', pathInput, 'Leave blank and Claude Desk finds it for you.'),
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
  body.replaceChildren(
    h('h3', {}, 'Instructions'),
    h('p', { class: 'muted small' }, 'Claude reads these at the start of every chat. Use them for house rules, like "use British English" or "run npm test after changes".'),
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
