/* global $, h, state, desk, toast, renderMarkdown, toRel, openFile, openDiff, reloadOpenFiles, refreshFiles, renderTree,
   activeTab, activateTab, cliState, showSetup, autoGrow, MODES, MODE_LABEL, EDIT_TOOLS, HIDDEN_TOOLS, refreshGit, reviews, addReviews, dropReviews, revealFirstChange, renderWorktreeBar, refreshWorktree, closeWorktreeChat, openPlanDoc,
   acct, chatAccount, multiAccount, renderAccountPill, noteAccountUsage, signInAccount, agentOf, agentLabel, renderAgentPicker, agentState, agentStatus, agentInfo, reopenAgentChat */
'use strict';

// ------------------------------------------------------------------ chat tabs
//
// Each tab is its own Claude Code conversation backed by its own long-lived process.

const ASK_PREFIX =
  '[Ask mode: answer my question. Do not create, edit or delete files, and do not run commands that change anything.]\n\n';

const chats = []; // { id, title, sessionId, account, el, turn, busy, alwaysAllow, usage, lastReply, resumeAt }
let activeChatId = null;

const activeChat = () => chats.find((c) => c.id === activeChatId) || null;
const chatById = (id) => chats.find((c) => c.id === id) || null;

function emptyState() {
  return h(
    'div',
    { class: 'empty-chat' },
    h('p', {}, h('b', {}, 'Ask'), ' to explore the code, ', h('b', {}, 'Plan'), ' to agree an approach first, or ', h('b', {}, 'Agent'), ' to make changes.'),
    h('p', { class: 'small' }, 'Paste a screenshot with Ctrl+V. Pick the agent below: Claude, Codex, Copilot, Cursor, Kimi or an API-key model. It works in ', state.folder ? state.folder.name : 'the open folder', '.')
  );
}

function createChat({ title = 'New chat', sessionId = null } = {}) {
  const chat = {
    id: crypto.randomUUID(),
    title,
    sessionId,
    account: acct.folderAccount, // which Claude account it runs on (accounts.js)
    agent: (state.settings && state.settings.lastAgent) || 'claude', // which agent runs it (agents.js)
    el: h('div', { class: 'messages-pane' }, emptyState()),
    turn: null,
    busy: false,
    alwaysAllow: new Set(),
    usage: { context: 0, turns: 0, model: '' },
    queue: [],
  };
  chats.push(chat);
  $('#messages-host').append(chat.el);
  switchChat(chat.id);
  return chat;
}

function isPristine(chat) {
  return chat && !chat.sessionId && !chat.busy && !!$('.empty-chat', chat.el);
}

function switchChat(id) {
  activeChatId = id;
  for (const c of chats) c.el.classList.toggle('hidden', c.id !== id);
  renderChatTabs();
  renderChatMeta();
  setRunning(!!activeChat()?.busy);
  renderQueue();
  renderWorktreeBar();
  renderAgentPicker();
  for (const el of document.querySelectorAll('.history-row')) el.classList.toggle('active', el.dataset.session === activeChat()?.sessionId);
}

async function closeChatTab(id) {
  const chat = chatById(id);
  if (!chat) return;
  if (chat.busy && !confirm('Claude is still working in this chat. Stop it and close the tab?')) return;
  if (chat.busy) desk.chatClose(chat.id), (chat.busy = false);
  if (!(await closeWorktreeChat(chat))) return;
  desk.chatClose(chat.id);
  chat.el.remove();
  chats.splice(chats.indexOf(chat), 1);
  if (!chats.length) createChat();
  else if (activeChatId === id) switchChat(chats[chats.length - 1].id);
  else renderChatTabs();
}

function closeAllChats() {
  for (const c of [...chats]) {
    desk.chatClose(c.id);
    c.el.remove();
  }
  chats.length = 0;
}

function renderChatTabs() {
  queueSaveWorkspace();
  const strip = $('#chat-tabs');
  strip.replaceChildren(
    ...chats.map((c) =>
      h(
        'div',
        { class: `chat-tab${c.id === activeChatId ? ' active' : ''}${c.busy ? ' busy' : ''}`, title: c.title, onclick: () => switchChat(c.id), onauxclick: (e) => e.button === 1 && closeChatTab(c.id) },
        c.busy ? h('span', { class: 'spinner' }) : null,
        c.worktree && !c.worktree.removed ? h('span', { class: 'wt-icon', title: 'Works in its own copy' }, '⑂') : null,
        h('span', { class: 't' }, c.title),
        h('button', { class: 'close', title: 'Close chat', onclick: (e) => (e.stopPropagation(), closeChatTab(c.id)) }, '×')
      )
    )
  );
}

function renderChatMeta() {
  const chat = activeChat();
  const el = $('#chat-usage');
  if (!chat || !chat.usage.turns) {
    el.textContent = '';
    return;
  }
  const k = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  el.textContent = `${chat.usage.turns} turn${chat.usage.turns > 1 ? 's' : ''} · context ${k(chat.usage.context)}`;
  el.title = `${chat.usage.model ? chat.usage.model + ' · ' : ''}Tokens currently in this conversation's context window.`;
}

function newChat() {
  const chat = activeChat();
  if (isPristine(chat)) return $('#input').focus();
  createChat();
  $('#input').focus();
}

function scrollChat(chat, force) {
  const el = $('#messages-host');
  if (chat && chat.id !== activeChatId) return;
  if (force || el.scrollHeight - el.scrollTop - el.clientHeight < 140) el.scrollTop = el.scrollHeight;
}

function appendChat(node, chat = activeChat()) {
  const empty = $('.empty-chat', chat.el);
  if (empty) empty.remove();
  chat.el.append(node);
  scrollChat(chat, true);
  return node;
}

// ------------------------------------------------------------------ slash commands
//
// Claude Code lists its commands (built-ins, your .claude/commands, skills and plugins) when a chat
// starts. The list is remembered so the menu works before the first message too.

const SLASH_DESCRIPTIONS = {
  clear: 'Start a fresh conversation in this tab',
  new: 'Start a fresh conversation in this tab',
  compact: 'Summarise the conversation to free up context',
  context: 'Show what is using the context window',
  cost: 'Show token usage for this conversation',
  usage: 'Show your plan usage',
  init: 'Write a CLAUDE.md that describes this project',
  review: 'Review a pull request',
  'code-review': 'Review the current changes for bugs',
  'security-review': 'Security review of the pending changes',
  simplify: 'Clean up the changed code',
  memory: 'Edit Claude memory files',
  mcp: 'Show MCP server status',
  model: 'Show or change the model',
  agents: 'List subagents',
  recap: 'Summarise the conversation so far',
  insights: 'Report on how you use Claude Code',
};
// Interactive-only or app-internal commands that do nothing useful here.
const SLASH_HIDDEN = new Set(['config', 'color', 'heapdump', 'doctor', 'reload-plugins', 'reload-skills', 'focus', 'fast', 'rename', 'import', 'goal', 'design-consent', 'design-revoke']);
const SLASH_LOCAL = new Set(['clear', 'new']);

