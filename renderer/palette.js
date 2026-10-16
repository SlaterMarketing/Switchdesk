/* global $, h, state, desk, modal, fuzzyScore, MODES, MODE_LABEL, setMode, setFolder, addWorkspaceFolder, saveActive, closeTab, quickOpen, newChat, newChatInCopy,
   addSelectionToChat, inlineEdit, toggleTerminal, newTerminal, showSidePanel, openSearch, openSettings, openPreview, toggleTheme, loadHistory,
   agentState, acct, multiAccount, chooseAgent, agentOf, activeChat, chatAccount, isMac, debugCmd, restartDebugging, toggleBreakpoint, activeTab, editor */
'use strict';

// ------------------------------------------------------------------ command palette
//
// Ctrl+Shift+P: every action in the app, searchable from one box, like Cursor's.

const paletteKey = (k) => (isMac ? k : k.replace('⌘', 'Ctrl+').replace('⇧', 'Shift+').replace('⌥', 'Alt+'));

function paletteCommands() {
  const cmds = [
    ['New Chat', '⌘N', newChat],
    ['New Chat in Its Own Copy', '⌘⌥N', newChatInCopy],
    ['New Window', '⌘⇧N', () => desk.newWindow(null)],
    ['Open Folder…', '⌘O', () => desk.pickFolder().then(setFolder)],
    ['Add Folder to Workspace…', '', () => addWorkspaceFolder()],
    ['Go to File…', '⌘P', quickOpen],
    ['Search in Files', '⌘⇧F', openSearch],
    ['Save', '⌘S', saveActive],
    ['Close Tab', '⌘W', () => state.activeTab && closeTab(state.activeTab)],
    ['Add Selection to Chat', '⌘L', addSelectionToChat],
    ['Edit Selection with the Agent', '⌘K', inlineEdit],
    ['Toggle Sidebar', '⌘B', () => $('#workbench').classList.toggle('no-sidebar')],
    ['Toggle Terminal', '⌘`', () => toggleTerminal()],
    ['New Terminal', '', () => (toggleTerminal(true), newTerminal())],
    ['Show Explorer', '', () => showSidePanel('explorer')],
    ['Show Source Control', '⌘⇧G', () => showSidePanel('git')],
    ['Show Past Chats', '', () => (showSidePanel('history'), loadHistory(true))],
    ['Preview', '⌘⇧V', () => openPreview()],
    ['Switch Light/Dark Theme', '', toggleTheme],
    ['Settings', '⌘,', () => openSettings()],
    ['Settings: Agents', '', () => openSettings('agents')],
    ['Settings: Claude Accounts', '', () => openSettings('accounts')],
    ['Settings: Instructions', '', () => openSettings('instructions')],
    ['Settings: Permissions', '', () => openSettings('permissions')],
    ['Settings: MCP Servers', '', () => openSettings('mcp')],
    ['Usage and Limits', '', () => openSettings('usage')],
    ['Attach Files to Chat…', '', () => pickAttachments()],
    ['Settings: Autocomplete', '', () => openSettings('autocomplete')],
    ['Settings: Code Intelligence', '', () => openSettings('intel')],
    ['Split Editor', '⌘\\', toggleSplit],
    ['Compare Active File With…', '', compareActiveWith],
    ['Compare Active File With Clipboard', '', () => (activeTab() && activeTab().kind === 'file' ? compareWithClipboard(activeTab().rel) : toast('Open a file first.'))],
    ['Git: Show File History', '', () => showFileHistory(activeTab() && activeTab().kind === 'file' ? activeTab().rel : null)],
    ['Git: Show History', '', () => ((git.fileHistory = null), (git.historyOpen = true), showSidePanel('git'), refreshGit())],
    ['Git: Write Pull Request', '', () => (showSidePanel('git'), pullRequest())],
    ['Git: Abort Merge', '', () => desk.git.abort().then(refreshGit)],
    ['Toggle Line Blame', '', toggleBlame],
    ['Debug: Start Debugging', 'F5', () => (showSidePanel('debug'), debugCmd('continue'))],
    ['Debug: Stop', '⇧F5', () => debugCmd('stop')],
    ['Debug: Restart', '⌘F5', restartDebugging],
    ['Debug: Toggle Breakpoint', 'F9', () => { const t = activeTab(); const p = editor.getPosition(); if (t && t.kind === 'file' && p) toggleBreakpoint(t.rel, p.lineNumber); }],
    ['Debug: Open Run and Debug', '', () => showSidePanel('debug')],
    ['Settings: Codebase Search', '', () => openSettings('codebase')],
    ['Update Codebase Index', '', () => (codebaseOn() ? (indexCodebase(), toast('Updating the codebase index.')) : openSettings('codebase'))],
    ['Restart Language Servers', '', () => desk.lsp.restart().then(() => toast('Language servers restarted. They start again as you open files.'))],
    ['Go to Next Problem', 'F8', () => (editor.focus(), editor.trigger('palette', 'editor.action.marker.nextInFiles', null))],
    ['Check for Updates', '', () => desk.checkUpdates()],
    ...MODES.map((m) => [`Mode: ${MODE_LABEL[m]}`, '', () => setMode(m)]),
  ];
  // Agents that are ready, and each Claude account.
  const chat = activeChat();
  for (const a of acct.accounts) {
    const auth = acct.status.get(a.id);
    if (auth && auth.loggedIn && !(agentOf(chat) === 'claude' && chatAccount(chat) === a.id)) cmds.push([`Agent: Claude${multiAccount() ? ` · ${a.name}` : ''}`, '', () => chooseAgent('claude', a.id)]);
  }
  for (const a of agentState.list) {
    const s = agentState.status.get(a.id);
    if (a.id !== 'claude' && s && s.loggedIn && agentOf(chat) !== a.id) cmds.push([`Agent: ${a.label}`, '', () => chooseAgent(a.id)]);
  }
  for (const f of (state.settings.recentFolders || []).filter((f) => !state.folder || f !== state.folder.root)) {
    cmds.push([`Open Recent: ${f}`, '', async () => setFolder(await desk.openFolder(f))]);
    cmds.push([`Open Recent in New Window: ${f}`, '', () => desk.newWindow(f)]);
  }
  return cmds;
}

