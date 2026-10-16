/* global $, h, state, monaco, editor, activeTab, activateTab, renderMarkdown, modal, openFile, chats, switchChat, agentLabel */
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
    if (t.plan.preview && activeTab() === t) renderPlanPreview(t);
  });
}

// Opens the plan in a tab. Returns handles the chat's plan card uses.
function openPlanDoc(markdown, { onBuild, onKeep, chat, path } = {}) {
  const t = { id: `plan:${++planSeq}`, kind: 'plan', rel: `Plan: ${planTitle(markdown)}`, plan: { text: markdown, state: '', status: '', preview: true, onBuild, onKeep, live: null, chatId: chat && chat.id, path } };
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
      refresh();
    },
    // The agent's own to-do list while it builds (TodoWrite, or ACP and Codex plan updates).
    todos: (list) => {
      t.plan.live = (list || []).map((x) => ({ text: x.content || x.activeForm || '', status: x.status }));
      refresh();
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
  const status = p.status === 'building' ? h('span', { class: 'plan-status building' }, h('span', { class: 'spinner' }), 'Building') : p.status === 'built' ? h('span', { class: 'plan-status built' }, 'Built ✓') : p.status ? h('span', { class: `plan-status ${p.status}` }, p.status === 'sent' ? 'Sent back' : p.status === 'waiting' ? 'Waiting on you' : 'Stopped') : null;
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
  const { body, todos } = splitTodos(p.text);
  const doc = h('div', { class: 'msg-text plan-doc' });
  renderMarkdown(doc, body);
  linkFiles(doc);
  // Without the agent's own progress, a finished build ticks off the plan's to-dos.
  const list = p.live && p.live.length ? p.live : p.status === 'built' ? todos.map((x) => ({ ...x, status: 'completed' })) : todos;
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
      p.live ? null : h('button', { class: 'btn small', onclick: () => (input.classList.remove('hidden'), input.focus()) }, '＋ New')
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
