/* global $, h, state, desk, toast, chats, activeChat, createChat, isPristine, appendChat, renderChatTabs, renderAccountPill, openSettings, field, newTerminal, toggleTerminal, queueSaveWorkspace,
   acct, multiAccount, accountName, chatAccount, accountStatus, accountDetail, switchChatAccount, setAccounts, checkCli, switchChat, renderPast, agentLabel, claudeAccountsBox, sendToSeveral */
'use strict';

// ------------------------------------------------------------------ agents
//
// Each chat runs on one agent: Claude Code, Codex, Kimi, or an API-key model (Gemini, Qwen,
// DeepSeek). The picker in the chat box chooses it. Each agent is the vendor's own CLI, signed in
// its own way; Settings → Agents installs them and signs them in, in the app's terminal.

const agentState = { list: [], status: new Map(), models: new Map() };
const CLAUDE_MODELS = [
  ['', 'Model'],
  ['opus', 'Opus'],
  ['sonnet', 'Sonnet'],
  ['haiku', 'Haiku'],
  ['fable', 'Fable'],
];

const agentOf = (chat) => (chat && chat.agent) || 'claude';
// Agents other than Claude can have several accounts too (Settings → Agents). 'default' is the main one.
const agentAccounts = (id) => (agentInfo(id).accounts || []).length ? agentInfo(id).accounts : [{ id: 'default', name: 'Main account' }];
const agentAccountOf = (chat) => {
  const id = agentOf(chat);
  return chat && chat.agentAccount && agentAccounts(id).some((x) => x.id === chat.agentAccount) ? chat.agentAccount : 'default';
};
const agentAccountName = (id, account) => (agentAccounts(id).find((x) => x.id === account) || { name: 'Main account' }).name;
const statusKey = (id, account) => (!account || account === 'default' ? id : `${id}:${account}`);
const agentInfo = (id) => agentState.list.find((a) => a.id === id) || { id, label: id === 'claude' ? 'Claude' : id, kind: id === 'claude' ? 'claude' : 'acp' };
const agentLabel = (chat) => agentInfo(agentOf(chat)).label;

async function loadAgents() {
  agentState.list = await desk.agents.list();
  renderAgentPicker();
  // Find out which agents (and their accounts) are ready, so the menu lists only those.
  for (const a of agentState.list) if (a.id !== 'claude') for (const x of agentAccounts(a.id)) agentStatus(a.id, false, x.id).then(refreshAgentMenu);
}

async function agentStatus(id, fresh, account) {
  const k = statusKey(id, account);
  if (!fresh && agentState.status.has(k)) return agentState.status.get(k);
  const s = await desk.agents.status(id, account && account !== 'default' ? account : undefined).catch((e) => ({ installed: false, detail: String(e.message || e) }));
  agentState.status.set(k, s);
  return s;
}

// ---------- the picker and the controls that depend on it

function renderAgentPicker() {
  renderAgentButton();
  renderModelPicker();
}

// The button names the agent, and for Claude with several accounts, the account too.
function renderAgentButton() {
  const btn = $('#agent-btn');
  if (!btn) return;
  const chat = activeChat();
  const id = agentOf(chat);
  const info = agentInfo(id);
  const account = id === 'claude' ? (multiAccount() ? accountName(chatAccount(chat)) : '') : agentAccounts(id).length > 1 ? agentAccountName(id, agentAccountOf(chat)) : '';
  btn.textContent = account ? `${info.label} · ${account}` : info.label;
  btn.title = `This chat runs on ${info.label}${account ? ` (${account} account)` : info.vendor ? ` (${info.vendor})` : ''}. Click to change.`;
}

// ---------- the agent menu: every Claude account and every other agent that's ready to use

function toggleAgentMenu() {
  const old = $('#agent-menu');
  if (old) return old.remove();
  const menu = h('div', { id: 'agent-menu', class: 'popup' });
  $('#agent-wrap').append(menu);
  fillAgentMenu(menu, true);
  const away = (e) => {
    if (!menu.isConnected) return removeEventListener('mousedown', away, true);
    if (!menu.contains(e.target) && e.target !== $('#agent-btn')) {
      menu.remove();
      removeEventListener('mousedown', away, true);
    }
  };
  addEventListener('mousedown', away, true);
}

