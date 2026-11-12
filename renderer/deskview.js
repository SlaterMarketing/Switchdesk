/* global $, h, desk, state, toast, setFolder, loadHistory, showSidePanel, activeChat, openFile, renderMarkdown, newChat, renderProjectSwitcher, fillProjectHome */
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

// The top of Desk's chat list is the project you're in, with the others a click away (projects.js).
function renderDeskFolder() {
  renderProjectSwitcher();
  fillProjectHome();
}

// Ctrl/⌘+K in Desk (the menu's shortcut for editing a selection, which Desk has no editor for).
function searchChats() {
  $('#workbench').classList.remove('no-sidebar');
  const filter = $('#history-filter');
  filter.focus();
  filter.select();
}

function wireDeskView() {
  for (const b of document.querySelectorAll('#view-switch button')) b.addEventListener('click', () => setView(b.dataset.view));
  // Searching your chats, as in Claude's app: type to filter, Escape clears.
  const filter = $('#history-filter');
  filter.addEventListener('input', () => loadHistory());
  filter.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      filter.value = '';
      loadHistory();
      $('#input').focus();
    } else if (e.key === 'Enter') {
      const first = document.querySelector('#history-list .history-row');
      if (first) first.click();
    }
  });
  $('#btn-desk-outputs').addEventListener('click', toggleDeskOutputs);
  // In Desk, where there's no editor to edit a selection in: Ctrl/⌘+K searches your chats, and
  // Escape closes the panel beside the chat (Claude's app does both).
  window.addEventListener(
    'keydown',
    (e) => {
      if (!document.body.classList.contains('desk') || $('#workbench').classList.contains('peek')) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        e.stopPropagation();
        searchChats();
      } else if (e.key === 'Escape' && !document.querySelector('.modal-backdrop, .popup:not(.hidden)') && document.activeElement !== filter) {
        const chat = activeChat();
        if (chat && chat.outputs && chat.outputs.size && !chat.outputsHidden) {
          chat.outputsHidden = true;
          renderDeskOutputs();
        }
      }
    },
    true
  );
  applyView();
}

// ------------------------------------------------------------------ what the chat made

// Desk's right-hand panel: every file the active chat has made or changed, newest first, with a
// preview of the one you pick. Documents show as their text, images as themselves.
const deskOut = { chat: null, rel: null, seq: 0 };
const TEXT_EXT = /\.(md|markdown|txt|csv|tsv|json|ya?ml|xml|log|js|ts|jsx|tsx|py|rb|go|rs|java|c|h|cpp|cs|php|sh|css|scss|sql|toml|ini)$/i;
const fileIcon = (rel) =>
  /\.(png|jpe?g|gif|webp|svg)$/i.test(rel) ? '🖼' : /\.(docx?|odt|rtf|pdf|md|txt)$/i.test(rel) ? '📄' : /\.(xlsx?|ods|csv|tsv)$/i.test(rel) ? '📊' : /\.(pptx?|odp)$/i.test(rel) ? '📽' : /\.html?$/i.test(rel) ? '🌐' : '📎';

function toggleDeskOutputs() {
  const chat = activeChat();
  if (!chat) return;
  chat.outputsHidden = !chat.outputsHidden;
  renderDeskOutputs();
}

// HTML, SVG and PDF show as themselves (a live page, the drawing, the document), like an artifact in
// Claude's app, in a sandboxed webview with no Node and no access to Switchdesk. Everything else
// shows as text. Each can flip to its text with "Code".
const LIVE_EXT = /\.(html?|svg|pdf)$/i;

function renderDeskOutputs() {
  const panel = $('#desk-outputs');
  if (!panel) return;
  const chat = activeChat();
  if (chat !== deskOut.chat) Object.assign(deskOut, { chat, rel: null, code: false });
  const list = chat && chat.outputs ? [...chat.outputs.values()].reverse() : [];
  const btn = $('#btn-desk-outputs');
  if (btn) {
    btn.classList.toggle('hidden', !list.length);
    btn.classList.toggle('active', list.length > 0 && !chat.outputsHidden);
    btn.textContent = `▤ ${list.length}`;
    btn.title = chat && chat.outputsHidden ? `Show the ${list.length} file${list.length === 1 ? '' : 's'} this chat made` : 'Hide the files this chat made (Esc)';
  }
  const show = list.length > 0 && !chat.outputsHidden;
  $('#workbench').classList.toggle('has-outputs', show);
  if (!show) return panel.replaceChildren();
  if (!deskOut.rel || !chat.outputs.has(deskOut.rel)) deskOut.rel = list[0].rel;
  const row = (c) => {
    const name = c.rel.split('/').pop();
    const dir = c.rel.includes('/') ? c.rel.slice(0, c.rel.lastIndexOf('/')) : '';
    const what = c.undone ? 'undone' : c.deleted ? 'deleted' : c.created ? 'new' : 'changed';
    return h(
      'button',
      { class: `out-row${c.rel === deskOut.rel ? ' active' : ''}${c.undone || c.deleted ? ' gone' : ''}`, title: c.rel, onclick: () => (Object.assign(deskOut, { rel: c.rel, code: false }), renderDeskOutputs()) },
      h('span', { class: 'out-icon' }, fileIcon(c.rel)),
      h('span', { class: 'out-name' }, name, dir ? h('span', { class: 'out-dir' }, dir) : null),
      h('span', { class: `out-what ${what}` }, what)
    );
  };
  const preview = h('div', { class: 'out-preview' }, h('div', { class: 'muted small' }, 'Loading…'));
  panel.replaceChildren(
    h('div', { class: 'out-head' }, h('b', {}, 'Made in this chat'), h('span', { class: 'muted small' }, String(list.length)), h('span', { class: 'spacer' }), h('button', { class: 'icon-btn out-close', title: 'Close (Esc)', onclick: toggleDeskOutputs }, '✕')),
    h('div', { class: 'out-list' }, ...list.map(row)),
    preview
  );
  showDeskPreview(preview, chat.outputs.get(deskOut.rel));
}