function slashCommandList() {
  const names = new Set(['clear', 'new', 'compact', 'context', 'init', 'review', ...(state.settings.slashCommands || [])]);
  return [...names]
    .filter((n) => !n.startsWith('_') && !SLASH_HIDDEN.has(n))
    .map((name) => ({ name, desc: SLASH_DESCRIPTIONS[name] || '' }));
}

function rememberSlashCommands(list) {
  if (!Array.isArray(list) || !list.length) return;
  const prev = state.settings.slashCommands || [];
  if (prev.length === list.length && prev.every((x, i) => x === list[i])) return;
  state.settings.slashCommands = list;
  desk.setSettings({ slashCommands: list });
}

// /clear and /new are handled here: the tab's Claude process restarts on a brand-new conversation.
function clearChat(chat) {
  desk.chatClose(chat.id);
  chat.sessionId = null;
  chat.lastReply = null;
  chat.resumeAt = null;
  chat.title = 'New chat';
  chat.usage = { context: 0, turns: 0, model: '' };
  chat.alwaysAllow = new Set();
  chat.queue = [];
  renderQueue();
  chat.el.replaceChildren(emptyState());
  renderChatTabs();
  renderChatMeta();
}

// ------------------------------------------------------------------ history

// Past chats from every agent: Claude's transcripts straight away, then each other agent's own list
// (asked once every couple of minutes, since it means starting that agent).
const agentRows = { root: null, at: 0, rows: [], loading: null };

async function loadHistory(fresh) {
  const list = $('#history-list');
  if (!state.folder) return list.replaceChildren();
  const root = state.folder.root;
  const claudeRows = (await desk.listSessions()).map((r) => ({ ...r, agent: 'claude' }));
  const show = () => renderHistory(list, [...claudeRows, ...(agentRows.root === root ? agentRows.rows : [])], !!agentRows.loading);
  show();
  if (!fresh && agentRows.root === root && Date.now() - agentRows.at < 120000) return;
  if (agentRows.loading) return;
  agentRows.loading = (async () => {
    const ready = [];
    for (const a of agentState.list) if (a.id !== 'claude' && (await agentStatus(a.id)).loggedIn) ready.push(a.id);
    const lists = await Promise.all(ready.map((id) => desk.agents.sessions(id).catch(() => [])));
    Object.assign(agentRows, { root, at: Date.now(), rows: lists.flat() });
  })();
  await agentRows.loading;
  agentRows.loading = null;
  if (state.folder && state.folder.root === root) loadHistory();
}

function renderHistory(list, rows, loading) {
  rows = rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 150);
  const items = [
    ...(rows.length || loading ? [] : [h('div', { class: 'muted small', style: 'padding:12px' }, 'No chats in this folder yet.')]),
    ...rows.map((r) =>
      h(
        'div',
        { class: `history-row${activeChat()?.sessionId === r.id ? ' active' : ''}`, 'data-session': r.id, onclick: () => openSession(r) },
        h('div', { class: 't' }, r.title),
        h('div', { class: 'd' }, h('span', { class: 'agent-tag' }, agentInfo(r.agent).label), r.updatedAt ? new Date(r.updatedAt).toLocaleString() : '')
      )
    ),
    loading ? h('div', { class: 'muted small', style: 'padding:8px 12px' }, 'Looking for chats from your other agents…') : null,
  ];
  list.replaceChildren(...items.filter(Boolean));
}

// Shows earlier messages in a chat tab.
function renderPast(chat, msgs) {
  for (const m of msgs) {
    if (m.uuid) chat.lastReply = m.uuid;
    if (m.role === 'user') appendChat(userBubble(chat, [m.text], { text: m.text, after: m.after || null, turnId: null }), chat);
    else if (m.role === 'assistant') {
      const el = h('div', { class: 'msg-text' });
      renderMarkdown(el, m.text);
      appendChat(el, chat);
    } else if (m.role === 'tool' && !HIDDEN_TOOLS.has(m.name)) {
      const tool = toolRow(m.name, m.input);
      tool.el.classList.remove('running');
      appendChat(tool.el, chat);
    }
  }
}

async function openSession(row, worktree, account) {
  const open = chats.find((c) => c.sessionId === row.id);
  if (open) return switchChat(open.id);
  if (row.agent && row.agent !== 'claude') {
    reopenAgentChat({ agent: row.agent, sessionId: row.id, title: row.title });
    return loadHistory();
  }
  // A past chat carries on with the account it last ran on.
  account = account || row.account || acct.folderAccount;
  const msgs = await desk.loadSession(row.id, worktree ? worktree.path : undefined, account);
  const chat = isPristine(activeChat()) && !activeChat().worktree ? activeChat() : createChat();
  chat.account = account;
  chat.agent = 'claude';
  if (worktree) {
    chat.worktree = worktree;
    refreshWorktree(chat);
  }
  chat.sessionId = row.id;
  chat.title = row.title.slice(0, 60);
  chat.el.replaceChildren();
  chat.lastReply = null;
  chat.resumeAt = null;
  renderPast(chat, msgs);
  appendChat(h('div', { class: 'notice' }, 'Continuing this conversation. New messages resume it in Claude Code.'), chat);
  switchChat(chat.id);
  loadHistory();
}

// ------------------------------------------------------------------ tool rows

const TOOL_ICON = { Read: '📄', Edit: '✎', MultiEdit: '✎', Write: '✎', NotebookEdit: '✎', Bash: '❯', PowerShell: '❯', Grep: '⌕', Glob: '⌕', WebFetch: '🌐', WebSearch: '🌐', Task: '⧉', Agent: '⧉', TodoWrite: '☑', ExitPlanMode: '◆', AskUserQuestion: '?' };
const isShell = (name) => name === 'Bash' || name === 'PowerShell';

function shortPath(p) {
  // Files in a chat's own copy show relative to the copy.
  const copy = /[\\/]worktrees[\\/][^\\/]+[\\/][^\\/]+[\\/](.+)$/.exec(p || '');
  if (copy) return copy[1].replace(/\\/g, '/');
  return toRel(p) || p;
}

function toolLabel(name, input = {}) {
  const code = (t) => h('code', {}, t);
  switch (name) {
    case 'Read':
      return [h('b', {}, 'Read '), code(shortPath(input.file_path || ''))];
    case 'Edit':
    case 'MultiEdit':
      return [h('b', {}, 'Edit '), code(shortPath(input.file_path || ''))];
    case 'Write':
      if (/[\\/]\.claude[\\/]plans[\\/]/.test(input.file_path || '')) return [h('b', {}, 'Drafted the plan')];
      return [h('b', {}, 'Write '), code(shortPath(input.file_path || ''))];
    case 'NotebookEdit':
      return [h('b', {}, 'Edit notebook '), code(shortPath(input.notebook_path || ''))];
    case 'Bash':
    case 'PowerShell':
      return [h('b', {}, 'Ran '), code((input.command || '').split('\n')[0].slice(0, 120))];
    case 'Grep':
      return [h('b', {}, 'Searched '), code(input.pattern || '')];
    case 'Glob':
      return [h('b', {}, 'Listed '), code(input.pattern || '')];
    case 'WebFetch':
      return [h('b', {}, 'Fetched '), input.url || ''];
    case 'WebSearch':
      return [h('b', {}, 'Searched the web for '), input.query || ''];
    case 'Task':
    case 'Agent':
      return [h('b', {}, 'Subagent: '), input.description || ''];
    case 'TodoWrite':
      return [h('b', {}, 'Updated the to-do list')];
    case 'ExitPlanMode':
      return [h('b', {}, 'Proposed a plan')];
    default:
      return [h('b', {}, name.replace(/^mcp__/, '').replace(/__/g, ' › ') + ' ')];
  }
}

