/* global $, h, desk, toolRow, toolResult, resultText, renderMarkdown, chatAccount, appendChat, HIDDEN_TOOLS */
'use strict';

// ------------------------------------------------------------------ subagents
//
// Claude's subagents (its Agent tool). Each one's row in the chat opens a view of it over the chat:
// the task it was given, its thinking, the tools it used and what it reported, live while it runs.
// A past chat's subagents come from their own transcripts.

const STATUS_TEXT = { running: 'Running', background: 'Running in the background', completed: 'Finished', failed: 'Failed', stopped: 'Stopped' };
let subView = null; // { sub, el }

function subFor(chat, id) {
  chat.subs ||= new Map();
  let sub = chat.subs.get(id);
  if (!sub) {
    sub = { id, chat, status: 'running', tools: new Map(), log: h('div', { class: 'sub-log' }), steps: 0 };
    chat.subs.set(id, sub);
  }
  return sub;
}

// A subagent's row: shows how far it has got, and opens its view.
function linkSubagent(chat, id, row) {
  const sub = subFor(chat, id || crypto.randomUUID());
  sub.row = row;
  row.sub = sub;
  sub.progressEl = h('span', { class: 'sub-progress' });
  $('.head', row.el).append(sub.progressEl, h('span', { class: 'sub-open' }, 'View ›'));
  renderSubProgress(sub);
}

function renderSubProgress(sub) {
  if (!sub.progressEl) return;
  const bits = [];
  if (sub.status === 'background') bits.push('in the background');
  else if (sub.status !== 'running' && sub.status !== 'completed') bits.push(STATUS_TEXT[sub.status].toLowerCase());
  if (sub.steps) bits.push(`${sub.steps} step${sub.steps > 1 ? 's' : ''}`);
  if (sub.lastTool && (sub.status === 'running' || sub.status === 'background')) bits.push(sub.lastTool);
  sub.progressEl.textContent = bits.length ? ' · ' + bits.join(' · ') : '';
  const live = sub.status === 'running' || sub.status === 'background';
  if (sub.row) {
    sub.row.el.classList.toggle('running', live);
    sub.row.el.classList.toggle('error', sub.status === 'failed');
  }
  if (subView && subView.sub === sub) renderSubHead(sub);
}

// Whatever the subagent itself says and does (events carrying its tool call's id).
function subagentEvent(chat, ev) {
  if (ev.type !== 'assistant' && ev.type !== 'user') return; // its streaming arrives whole as well
  addToLog(subFor(chat, ev.parent_tool_use_id), ev);
}

function addToLog(sub, ev) {
  const at = sub.log;
  const stick = subView && subView.sub === sub && nearBottom();
  const content = ev.message?.content;
  if (ev.type === 'user') {
    if (typeof content === 'string') sub.prompt ||= content; // the task it was given
    for (const b of Array.isArray(content) ? content : []) {
      if (b.type === 'tool_result' && sub.tools.has(b.tool_use_id)) toolResult(sub.tools.get(b.tool_use_id), b, ev.tool_use_result);
      else if (b.type === 'text' && !sub.prompt) sub.prompt = b.text;
    }
  } else {
    for (const b of content || []) {
      if (b.type === 'thinking' && b.thinking) {
        at.append(h('details', { class: 'thinking' }, h('summary', {}, 'Thinking'), h('div', { class: 'body' }, b.thinking)));
      } else if (b.type === 'text' && b.text.trim()) {
        const el = h('div', { class: 'msg-text' });
        renderMarkdown(el, b.text);
        at.append(el);
        sub.lastText = b.text;
      } else if (b.type === 'tool_use' && !HIDDEN_TOOLS.has(b.name)) {
        const row = toolRow(b.name, b.input);
        sub.tools.set(b.id, row);
        at.append(row.el);
        sub.steps++;
        sub.lastTool = b.name;
      }
    }
    renderSubProgress(sub);
  }
  if (stick) scrollSub();
}

// Claude Code's own reports on its subagents: started, progress, finished.
function subagentStatus(chat, ev) {
  if (ev.subtype === 'background_tasks_changed') {
    chat.background = (ev.tasks || []).map((t) => t.task_id);
    if (!chat.background.length) waitingForBackground(chat, false);
    else if (chat.bgNotice) waitingForBackground(chat, true);
    return;
  }
  const sub = ev.tool_use_id ? subFor(chat, ev.tool_use_id) : [...(chat.subs || new Map()).values()].find((s) => s.taskId === ev.task_id);
  if (!sub) return;
  if (ev.task_id) sub.taskId = ev.task_id;
  if (ev.subtype === 'task_started') {
    if (ev.prompt) sub.prompt = ev.prompt;
    if (ev.is_backgrounded) sub.status = 'background';
  } else if (ev.subtype === 'task_progress') {
    if (ev.last_tool_name) sub.lastTool = ev.last_tool_name;
  } else if (ev.subtype === 'task_notification' || (ev.subtype === 'task_updated' && ev.patch && /^(completed|failed|stopped|killed)$/.test(ev.patch.status || ''))) {
    const st = ev.status || ev.patch.status;
    sub.status = st === 'completed' ? 'completed' : st === 'failed' ? 'failed' : 'stopped';
    if (ev.summary) sub.summary = ev.summary;
  }
  renderSubProgress(sub);
}