// A webview showing a file the agent made, kept apart from the Preview tab's (its own, in-memory session).
function liveView(url) {
  const v = document.createElement('webview');
  v.className = 'out-live';
  v.setAttribute('partition', 'desk-outputs');
  v.setAttribute('plugins', ''); // Chromium's PDF viewer
  v.setAttribute('src', url);
  return v;
}

async function showDeskPreview(el, c) {
  const seq = ++deskOut.seq;
  const gone = c.undone || c.deleted;
  const act = (label, fn, cls = 'btn small', title) => h('button', { class: cls, title: title || '', onclick: () => Promise.resolve(fn()).catch((e) => toast(String(e.message || e))) }, label);
  const live = !gone && LIVE_EXT.test(c.rel) ? await desk.fileUrl(c.rel).catch(() => null) : null;
  if (seq !== deskOut.seq) return;
  let text = null;
  const actions = gone
    ? []
    : [
        live
          ? h(
              'div',
              { class: 'out-seg', role: 'group' },
              act('Preview', () => ((deskOut.code = false), renderDeskOutputs()), `seg-btn${deskOut.code ? '' : ' active'}`, 'Show it as it looks'),
              act(/\.pdf$/i.test(c.rel) ? 'Text' : 'Code', () => ((deskOut.code = true), renderDeskOutputs()), `seg-btn${deskOut.code ? ' active' : ''}`, 'Show its text')
            )
          : null,
        h('span', { class: 'spacer' }),
        act('Copy', () => (text != null ? navigator.clipboard.writeText(text).then(() => toast('Copied.')) : toast("There's no text to copy in this file.")), 'btn small', 'Copy its text'),
        TEXT_EXT.test(c.rel) || /\.(html?|svg)$/i.test(c.rel) ? act('Edit', () => openFile(c.rel), 'btn small', 'Edit it beside the chat') : null,
        act('Show in folder', () => desk.revealFile(c.rel)),
        act('Open', () => desk.openFileDefault(c.rel), 'btn small primary', 'Open it in its own app'),
      ].filter(Boolean);
  let body;
  if (gone) body = h('div', { class: 'muted small' }, c.undone ? 'You undid this change.' : 'The agent deleted this file.');
  else if (live && !deskOut.code) {
    body = liveView(live);
    // Its text is still there to copy.
    desk.previewFile(c.rel).then((r) => r && typeof r.text === 'string' && seq === deskOut.seq && (text = r.text), () => {});
  } else {
    const r = /\.(html?|svg)$/i.test(c.rel) ? await desk.readFile(c.rel).then((x) => ({ kind: 'text', text: typeof x === 'string' ? x : (x && x.content) || '' })).catch(() => desk.previewFile(c.rel)) : await desk.previewFile(c.rel).catch((e) => ({ kind: 'error', error: String(e.message || e) }));
    if (seq !== deskOut.seq) return;
    if (r && typeof r.text === 'string') text = r.text;
    if (!r || r.kind === 'file') body = h('div', { class: 'muted small' }, "Switchdesk can't show this kind of file. Open it in its own app instead.");
    else if (r.kind === 'error') body = h('div', { class: 'muted small' }, r.error);
    else if (r.kind === 'image') body = h('img', { class: 'out-image', src: `data:${r.mediaType};base64,${r.data}`, alt: c.rel });
    else if (!/\.(html?|svg)$/i.test(c.rel) && /\.(md|markdown|docx?|odt|rtf|pdf|pptx?|odp)$/i.test(c.rel)) {
      body = h('div', { class: 'msg-text out-doc' });
      renderMarkdown(body, r.text + (r.truncated ? '\n\n…' : ''));
    } else body = h('pre', { class: 'out-text' }, r.text);
  }
  if (seq !== deskOut.seq) return;
  el.replaceChildren(
    h('div', { class: 'out-actions' }, h('span', { class: 'out-title', title: c.rel }, c.rel.split('/').pop())),
    actions.length ? h('div', { class: 'out-actions out-tools' }, ...actions) : '',
    h('div', { class: `out-body${body.tagName === 'WEBVIEW' ? ' live' : ''}` }, body)
  );
}