function toolRow(name, input) {
  const head = h('div', { class: 'head' }, h('span', { class: 'icon' }, TOOL_ICON[name] || '•'), h('span', { class: 'label' }));
  const out = h('div', { class: 'out' });
  const el = h('div', { class: 'tool running' }, head, out);
  const row = {
    el,
    name,
    input: input || {},
    setInput(inp) {
      row.input = inp || {};
      $('.label', el).replaceChildren(...toolLabel(name, row.input));
      if (isShell(name) && row.input.command && !out.textContent) out.textContent = '$ ' + row.input.command;
      if (name === 'TodoWrite' && Array.isArray(row.input.todos)) {
        out.textContent = row.input.todos.map((t) => `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : '○'} ${t.content}`).join('\n');
        el.classList.add('open');
      }
    },
  };
  head.addEventListener('click', () => {
    const rel = toRel(row.input.file_path || row.input.notebook_path);
    if (rel && state.fileSet.has(rel) && !out.textContent) return openFile(rel);
    el.classList.toggle('open');
  });
  row.setInput(input);
  return row;
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  return '';
}

function patchStats(structuredPatch) {
  let add = 0;
  let del = 0;
  for (const hunk of structuredPatch || []) for (const l of hunk.lines || []) l[0] === '+' ? add++ : l[0] === '-' ? del++ : 0;
  return { add, del };
}

// ------------------------------------------------------------------ one turn

// A sent message. rw holds what Rewind needs: the text to put back, the reply it followed
// (where the conversation resumes from) and the turn whose file snapshot restores the code.
function userBubble(chat, body, rw) {
  const el = h(
    'div',
    { class: 'msg-user' },
    // Rewind uses Claude Code's conversation forking, so it's Claude only.
    agentOf(chat) === 'claude' ? h('button', { class: 'rewind-btn', title: 'Rewind to here: undo this message and everything after it', onclick: () => rewindTo(chat, el) }, '↺ Rewind') : null,
    ...body
  );
  el.rw = rw;
  return el;
}

function startTurn(chat, shown, mode, images, rwText) {
  const bubble = appendChat(
    userBubble(
      chat,
      [
        h('div', { class: `mode-tag ${mode}` }, MODE_LABEL[mode]),
        shown,
        images && images.length ? h('div', { class: 'msg-images' }, ...images.map((im) => h('img', { src: `data:${im.mediaType};base64,${im.data}` }))) : null,
      ],
      { text: rwText ?? shown, after: chat.resumeAt || chat.lastReply || null, turnId: null }
    ),
    chat
  );
  chat.turn = {
    bubble,
    mode,
    blocks: new Map(),
    tools: new Map(),
    streamedMsgIds: new Set(),
    autoEdits: mode === 'agent' || mode === 'auto',
    started: Date.now(),
  };
  chat.busy = true;
  renderChatTabs();
  if (chat.id === activeChatId) setRunning(true), renderQueue();
}

function endTurn(chat) {
  const stopped = (!chat.turn || chat.turn.interrupted) && !chat.sendNext;
  chat.sendNext = false;
  if (chat.turn) for (const row of chat.turn.tools.values()) row.el.classList.remove('running');
  chat.turn = null;
  chat.busy = false;
  renderChatTabs();
  if (chat.id === activeChatId) setRunning(false);
  // Queued messages go next, unless you pressed Stop (then they wait for Send).
  if (!stopped && chat.queue.length) setTimeout(() => runQueue(chat), 300);
  else if (chat.id === activeChatId) renderQueue();
}

let renderQueued = new Map();
function queueRender(chat, block) {
  renderQueued.set(block, chat);
  if (renderQueued.size === 1)
    requestAnimationFrame(() => {
      for (const [b, c] of renderQueued) {
        renderMarkdown(b.el, b.text);
        scrollChat(c);
      }
      renderQueued = new Map();
    });
}

function handleEvent(chat, ev) {
  if (ev.parent_tool_use_id) return; // subagent internals stay folded under the Task row
  const turn = chat.turn;
  switch (ev.type) {
    case 'system':
      if (ev.subtype === 'init') {
        chat.sessionId = ev.session_id;
        rememberSlashCommands(ev.slash_commands);
        chat.usage.model = ev.model || chat.usage.model;
      } else if (ev.subtype === 'models') {
        // The models this agent offers (Cursor lists them per session) fill the Model menu.
        const id = agentOf(chat);
        agentState.models.set(id, ev.models || []);
        if (chat === activeChat()) renderModelPicker();
      } else if (ev.subtype === 'api_retry' && turn) {
        appendChat(h('div', { class: 'notice' }, `API ${ev.error || 'error'}, retrying (attempt ${ev.attempt}/${ev.max_retries})…`), chat);
      } else if (ev.subtype === 'notice' && turn) {
        appendChat(h('div', { class: 'notice' }, ev.text), chat);
      } else if (ev.subtype === 'compact_boundary') {
        appendChat(h('div', { class: 'notice' }, 'Conversation compacted to free up context.'), chat);
      }
      break;
    case 'rate_limit_event': {
      const w = ev.rate_limit_info?.unifiedWindows;
      if (w) {
        const parts = [];
        if (w.five_hour) parts.push(`5h ${Math.round(w.five_hour.utilization * 100)}%`);
        if (w.seven_day) parts.push(`7d ${Math.round(w.seven_day.utilization * 100)}%`);
        noteAccountUsage(chat, parts.join(' · '));
        const win = (x) => x && { pct: Math.round(x.utilization * 100), resetsAt: x.resets_at || x.resetsAt || null };
        desk.usage.limits(usageKey(chat), { short: win(w.five_hour), long: win(w.seven_day) });
      }
      break;
    }
    case 'stream_event':
      if (turn) handleStream(chat, turn, ev.event || {});
      break;
    case 'assistant': {
      if (ev.uuid) chat.lastReply = ev.uuid;
      const u = ev.message?.usage;
      if (u) {
        chat.usage.context = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
        if (ev.message.model) chat.usage.model = ev.message.model;
        if (chat.id === activeChatId) renderChatMeta();
        if (turn) turn.lastUsage = u;
      }
      if (turn) handleAssistant(chat, turn, ev.message || {});
      break;
    }
    case 'user':
      if (!turn) break;
      for (const b of ev.message?.content || []) {
        if (b.type !== 'tool_result') continue;
        const row = turn.tools.get(b.tool_use_id);
        if (!row) continue;
        row.el.classList.remove('running');
        if (b.is_error) row.el.classList.add('error');
        const r = ev.tool_use_result;
        if (r && r.structuredPatch && EDIT_TOOLS.has(row.name)) {
          const s = patchStats(r.structuredPatch);
          if (s.add || s.del) $('.label', row.el).append(' ', h('span', { class: 'stat-add' }, `+${s.add}`), ' ', h('span', { class: 'stat-del' }, `−${s.del}`));
        } else if (row.name !== 'TodoWrite' && row.name !== 'Read') {
          const text = resultText(b.content);
          if (text) $('.out', row.el).textContent = (isShell(row.name) ? `$ ${row.input.command}\n` : '') + text.slice(0, 20000);
        }
        if (b.is_error) $('.out', row.el).textContent = resultText(b.content).slice(0, 4000);
      }
      break;
    case 'result':
      if (ev.session_id) chat.sessionId = ev.session_id;
      chat.usage.turns++;
      recordUsage(chat, ev);
      if (chat.id === activeChatId) renderChatMeta();
      if (turn) {
        if (turn.interrupted) appendChat(h('div', { class: 'notice' }, turn.forQueued ? 'Interrupted to send your new message.' : 'Stopped.'), chat);
        else if (ev.is_error) appendChat(h('div', { class: 'turn-error' }, ev.result || (ev.errors || []).join('\n') || `Claude Code stopped (${ev.subtype}).`), chat);
        else {
          const secs = Math.round((ev.duration_ms || Date.now() - turn.started) / 1000);
          const denied = (ev.permission_denials || []).length;
          appendChat(h('div', { class: 'turn-foot' }, `${secs}s · ${ev.num_turns || 1} step${ev.num_turns === 1 ? '' : 's'}${denied ? ` · ${denied} action${denied > 1 ? 's' : ''} denied` : ''}`), chat);
        }
      }
      endTurn(chat);
      if (!document.hasFocus()) {
        new Notification('Switchdesk', { body: `${agentLabel(chat)} finished: ${chat.title}` });
        desk.flashWindow();
      }
      break;
  }
}