function refreshAgentMenu() {
  const menu = $('#agent-menu');
  if (menu) fillAgentMenu(menu);
}

const pendingStatus = new Set();

function fillAgentMenu(menu, fresh) {
  const chat = activeChat();
  const current = agentOf(chat);
  const currentAccount = chatAccount(chat);
  const close = () => menu.remove();
  const row = (active, title, vendor, detail, onclick) => h('button', { class: active ? 'active' : '', onclick: () => (close(), onclick()) }, h('b', {}, title), vendor ? h('span', { class: 'agent-vendor' }, vendor) : null, h('span', { class: 'acct-detail' }, detail));
  const rows = [];
  // Claude: one row per account that's signed in (or still being checked).
  for (const a of acct.accounts) {
    const auth = acct.status.get(a.id);
    if (!acct.status.has(a.id)) accountStatus(a.id).then(refreshAgentMenu);
    else if (!auth || !auth.loggedIn) continue;
    rows.push(row(current === 'claude' && currentAccount === a.id, multiAccount() ? `Claude · ${a.name}` : 'Claude', 'Anthropic', accountDetail(auth), () => chooseAgent('claude', a.id)));
  }
  // Other agents: one row per account that's signed in, or has a key.
  let checking = 0;
  let hidden = 0;
  for (const a of agentState.list) {
    if (a.id === 'claude') continue;
    const several = agentAccounts(a.id).length > 1;
    let shown = 0;
    for (const x of agentAccounts(a.id)) {
      const k = statusKey(a.id, x.id);
      if (!agentState.status.has(k)) {
        checking++;
        if (!pendingStatus.has(k)) pendingStatus.add(k), agentStatus(a.id, false, x.id).then(() => (pendingStatus.delete(k), refreshAgentMenu()));
        continue;
      }
      const s = agentState.status.get(k);
      // Not ready last time: look again (it may have been signed in since), and show it if so.
      if ((!s || !s.installed || !s.loggedIn) && fresh && !pendingStatus.has(k)) pendingStatus.add(k), agentStatus(a.id, true, x.id).then((n) => (pendingStatus.delete(k), n && n.loggedIn && refreshAgentMenu()));
      if (!s || !s.installed || !s.loggedIn) continue;
      shown++;
      rows.push(row(current === a.id && agentAccountOf(chat) === x.id, several ? `${a.label} · ${x.name}` : a.label, a.vendor, s.detail || 'Ready', () => chooseAgent(a.id, x.id)));
    }
    if (!shown && agentState.status.has(a.id)) hidden++;
  }
  const folder = state.folder;
  const ruled = folder && current === 'claude' && acct.rules[folder.root] === currentAccount;
  const items = [
    h('div', { class: 'menu-head' }, 'Run this chat on'),
    ...rows,
    checking ? h('div', { class: 'menu-note' }, 'Checking your other agents…') : null,
    h('div', { class: 'menu-sep' }),
    folder && current === 'claude' && multiAccount()
      ? h(
          'button',
          {
            title: ruled ? 'Stop tying this folder to an account' : `New chats in ${folder.name} use ${accountName(currentAccount)}`,
            onclick: async () => {
              close();
              setAccounts(await desk.accounts.setRule(folder.root, ruled ? null : currentAccount));
              toast(ruled ? `${folder.name} now uses your default account (${accountName(acct.folderAccount)}).` : `New chats in ${folder.name} will use ${accountName(currentAccount)}.`);
              checkCli();
            },
          },
          h('b', {}, `${ruled ? '✓ ' : ''}Always use ${accountName(currentAccount)} in ${folder.name}`)
        )
      : null,
    h('button', { onclick: () => (close(), sendToSeveral()) }, h('b', {}, 'Send to several agents and compare…')),
    h('button', { onclick: () => (close(), openSettings('agents')) }, h('b', {}, hidden ? `Set up more agents (${hidden} more), or add accounts…` : 'Agents and accounts…')),
  ];
  menu.replaceChildren(...items.filter(Boolean));
}

async function chooseAgent(id, account) {
  if (agentOf(activeChat()) !== id) await pickAgent(id, id === 'claude' ? undefined : account);
  else if (id !== 'claude' && account && agentAccountOf(activeChat()) !== account) await switchAgentAccount(activeChat(), account);
  if (id === 'claude' && account) await switchChatAccount(activeChat(), account);
  renderAgentButton();
}

