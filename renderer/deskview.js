/* global $, h, desk, state, setFolder, loadHistory, showSidePanel */
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
