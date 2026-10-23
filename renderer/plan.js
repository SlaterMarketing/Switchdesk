/* global $, h, state, monaco, editor, activeTab, activateTab, renderMarkdown, modal, openFile, chats, switchChat, agentLabel, toast, send, setMode, queueSaveWorkspace, PLAN_TRACK */
'use strict';

// ------------------------------------------------------------------ plans as documents
//
// When an agent proposes a plan, it opens in its own tab as a formatted document, like Cursor's:
// file names in it open the file, its to-dos are listed underneath (and tick off as the agent works
// through them), and Edit switches to the Markdown to change anything. Build it sends your version;
// Keep planning sends feedback instead.

let planSeq = 0;

function planTitle(markdown) {
  const m = /^#{1,3}\s+(.+)$/m.exec(markdown);
  return (m ? m[1].replace(/[*_`]/g, '') : 'Plan').trim().slice(0, 40);
}

function attachPlanModel(t) {
  t.model = monaco.editor.createModel(t.plan.text, 'markdown');
  t.model.onDidChangeContent(() => {
    t.plan.text = t.model.getValue();
    queueSaveWorkspace();
    if (t.plan.preview && activeTab() === t) renderPlanPreview(t);
  });
}

// Opens the plan in a tab. Returns handles the chat's plan card uses.
function openPlanDoc(markdown, { onBuild, onKeep, chat, path } = {}) {
  const t = { id: `plan:${++planSeq}`, kind: 'plan', rel: `Plan: ${planTitle(markdown)}`, plan: { text: markdown, state: '', status: '', preview: true, onBuild, onKeep, live: null, ticked: [], doing: null, chatId: chat && chat.id, path } };
  attachPlanModel(t);
  state.tabs.push(t);
  activateTab(t.id);
  const refresh = () => activeTab() === t && showPlan(t);
  return {
    text: () => t.plan.text,
    open: () => {
      if (!state.tabs.includes(t)) {
        attachPlanModel(t);
        state.tabs.push(t);
      }
      activateTab(t.id);
    },
    // status: building, built, waiting, sent or error; label is what the header says.
    resolve: (label, status) => {
      t.plan.state = label;
      t.plan.status = status || t.plan.status || 'building';
      if (t.plan.status !== 'building') t.plan.doing = null; // the turn ended: nothing is underway
      refresh();
      queueSaveWorkspace();
    },
    // A later turn in the plan's chat ended: nothing is underway now.
    idle: () => {
      t.plan.doing = null;
      refresh();
    },
    // The agent's own to-do list while it builds (TodoWrite, or ACP and Codex plan updates). The
    // plan's to-dos it matches tick off as it finishes them, and stay ticked in later turns.
    todos: (list) => {
      t.plan.live = (list || []).map((x) => ({ text: x.content || x.activeForm || '', status: x.status }));
      trackTodos(t.plan);
      refresh();
      queueSaveWorkspace();
    },
  };
}

// The plan's "To-dos" section: a checklist, pulled out of the document to show underneath it.
const TODO_HEAD = /^#{1,3}\s+to-?dos\s*$/im;
function splitTodos(text) {
  const m = TODO_HEAD.exec(text);
  if (!m) return { body: text, todos: [] };
  const rest = text.slice(m.index + m[0].length);
  const next = /^#{1,3}\s/m.exec(rest);
  const section = next ? rest.slice(0, next.index) : rest;
  const todos = [...section.matchAll(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/gm)].map((x) => ({ text: x[2].trim(), status: x[1] === ' ' ? 'pending' : 'completed' }));
  if (!todos.length) return { body: text, todos: [] };
  return { body: text.slice(0, m.index) + (next ? rest.slice(next.index) : ''), todos };
}

// Words that say what a to-do is, to match the agent's list against the plan's.
const todoWords = (text) => new Set(String(text).toLowerCase().replace(/[`*_]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length > 2));
function todoMatch(a, b) {
  const x = todoWords(a);
  const y = todoWords(b);
  if (!x.size || !y.size) return 0;
  const both = [...x].filter((w) => y.has(w)).length;
  return both / new Set([...x, ...y]).size;
}

// Which of the plan's to-dos the agent's list says are done, or being done. Each of the agent's
// items counts for the one plan to-do it's most like, and only when it's clearly the same thing, so
// a small step finishing doesn't tick off a big to-do.
function trackTodos(p) {
  const { todos } = splitTodos(p.text);
  const ticked = new Set(p.ticked || []);
  p.doing = null;
  for (const item of p.live || []) {
    let best = null;
    let score = 0.5;
    for (const td of todos) {
      const s = todoMatch(item.text, td.text);
      if (s >= score) (best = td), (score = s);
    }
    if (!best) continue;
    if (item.status === 'completed') ticked.add(best.text);
    else if (item.status === 'in_progress' && !ticked.has(best.text)) p.doing = best.text;
  }
  p.ticked = [...ticked];
}

// The plan's to-dos with how each stands; without any, the agent's own list.
function planTodoList(p) {
  const { todos } = splitTodos(p.text);
  if (!todos.length) return p.live || [];
  const ticked = new Set(p.ticked || []);
  return todos.map((x) => ({ ...x, status: x.status === 'completed' || ticked.has(x.text) ? 'completed' : p.doing === x.text ? 'in_progress' : 'pending' }));
}

function addTodo(t, text) {
  let md = t.plan.text;
  if (TODO_HEAD.test(md)) {
    const m = TODO_HEAD.exec(md);
    const rest = md.slice(m.index + m[0].length);
    const next = /^#{1,3}\s/m.exec(rest);
    const at = m.index + m[0].length + (next ? next.index : rest.length);
    md = `${md.slice(0, at).trimEnd()}\n- [ ] ${text}\n${next ? '\n' + md.slice(at) : ''}`;
  } else md = `${md.trimEnd()}\n\n## To-dos\n\n- [ ] ${text}\n`;
  t.model.setValue(md); // updates t.plan.text through the model
  showPlan(t);
}

// File names in the plan (`src/app.js`, src/app.js:42, or a link to one) open the file.
function linkFiles(el) {
  const known = (raw) => {
    const root = state.folder ? state.folder.root.replace(/\\/g, '/').replace(/\/$/, '') + '/' : '';
    raw = raw.trim().replace(/\\/g, '/');
    if (root && raw.toLowerCase().startsWith(root.toLowerCase())) raw = raw.slice(root.length);
    const m = /^\.?\/?([^\s:#]+?)(?::(\d+)(?:[-–]\d+)?|#L(\d+))?$/.exec(raw);
    if (!m) return null;
    let rel = m[1].replace(/\\/g, '/');
    if (!state.fileSet.has(rel)) rel = [...state.fileSet].find((r) => r.endsWith('/' + rel)) || null;
    return rel ? { rel, line: +(m[2] || m[3]) || undefined } : null;
  };
  for (const code of el.querySelectorAll(':not(pre) > code')) {
    const f = known(code.textContent);
    if (!f) continue;
    code.classList.add('file-ref');
    code.title = `Open ${f.rel}`;
    code.addEventListener('click', () => openFile(f.rel, f.line));
  }
  for (const a of el.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (/^[a-z]+:/i.test(href)) continue;
    const f = known(decodeURIComponent(href));
    if (!f) continue;
    a.classList.add('file-ref');
    a.addEventListener('click', (e) => (e.preventDefault(), openFile(f.rel, f.line)));
  }
}

// A to-do's text: `code` as code, the rest as plain text.
function inlineMarkdown(text) {
  const span = h('span', { class: 'todo-text' });
  String(text)
    .split(/(`[^`]+`)/)
    .forEach((part) => part && span.append(/^`[^`]+`$/.test(part) ? h('code', {}, part.slice(1, -1)) : document.createTextNode(part.replace(/\*\*|__/g, ''))));
  return span;
}

const TODO_ICON = { pending: '○', in_progress: '◐', completed: '✓' };

function renderPlanBar(t) {
  const bar = $('#plan-bar');
  const p = t.plan;
  const name = p.path ? p.path.split(/[\\/]/).pop() : planTitle(p.text);
  const toggle = h('button', { class: 'btn small', title: p.preview ? 'Edit the Markdown' : 'See it formatted', onclick: () => ((p.preview = !p.preview), showPlan(t)) }, p.preview ? 'Edit' : 'Done editing');
  const list = planTodoList(p);
  const done = list.filter((x) => x.status === 'completed').length;
  const partly = list.length && done < list.length;
  const status = p.status === 'building' ? h('span', { class: 'plan-status building' }, h('span', { class: 'spinner' }), 'Building') : p.status === 'built' ? h('span', { class: `plan-status ${partly ? 'waiting' : 'built'}`, title: partly ? 'The agent finished its turn with some to-dos still to do' : '' }, partly ? `${done} of ${list.length} done` : 'Built ✓') : p.status ? h('span', { class: `plan-status ${p.status}` }, p.status === 'sent' ? 'Sent back' : p.status === 'waiting' ? 'Waiting on you' : 'Stopped') : null;
  bar.replaceChildren(
    ...[
      h('span', { class: 'plan-crumbs' }, h('span', { class: 'muted' }, 'Plans'), h('span', { class: 'muted' }, ' › '), h('span', { class: 'plan-icon' }, '◆'), h('span', { class: 'plan-name', title: p.path || name }, name)),
      h('span', { class: 'spacer' }),
      p.state ? h('span', { class: 'muted small plan-state', title: p.state }, p.state) : null,
      status,
      toggle,
      p.state ? null : h('button', { class: 'btn small', onclick: () => keepPlanningPrompt(t) }, 'Keep planning'),
      p.state ? null : h('button', { class: 'btn small primary', onclick: () => p.onBuild() }, 'Build it'),
    ].filter(Boolean)
  );
}

function renderPlanPreview(t) {
  const host = $('#plan-preview');
  const p = t.plan;
  const { body } = splitTodos(p.text);
  const doc = h('div', { class: 'msg-text plan-doc' });
  renderMarkdown(doc, body);
  linkFiles(doc);
  const list = planTodoList(p);
  const done = list.filter((x) => x.status === 'completed').length;
  const input = h('input', { class: 'todo-new hidden', placeholder: 'A new to-do, then Enter', spellcheck: 'false' });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && input.value.trim()) addTodo(t, input.value.trim());
    if (e.key === 'Escape') input.classList.add('hidden');
  });
  const todoBox = h(
    'div',
    { class: 'plan-section' },
    h(
      'div',
      { class: 'plan-section-head' },
      h('span', {}, list.length ? `${list.length} To-do${list.length > 1 ? 's' : ''}${done ? ` · ${done} done` : ''}` : 'To-dos'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', onclick: () => (input.classList.remove('hidden'), input.focus()) }, '＋ New')
    ),
    ...list.map((x) => {
      const row = h('div', { class: `plan-todo ${x.status}` }, h('span', { class: 'todo-icon' }, TODO_ICON[x.status] || '○'), inlineMarkdown(x.text));
      linkFiles(row);
      return row;
    }),
    list.length ? null : h('div', { class: 'muted small' }, p.live === null ? 'No to-dos in this plan. Add some and they go with it when you build.' : ''),
    input
  );
  const chat = p.chatId && chats.find((c) => c.id === p.chatId);
  const refs = chat
    ? h(
        'div',
        { class: 'plan-section' },
        h('div', { class: 'plan-section-head' }, h('span', {}, 'Referenced by 1 agent')),
        h('div', { class: 'plan-ref', onclick: () => switchChat(chat.id) }, h('span', { class: 'todo-icon' }, '💬'), h('span', {}, chat.title), h('span', { class: 'muted' }, ` · ${agentLabel(chat)} · Author${list.length ? ` · ${list.length} to-do${list.length > 1 ? 's' : ''}` : ''}`))
      )
    : null;
  host.replaceChildren(...[doc, todoBox, refs].filter(Boolean));
}

// Called by activateTab for plan tabs (and with null to hide the plan UI).
function showPlan(t) {
  const on = !!(t && t.kind === 'plan');
  editor.updateOptions({ wordWrap: on ? 'on' : 'off' });
  $('#editor-host').classList.toggle('with-plan', on);
  $('#plan-bar').classList.toggle('hidden', !on);
  $('#plan-preview').classList.toggle('hidden', !on || !t.plan.preview);
  if (!on) return;
  renderPlanBar(t);
  if (t.plan.preview) renderPlanPreview(t);
  else editor.focus();
}

function keepPlanningPrompt(t) {
  const box = h('textarea', { class: 'plan-feedback', rows: 4, placeholder: 'What should change? Your edits to the plan are sent too.' });
  const send = h('button', { class: 'btn primary' }, 'Send back');
  const cancel = h('button', { class: 'btn' }, 'Cancel');
  const close = modal([h('div', { class: 'body' }, h('h3', {}, 'Keep planning'), box), h('div', { class: 'foot' }, cancel, send)]);
  cancel.addEventListener('click', close);
  send.addEventListener('click', () => {
    close();
    t.plan.onKeep(box.value.trim());
  });
  box.focus();
}

// ------------------------------------------------------------------ plans across restarts
//
// Open plan tabs are saved with the folder's workspace. After a restart the agent's turn that
// proposed the plan is gone, so Build it and Keep planning send a new message to the plan's chat.

function planSnapshot() {
  return state.tabs
    .filter((t) => t.kind === 'plan')
    .slice(-10)
    .map((t) => {
      const chat = chats.find((c) => c.id === t.plan.chatId);
      const p = t.plan;
      return { text: p.text.slice(0, 200000), state: p.state, status: p.status, path: p.path || null, live: p.live, ticked: p.ticked, session: chat ? chat.sessionId || null : p.session || null, active: activeTab() === t };
    });
}

function restorePlans(list) {
  let active = null;
  for (const s of list || []) {
    if (!s || !s.text) continue;
    const chatFor = () => chats.find((c) => s.session && c.sessionId === s.session) || null;
    let doc;
    const job = () => ({ started: false, todos: (l) => doc.todos(l), idle: () => doc.idle(), say: (text, status) => doc.resolve(text, status) });
    const onBuild = () => {
      const chat = chatFor();
      if (!chat) return toast('The chat this plan came from isn’t open any more.');
      if (chat.busy) return toast(`${agentLabel(chat)} is still working in that chat.`);
      switchChat(chat.id);
      chat.planBuildNext = job();
      send(`Build this plan now. Follow it step by step. ${PLAN_TRACK}\n\n${doc.text()}`, 'agent', 'Build the plan', chat);
      setMode('agent');
      doc.resolve('Approved. Building it now.', 'building');
    };
    const onKeep = (feedback) => {
      const chat = chatFor();
      if (!chat) return toast('The chat this plan came from isn’t open any more.');
      switchChat(chat.id);
      send(`Keep planning.${feedback ? ' My feedback: ' + feedback : ''} Here is the plan as it stands:\n\n${doc.text()}\n\nRevise it and present it again.`, 'plan', feedback ? `Keep planning: ${feedback}` : 'Keep planning', chat);
      doc.resolve('Sent back for revision.', 'sent');
    };
    doc = openPlanDoc(s.text, { onBuild, onKeep, chat: chatFor(), path: s.path });
    const t = state.tabs[state.tabs.length - 1];
    t.plan.session = s.session;
    // A build that was running when the app closed can't be followed any more.
    t.plan.state = s.status === 'building' ? 'Was building when Switchdesk closed.' : s.state || '';
    t.plan.status = s.status === 'building' ? 'error' : s.status || '';
    t.plan.live = s.live || null;
    t.plan.ticked = s.ticked || [];
    if (s.active) active = t;
  }
  return active;
}