// The subagent's tool call came back: what it reported, or (in the background) that it started.
function subagentResult(sub, b, r) {
  if (r && r.agentId) sub.agentId = r.agentId;
  if (r && r.isAsync) {
    if (sub.status === 'running') sub.status = 'background';
  } else {
    sub.result = resultText(b.content);
    sub.status = b.is_error ? 'failed' : 'completed';
  }
  renderSubProgress(sub);
}

const runningInBackground = (chat) => !!(chat.background && chat.background.length);

// After Claude's turn, while its background subagents still run.
function waitingForBackground(chat, on) {
  if (!on) {
    if (chat.bgNotice) chat.bgNotice.remove();
    chat.bgNotice = null;
    return;
  }
  const n = (chat.background || []).length;
  const text = `Waiting for ${n} background subagent${n === 1 ? '' : 's'}. Claude carries on when ${n === 1 ? 'it finishes' : 'they finish'}.`;
  if (chat.bgNotice) return ($('.t', chat.bgNotice).textContent = text);
  chat.bgNotice = appendChat(h('div', { class: 'notice waiting' }, h('span', { class: 'spinner' }), h('span', { class: 't' }, text)), chat);
}

// A past chat's subagent: its result and transcript.
function pastSubagent(chat, m) {
  const sub = chat.subs && chat.subs.get(m.id);
  if (!sub) return;
  sub.agentId = m.agentId;
  sub.status = 'completed';
  if (m.text) sub.result = m.text;
  sub.past = true;
  renderSubProgress(sub);
}

// ------------------------------------------------------------------ the view

function openSubagent(sub) {
  closeSubagent();
  const el = h('div', { class: 'sub-view' });
  subView = { sub, el };
  $('#chat').append(el);
  el.replaceChildren(
    h('div', { class: 'sub-head' }, h('button', { class: 'btn small', onclick: closeSubagent }, '← Back to chat'), h('div', { class: 'sub-title' }), h('span', { class: 'sub-status' })),
    h('div', { class: 'sub-body' }, h('details', { class: 'card sub-task', open: true }, h('summary', {}, 'Task'), h('div', { class: 'msg-text' })), sub.log, h('div', { class: 'sub-report' }))
  );
  // A past chat's subagent, or one opened after a restart: read what it did from its transcript.
  if (!sub.log.children.length && sub.agentId && sub.chat.sessionId && !sub.loading) {
    sub.loading = desk
      .loadSubagent(sub.chat.sessionId, sub.agentId, sub.chat.worktree ? sub.chat.worktree.path : undefined, chatAccount(sub.chat))
      .then((evs) => {
        if (!sub.log.children.length) for (const ev of evs) addToLog(sub, ev);
      })
      .catch(() => {})
      .finally(() => {
        sub.loaded = true;
        if (subView && subView.sub === sub) renderSubHead(sub), scrollSub();
      });
  }
  renderSubHead(sub);
  scrollSub();
}

function renderSubHead(sub) {
  const el = subView.el;
  const input = (sub.row && sub.row.input) || {};
  $('.sub-title', el).replaceChildren(...[h('b', {}, input.description || 'Subagent'), input.subagent_type && input.subagent_type !== 'general-purpose' ? h('span', { class: 'muted small' }, ` · ${input.subagent_type}`) : null].filter(Boolean));
  const status = sub.past && sub.status === 'completed' ? 'Finished' : STATUS_TEXT[sub.status] || sub.status;
  const live = sub.status === 'running' || sub.status === 'background';
  $('.sub-status', el).replaceChildren(...(live ? [h('span', { class: 'spinner' })] : []), `${status}${sub.steps ? ` · ${sub.steps} step${sub.steps > 1 ? 's' : ''}` : ''}`);
  $('.sub-status', el).className = `sub-status ${sub.status}`;
  renderMarkdown($('.sub-task .msg-text', el), sub.prompt || input.prompt || '_The task it was given will show when it starts._');
  const report = sub.result || sub.summary;
  const box = $('.sub-report', el);
  if (!sub.log.children.length && !live) return box.replaceChildren(h('div', { class: 'muted small' }, sub.loading && !sub.loaded ? 'Loading what it did…' : 'Nothing more was recorded for this subagent.'));
  // Its last message is usually the report itself: no need to show it twice.
  if (!report || live || report.trim() === (sub.lastText || '').trim()) return box.replaceChildren();
  const md = h('div', { class: 'msg-text' });
  renderMarkdown(md, report);
  box.replaceChildren(h('div', { class: 'card sub-result' }, h('h4', {}, sub.status === 'failed' ? 'Failed' : 'Reported back'), md));
}

const nearBottom = () => {
  const b = subView && $('.sub-body', subView.el);
  return !b || b.scrollHeight - b.scrollTop - b.clientHeight < 140;
};
function scrollSub() {
  const b = subView && $('.sub-body', subView.el);
  if (b) b.scrollTop = b.scrollHeight;
}

function closeSubagent() {
  if (!subView) return;
  subView.el.remove();
  subView = null;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && subView && !document.querySelector('.modal-backdrop, .modal')) closeSubagent();
});