// Another account of the same agent. Its conversations are kept by that account, so a chat with
// history carries on in the same tab, with the new account given the conversation so far.
async function switchAgentAccount(chat, account) {
  const id = agentOf(chat);
  if (!isPristine(chat) && !handOverInPlace(chat, `This conversation started on another ${agentInfo(id).label} account, and you're taking it over. Here it is so far, so you can carry on. The files are as they were left.`, `Carrying on on ${agentAccountName(id, account)}. It gets the conversation so far along with your next message.`)) return;
  chat.agentAccount = account;
  renderChatTabs();
  renderAgentPicker();
  queueSaveWorkspace();
  const s = await agentStatus(id, false, account);
  if (!s.installed || !s.loggedIn) openSettings('agents');
}

// Moves a chat with history to another agent or account without leaving the tab: the old
// conversation ends, and the next message starts a new one that's given everything so far.
function handOverInPlace(chat, intro, notice) {
  if (chat.busy) {
    toast(`${agentLabel(chat)} is still working. Stop it or wait for it to finish, then switch.`);
    return false;
  }
  const note = handoffNote(chat, intro);
  desk.chatClose(chat.id);
  chat.sessionId = null;
  chat.resumeAt = null;
  chat.lastReply = null;
  chat.usage.context = 0;
  chat.handoff = note || null;
  // Rewinding to a message from before the switch would need the old conversation, which is closed.
  for (const b of chat.el.querySelectorAll('.rewind-btn')) b.remove();
  appendChat(h('div', { class: 'notice handover' }, notice), chat);
  return true;
}

function renderModelPicker() {
  const id = agentOf(activeChat());
  const sel = $('#model-select');
  const saved = id === 'claude' ? state.settings.model || '' : (state.settings.agentModels || {})[id] || '';
  let opts = CLAUDE_MODELS;
  if (id !== 'claude') {
    const info = agentInfo(id);
    const extra = agentState.models.get(id) || [];
    const fallback = info.options && info.options.model ? [[info.options.model, info.options.model]] : [];
    opts = [['', 'Model'], ...(extra.length ? extra.map((m) => [m.id, m.label]) : fallback)];
    if (id === 'codex' && !agentState.models.has(id)) {
      agentState.models.set(id, []);
      desk.agents.models(id).then((list) => {
        agentState.models.set(id, list);
        if (agentOf(activeChat()) === id) renderModelPicker();
      });
    }
  }
  if (saved && !opts.some(([v]) => v === saved)) opts = [...opts, [saved, saved]];
  sel.replaceChildren(...opts.map(([v, label]) => h('option', { value: v, selected: v === saved }, label)));
  sel.value = saved;
  // Effort applies to Claude and Codex only.
  $('#effort-select').classList.toggle('hidden', !(id === 'claude' || id === 'codex'));
  renderAccountPill();
}

function saveModelChoice(value) {
  const id = agentOf(activeChat());
  if (id === 'claude') {
    state.settings.model = value;
    desk.setSettings({ model: value });
  } else {
    const agentModels = { ...(state.settings.agentModels || {}), [id]: value };
    state.settings.agentModels = agentModels;
    desk.setSettings({ agentModels });
  }
}

// Picking an agent: the chat stays in its tab. One with history carries on, with the new agent
// given the conversation so far along with your next message.
async function pickAgent(id, account) {
  const chat = activeChat();
  if (!chat || agentOf(chat) === id) return;
  if (!isPristine(chat)) {
    const from = agentLabel(chat);
    if (!handOverInPlace(chat, null, `Switched from ${from} to ${agentInfo(id).label}. It gets the conversation so far along with your next message, and the files are as ${from} left them.`)) return;
  }
  chat.agent = id;
  chat.agentAccount = account && account !== 'default' ? account : undefined;
  state.settings.lastAgent = id;
  desk.setSettings({ lastAgent: id });
  renderChatTabs();
  renderAgentPicker();
  queueSaveWorkspace();
  $('#input').focus();
  const s = await agentStatus(id, false, account);
  if (!s.installed || !s.loggedIn) openSettings('agents');
}

