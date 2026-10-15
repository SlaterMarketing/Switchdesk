/* global $, h, state, desk, toast, chats, activeChat, createChat, isPristine, appendChat, renderChatTabs, renderAccountPill, openSettings, field, newTerminal, toggleTerminal, queueSaveWorkspace */
'use strict';

// ------------------------------------------------------------------ agents
//
// Each chat runs on one agent: Claude Code, Codex, Kimi, or an API-key model (Gemini, Qwen,
// DeepSeek). The picker in the chat box chooses it. Each agent is the vendor's own CLI, signed in
// its own way; Settings → Agents installs them and signs them in, in the app's terminal.

const agentState = { list: [], status: new Map(), models: new Map() };
const CLAUDE_MODELS = [
  ['', 'Default model'],
  ['opus', 'Opus'],
  ['sonnet', 'Sonnet'],
  ['haiku', 'Haiku'],
  ['fable', 'Fable'],
];

const agentOf = (chat) => (chat && chat.agent) || 'claude';
const agentInfo = (id) => agentState.list.find((a) => a.id === id) || { id, label: id === 'claude' ? 'Claude' : id, kind: id === 'claude' ? 'claude' : 'acp' };
const agentLabel = (chat) => agentInfo(agentOf(chat)).label;

async function loadAgents() {
  agentState.list = await desk.agents.list();
  renderAgentPicker();
}

async function agentStatus(id, fresh) {
  if (!fresh && agentState.status.has(id)) return agentState.status.get(id);
  const s = await desk.agents.status(id).catch((e) => ({ installed: false, detail: String(e.message || e) }));
  agentState.status.set(id, s);
  return s;
}

// ---------- the picker and the controls that depend on it

function renderAgentPicker() {
  const sel = $('#agent-select');
  if (!sel || !agentState.list.length) return;
  const current = agentOf(activeChat());
  sel.replaceChildren(...agentState.list.map((a) => h('option', { value: a.id, selected: a.id === current }, a.label)));
  sel.title = `This chat runs on ${agentInfo(current).label}${agentInfo(current).vendor ? ` (${agentInfo(current).vendor})` : ''}`;
  renderModelPicker();
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
    opts = [['', 'Default model'], ...(extra.length ? extra.map((m) => [m.id, m.label]) : fallback)];
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

// Picking an agent: a fresh chat switches over; a chat with history opens a new tab, since a
// conversation can't move between vendors.
async function pickAgent(id) {
  let chat = activeChat();
  if (!chat || agentOf(chat) === id) return;
  if (!isPristine(chat) || chat.worktree) {
    chat = createChat();
    toast(`New chat on ${agentInfo(id).label}. Your other chat is still in its tab.`);
  }
  chat.agent = id;
  state.settings.lastAgent = id;
  desk.setSettings({ lastAgent: id });
  renderChatTabs();
  renderAgentPicker();
  queueSaveWorkspace();
  $('#input').focus();
  const s = await agentStatus(id);
  if (!s.installed || !s.loggedIn) openSettings('agents');
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
      if (a.id === 'claude') btns.push(h('button', { class: 'btn small', onclick: () => openSettings('accounts') }, 'Claude accounts'));
      else {
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
    return card;
  });
  body.replaceChildren(
    h('h3', {}, 'Agents'),
    h('p', { class: 'muted small' }, 'Pick the agent for each chat in the chat box. Each one is the official app from its maker, running on this computer with your own sign-in or API key. Switchdesk never sees your logins, and API keys are stored encrypted on this computer.'),
    ...cards
  );
}

function keyForm(a, rerender) {
  const key = h('input', { type: 'password', placeholder: a.hasKey ? 'Saved. Paste a new key to replace it.' : `Paste your ${a.key.name}`, spellcheck: 'false', autocomplete: 'off' });
  const showAdvanced = a.options && a.options.baseUrl;
  const base = h('input', { type: 'text', value: (a.options && a.options.baseUrl) || '', spellcheck: 'false' });
  const model = h('input', { type: 'text', value: (a.options && a.options.model) || '', placeholder: 'Default', spellcheck: 'false' });
  const save = h('button', { class: 'btn small primary' }, 'Save');
  save.addEventListener('click', async () => {
    await desk.agents.setKey(a.id, { key: key.value.trim() ? key.value.trim() : undefined, baseUrl: base.value, model: model.value });
    agentState.status.delete(a.id);
    agentState.models.delete(a.id);
    toast(`Saved ${a.label} settings.`);
    rerender();
  });
  const clear = h('button', { class: 'btn small', onclick: async () => (await desk.agents.setKey(a.id, { key: '', baseUrl: base.value, model: model.value }), agentState.status.delete(a.id), rerender()) }, 'Remove key');
  return h(
    'div',
    { class: 'agent-key' },
    h('div', { class: 'row' }, key, save, a.hasKey ? clear : null),
    h('div', { class: 'muted small' }, 'Get a key at ', h('a', { href: '#', onclick: (e) => (e.preventDefault(), desk.openExternal(a.key.url)) }, a.key.url.replace(/^https:\/\//, '').replace(/\/$/, '')), '. Usage is billed to your account by the provider.'),
    showAdvanced ? h('details', {}, h('summary', { class: 'muted small' }, 'Endpoint and model'), field('API address', base), field('Model', model)) : field('Model', model)
  );
}

function codexKeyForm(rerender) {
  const key = h('input', { type: 'password', placeholder: 'Or paste an OpenAI API key', spellcheck: 'false', autocomplete: 'off' });
  const save = h('button', { class: 'btn small' }, 'Use API key');
  save.addEventListener('click', async () => {
    if (!key.value.trim()) return key.focus();
    const r = await desk.agents.codexKey(key.value);
    agentState.status.delete('codex');
    toast(r.ok ? 'Codex will use your API key.' : `Codex didn't accept it: ${r.out}`);
    rerender();
  });
  return h('div', { class: 'agent-key' }, h('div', { class: 'row' }, key, save), h('div', { class: 'muted small' }, 'Codex stores the key itself, the same as `codex login --with-api-key`.'));
}

function wireAgents() {
  $('#agent-select').addEventListener('change', (e) => pickAgent(e.target.value));
}

// Reopens a saved non-Claude chat. Its history lives in that agent's own files, so the tab starts
// with a note, and the next message carries the conversation on.
function reopenAgentChat(saved) {
  const chat = isPristine(activeChat()) && !activeChat().worktree ? activeChat() : createChat();
  chat.agent = saved.agent;
  chat.sessionId = saved.sessionId;
  chat.title = (saved.title || 'Chat').slice(0, 60);
  if (saved.worktree) chat.worktree = saved.worktree;
  chat.el.replaceChildren();
  appendChat(h('div', { class: 'notice' }, `Continuing your ${agentInfo(saved.agent).label} conversation "${chat.title}". Earlier messages are in ${agentInfo(saved.agent).label}'s own history; new messages carry on from them.`), chat);
  renderChatTabs();
  renderAgentPicker();
}