function handleStream(chat, turn, e) {
  if (e.type === 'message_start') {
    turn.blocks = new Map();
    if (e.message?.id) turn.streamedMsgIds.add(e.message.id);
  } else if (e.type === 'content_block_start') {
    const cb = e.content_block || {};
    if (cb.type === 'text') {
      const el = appendChat(h('div', { class: 'msg-text' }), chat);
      turn.blocks.set(e.index, { kind: 'text', el, text: cb.text || '' });
    } else if (cb.type === 'thinking') {
      const body = h('div', { class: 'body' });
      const el = appendChat(h('details', { class: 'thinking' }, h('summary', {}, 'Thinking…'), body), chat);
      turn.blocks.set(e.index, { kind: 'thinking', el, body, text: '' });
    } else if (cb.type === 'tool_use') {
      if (HIDDEN_TOOLS.has(cb.name)) return;
      const row = toolRow(cb.name, {});
      turn.tools.set(cb.id, row);
      appendChat(row.el, chat);
      turn.blocks.set(e.index, { kind: 'tool', row, json: '' });
    }
  } else if (e.type === 'content_block_delta') {
    const b = turn.blocks.get(e.index);
    if (!b) return;
    const d = e.delta || {};
    if (d.type === 'text_delta' && b.kind === 'text') {
      b.text += d.text;
      queueRender(chat, b);
    } else if (d.type === 'thinking_delta' && b.kind === 'thinking') {
      b.text += d.thinking;
      b.body.textContent = b.text;
    } else if (d.type === 'input_json_delta' && b.kind === 'tool') {
      b.json += d.partial_json;
    }
  } else if (e.type === 'content_block_stop') {
    const b = turn.blocks.get(e.index);
    if (b && b.kind === 'tool') {
      try {
        b.row.setInput(JSON.parse(b.json || '{}'));
      } catch {
        /* finalized by the full assistant message */
      }
    } else if (b && b.kind === 'thinking') {
      $('summary', b.el).textContent = 'Thought for a moment';
    } else if (b && b.kind === 'text') {
      renderMarkdown(b.el, b.text);
    }
  }
}

function handleAssistant(chat, turn, msg) {
  const streamed = msg.id && turn.streamedMsgIds.has(msg.id);
  for (const b of msg.content || []) {
    if (b.type === 'tool_use') {
      if (HIDDEN_TOOLS.has(b.name)) continue;
      let row = turn.tools.get(b.id);
      if (!row) {
        row = toolRow(b.name, b.input);
        turn.tools.set(b.id, row);
        appendChat(row.el, chat);
      } else row.setInput(b.input);
    } else if (b.type === 'text' && !streamed && b.text.trim()) {
      const el = appendChat(h('div', { class: 'msg-text' }), chat);
      renderMarkdown(el, b.text);
    }
  }
}

// ------------------------------------------------------------------ approvals

function approvalKey(toolName, input) {
  if (isShell(toolName)) return toolName + ':' + ((input.command || '').trim().split(/\s+/)[0] || '');
  return toolName;
}

// The rule Claude Code itself understands, so "Always allow" sticks across chats and the terminal.
function permissionRule(toolName, input) {
  if (isShell(toolName)) {
    const first = (input.command || '').trim().split(/\s+/)[0];
    return first ? `${toolName}(${first} *)` : null;
  }
  if (toolName === 'WebFetch' && input.url) {
    try {
      return `WebFetch(domain:${new URL(input.url).hostname})`;
    } catch {
      return null;
    }
  }
  return toolName;
}

