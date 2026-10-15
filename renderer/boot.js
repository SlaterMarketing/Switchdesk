/* global $, desk, state, isMac, applyTheme, wire, wireImageInput, wireTerminal, wireGit, setMode, renderRecent, checkCli, loadMonaco, createEditors, wireDiff, createChat, setFolder */
'use strict';

// Runs last, once every renderer script has loaded.

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
  setMode(state.settings.mode || 'agent');
  $('#model-select').value = state.settings.model || '';
  $('#effort-select').value = state.settings.effort || '';
  renderRecent();
  checkCli({ showSetupIfNeeded: true });
  await loadMonaco();
  createEditors();
  wireDiff();
  createChat();
  const current = await desk.currentFolder();
  if (current) setFolder(current);
  else if ((state.settings.recentFolders || [])[0]) setFolder(await desk.openFolder(state.settings.recentFolders[0]));
}

init();