// The conversation so far, as text another agent can pick up from: what you asked, what the agent
// said and did, and the files it changed. The most recent part is kept when it's long.
function handoffNote(from, intro) {
  const who = agentLabel(from);
  const lines = [];
  for (const el of from.el.querySelectorAll('.msg-user, .msg-text, .tool .head .label, .card.changes .name')) {
    if (el.closest('.msg-user') && !el.classList.contains('msg-user')) continue;
    if (el.classList.contains('msg-user')) lines.push(`User: ${[...el.childNodes].filter((n) => !(n.classList && n.classList.contains('rewind-btn'))).map((n) => n.textContent).join('').trim()}`);
    else if (el.classList.contains('msg-text')) lines.push(`${who}: ${el.innerText.trim()}`);
    else if (el.closest('.card.changes')) lines.push(`(${who} changed ${el.textContent.trim()})`);
    else lines.push(`(${who} ran: ${el.textContent.trim()})`);
  }
  if (!lines.length) return '';
  let text = lines.join('\n\n');
  if (text.length > 16000) text = `${lines[0]}\n\n[…earlier messages left out…]\n\n${text.slice(-14000)}`;
  intro = intro || `This conversation started with ${who}, and you're taking it over. Here it is so far, so you can carry on. The files are as ${who} left them.`;
  return `<switchdesk-context>\n${intro}\n\n${text}\n</switchdesk-context>\n\n`;
}

// ---------- Settings → Agents

// Runs a command in a new terminal tab, so you can see it and answer any prompts.
async function runInTerminal(cmd) {
  const t = await newTerminal();
  toggleTerminal(true);
  if (t) setTimeout(() => desk.term.write(t.id, cmd + '\r'), 700);
}

async function settingsAgents(body, close) {
  await loadAgents();
  const rerender = () => settingsAgents(body, close);
  const cards = agentState.list.map((a) => {
    const statusEl = h('div', { class: 'muted small' }, 'Checking…');
    const actions = h('div', { class: 'row' });
    const card = h('div', { class: 'set-box agent-card' }, h('div', { class: 'row' }, h('b', {}, a.label), h('span', { class: 'muted small' }, a.vendor), h('span', { class: 'spacer' }), h('span', { class: 'agent-dot' })), a.help ? h('div', { class: 'muted small' }, a.help) : null, statusEl, actions);
    agentStatus(a.id, true).then((s) => {
      $('.agent-dot', card).className = `agent-dot ${s.installed && s.loggedIn ? 'ok' : s.installed ? 'warn' : 'bad'}`;
      statusEl.textContent = !s.installed ? 'Not installed.' : `${s.version ? s.version + ' · ' : ''}${s.detail || (s.loggedIn ? 'Ready' : 'Not signed in')}`;
      const btns = [];
      if (a.id !== 'claude') {
        if (!s.installed)
          btns.push(
            h('button', {
              class: 'btn small primary',
              onclick: async () => {
                close();
                await runInTerminal(await desk.agents.command(a.id, 'install'));
                toast(`Installing ${a.label} in the terminal. Come back to Settings → Agents when it finishes.`);
              },
            }, `Install ${a.label}`)
          );
        if (s.installed && a.canLogin)
          btns.push(
            h('button', {
              class: `btn small${s.loggedIn ? '' : ' primary'}`,
              onclick: async () => {
                close();
                await runInTerminal(await desk.agents.command(a.id, 'login'));
                toast(`Finish signing in to ${a.label} in the terminal, then send your message.`);
                agentState.status.delete(a.id);
              },
            }, s.loggedIn ? 'Sign in again' : 'Sign in')
          );
      }
      actions.replaceChildren(...btns);
    });
    if (a.key) card.append(keyForm(a, rerender));
    if (a.id === 'codex') card.append(codexKeyForm(rerender));
    if (a.id === 'claude') card.append(claudeAccountsBox(rerender));
    else if (a.canAddAccounts) card.append(agentAccountsBox(a, rerender, close));
    card.dataset.agent = a.id;
    return card;
  });
  const scroll = (body.closest('.settings-body') || body).scrollTop;
  body.replaceChildren(
    h('h3', {}, 'Agents'),
    h('p', { class: 'muted small' }, 'Pick the agent for each chat in the chat box. Each one is the official app from its maker, running on this computer with your own sign-in or API key. Switchdesk never sees your logins, and API keys are stored encrypted on this computer.'),
    ...cards
  );
  (body.closest('.settings-body') || body).scrollTop = scroll; // a change on one card keeps your place
}

