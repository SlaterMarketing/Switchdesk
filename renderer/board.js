/* global $, h, state, desk, toast, modal, chats, activeTab, activateTab, renderTabs, switchChat, createChat, renderChatTabs, renderWorktreeBar, appendChat,
   send, setMode, cleanErr, agentLabel, compareChoices, agentOf, activeChat, queueSaveWorkspace, gh, lin, refreshGithub, refreshLinear, startIssue, issueRef, openPr,
   openPrFromCopy, pushToPr, canPushTo */
'use strict';

// ------------------------------------------------------------------ the board
//
// Every chat's work at a glance, in columns: what needs you (a permission, a question or a plan to
// approve, or an error), what's running, what's done and ready for you to look at, and what has a
// pull request open. Start several issues or tasks at once from here, each in its own copy of the
// folder, so they run side by side.

const BOARD_COLUMNS = [
  { key: 'needs', title: 'Needs you' },
  { key: 'running', title: 'Running' },
  { key: 'review', title: 'Ready to review' },
  { key: 'pr', title: 'Pull request open' },
  { key: 'idle', title: 'Idle' },
];
let boardTimer = null;

function openBoard() {
  let t = state.tabs.find((x) => x.kind === 'board');
  if (!t) {
    t = { id: 'board', kind: 'board', rel: 'Board' };
    state.tabs.push(t);
  }
  activateTab(t.id);
}

function showBoard(t) {
  const on = !!(t && t.kind === 'board');
  $('#board-view').classList.toggle('hidden', !on);
  clearInterval(boardTimer);
  boardTimer = null;
  if (!on) return;
  renderBoard();
  // Chats change state in many places; while the board shows, it keeps up by itself.
  boardTimer = setInterval(renderBoard, 2000);
}

const boardShown = () => {
  const t = activeTab();
  return !!(t && t.kind === 'board');
};

// What a chat is waiting on you for, if anything.
function needsYou(chat) {
  const card = $('.card.approval:not(.resolved), .card.plan:not(.resolved)', chat.el);
  if (card) return ($('h4', card) || card).textContent.trim();
  const last = chat.el.lastElementChild;
  if (last && last.classList.contains('turn-error')) return 'It stopped with an error';
  return null;
}

function columnOf(chat) {
  if (needsYou(chat)) return 'needs';
  if (chat.busy || chat.making) return 'running';
  if (chat.pr && !(chat.worktree && chat.worktree.removed)) return 'pr';
  if (chat.worktree && !chat.worktree.removed && (chat.wtChanges || []).length) return 'review';
  return 'idle';
}

// The last thing it said, in a line.
function lastWords(chat) {
  const texts = chat.el.querySelectorAll('.msg-text, .turn-error, .notice');
  const el = texts[texts.length - 1];
  const text = el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  return text.length > 160 ? text.slice(0, 159) + '…' : text;
}

function boardCard(chat) {
  const col = columnOf(chat);
  const open = () => switchChat(chat.id);
  const wt = chat.worktree && !chat.worktree.removed;
  const changes = (chat.wtChanges || []).length;
  const action =
    col === 'needs'
      ? h('button', { class: 'btn small primary', onclick: open }, 'Answer')
      : col === 'pr'
        ? h('button', { class: 'btn small', onclick: () => openPr(chat.pr.number) }, `PR #${chat.pr.number}`)
        : col === 'review' && chat.issue && !chat.pr
          ? h('button', { class: 'btn small primary', onclick: () => (switchChat(chat.id), openPrFromCopy(chat)) }, 'Open pull request')
          : col === 'review' && chat.pr && canPushTo(chat.pr)
            ? h('button', { class: 'btn small primary', onclick: () => (switchChat(chat.id), pushToPr(chat)) }, `Push to PR #${chat.pr.number}`)
            : null;
  const bits = [agentLabel(chat), chat.issue ? `issue ${issueRef(chat.issue)}` : null, wt ? (changes ? `${changes} file${changes > 1 ? 's' : ''} changed` : 'own copy') : null, chat.pr && chat.pr.watch ? 'watching checks' : null].filter(Boolean);
  return h(
    'div',
    { class: `board-card ${col}${chat === activeChat() ? ' active' : ''}`, 'data-chat': chat.id },
    h('div', { class: 'board-title', title: chat.title, onclick: open }, chat.busy ? h('span', { class: 'spinner' }) : null, chat.title),
    h('div', { class: 'muted small' }, bits.join(' · ')),
    col === 'needs' ? h('div', { class: 'board-why small' }, needsYou(chat)) : null,
    lastWords(chat) ? h('div', { class: 'board-last small' }, lastWords(chat)) : null,
    h('div', { class: 'actions' }, h('button', { class: 'btn small', onclick: open }, 'Open chat'), action)
  );
}