function handleApproval(req) {
  const chat = chatById(req.chatId);
  const answer = (decision) => desk.answerApproval(req.chatId, req.reqId, decision);
  if (!chat || !chat.turn) return answer({ behavior: 'deny', message: 'This chat is no longer active.' });
  const turn = chat.turn;
  const { toolName, input } = req;
  const allow = (updatedInput) => answer({ behavior: 'allow', updatedInput: updatedInput || input });
  const deny = (message) => answer({ behavior: 'deny', message: message || 'The user denied this action.' });

  if (toolName === 'AskUserQuestion') return questionCard(chat, input, deny);
  if (turn.mode === 'ask') return deny("Ask mode is on, so nothing can be changed. Answer the user's question without modifying files or running commands that change anything.");
  if (toolName === 'ExitPlanMode') return planCard(chat, input, allow, deny);
  if (EDIT_TOOLS.has(toolName) && turn.autoEdits) return allow();
  const key = approvalKey(toolName, input);
  if (chat.alwaysAllow.has(key)) return allow();

  let title = `Allow ${toolName}?`;
  let detail;
  if (isShell(toolName)) {
    title = 'Run this command?';
    detail = h('pre', { class: 'cmd' }, input.command || '');
  } else if (EDIT_TOOLS.has(toolName)) {
    title = `Edit ${shortPath(input.file_path || input.notebook_path || '')}?`;
    detail = h('pre', { class: 'cmd' }, input.new_string != null ? `- ${input.old_string}\n+ ${input.new_string}` : (input.content || '').slice(0, 2000));
  } else if (toolName === 'WebFetch') {
    title = 'Fetch this page?';
    detail = h('pre', { class: 'cmd' }, input.url || '');
  } else {
    detail = h('pre', { class: 'cmd' }, JSON.stringify(input, null, 2).slice(0, 3000));
  }
  const reason = h('input', { type: 'text', placeholder: 'Optional: tell Claude what to do instead', class: 'hidden' });
  const card = h('div', { class: 'card approval' }, h('h4', {}, title), detail, req.description || input.description ? h('div', { class: 'muted small' }, req.description || input.description) : null, reason);
  const resolve = (text) => {
    card.classList.add('resolved');
    $('.actions', card).replaceChildren(h('span', { class: 'resolution' }, text));
  };
  const rule = agentOf(chat) === 'claude' ? permissionRule(toolName, input) : null; // saved rules are Claude Code's
  const alwaysLabel = key.includes(':') ? `Always allow \`${key.split(':')[1]}\`` : `Always allow ${toolName}`;
  card.append(
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'btn small primary', onclick: () => (allow(), resolve('Allowed')) }, 'Allow'),
      h(
        'button',
        {
          class: 'btn small',
          title: rule ? `Saves "${rule}" to this project's Claude Code settings` : 'Allows this for the rest of this chat',
          onclick: () => {
            chat.alwaysAllow.add(key);
            if (rule) desk.cfg.rule('local', rule, true);
            allow();
            resolve(rule ? `Allowed. Saved "${rule}" for this project (Settings → Permissions).` : 'Allowed for this chat.');
          },
        },
        alwaysLabel
      ),
      h(
        'button',
        {
          class: 'btn small danger',
          onclick: () => {
            if (reason.classList.contains('hidden') && !reason.value) {
              reason.classList.remove('hidden');
              reason.focus();
              return;
            }
            deny(reason.value ? `The user denied this and said: ${reason.value}` : undefined);
            resolve('Denied');
          },
        },
        'Deny'
      )
    )
  );
  reason.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      deny(`The user denied this and said: ${reason.value}`);
      resolve('Denied');
    }
  });
  appendChat(card, chat);
  notifyAttention(chat);
}

function planCard(chat, input, allow, deny) {
  const turn = chat.turn;
  const plan = input.plan || '';
  const body = h('div', { class: 'msg-text plan-body' });
  renderMarkdown(body, plan);
  const card = h('div', { class: 'card plan' }, h('h4', {}, 'Plan ready for review'), body);
  let decided = false;
  const done = (text) => {
    decided = true;
    card.classList.add('resolved');
    $('.actions', card).replaceChildren(h('button', { class: 'btn small', onclick: () => doc.open() }, 'Open plan'), h('span', { class: 'resolution' }, text));
    doc.resolve(text);
  };
  const build = () => {
    if (decided) return;
    const edited = doc.text();
    if (edited !== plan) renderMarkdown(body, edited);
    if (turn) turn.autoEdits = true; // Approving a plan works like Agent mode from here on.
    allow({ ...input, plan: edited });
    desk.chatSetMode(chat.id, 'agent');
    setMode('agent');
    done(edited !== plan ? 'Approved with your edits. Building it now.' : 'Approved. Building it now.');
  };
  const keepPlanning = (feedback) => {
    if (decided) return;
    const edited = doc.text();
    const changed = edited !== plan ? `\n\nThey edited the plan to:\n\n${edited}` : '';
    deny(`The user wants to keep planning.${feedback ? ' Their feedback: ' + feedback : ''}${changed} Revise the plan and present it again.`);
    done('Sent back for revision.');
  };
  // The plan opens as its own editable tab, like Cursor.
  const doc = openPlanDoc(plan, { onBuild: build, onKeep: keepPlanning });
  const feedback = h('textarea', { rows: 2, placeholder: 'What should change? (for Keep planning)', class: 'hidden' });
  card.append(
    feedback,
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'btn small primary', onclick: build }, 'Build it'),
      h('button', { class: 'btn small', title: 'Edit the plan in the editor', onclick: () => doc.open() }, 'Open in editor'),
      h(
        'button',
        {
          class: 'btn small',
          onclick: () => {
            if (feedback.classList.contains('hidden')) {
              feedback.classList.remove('hidden');
              feedback.focus();
              return;
            }
            keepPlanning(feedback.value.trim());
          },
        },
        'Keep planning'
      )
    )
  );
  appendChat(card, chat);
  notifyAttention(chat);
}

function questionCard(chat, input, deny) {
  const questions = input.questions || [];
  const answers = new Map();
  const card = h('div', { class: 'card approval' }, h('h4', {}, 'Claude has a question'));
  for (const q of questions) {
    const other = h('input', { type: 'text', placeholder: 'Or type an answer' });
    other.addEventListener('input', () => answers.set(q.question, other.value));
    const opts = (q.options || []).map((o) =>
      h(
        'button',
        {
          class: 'btn small',
          title: o.description || '',
          onclick: (e) => {
            answers.set(q.question, o.label);
            for (const b of e.target.parentElement.querySelectorAll('button')) b.classList.remove('primary');
            e.target.classList.add('primary');
          },
        },
        o.label
      )
    );
    card.append(h('div', { style: 'margin:6px 0' }, h('div', {}, q.question), h('div', { class: 'actions', style: 'margin-top:6px' }, ...opts), other));
  }
  const submit = h('button', { class: 'btn small primary' }, 'Answer');
  submit.addEventListener('click', () => {
    const text = [...answers].map(([q, a]) => `"${q}" → ${a}`).join('\n');
    // The answer goes back as the tool's result message, which Claude reads.
    deny(`The user answered your question${questions.length > 1 ? 's' : ''}:\n${text || '(no answer)'}`);
    card.classList.add('resolved');
    submit.replaceWith(h('span', { class: 'resolution' }, 'Answered'));
  });
  card.append(h('div', { class: 'actions' }, submit));
  appendChat(card, chat);
  notifyAttention(chat);
}

function notifyAttention(chat) {
  if (chat.id !== activeChatId) renderChatTabs();
  if (!document.hasFocus()) {
    new Notification('Switchdesk', { body: `${agentLabel(chat)} is waiting for you: ${chat.title}` });
    desk.flashWindow();
  }
}

// ------------------------------------------------------------------ changes card

function lineDiffStats(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  if (x.length * y.length > 4e6) return { add: Math.max(0, y.length - x.length), del: Math.max(0, x.length - y.length) };
  const prev = new Uint32Array(y.length + 1);
  const cur = new Uint32Array(y.length + 1);
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev.set(cur);
  }
  const lcs = prev[y.length];
  return { add: y.length - lcs, del: x.length - lcs };
}

