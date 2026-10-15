/* global $, desk, state, isMac, applyTheme, wire, wireImageInput, wireTerminal, wireGit, setMode, renderRecent, checkCli, loadMonaco, createEditors, wireDiff, wireReview, wirePreview, createChat, setFolder, loadAccounts, wireAccounts, loadAgents, wireAgents */
'use strict';

// Runs last, once every renderer script has loaded.

// The window never scrolls as a whole; only panels inside it do. Undo any scroll a focus() causes.
for (const el of [document.scrollingElement, document.body, document.getElementById('app')])
  el.addEventListener('scroll', () => el.scrollTop && (el.scrollTop = 0));
addEventListener('scroll', () => scrollY && scrollTo(0, 0));

async function init() {
  if (!isMac) {
    // Show Ctrl shortcuts on Windows and Linux.
    for (const el of document.querySelectorAll('kbd, [title]')) {
      if (el.tagName === 'KBD') el.textContent = el.textContent.replace('⌘', 'Ctrl+');
      if (el.title) el.title = el.title.replace('⌘', 'Ctrl+');
    }
  }
  state.settings = await desk.getSettings();
  applyTheme();
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);
  renderAppMenu();
  wire();
  wireImageInput();
  wireTerminal();
  wireGit();
  wireSearch();
  wireAccounts();
  wireAgents();
  await loadAccounts();
  await loadAgents();
  setMode(state.settings.mode || 'agent');
  $('#effort-select').value = state.settings.effort || '';
  renderRecent();
  checkCli({ showSetupIfNeeded: true });
  await loadMonaco();
  createEditors();
  wireDiff();
  wireReview();
  wirePreview();
  createChat();
  const current = await desk.currentFolder();
  if (current) setFolder(current);
  else if ((state.settings.recentFolders || [])[0]) setFolder(await desk.openFolder(state.settings.recentFolders[0]));
}

init();