// The key form for an API-key agent's account (the main one unless account says otherwise).
function keyForm(a, rerender, account) {
  const x = account ? (a.accounts || []).find((y) => y.id === account) || {} : a;
  const key = h('input', { type: 'password', placeholder: x.hasKey ? 'Saved. Paste a new key to replace it.' : `Paste your ${a.key.name}`, spellcheck: 'false', autocomplete: 'off' });
  const showAdvanced = x.options && x.options.baseUrl;
  const base = h('input', { type: 'text', value: (x.options && x.options.baseUrl) || '', spellcheck: 'false' });
  const model = h('input', { type: 'text', value: (x.options && x.options.model) || '', placeholder: 'Default', spellcheck: 'false' });
  const save = h('button', { class: 'btn small primary' }, 'Save');
  save.addEventListener('click', async () => {
    await desk.agents.setKey(a.id, { key: key.value.trim() ? key.value.trim() : undefined, baseUrl: base.value, model: model.value }, account);
    agentState.status.delete(statusKey(a.id, account));
    agentState.models.delete(a.id);
    toast(`Saved ${a.label} settings.`);
    rerender();
  });
  const clear = h('button', { class: 'btn small', onclick: async () => (await desk.agents.setKey(a.id, { key: '', baseUrl: base.value, model: model.value }, account), agentState.status.delete(statusKey(a.id, account)), rerender()) }, 'Remove key');
  return h(
    'div',
    { class: 'agent-key' },
    h('div', { class: 'row' }, key, save, x.hasKey ? clear : null),
    h('div', { class: 'muted small' }, 'Get a key at ', h('a', { href: '#', onclick: (e) => (e.preventDefault(), desk.openExternal(a.key.url)) }, a.key.url.replace(/^https:\/\//, '').replace(/\/$/, '')), '. Usage is billed to your account by the provider.'),
    showAdvanced ? h('details', {}, h('summary', { class: 'muted small' }, 'Endpoint and model'), field('API address', base), field('Model', model)) : field('Model', model)
  );
}

function codexKeyForm(rerender, account) {
  const key = h('input', { type: 'password', placeholder: 'Or paste an OpenAI API key', spellcheck: 'false', autocomplete: 'off' });
  const save = h('button', { class: 'btn small' }, 'Use API key');
  save.addEventListener('click', async () => {
    if (!key.value.trim()) return key.focus();
    const r = await desk.agents.codexKey(key.value, account);
    agentState.status.delete(statusKey('codex', account));
    toast(r.ok ? 'Codex will use your API key.' : `Codex didn't accept it: ${r.out}`);
    rerender();
  });
  return h('div', { class: 'agent-key' }, h('div', { class: 'row' }, key, save), h('div', { class: 'muted small' }, 'Codex stores the key itself, the same as `codex login --with-api-key`.'));
}

// More accounts for one agent, each with its own sign-in (or key), chat history and settings.
function agentAccountsBox(a, rerender, close) {
  const extra = (a.accounts || []).filter((x) => x.id !== 'default');
  const rows = extra.map((x) => {
    const detail = h('span', { class: 'muted small' }, 'Checking…');
    const btns = h('span', { class: 'row' });
    agentStatus(a.id, true, x.id).then((s) => {
      detail.textContent = !s.installed ? 'Not installed.' : s.detail || (s.loggedIn ? 'Ready' : 'Not signed in');
      if (s.installed && a.canLogin)
        btns.replaceChildren(
          h('button', {
            class: `btn small${s.loggedIn ? '' : ' primary'}`,
            onclick: async () => {
              close();
              await runInTerminal(await desk.agents.command(a.id, 'login', x.id));
              toast(`Sign in to ${a.label} as ${x.name} in the terminal. Use the browser profile for that account.`);
              agentState.status.delete(statusKey(a.id, x.id));
            },
          }, s.loggedIn ? 'Sign in again' : 'Sign in')
        );
    });
    const name = h('b', { class: 'acct-name', title: 'Click to rename', contenteditable: 'plaintext-only', spellcheck: 'false' }, x.name);
    name.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), name.blur()));
    name.addEventListener('blur', async () => {
      if (name.textContent.trim() && name.textContent.trim() !== x.name) (await desk.agents.renameAccount(a.id, x.id, name.textContent), rerender());
      else name.textContent = x.name;
    });
    const remove = h('button', {
      class: 'btn small danger',
      onclick: async () => {
        if (chats.some((c) => c.busy && agentOf(c) === a.id && agentAccountOf(c) === x.id)) return toast(`A chat is still running on ${x.name}. Stop it first.`);
        if (!confirm(`Remove ${x.name}? Switchdesk deletes its ${a.label} sign-in, chat history and settings on this computer. The account itself isn't affected.`)) return;
        await desk.agents.removeAccount(a.id, x.id);
        for (const c of chats) if (agentOf(c) === a.id && c.agentAccount === x.id) c.agentAccount = undefined;
        agentState.status.delete(statusKey(a.id, x.id));
        rerender();
      },
    }, 'Remove');
    return h(
      'div',
      { class: 'acct-block' },
      h('div', { class: 'acct-row' }, h('div', { class: 'acct-who' }, name, h('br'), detail), h('span', { class: 'spacer' }), btns, remove),
      a.key ? keyForm(a, rerender, x.id) : null,
      a.id === 'codex' ? codexKeyForm(rerender, x.id) : null
    );
  });
  const nameInput = h('input', { type: 'text', placeholder: 'Name, e.g. Work', spellcheck: 'false' });
  const add = async () => {
    const n = nameInput.value.trim();
    if (!n) return nameInput.focus();
    await desk.agents.addAccount(a.id, n);
    toast(a.key ? `Added ${n}. Paste its key below.` : `Added ${n}. Click Sign in next to it.`);
    rerender();
  };
  nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && add());
  return h(
    'details',
    { class: 'agent-accounts', open: extra.length ? '' : null },
    h('summary', { class: 'muted small' }, extra.length ? `More ${a.label} accounts (${extra.length})` : `Add another ${a.label} account`),
    ...rows,
    h('div', { class: 'row' }, nameInput, h('button', { class: 'btn small', onclick: add }, 'Add account')),
    h('div', { class: 'muted small' }, a.key ? 'Each account uses its own key. Pick the account for a chat from the agent menu in the chat box.' : `Each account has its own ${a.label} sign-in and chat history. Pick it for a chat from the agent menu in the chat box.`)
  );
}