const changeCards = new Map(); // turnId -> card

// Changes still under review open in the editor with inline Keep/Undo; the rest open as a diff.
function reviewChange(c) {
  if (c.binary) return;
  if (c.worktree) return openDiff({ ...c, source: 'worktree' });
  if (reviews.has(c.rel)) return openFile(c.rel).then(revealFirstChange);
  if (!c.deleted && !c.undone && state.fileSet.has(c.rel)) return openFile(c.rel);
  openDiff(c);
}

// Collapsed by default, like Cursor: "› 2 Files  Undo  Keep  Review". Click the row to list the files.
function changesCard(chat, turnId, changes) {
  let add = 0;
  let del = 0;
  const rows = changes.map((c) => {
    c.turnId = turnId;
    const s = c.binary ? null : lineDiffStats(c.before, c.after);
    if (s) (add += s.add), (del += s.del);
    const label = c.rel + (c.created ? ' (new)' : c.deleted ? ' (deleted)' : c.binary ? ' (binary)' : '');
    const row = h(
      'div',
      { class: 'file' },
      h('span', { class: 'name', title: c.rel, onclick: () => reviewChange(c) }, label),
      s ? h('span', { class: 'stat-add' }, `+${s.add}`) : null,
      s ? h('span', { class: 'stat-del' }, `−${s.del}`) : null,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', onclick: () => undo([c]) }, 'Undo')
    );
    c.row = row;
    if (!c.worktree) state.changedFiles.add(c.rel);
    return row;
  });
  const body = h('div', { class: 'changes-body hidden' }, ...rows);
  const status = h('span', { class: 'changes-status' });
  const setStatus = (text) => {
    status.textContent = text;
    card.classList.toggle('settled', !!text);
  };
  const undo = async (list) => {
    list = list.filter((c) => !c.undone);
    if (!list.length) return;
    await desk.undoChanges(turnId, list.map((c) => c.path));
    dropReviews(list.map((c) => c.rel));
    for (const c of list) {
      c.undone = true;
      c.row.classList.add('undone');
      $('button', c.row).disabled = true;
      state.changedFiles.delete(c.rel);
    }
    if (changes.every((c) => c.undone)) setStatus('Undone');
    await reloadOpenFiles(list.map((c) => c.rel));
    if (activeTab()?.change && list.includes(activeTab().change)) activateTab(state.activeTab);
    refreshFiles();
    refreshGit();
    renderTree();
  };
  // Keep accepts everything: the inline green/red highlights go away.
  const keep = () => {
    const live = changes.filter((c) => !c.undone);
    dropReviews(live.map((c) => c.rel));
    for (const c of live) state.changedFiles.delete(c.rel);
    renderTree();
    setStatus('Kept');
  };
  const reviewable = changes.find((c) => !c.binary && !c.undone);
  const stop = (fn) => (e) => (e.stopPropagation(), fn());
  const twisty = h('span', { class: 'twisty' }, '›');
  const head = h(
    'div',
    {
      class: 'changes-head',
      title: 'Show the files',
      onclick: () => {
        body.classList.toggle('hidden');
        card.classList.toggle('open', !body.classList.contains('hidden'));
        if (!body.classList.contains('hidden')) body.scrollIntoView({ block: 'nearest' });
      },
    },
    twisty,
    h('span', { class: 'changes-count' }, `${changes.length} File${changes.length > 1 ? 's' : ''}`),
    add || del ? h('span', { class: 'stat-add' }, `+${add}`) : null,
    add || del ? h('span', { class: 'stat-del' }, `−${del}`) : null,
    status,
    h('span', { class: 'spacer' }),
    h('button', { class: 'ghost-btn', title: 'Put every file back how it was', onclick: stop(() => undo(changes)) }, 'Undo'),
    changes[0] && changes[0].worktree ? null : h('button', { class: 'ghost-btn', title: 'Accept these changes', onclick: stop(keep) }, 'Keep'),
    reviewable ? h('button', { class: 'ghost-btn strong', title: 'Step through the changes', onclick: stop(() => reviewChange(changes.find((c) => reviews.has(c.rel)) || reviewable)) }, 'Review') : null
  );
  const card = h('div', { class: 'card changes' }, head, body);
  card.undo = undo;
  changeCards.set(turnId, card);
  appendChat(card, chat);
  renderTree();
  return card;
}

// ------------------------------------------------------------------ rewind
//
// Takes the chat back to just before a message: the conversation carries on from the reply before
// it (Claude Code forks the session, so the original is kept in History), the message goes back in
// the box to edit, and the files can go back to how they were before it.

async function rewindTo(chat, bubble) {
  if (chat.busy) return toast('Wait for Claude to finish, or stop it, before rewinding.');
  const all = [...chat.el.querySelectorAll('.msg-user')];
  const from = all.slice(all.indexOf(bubble));
  const turnIds = from.map((b) => b.rw && b.rw.turnId).filter(Boolean);
  const files = bubble.rw.turnId ? await desk.rewindFiles(turnIds) : { available: false, files: [] };
  const restore = h('input', { type: 'checkbox', checked: files.files.length > 0 });
  const later = from.length - 1;
  const content = [
    h('h3', {}, 'Rewind to this message?'),
    h(
      'p',
      { class: 'muted' },
      `The conversation goes back to just before this message${later ? `, along with ${later === 1 ? 'the message' : `the ${later} messages`} after it` : ''}, and the message is put back in the box so you can change it and send again. The original conversation stays in History.`
    ),
  ];
  if (files.files.length)
    content.push(
      h('label', { class: 'rewind-files' }, restore, ` Also put back ${files.files.length} file${files.files.length > 1 ? 's' : ''} as they were before this message`),
      h('div', { class: 'rewind-list' }, ...files.files.slice(0, 12).map((f) => h('div', {}, f)), files.files.length > 12 ? h('div', {}, `and ${files.files.length - 12} more`) : null)
    );
  else if (!files.available)
    content.push(h('p', { class: 'muted small' }, 'Files can only be rewound for messages sent since Switchdesk was opened, so only the conversation will rewind.'));
  else content.push(h('p', { class: 'muted small' }, 'No files have changed since this message.'));
  const go = h('button', { class: 'btn primary' }, 'Rewind');
  const cancel = h('button', { class: 'btn' }, 'Cancel');
  const close = modal([h('div', { class: 'body' }, ...content), h('div', { class: 'foot' }, cancel, go)]);
  cancel.addEventListener('click', close);
  go.focus();
  go.addEventListener('click', async () => {
    close();
    if (restore.checked && files.files.length) {
      await desk.rewindApply(turnIds);
      dropReviews(files.files);
      for (const rel of files.files) state.changedFiles.delete(rel);
      await reloadOpenFiles(files.files);
      refreshFiles();
      refreshGit();
    }
    desk.chatClose(chat.id);
    const after = bubble.rw.after;
    if (after) chat.resumeAt = after;
    else chat.sessionId = null; // rewinding the first message starts a fresh conversation
    chat.lastReply = after;
    let node = bubble;
    while (node) {
      const next = node.nextSibling;
      node.remove();
      node = next;
    }
    if (!chat.el.children.length) chat.el.append(emptyState());
    const input = $('#input');
    input.value = bubble.rw.text || '';
    autoGrow();
    input.focus();
    renderTree();
    toast(restore.checked && files.files.length ? 'Rewound the conversation and files.' : 'Rewound the conversation.');
  });
}