function renderBoard() {
  if (!boardShown()) return;
  const view = $('#board-view');
  // Don't redraw under the mouse while you're pressing a button.
  if (view.matches(':active')) return;
  const list = chats.filter((c) => !(!c.sessionId && !c.busy && !c.making && !c.worktree && $('.empty-chat', c.el)));
  const by = new Map(BOARD_COLUMNS.map((c) => [c.key, []]));
  for (const c of list) by.get(columnOf(c)).push(c);
  const scroll = view.scrollTop;
  view.replaceChildren(
    h(
      'div',
      { class: 'board-head' },
      h('h2', {}, 'Board'),
      h('span', { class: 'muted small' }, list.length ? `${by.get('running').length} running · ${by.get('needs').length} need${by.get('needs').length === 1 ? 's' : ''} you` : ''),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn small primary', onclick: startSeveral }, 'Start several…')
    ),
    list.length
      ? h(
          'div',
          { class: 'board-cols' },
          ...BOARD_COLUMNS.filter((c) => c.key !== 'idle' || by.get('idle').length).map((c) =>
            h('div', { class: `board-col ${c.key}` }, h('div', { class: 'board-col-head small' }, `${c.title} (${by.get(c.key).length})`), ...by.get(c.key).map(boardCard))
          )
        )
      : h('div', { class: 'muted board-empty' }, 'No chats yet. Start several issues or tasks at once, each in its own copy of the folder.')
  );
  view.scrollTop = scroll;
}

// ------------------------------------------------------------------ starting several at once

async function startSeveral() {
  if (!state.folder) return toast('Open a folder first.');
  if (gh.status && gh.status.signedIn && !gh.issues) await refreshGithub(true);
  if (lin.status && lin.status.signedIn && !lin.issues) await refreshLinear(true);
  const choices = await compareChoices();
  if (!choices.length) return toast('Sign in to an agent first (Settings → Agents).');
  const own = agentOf(activeChat());
  const agent = h('select', {}, ...[...choices.filter((c) => c.id === own), ...choices.filter((c) => c.id !== own)].map((c, i) => h('option', { value: String(choices.indexOf(c)), selected: i === 0 }, c.label)));
  const mode = h('select', {}, h('option', { value: 'agent' }, 'Do the work (Agent)'), h('option', { value: 'plan' }, 'Plan first, for me to approve'));
  const picks = [];
  const row = (label, sub, item) => {
    const box = h('input', { type: 'checkbox' });
    picks.push({ box, item });
    return h('label', { class: 'board-pick' }, box, h('span', {}, label), h('span', { class: 'muted small' }, sub));
  };
  const issues = [
    ...(gh.issues || []).map((i) => row(i.title, `#${i.number}`, { kind: 'github', number: i.number })),
    ...((lin.status && lin.status.signedIn && lin.issues) || []).map((i) => row(i.title, i.identifier, { kind: 'linear', id: i.id })),
  ];
  const tasks = h('textarea', { class: 'pr-body', rows: 4, placeholder: 'Or type tasks, one per line, e.g.\nAdd a dark mode\nMake the tests faster', spellcheck: 'true' });
  const go = h('button', { class: 'btn primary' }, 'Start');
  const close = modal([
    h(
      'div',
      { class: 'body board-start' },
      h('h3', {}, 'Start several at once'),
      h('p', { class: 'muted small' }, 'Each one gets its own chat in its own copy of the folder, on its own branch, and they all run at the same time. Your folder isn\'t touched.'),
      issues.length ? h('div', { class: 'board-picks' }, ...issues) : null,
      tasks,
      h('div', { class: 'row' }, agent, mode)
    ),
    h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: () => close() }, 'Cancel'), go),
  ]);
  go.addEventListener('click', async () => {
    const chosen = picks.filter((p) => p.box.checked).map((p) => p.item);
    const lines = tasks.value.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!chosen.length && !lines.length) return tasks.focus();
    go.disabled = true;
    go.textContent = 'Starting…';
    const pick = choices[Number(agent.value)];
    const opts = { agent: pick.id, account: pick.account };
    let started = 0;
    for (const item of chosen) {
      try {
        const i = item.kind === 'github' ? await desk.github.issue(item.number) : await desk.linear.issue(item.id);
        await startIssue(i, mode.value, opts);
        started++;
      } catch (e) {
        toast(cleanErr(e));
      }
    }
    for (const line of lines) if (await startTask(line, mode.value, opts)) started++;
    close();
    openBoard();
    toast(`Started ${started} chat${started === 1 ? '' : 's'}.`);
  });
}

// A chat in its own copy, working on one task.
async function startTask(text, mode, { agent, account } = {}) {
  const chat = createChat({ title: text.slice(0, 60) });
  if (agent) chat.agent = agent;
  if (account && account !== 'default') chat.agentAccount = account;
  chat.making = true;
  try {
    chat.worktree = await desk.worktree.create(text.slice(0, 40));
    chat.wtCount = 0;
  } catch (e) {
    chat.making = false;
    appendChat(h('div', { class: 'turn-error' }, cleanErr(e)), chat);
    return false;
  }
  chat.making = false;
  renderChatTabs();
  renderWorktreeBar();
  queueSaveWorkspace();
  if (chat === activeChat()) setMode(mode);
  send(`${text}\n\nYou're in your own copy of the repository, on a branch of its own. Make the change, check it works, and commit with a clear message.`, mode, text, chat);
  return true;
}

function wireBoard() {
  $('#btn-board').addEventListener('click', openBoard);
}