function commandPalette() {
  if ($('.modal .palette')) return;
  const input = h('input', { class: 'big palette', placeholder: 'Type a command…', spellcheck: 'false' });
  const results = h('div', { class: 'results' });
  const all = paletteCommands();
  let items = [];
  let index = 0;
  const run = (c) => {
    close();
    setTimeout(c[2], 0);
  };
  const render = () => {
    const q = input.value.trim().toLowerCase();
    items = q
      ? all
          .map((c) => ({ c, score: fuzzyScore(c[0].toLowerCase(), q) }))
          .filter((x) => x.score > -1)
          .sort((a, b) => b.score - a.score)
          .map((x) => x.c)
      : all;
    items = items.slice(0, 60);
    index = Math.min(index, Math.max(0, items.length - 1));
    results.replaceChildren(
      ...items.map((c, i) => h('div', { class: `pop-item palette-item${i === index ? ' active' : ''}`, onclick: () => run(c) }, h('span', {}, c[0]), c[1] ? h('kbd', {}, paletteKey(c[1])) : null))
    );
    const active = results.children[index];
    if (active) active.scrollIntoView({ block: 'nearest' });
  };
  const close = modal([input, results]);
  input.addEventListener('input', () => ((index = 0), render()));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') (index = Math.min(index + 1, items.length - 1)), render(), e.preventDefault();
    else if (e.key === 'ArrowUp') (index = Math.max(index - 1, 0)), render(), e.preventDefault();
    else if (e.key === 'Enter' && items[index]) run(items[index]);
  });
  render();
  input.focus();
}