// ------------------------------------------------------------------ composer

function setMode(mode) {
  state.mode = mode;
  const btn = $('#mode-btn');
  btn.dataset.mode = mode;
  btn.textContent = `${MODE_LABEL[mode]} ▾`;
  for (const b of document.querySelectorAll('#mode-menu button')) b.classList.toggle('active', b.dataset.mode === mode);
  desk.setSettings({ mode });
}

function setRunning(running) {
  const input = $('#input');
  if (!input.dataset.placeholder) input.dataset.placeholder = input.placeholder;
  input.placeholder = running ? 'Claude is working. Enter queues a message; Enter again (empty box) sends it now.' : input.dataset.placeholder;
  updateSendButton();
}

// While Claude works the button is Stop, unless there's something typed (then it queues it).
function updateSendButton() {
  const btn = $('#send-btn');
  const busy = !!activeChat()?.busy;
  const typed = !!$('#input').value.trim() || state.chips.length > 0;
  const stopping = busy && !typed;
  btn.classList.toggle('stop', stopping);
  btn.title = stopping ? 'Stop' : busy ? 'Queue this message (Enter)' : 'Send (Enter)';
}

function buildPrompt(text) {
  const code = state.chips.filter((c) => c.kind !== 'image');
  if (!code.length) return text;
  const ctx = code.map((c) => (c.kind === 'element' || c.kind === 'context' ? c.context : `Context from \`${c.rel}\` lines ${c.start}-${c.end}:\n\`\`\`${c.lang}\n${c.text}\n\`\`\``)).join('\n\n');
  return `${ctx}\n\n${text}`;
}

async function send(textOverride, modeOverride, display) {
  const chat = activeChat();
  if (!chat) return;
  if (agentOf(chat) === 'claude') {
    if (cliState && !cliState.found) return showSetup();
    const auth = multiAccount() ? acct.status.get(chatAccount(chat)) : cliState && cliState.auth;
    if (auth && !auth.loggedIn) return multiAccount() ? signInAccount(chatAccount(chat)) : showSetup();
  }
  if (!state.folder) return toast('Open a folder first.');
  if (chat.worktree && chat.worktree.removed) return toast("This chat's copy was deleted. Start a new chat to keep going.");
  if (chat.making) return toast('Still making the copy. One moment.');
  const input = $('#input');
  const text = (textOverride ?? input.value).trim();
  const images = textOverride ? [] : state.chips.filter((c) => c.kind === 'image');
  // Enter with an empty box while Claude works: send the next queued message right away.
  if (!text && !images.length && chat.busy && chat.queue.length) return sendNow(chat, 0);
  if (!text && !images.length) return;
  if (!textOverride && state.chips.some((c) => c.loading)) return toast('Still loading the page. One moment.');
  const mode = modeOverride || state.mode;
  const slash = !textOverride && /^\/[\w:.-]+/.exec(text);
  if (slash && SLASH_LOCAL.has(slash[0].slice(1))) {
    if (chat.busy) return toast('Wait for Claude to finish, or stop it, before clearing the chat.');
    input.value = '';
    autoGrow();
    if (chat.sessionId || !isPristine(chat)) clearChat(chat);
    return;
  }
  let prompt = textOverride ? text : buildPrompt(text || 'See the attached image.');
  // Slash commands go to Claude Code exactly as typed, without added context.
  if (slash) prompt = text;
  else if (mode === 'ask') prompt = ASK_PREFIX + prompt;
  const codeChips = state.chips.filter((c) => c.kind !== 'image');
  const shown = display || (codeChips.length ? `${text}\n\n${codeChips.map((c) => `📎 ${chipLabel(c)}`).join('\n')}` : text);
  if (!textOverride) {
    input.value = '';
    autoGrow();
    state.chips = [];
    renderChips();
  }
  if (!chat.sessionId && chat.title === 'New chat') {
    chat.title = (display || text || 'Image').slice(0, 60);
    renderChatTabs();
  }
  const content = [
    ...(slash ? [] : images).map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } })),
    { type: 'text', text: prompt },
  ];
  const item = { content, shown, mode, images, rwText: textOverride ? display || text : text };
  // While Claude is working, new messages wait their turn.
  if (chat.busy) {
    chat.queue.push(item);
    renderQueue();
    return;
  }
  return dispatch(chat, item);
}

