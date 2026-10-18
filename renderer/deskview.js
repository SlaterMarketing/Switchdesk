/* global $, h, desk, state, toast, setFolder, loadHistory, showSidePanel, activeChat, openFile, renderMarkdown */
'use strict';

// Two views of the same window. Code is the editor. Desk hides the editor, files and terminal and
// puts the chat in the middle with your chats down the left, for working with an agent the way
// Claude's desktop app does. Both show the same chats, so you can switch mid-conversation.
// Anything opened in an editor tab (a file, a plan, the board) shows beside the chat until it's closed.

function applyView() {
  const deskView = state.settings.view === 'desk';
  document.body.classList.toggle('desk', deskView);
  for (const b of document.querySelectorAll('#view-switch button')) b.classList.toggle('active', b.dataset.view === (deskView ? 'desk' : 'code'));
  if (deskView) {
    $('#workbench').classList.remove('no-sidebar');
    renderDeskFolder();
    loadHistory();
  } else if (state.sidePanel && state.sidePanel !== 'history') showSidePanel(state.sidePanel);
}

async function setView(view) {
  if ((state.settings.view || 'code') === view) return;
  state.settings = await desk.setSettings({ view });
  applyView();
  $('#input').focus();
}

function toggleView() {
  return setView(state.settings.view === 'desk' ? 'code' : 'desk');
}

// The folder the agents work in, at the top of Desk's chat list. It's optional: with none, chats are plain chats.
function renderDeskFolder() {
  const el = $('#desk-folder');
  if (!el) return;
  const pick = async () => setFolder(await desk.pickFolder());
  el.replaceChildren(
    state.folder
      ? h('div', { class: 'desk-folder-row', title: state.folder.root }, h('span', { class: 'desk-folder-icon' }, '📁'), h('span', { class: 'desk-folder-name' }, state.folder.name), h('button', { class: 'ghost-btn', onclick: pick }, 'Change'))
      : h('button', { class: 'btn small desk-folder-pick', title: 'Let the agent read and change the files in a folder', onclick: pick }, '📁 Work in a folder…')
  );
}

function wireDeskView() {
  for (const b of document.querySelectorAll('#view-switch button')) b.addEventListener('click', () => setView(b.dataset.view));
  applyView();
}

// ------------------------------------------------------------------ what the chat made

// Desk's right-hand panel: every file the active chat has made or changed, newest first, with a
// preview of the one you pick. Documents show as their text, images as themselves.
const deskOut = { chat: null, rel: null, seq: 0 };
const TEXT_EXT = /\.(md|markdown|txt|csv|tsv|json|ya?ml|xml|log|js|ts|jsx|tsx|py|rb|go|rs|java|c|h|cpp|cs|php|sh|css|scss|sql|toml|ini)$/i;
const fileIcon = (rel) =>
  /\.(png|jpe?g|gif|webp|svg)$/i.test(rel) ? '🖼' : /\.(docx?|odt|rtf|pdf|md|txt)$/i.test(rel) ? '📄' : /\.(xlsx?|ods|csv|tsv)$/i.test(rel) ? '📊' : /\.(pptx?|odp)$/i.test(rel) ? '📽' : /\.html?$/i.test(rel) ? '🌐' : '📎';

function renderDeskOutputs() {
  const panel = $('#desk-outputs');
  if (!panel) return;
  const chat = activeChat();
  if (chat !== deskOut.chat) Object.assign(deskOut, { chat, rel: null });
  const list = chat && chat.outputs ? [...chat.outputs.values()].reverse() : [];
  $('#workbench').classList.toggle('has-outputs', list.length > 0);
  if (!list.length) return panel.replaceChildren();
  if (!deskOut.rel || !chat.outputs.has(deskOut.rel)) deskOut.rel = list[0].rel;
  const row = (c) => {
    const name = c.rel.split('/').pop();
    const dir = c.rel.includes('/') ? c.rel.slice(0, c.rel.lastIndexOf('/')) : '';
    const what = c.undone ? 'undone' : c.deleted ? 'deleted' : c.created ? 'new' : 'changed';
    return h(
      'button',
      { class: `out-row${c.rel === deskOut.rel ? ' active' : ''}${c.undone || c.deleted ? ' gone' : ''}`, title: c.rel, onclick: () => ((deskOut.rel = c.rel), renderDeskOutputs()) },
      h('span', { class: 'out-icon' }, fileIcon(c.rel)),
      h('span', { class: 'out-name' }, name, dir ? h('span', { class: 'out-dir' }, dir) : null),
      h('span', { class: `out-what ${what}` }, what)
    );
  };
  const preview = h('div', { class: 'out-preview' }, h('div', { class: 'muted small' }, 'Loading…'));
  panel.replaceChildren(h('div', { class: 'out-head' }, h('b', {}, 'Made in this chat'), h('span', { class: 'muted small' }, String(list.length))), h('div', { class: 'out-list' }, ...list.map(row)), preview);
  showDeskPreview(preview, chat.outputs.get(deskOut.rel));
}

async function showDeskPreview(el, c) {
  const seq = ++deskOut.seq;
  const gone = c.undone || c.deleted;
  const act = (label, fn, cls = 'btn small') => h('button', { class: cls, onclick: () => Promise.resolve(fn()).catch((e) => toast(String(e.message || e))) }, label);
  const actions = gone
    ? []
    : [
        act('Open', () => desk.openFileDefault(c.rel), 'btn small primary'),
        act('Show in folder', () => desk.revealFile(c.rel)),
        TEXT_EXT.test(c.rel) || /\.html?$/i.test(c.rel) ? act('Edit', () => openFile(c.rel)) : null,
      ].filter(Boolean);
  let body;
  if (gone) body = h('div', { class: 'muted small' }, c.undone ? 'You undid this change.' : 'The agent deleted this file.');
  else {
    const r = await desk.previewFile(c.rel).catch((e) => ({ kind: 'error', error: String(e.message || e) }));
    if (seq !== deskOut.seq) return;
    if (!r || r.kind === 'file') body = h('div', { class: 'muted small' }, "Switchdesk can't show this kind of file. Open it in its own app instead.");
    else if (r.kind === 'error') body = h('div', { class: 'muted small' }, r.error);
    else if (r.kind === 'image') body = h('img', { class: 'out-image', src: `data:${r.mediaType};base64,${r.data}`, alt: c.rel });
    else if (/\.(md|markdown|docx?|odt|rtf|pdf|pptx?|odp|html?)$/i.test(c.rel)) {
      body = h('div', { class: 'msg-text out-doc' });
      renderMarkdown(body, r.text + (r.truncated ? '\n\n…' : ''));
    } else body = h('pre', { class: 'out-text' }, r.text);
  }
  if (seq !== deskOut.seq) return;
  el.replaceChildren(h('div', { class: 'out-actions' }, h('span', { class: 'out-title', title: c.rel }, c.rel.split('/').pop()), h('span', { class: 'spacer' }), ...actions), h('div', { class: 'out-body' }, body));
}
