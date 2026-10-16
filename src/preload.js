const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => {
  const listener = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
const call =
  (channel) =>
  (...args) =>
    ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('desk', {
  platform: process.platform,
  getSettings: call('settings:get'),
  setSettings: call('settings:set'),
  cliStatus: call('cli:status'),
  installClaude: call('setup:install'),
  startLogin: call('setup:login'),
  sendLoginCode: call('setup:login-code'),
  cancelLogin: call('setup:login-cancel'),
  openExternal: call('open-external'),
  onSetupLog: on('setup-log'),
  onLoginUrl: on('setup-login-url'),
  onLoginExit: on('setup-login-exit'),
  agents: {
    list: call('agents:list'),
    status: call('agents:status'),
    setKey: call('agents:set-key'),
    command: call('agents:command'),
    codexKey: call('agents:codex-key'),
    models: call('agents:models'),
    sessions: call('agents:sessions'),
    history: call('agents:history'),
  },
  accounts: {
    list: call('accounts:list'),
    add: call('accounts:add'),
    rename: call('accounts:rename'),
    remove: call('accounts:remove'),
    setRule: call('accounts:set-rule'),
    setDefault: call('accounts:set-default'),
  },

  pickFolder: call('folder:pick'),
  openFolder: call('folder:open'),
  currentFolder: call('folder:current'),
  startFolder: call('folder:start'),
  addFolder: call('folder:add'),
  removeFolder: call('folder:remove'),
  newWindow: call('window:new'),
  onOpenFolder: on('menu-open-folder'),
  onSettingsChanged: on('settings-changed'),
  listFiles: call('files:list'),
  searchFiles: call('files:search'),
  readFile: call('file:read'),
  writeFile: call('file:write'),
  revealFile: call('file:reveal'),

  listSessions: call('sessions:list'),
  loadSession: call('sessions:load'),

  chatSend: call('chat:send'),
  chatInterrupt: call('chat:interrupt'),
  chatClose: call('chat:close'),
  chatSetMode: call('chat:set-mode'),
  answerApproval: call('approval:answer'),
  undoChanges: call('changes:undo'),
  rewindFiles: call('rewind:files'),
  flashWindow: call('window:flash'),
  worktree: {
    create: call('worktree:create'),
    changes: call('worktree:changes'),
    diff: call('worktree:diff'),
    merge: call('worktree:merge'),
    remove: call('worktree:remove'),
    exists: call('worktree:exists'),
  },
  preview: { capture: call('preview:capture'), openExternal: call('preview:open-external') },
  rewindApply: call('rewind:apply'),
  onChatEvent: on('chat-event'),
  onChatTurnEnd: on('chat-turn-end'),
  onChatExit: on('chat-exit'),
  onApproval: on('approval-request'),

  git: {
    status: call('git:status'),
    head: call('git:head'),
    commit: call('git:commit'),
    checkout: call('git:checkout'),
    sync: call('git:sync'),
    discard: call('git:discard'),
    init: call('git:init'),
    suggest: call('git:suggest'),
  },

  term: {
    create: call('term:create'),
    write: call('term:write'),
    resize: call('term:resize'),
    kill: call('term:kill'),
    onData: on('term-data'),
    onExit: on('term-exit'),
  },

  cfg: {
    memory: call('cfg:memory'),
    saveMemory: call('cfg:save-memory'),
    rulesShared: call('cfg:rules-shared'),
    shareRules: call('cfg:share-rules'),
    permissions: call('cfg:permissions'),
    rule: call('cfg:rule'),
    mcpList: call('cfg:mcp-list'),
    mcpRemove: call('cfg:mcp-remove'),
    mcpAdd: call('cfg:mcp-add'),
  },

  menuLabels: call('menu:labels'),
  popupMenu: call('menu:popup'),
  setTitleBarColors: call('window:titlebar-colors'),
  installUpdate: call('update:install'),
  checkUpdates: call('update:check'),
  appVersion: call('app:version'),
  onUpdateStatus: on('update-status'),
  onFsChanged: on('fs-changed'),
  onMenu: on('menu'),
});