async function dispatch(chat, { content, shown, mode, images, rwText }) {
  // A chat taken over from another agent sends that conversation with its first message.
  if (chat.handoff) {
    content = [...content, { type: 'text', text: '\n\n' + chat.handoff }];
    chat.handoff = null;
  }
  startTurn(chat, shown, mode, images, rwText);
  const bubble = chat.turn.bubble;
  const resumeAt = chat.sessionId ? chat.resumeAt : null;
  chat.resumeAt = null;
  try {
    const r = await desk.chatSend(chat.id, {
      content,
      mode,
      model: $('#model-select').value,
      effort: $('#effort-select').value,
      sessionId: chat.sessionId,
      resumeAt,
      cwd: chat.worktree ? chat.worktree.path : undefined,
      account: chatAccount(chat),
      agent: agentOf(chat),
    });
    if (r && r.turnId) bubble.rw.turnId = r.turnId;
  } catch (e) {
    appendChat(h('div', { class: 'turn-error' }, String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')), chat);
    endTurn(chat);
  }
}

// ------------------------------------------------------------------ queued messages

function renderQueue() {
  const chat = activeChat();
  const host = $('#queue');
  const q = chat ? chat.queue : [];
  host.classList.toggle('hidden', !q.length);
  host.replaceChildren(
    ...q.map((item, i) =>
      h(
        'div',
        { class: 'queued' },
        h('span', { class: 'q-label' }, i === 0 ? (chat.busy ? 'Next' : 'Paused') : 'Queued'),
        h('span', { class: 'q-text', title: item.shown }, item.shown.split('\n')[0]),
        chat.busy
          ? h('button', { class: 'q-now', title: i === 0 ? 'Send now: stops Claude and sends this (or press Enter in the empty box)' : 'Send now: stops Claude and sends this', onclick: () => sendNow(chat, i) }, '↑')
          : i === 0
            ? h('button', { class: 'btn small primary', onclick: () => runQueue(chat) }, 'Send')
            : null,
        h('button', { class: 'btn small', title: 'Move back to the chat box to edit', onclick: () => editQueued(chat, i) }, 'Edit'),
        h('button', { class: 'q-x', title: 'Remove', onclick: () => (chat.queue.splice(i, 1), renderQueue()) }, '×')
      )
    )
  );
}

function editQueued(chat, i) {
  const [item] = chat.queue.splice(i, 1);
  const input = $('#input');
  input.value = item.rwText + (input.value ? '\n' + input.value : '');
  autoGrow();
  input.focus();
  renderQueue();
}

// Interrupts Claude and sends this queued message straight after, so you can steer it mid-task.
function sendNow(chat, i) {
  if (!chat.busy) return runQueue(chat);
  const [item] = chat.queue.splice(i, 1);
  chat.queue.unshift(item);
  chat.sendNext = true;
  if (chat.turn) chat.turn.interrupted = chat.turn.forQueued = true;
  desk.chatInterrupt(chat.id);
  renderQueue();
}

function runQueue(chat) {
  if (chat.busy || !chat.queue.length) return;
  dispatch(chat, chat.queue.shift());
  if (chat.id === activeChatId) renderQueue();
}

function stop() {
  const chat = activeChat();
  if (!chat || !chat.busy) return;
  if (chat.turn) chat.turn.interrupted = true;
  desk.chatInterrupt(chat.id);
}

desk.onChatEvent(({ chatId, ev }) => {
  const chat = chatById(chatId);
  if (chat) handleEvent(chat, ev);
});

desk.onChatTurnEnd(async ({ chatId, turnId, changes }) => {
  const chat = chatById(chatId);
  if (chat && chat.worktree) {
    // Changes made in the chat's own copy: shown in its card, reviewed when merged.
    for (const c of changes || []) c.worktree = true;
    if (changes && changes.length) changesCard(chat, turnId, changes);
    refreshWorktree(chat);
    return;
  }
  if (chat && changes && changes.length) changesCard(chat, turnId, changes);
  if (changes && changes.length) addReviews(changes);
  await reloadOpenFiles();
  refreshFiles();
  refreshGit();
  loadHistory();
});

desk.onChatExit(({ chatId, code, stderr }) => {
  const chat = chatById(chatId);
  if (!chat) return;
  if (chat.busy) {
    if (chat.turn && chat.turn.interrupted) appendChat(h('div', { class: 'notice' }, chat.turn.forQueued ? 'Interrupted to send your new message.' : 'Stopped.'), chat);
    else appendChat(h('div', { class: 'turn-error' }, `Claude Code stopped unexpectedly (code ${code}).\n${(stderr || '').trim().slice(-1500)}`.trim()), chat);
    endTurn(chat);
  }
});

desk.onApproval(handleApproval);

// ------------------------------------------------------------------ chips (code context and images)

function chipLabel(c) {
  if (c.kind === 'context') return `${c.icon} ${c.label}`;
  return c.kind === 'element' ? `⌖ ${c.label}` : `${c.rel}:${c.start}-${c.end}`;
}

// ------------------------------------------------------------------ usage ledger (Settings → Usage)
function usageKey(chat) {
  return chat.agent && chat.agent !== 'claude' ? chat.agent : `claude:${chatAccount(chat)}`;
}

// Claude Code reports the whole turn's tokens and cost; other agents report tokens as they go.
function recordUsage(chat, ev) {
  const u = ev.usage || (chat.turn && chat.turn.lastUsage);
  if (!u && !ev.total_cost_usd) return;
  const input = u ? (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) : 0;
  desk.usage.record(usageKey(chat), { input, output: (u && u.output_tokens) || 0, cost: ev.total_cost_usd || 0 }).catch(() => {});
}

// @changes, @terminal and @<web address> attach their content to the message as a chip.
async function attachMention(it) {
  const add = (chip) => (state.chips.push(chip), renderChips(), chip);
  if (it.id === 'changes') {
    const diff = await desk.git.diff().catch(() => '');
    if (!diff) return toast('There are no uncommitted changes to attach.');
    const cut = diff.length > 60000;
    return add({ kind: 'context', icon: '±', label: 'Uncommitted changes', context: `My uncommitted changes (git diff against HEAD)${cut ? ', cut short' : ''}:\n\`\`\`diff\n${diff.slice(0, 60000)}\n\`\`\`` });
  }
  if (it.id === 'terminal') {
    const t = terms.find((x) => x.id === activeTermId) || terms[terms.length - 1];
    const out = t && terminalText(t, 200);
    if (!out) return toast(t ? 'The terminal is empty.' : 'Open a terminal first.');
    return add({ kind: 'context', icon: '›_', label: `Terminal${terms.length > 1 ? ' ' + t.title : ''}`, context: `Recent output from my terminal${t.title ? ` (${t.title})` : ''}:\n\`\`\`\n${out}\n\`\`\`` });
  }
  if (it.id === 'url') {
    let host = it.name;
    try {
      host = new URL(it.name).host;
    } catch {}
    const chip = add({ kind: 'context', icon: '🌐', label: `Loading ${host}…`, loading: true, context: '' });
    try {
      const page = await desk.fetchPage(it.name);
      chip.loading = false;
      chip.label = (page.title || host).slice(0, 60);
      chip.context = `The web page ${page.url}${page.title ? ` ("${page.title}")` : ''}${page.truncated ? ', cut short' : ''}:\n\`\`\`\n${page.text}\n\`\`\``;
    } catch (e) {
      state.chips.splice(state.chips.indexOf(chip), 1);
      toast(`Couldn't fetch ${host}: ${String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`);
    }
    renderChips();
  }
}

function renderChips() {
  $('#chips').replaceChildren(
    ...state.chips.map((c, i) =>
      c.kind === 'image'
        ? h('span', { class: 'chip image' }, h('img', { src: `data:${c.mediaType};base64,${c.data}` }), h('button', { title: 'Remove', onclick: () => (state.chips.splice(i, 1), renderChips()) }, '×'))
        : h('span', { class: `chip${c.kind === 'element' || c.kind === 'context' ? ' element' : ''}${c.loading ? ' loading' : ''}`, title: (c.text || c.context).slice(0, 500) }, chipLabel(c), h('button', { title: 'Remove', onclick: () => (state.chips.splice(i, 1), renderChips()) }, '×'))
    )
  );
  updateSendButton();
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function addImageFile(file) {
  if (!IMAGE_TYPES.has(file.type)) return toast('Only PNG, JPEG, GIF and WebP images can be attached.');
  if (file.size > 5 * 1024 * 1024) return toast('That image is over 5 MB. Try a smaller screenshot.');
  const reader = new FileReader();
  reader.onload = () => {
    const data = String(reader.result).split(',')[1];
    state.chips.push({ kind: 'image', mediaType: file.type, data });
    renderChips();
  };
  reader.readAsDataURL(file);
}

function wireImageInput() {
  const input = $('#input');
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    files.forEach(addImageFile);
  });
  const box = $('.composer-box');
  box.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.items || [])].some((i) => i.type.startsWith('image/'))) {
      e.preventDefault();
      box.classList.add('drop');
    }
  });
  box.addEventListener('dragleave', () => box.classList.remove('drop'));
  box.addEventListener('drop', (e) => {
    box.classList.remove('drop');
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    files.forEach(addImageFile);
  });
}