function wireAgents() {
  $('#agent-btn').addEventListener('click', toggleAgentMenu);
}

// Reopens a saved non-Claude chat. Its history lives in that agent's own files, so the tab starts
// with a note, and the next message carries the conversation on.
function reopenAgentChat(saved) {
  const chat = isPristine(activeChat()) && !activeChat().worktree ? activeChat() : createChat();
  chat.agent = saved.agent;
  chat.agentAccount = saved.agentAccount || undefined;
  chat.sessionId = saved.sessionId;
  chat.title = (saved.title || 'Chat').slice(0, 60);
  if (saved.worktree) chat.worktree = saved.worktree;
  const label = agentInfo(saved.agent).label;
  const loading = h('div', { class: 'notice' }, `Loading your ${label} conversation…`);
  chat.el.replaceChildren(loading);
  renderChatTabs();
  renderAgentPicker();
  switchChat(chat.id);
  // The agent replays its own copy of the conversation. Until then (or if it can't), a note says
  // where the earlier messages are; new messages carry on either way.
  desk.agents
    .history(saved.agent, saved.sessionId, saved.agentAccount || undefined)
    .catch(() => null)
    .then((msgs) => {
      if (!chat.el.contains(loading)) return; // the chat moved on meanwhile
      loading.remove();
      if (msgs && msgs.length) {
        const keep = [...chat.el.childNodes];
        chat.el.replaceChildren();
        renderPast(chat, msgs);
        chat.el.append(...keep);
        appendChat(h('div', { class: 'notice' }, `Continuing this ${label} conversation. New messages carry on from here.`), chat);
      } else appendChat(h('div', { class: 'notice' }, `Continuing your ${label} conversation "${chat.title}". Earlier messages are in ${label}'s own history; new messages carry on from them.`), chat);
    });
}
