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

  pickFolder: call('folder:pick'),
  openFolder: call('folder:open'),
  currentFolder: call('folder:current'),
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
  appVersion: call('app:version'),
  onUpdateStatus: on('update-status'),
  onFsChanged: on('fs-changed'),
  onMenu: on('menu'),
});
