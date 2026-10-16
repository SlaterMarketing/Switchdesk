/* global $, desk, state, isMac, applyTheme, wire, wireImageInput, wireTerminal, wireGit, setMode, renderRecent, checkCli, loadMonaco, createEditors, wireDiff, wireReview, wirePreview, createChat, setFolder, loadAccounts, loadAgents, wireAgents, wireCompare, wireOpinion, wireSchedules */
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
      const keys = (t) => t.replace('⌘', 'Ctrl+').replace('⇧', 'Shift+').replace('⌥', 'Alt+');
      if (el.tagName === 'KBD') el.textContent = keys(el.textContent);
      if (el.title) el.title = keys(el.title);
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
  wireAgents();
  $('#status-limit').addEventListener('click', () => openSettings('usage'));
  $('#status-perms').addEventListener('click', () => openSettings('permissions'));
  renderPermissionBadge();
  await loadAccounts();
  loadUsageLimits();
  await loadAgents();
  setMode(state.settings.mode || 'agent');
  $('#effort-select').value = state.settings.effort || '';
  renderRecent();
  checkCli({ showSetupIfNeeded: true });
  await loadMonaco();
  createEditors();
  wireAutocomplete();
  wireIntel();
  wireCodebase();
  wireConflicts();
  wireBlame();
  wireSplit();
  wireDebug();
  wireDebugMode();
  wireQuickFix();
  wireTests();
  wireCompare();
  wireOpinion();
  wireSchedules();
  wireNotebooks();
  wireDiff();
  wireReview();
  wirePreview();
  createChat();
  // This window's folder: the one it had (after a reload), the one it opened with, or none.
  const start = await desk.startFolder();
  if (start) setFolder(start);
}

init();
