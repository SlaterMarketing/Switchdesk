/* global require, monaco, marked, DOMPurify, desk */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
};

const isMac = desk.platform === 'darwin';
if (isMac) document.body.classList.add('mac');
const MODES = ['ask', 'plan', 'agent', 'debug', 'auto'];
const MODE_LABEL = { ask: 'Ask', plan: 'Plan', agent: 'Agent', debug: 'Debug', auto: 'Auto' };
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const HIDDEN_TOOLS = new Set(['ToolSearch']); // internal plumbing, not worth a row

const state = {
  settings: {},
  folder: null,
  files: [],
  fileSet: new Set(),
  expanded: new Set(['']),
  collapsedRoots: new Set(), // folder rows closed in a workspace with several folders
  tabs: [], // { id, kind: 'file'|'diff', rel, model, viewState, dirty, change }
  activeTab: null,
  changedFiles: new Set(),
  mode: 'agent',
  chips: [],
};

// ------------------------------------------------------------------ Monaco

let editor = null;
let diffEditor = null;

function loadMonaco() {
  return new Promise((resolve) => {
    require.config({ paths: { vs: '../node_modules/monaco-editor/min/vs' } });
    window.MonacoEnvironment = {
      getWorkerUrl: () => '../node_modules/monaco-editor/min/vs/base/worker/workerMain.js',
    };
    require(['vs/editor/editor.main'], () => resolve());
  });
}

function currentTheme() {
  const t = state.settings.theme || 'system';
  if (t === 'system') return matchMedia('(prefers-color-scheme: light)').matches ? 'vs' : 'vs-dark';
  return t === 'light' ? 'vs' : 'vs-dark';
}

function defineThemes() {
  monaco.editor.defineTheme('desk-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: { 'editor.background': '#181818', 'editorGutter.background': '#181818', 'editor.lineHighlightBackground': '#ffffff08' },
  });
  monaco.editor.defineTheme('desk-light', { base: 'vs', inherit: true, rules: [], colors: { 'editor.background': '#fbfbfa' } });
}

const SUN = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z"/></svg>';

// The sun/moon button in the title bar flips between light and dark (Settings still offers "System").
function renderThemeButton() {
  const btn = document.getElementById('btn-theme');
  if (!btn) return;
  const dark = currentTheme() === 'vs-dark';
  btn.innerHTML = dark ? SUN : MOON;
  btn.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
}

async function toggleTheme() {
  const theme = currentTheme() === 'vs-dark' ? 'light' : 'dark';
  state.settings = await desk.setSettings({ theme });
  applyTheme();
}

function applyTheme() {
  const t = state.settings.theme || 'system';
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  if (window.monaco) monaco.editor.setTheme(currentTheme() === 'vs' ? 'desk-light' : 'desk-dark');
  if (typeof retheme === 'function') retheme();
  renderThemeButton();
  if (!isMac) {
    // Match the window buttons the OS draws over our title bar.
    const css = getComputedStyle(document.documentElement);
    desk.setTitleBarColors(css.getPropertyValue('--bg-panel').trim(), css.getPropertyValue('--text').trim());
  }
}

// Windows and Linux: File/Edit/View/Window/Help live in our own title bar instead of a separate native bar.
async function renderAppMenu() {
  if (isMac) return;
  const labels = await desk.menuLabels();
  $('#app-menu').replaceChildren(
    ...labels.map((label, i) =>
      h(
        'button',
        {
          class: 'menu-btn',
          onclick: async (e) => {
            const b = e.currentTarget;
            const r = b.getBoundingClientRect();
            b.classList.add('open');
            await desk.popupMenu(i, r.left, r.bottom);
            b.classList.remove('open');
          },
        },
        label
      )
    )
  );
}

function createEditors() {
  defineThemes();
  const common = {
    automaticLayout: true,
    fontSize: 13,
    fontFamily: "'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace",
    minimap: { enabled: true, scale: 1, renderCharacters: false },
    smoothScrolling: true,
    scrollBeyondLastLine: false,
    renderLineHighlight: 'all',
    padding: { top: 8 },
  };
  editor = monaco.editor.create($('#editor'), { ...common, model: null, inlineSuggest: { enabled: true, mode: 'subwordSmart' } });
  diffEditor = monaco.editor.createDiffEditor($('#diff-editor'), { ...common, readOnly: true, renderSideBySide: true, originalEditable: false });
  applyTheme();

  editor.onDidChangeCursorSelection(() => {
    const p = editor.getPosition();
    if (p) $('#status-cursor').textContent = `Ln ${p.lineNumber}, Col ${p.column}`;
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveActive);
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL, addSelectionToChat);
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, inlineEdit);
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, quickOpen);
  // Where you are in each file is part of what the window reopens with.
  editor.onDidChangeCursorPosition(() => queueSaveWorkspace());
  editor.onDidScrollChange(() => queueSaveWorkspace());
}

function languageFor(rel) {
  const name = rel.split('/').pop().toLowerCase();
  const ext = name.includes('.') ? '.' + name.split('.').pop() : '';
  for (const lang of monaco.languages.getLanguages()) {
    if ((lang.filenames || []).map((f) => f.toLowerCase()).includes(name)) return lang.id;
    if (ext && (lang.extensions || []).includes(ext)) return lang.id;
  }
  return 'plaintext';
}

function modelUri(rel) {
  return monaco.Uri.from({ scheme: 'file', path: '/' + rel });
}

// ------------------------------------------------------------------ tabs

function renderTabs() {
  queueSaveWorkspace();
  const bar = $('#tabs');
  bar.replaceChildren(
    ...state.tabs.map((t) =>
      h(
        'div',
        {
          class: `tab${t.id === state.activeTab ? ' active' : ''}${t.dirty ? ' dirty' : ''}${t.kind === 'file' && t.rel === side.rel ? ' on-side' : ''}`,
          'data-id': t.id,
          title: t.rel,
          onclick: () => activateTab(t.id),
          onauxclick: (e) => e.button === 1 && closeTab(t.id),
        },
        t.kind === 'diff' ? h('span', { class: 'badge' }, 'Δ') : t.kind === 'preview' ? h('span', { class: 'badge' }, '◉') : t.kind === 'plan' ? h('span', { class: 'badge' }, '◆') : null,
        t.rel.split('/').pop(),
        h('button', { class: 'close', onclick: (e) => (e.stopPropagation(), closeTab(t.id)) }, '×')
      )
    )
  );
  $('#welcome').classList.toggle('hidden', state.tabs.length > 0);
  highlightTreeActive();
}

function activeTab() {
  return state.tabs.find((t) => t.id === state.activeTab) || null;
}

function activateTab(id) {
  const prev = activeTab();
  if (prev && (prev.kind === 'file' || prev.kind === 'plan')) prev.viewState = editor.saveViewState();
  state.activeTab = id;
  const t = activeTab();
  const isDiff = t && t.kind === 'diff';
  $('#preview').classList.toggle('hidden', !(t && t.kind === 'preview'));
  $('#editor').classList.toggle('hidden', isDiff);
  $('#diff-editor').classList.toggle('hidden', !isDiff);
  $('#diff-bar').classList.toggle('hidden', !isDiff);
  showPlan(t);
  if (t && (t.kind === 'file' || t.kind === 'plan')) {
    editor.setModel(t.model);
    if (t.viewState) editor.restoreViewState(t.viewState);
    editor.focus();
  } else if (isDiff) {
    diffEditor.setModel({ original: t.original, modified: t.modified });
    renderDiffBar(t);
  } else if (t && t.kind === 'preview') {
    editor.setModel(null);
  } else {
    editor.setModel(null);
  }
  renderTabs();
}

function closeTab(id) {
  const i = state.tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const t = state.tabs[i];
  if (t.dirty && !confirm(`${t.rel} has unsaved changes. Close anyway?`)) return;
  state.tabs.splice(i, 1);
  sideTabClosed(t);
  if (t.kind === 'file' || t.kind === 'plan') t.model.dispose();
  else if (t.kind === 'preview') $('#preview').classList.add('hidden');
  else {
    t.original.dispose();
    t.modified.dispose();
  }
  if (state.activeTab === id) {
    const next = state.tabs[Math.min(i, state.tabs.length - 1)];
    state.activeTab = null;
    if (next) activateTab(next.id);
    else {
      editor.setModel(null);
      showPlan(null);
      $('#diff-editor').classList.add('hidden');
      $('#diff-bar').classList.add('hidden');
      $('#editor').classList.remove('hidden');
    }
  }
  renderTabs();
}

async function openFile(rel, line) {
  const t = await loadFileTab(rel);
  if (!t) return;
  activateTab(t.id);
  if (line) {
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
  }
}

// The file's tab, opening it (without switching to it) if it isn't open yet.
async function loadFileTab(rel) {
  rel = rel.replace(/^\.?\//, '');
  let t = state.tabs.find((x) => x.kind === 'file' && x.rel === rel);
  if (!t) {
    let res;
    try {
      res = await desk.readFile(rel);
    } catch (e) {
      toast(`Couldn't open ${rel}: ${e.message}`);
      return;
    }
    if (res.binary || res.tooLarge) {
      toast(`${rel} is ${res.binary ? 'a binary file' : 'too large'} to open here.`);
      return;
    }
    const existing = monaco.editor.getModel(modelUri(rel));
    if (existing) existing.dispose();
    const model = monaco.editor.createModel(res.content, languageFor(rel), modelUri(rel));
    t = { id: 'f:' + rel, kind: 'file', rel, model, savedVersion: model.getAlternativeVersionId(), dirty: false };
    model.onDidChangeContent(() => {
      const dirty = model.getAlternativeVersionId() !== t.savedVersion;
      if (dirty !== t.dirty) {
        t.dirty = dirty;
        renderTabs();
      }
    });
    state.tabs.push(t);
    renderTabs();
  }
  return t;
}

async function saveActive(tab) {
  const t = tab && tab.kind ? tab : sideEditor && sideEditor.hasTextFocus() ? sideTab() : activeTab();
  if (!t || t.kind !== 'file') return;
  await desk.writeFile(t.rel, t.model.getValue());
  t.savedVersion = t.model.getAlternativeVersionId();
  t.dirty = false;
  renderTabs();
}

async function reloadOpenFiles(paths) {
  const set = paths ? new Set(paths) : null;
  for (const t of state.tabs) {
    if (t.kind !== 'file' || (set && !set.has(t.rel))) continue;
    let res;
    try {
      res = await desk.readFile(t.rel);
    } catch {
      continue; // deleted
    }
    if (res.content == null || res.content === t.model.getValue()) continue;
    if (t.dirty) {
      toast(`${t.rel} changed on disk while you have unsaved edits. Save to overwrite, or close the tab to reload.`);
      continue;
    }
    const vs = t.id === state.activeTab ? editor.saveViewState() : null;
    t.model.pushEditOperations([], [{ range: t.model.getFullModelRange(), text: res.content }], () => null);
    t.savedVersion = t.model.getAlternativeVersionId();
    t.dirty = false;
    if (vs) editor.restoreViewState(vs);
  }
  renderTabs();
}

// ------------------------------------------------------------------ explorer

function buildTree(files) {
  const root = { name: '', path: '', dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join('/');
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { name: parts[i], path: p, dirs: new Map(), files: [] });
      node = node.dirs.get(parts[i]);
    }
    node.files.push({ name: parts[parts.length - 1], path: f });
  }
  return root;
}

function renderTree() {
  const host = $('#tree');
  const filter = $('#file-filter').value.trim().toLowerCase();
  const rows = [];
  if (filter) {
    for (const f of state.files.filter((f) => f.toLowerCase().includes(filter)).slice(0, 400)) {
      rows.push(fileRow({ name: f, path: f }, 0));
    }
  } else {
    const walk = (node, depth) => {
      const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
      for (const d of dirs) {
        // Collapse single-child directory chains like VS Code does.
        let cur = d;
        let label = d.name;
        while (cur.files.length === 0 && cur.dirs.size === 1) {
          cur = [...cur.dirs.values()][0];
          label += '/' + cur.name;
        }
        const open = state.expanded.has(cur.path);
        rows.push(
          h(
            'div',
            {
              class: 'tree-row dir',
              style: `padding-left:${8 + depth * 12}px`,
              onclick: () => {
                if (open) state.expanded.delete(cur.path);
                else state.expanded.add(cur.path);
                renderTree();
              },
            },
            h('span', { class: 'twisty' }, open ? '▾' : '▸'),
            h('span', { class: 'name' }, label),
            [...state.changedFiles].some((c) => c.startsWith(cur.path + '/')) ? h('span', { class: 'dot' }) : null
          )
        );
        if (open) walk(cur, depth + 1);
      }
      for (const f of node.files.sort((a, b) => a.name.localeCompare(b.name))) rows.push(fileRow(f, depth));
    };
    const tree = state.tree || buildTree([]);
    const extra = (state.folder && state.folder.extra) || [];
    if (!extra.length) walk(tree, 0);
    else {
      // A workspace with several folders: one top-level row per folder, the main one first.
      const main = { ...tree, dirs: new Map([...tree.dirs].filter(([name]) => !name.startsWith('⟦'))) };
      const folders = [{ key: '', name: state.folder.name, title: state.folder.root, node: main }, ...extra.map((f) => ({ key: f.key, name: f.name, title: f.dir, dir: f.dir, node: tree.dirs.get(f.key) || { dirs: new Map(), files: [] } }))];
      for (const f of folders) {
        const open = !state.collapsedRoots.has(f.key);
        rows.push(
          h(
            'div',
            {
              class: 'tree-row dir root',
              title: f.title,
              onclick: () => {
                if (open) state.collapsedRoots.add(f.key);
                else state.collapsedRoots.delete(f.key);
                renderTree();
              },
            },
            h('span', { class: 'twisty' }, open ? '▾' : '▸'),
            h('span', { class: 'name' }, f.name),
            f.dir ? h('button', { class: 'icon-btn root-remove', title: `Remove ${f.name} from this workspace (the folder itself stays)`, onclick: (e) => (e.stopPropagation(), removeWorkspaceFolder(f.dir)) }, '✕') : null
          )
        );
        if (open) walk(f.node, 1);
      }
    }
  }
  host.replaceChildren(...rows);
  highlightTreeActive();
}

function fileRow(f, depth) {
  return h(
    'div',
    { class: 'tree-row file', 'data-path': f.path, style: `padding-left:${20 + depth * 12}px`, onclick: () => openFile(f.path), title: f.path },
    h('span', { class: 'name' }, f.name),
    state.changedFiles.has(f.path) ? h('span', { class: 'dot', title: 'Changed by Claude' }) : null
  );
}

function highlightTreeActive() {
  const t = activeTab();
  for (const el of document.querySelectorAll('.tree-row.file')) el.classList.toggle('active', !!t && el.dataset.path === t.rel);
}

async function refreshFiles() {
  if (!state.folder) return;
  state.files = await desk.listFiles();
  state.fileSet = new Set(state.files);
  state.tree = buildTree(state.files);
  renderTree();
}

// ------------------------------------------------------------------ folder

async function setFolder(info) {
  if (!info) return;
  // The folder is already open in another window, which has come to the front.
  if (info.elsewhere) return toast(`${info.name} is open in another window.`);
  restoringWorkspace = true;
  try {
    state.folder = info;
    showFolderName();
    state.expanded = new Set(['']);
    for (const t of [...state.tabs]) closeTab(t.id);
    reviews.clear();
    resetPreview();
    await refreshFiles();
    queueCodebaseIndex(3000);
    closeAllChats();
    await loadAccounts(); // the folder may use a different account
    await restoreWorkspace(info.root);
  } finally {
    restoringWorkspace = false;
  }
  loadHistory();
  refreshGit();
  checkCli();
}

function showFolderName() {
  const f = state.folder;
  const extra = (f && f.extra) || [];
  $('#folder-name').textContent = !f ? 'No folder open' : extra.length ? `${f.name} + ${extra.map((x) => x.name).join(', ')}` : f.name;
  $('#folder-name').title = !f ? '' : [f.root, ...extra.map((x) => x.dir)].join('\n');
}

// ------------------------------------------------------------------ workspaces
//
// A window can hold more folders than its main one. Their files show as "⟦name⟧/path", every agent
// in the window can read and change them, and they come back whenever the main folder opens.

async function addWorkspaceFolder(dir) {
  if (!state.folder) return toast('Open a folder first.');
  try {
    const info = await desk.addFolder(dir);
    if (!info) return;
    const added = info.extra[info.extra.length - 1];
    await workspaceFoldersChanged(info);
    toast(`Added ${added ? added.name : 'the folder'}. Agents in this window can work in it from their next message.`);
  } catch (e) {
    toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  }
}

async function removeWorkspaceFolder(dir) {
  const info = await desk.removeFolder(dir);
  const gone = (state.folder.extra || []).find((x) => x.dir === dir);
  if (gone) for (const t of state.tabs.filter((x) => x.kind === 'file' && x.rel.startsWith(gone.key + '/'))) closeTab(t.id);
  await workspaceFoldersChanged(info);
}

async function workspaceFoldersChanged(info) {
  state.folder = info;
  showFolderName();
  await refreshFiles();
  queueCodebaseIndex(2000);
}

// ------------------------------------------------------------------ reopen where you left off
//
// Open files and chat tabs are remembered per folder, in the app's settings file.

let restoringWorkspace = false;
let saveWorkspaceTimer = null;

function queueSaveWorkspace() {
  if (restoringWorkspace || !state.folder) return;
  clearTimeout(saveWorkspaceTimer);
  saveWorkspaceTimer = setTimeout(saveWorkspace, 800);
}

async function saveWorkspace() {
  if (restoringWorkspace || !state.folder) return;
  const t = activeTab();
  if (t && t.kind === 'file') t.viewState = editor.saveViewState();
  // Where you were in each file (cursor, selection, scroll), so it reopens the same way.
  const views = {};
  for (const x of state.tabs) if (x.kind === 'file' && x.viewState) views[x.rel] = x.viewState;
  const snapshot = {
    tabs: state.tabs.filter((x) => x.kind === 'file').map((x) => x.rel),
    active: t && t.kind === 'file' ? t.rel : null,
    views,
    side: side.rel || null,
    panel: state.sidePanel || 'explorer',
    draft: $('#input').value.slice(0, 20000),
    chats: chats.filter((c) => c.sessionId && !(c.worktree && c.worktree.removed)).map((c) => ({ sessionId: c.sessionId, title: c.title, worktree: c.worktree || undefined, account: c.account || undefined, agent: c.agent || undefined, agentAccount: c.agentAccount || undefined })),
    activeChat: activeChat()?.sessionId || null,
    savedAt: Date.now(),
  };
  const all = { ...(state.settings.workspaces || {}), [state.folder.root]: snapshot };
  // Keep the 30 most recent folders.
  const keep = Object.entries(all).sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0)).slice(0, 30);
  state.settings = await desk.setSettings({ workspaces: Object.fromEntries(keep) });
}

async function restoreWorkspace(root) {
  const saved = (state.settings.workspaces || {})[root];
  if (saved) {
    for (const c of saved.chats || []) {
      try {
        if (c.worktree && !(await desk.worktree.exists(c.worktree))) continue;
        if (c.agent && c.agent !== 'claude') reopenAgentChat(c);
        else await openSession({ id: c.sessionId, title: c.title || 'Chat' }, c.worktree, c.account);
      } catch {
        /* transcript deleted */
      }
    }
  }
  if (!chats.length) createChat();
  const active = saved && saved.activeChat && chats.find((c) => c.sessionId === saved.activeChat);
  if (active) switchChat(active.id);
  if (saved) {
    for (const rel of saved.tabs || []) if (state.fileSet.has(rel)) await openFile(rel);
    for (const x of state.tabs) if (x.kind === 'file' && saved.views && saved.views[x.rel]) x.viewState = saved.views[x.rel];
    const t = (saved.active && state.tabs.find((x) => x.kind === 'file' && x.rel === saved.active)) || [...state.tabs].reverse().find((x) => x.kind === 'file');
    if (t) {
      state.activeTab = null; // so activating it applies the saved place instead of saving the current one over it
      activateTab(t.id);
    }
    if (saved.side && state.fileSet.has(saved.side)) await openToSide(saved.side).then(() => editor.focus());
    if (saved.panel && saved.panel !== 'explorer') showSidePanel(saved.panel);
    if (saved.draft && !$('#input').value) {
      $('#input').value = saved.draft;
      autoGrow();
    }
  }
}

async function renderRecent() {
  const host = $('#recent-folders');
  const recents = state.settings.recentFolders || [];
  host.replaceChildren(
    ...(recents.length ? [h('div', { class: 'muted small', style: 'padding:0 8px 4px' }, 'Recent')] : []),
    ...recents.map((f) =>
      h(
        'div',
        { class: 'recent-row' },
        h('button', { class: 'recent', title: f, onclick: async () => setFolder(await desk.openFolder(f)) }, f),
        h('button', { class: 'icon-btn', title: 'Open in a new window', onclick: () => desk.newWindow(f) }, '⧉')
      )
    )
  );
}

// ------------------------------------------------------------------ markdown

marked.setOptions({ gfm: true, breaks: false });

function renderMarkdown(el, text) {
  el.innerHTML = DOMPurify.sanitize(marked.parse(text || ''));
  for (const code of el.querySelectorAll('pre code')) {
    const lang = (/language-([\w+#-]+)/.exec(code.className) || [])[1];
    if (lang && window.monaco) {
      const id = (monaco.languages.getLanguages().find((l) => l.id === lang || (l.aliases || []).map((a) => a.toLowerCase()).includes(lang.toLowerCase())) || {}).id;
      if (id) monaco.editor.colorize(code.textContent, id, {}).then((html) => (code.innerHTML = DOMPurify.sanitize(html)));
    }
  }
  // Make inline `path/to/file.ts:12` mentions clickable.
  for (const code of el.querySelectorAll(':not(pre) > code')) {
    const m = /^([\w./@-]+?)(?::(\d+))?(?:-\d+)?$/.exec(code.textContent.trim());
    if (!m) continue;
    const rel = toRel(m[1]);
    if (rel && state.fileSet.has(rel)) {
      code.classList.add('file-link');
      code.addEventListener('click', () => openFile(rel, m[2] ? Number(m[2]) : undefined));
    }
  }
}

function toRel(p) {
  if (!p || !state.folder) return null;
  p = p.replace(/\\/g, '/');
  // The most specific folder wins, so a file in an extra folder gets that folder's key.
  const folders = [{ key: '', dir: state.folder.root }, ...(state.folder.extra || [])].map((f) => ({ key: f.key, dir: f.dir.replace(/\\/g, '/') })).sort((a, b) => b.dir.length - a.dir.length);
  for (const f of folders) if (p.startsWith(f.dir + '/')) return (f.key ? f.key + '/' : '') + p.slice(f.dir.length + 1);
  return p.replace(/^\.\//, '');
}


function selectionInfo() {
  const t = activeTab();
  if (!t || t.kind !== 'file') return null;
  const sel = editor.getSelection();
  let range = sel;
  if (!sel || sel.isEmpty()) {
    const line = editor.getPosition()?.lineNumber || 1;
    range = new monaco.Range(line, 1, line, t.model.getLineMaxColumn(line));
  }
  return { rel: t.rel, start: range.startLineNumber, end: range.endLineNumber, text: t.model.getValueInRange(range), lang: t.model.getLanguageId() };
}

function addSelectionToChat() {
  const info = selectionInfo();
  if (!info) return;
  state.chips.push(info);
  renderChips();
  $('#input').focus();
}

let mention = null; // { kind: 'file'|'slash', start, items, index }
function updateMention() {
  const input = $('#input');
  const pos = input.selectionStart;
  const before = input.value.slice(0, pos);
  const pop = $('#mention-popup');
  // "/" at the very start of the message lists slash commands.
  const slash = /^\/([\w:.-]*)$/.exec(before);
  if (slash) {
    const q = slash[1].toLowerCase();
    const items = slashCommandList()
      .map((c) => ({ c, score: c.name.toLowerCase().startsWith(q) ? 1000 - c.name.length : fuzzyScore(c.name.toLowerCase(), q) }))
      .filter((x) => x.score > -1)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map((x) => x.c);
    mention = { kind: 'slash', start: 0, items, index: 0 };
    return renderMention();
  }
  const m = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!m) {
    mention = null;
    pop.classList.add('hidden');
    return;
  }
  const q = m[2].toLowerCase();
  // Things to attach besides files: what's changed, the terminal, a web page.
  const extras = mentionExtras(m[2]);
  const folders = [...new Set(state.files.flatMap((f) => f.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/') + '/')))];
  const items = /^https?:/i.test(m[2])
    ? extras
    : [
        ...extras,
        ...[...folders, ...state.files]
          .map((f) => ({ f, score: fuzzyScore(f.toLowerCase().replace(/\/$/, ''), q) - (f.endsWith('/') ? 1 : 0) }))
          .filter((x) => x.score > -1)
          .sort((a, b) => b.score - a.score)
          .slice(0, 12)
          .map((x) => x.f),
      ];
  mention = { kind: 'file', start: pos - m[2].length - 1, items, index: 0 };
  renderMention();
}

const MENTION_EXTRAS = [
  { id: 'codebase', name: 'codebase', icon: '≈', desc: 'The parts of the project your message is about' },
  { id: 'changes', name: 'changes', icon: '±', desc: 'Your uncommitted changes (git diff)' },
  { id: 'terminal', name: 'terminal', icon: '›_', desc: 'Recent output from the terminal' },
  { id: 'web', name: 'web', icon: '🌐', desc: 'A web page. Type or paste its address' },
];

function mentionExtras(typed) {
  if (/^https?:\/\/\S+\.\S+/i.test(typed)) return [{ id: 'url', name: typed, icon: '🌐', desc: 'Fetch this page and attach it' }];
  if (/^https?:/i.test(typed)) return [];
  const q = typed.toLowerCase();
  return MENTION_EXTRAS.filter((x) => !q || x.name.startsWith(q) || (x.id === 'changes' && 'git'.startsWith(q)));
}

function renderMention() {
  const pop = $('#mention-popup');
  if (!mention || !mention.items.length) return pop.classList.add('hidden');
  pop.classList.remove('hidden');
  pop.replaceChildren(
    ...mention.items.map((it, i) =>
      h(
        'div',
        { class: `pop-item${mention.kind === 'slash' || typeof it === 'object' ? ' slash' : ''}${i === mention.index ? ' active' : ''}`, onmousedown: (e) => (e.preventDefault(), pickMention(it)) },
        mention.kind === 'slash' || typeof it === 'object'
          ? [h('b', {}, (mention.kind === 'slash' ? '/' : it.icon + ' ') + it.name), it.desc ? h('span', { class: 'desc' }, it.desc) : null]
          : it
      )
    )
  );
  $('.pop-item.active', pop)?.scrollIntoView({ block: 'nearest' });
}

function pickMention(it) {
  const input = $('#input');
  const pos = input.selectionStart;
  if (mention.kind === 'file' && typeof it === 'object') {
    // "@web" waits for an address; the others become attachments and leave the text alone.
    const insert = it.id === 'web' ? '@https://' : '';
    input.value = input.value.slice(0, mention.start) + insert + input.value.slice(pos);
    const caret = mention.start + insert.length;
    input.setSelectionRange(caret, caret);
    mention = null;
    $('#mention-popup').classList.add('hidden');
    input.focus();
    if (it.id === 'web') return updateMention();
    return attachMention(it);
  }
  const insert = mention.kind === 'slash' ? '/' + it.name + ' ' : '@' + it + ' ';
  input.value = input.value.slice(0, mention.start) + insert + input.value.slice(pos);
  const caret = mention.start + insert.length;
  input.setSelectionRange(caret, caret);
  mention = null;
  $('#mention-popup').classList.add('hidden');
  input.focus();
}

function fuzzyScore(s, q) {
  if (!q) return 0;
  const base = s.split('/').pop();
  if (base.startsWith(q)) return 1000 - s.length;
  if (s.includes(q)) return 500 - s.length;
  let i = 0;
  let score = 0;
  for (const ch of s) {
    if (ch === q[i]) {
      i++;
      score += 1;
      if (i === q.length) return score * 2 - s.length / 10;
    }
  }
  return -1;
}

function autoGrow() {
  const el = $('#input');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 240) + 'px';
}

// ------------------------------------------------------------------ modals

function modal(content, { onClose } = {}) {
  const backdrop = h('div', { class: 'modal-backdrop' }, h('div', { class: 'modal' }, ...content));
  const close = () => {
    backdrop.remove();
    onClose && onClose();
  };
  backdrop.addEventListener('mousedown', (e) => e.target === backdrop && close());
  backdrop.addEventListener('keydown', (e) => e.key === 'Escape' && (e.preventDefault(), close()));
  $('#modal-root').append(backdrop);
  return close;
}

function quickOpen() {
  if (!state.folder) return;
  const input = h('input', { class: 'big', placeholder: 'Go to file…', spellcheck: 'false' });
  const results = h('div', { class: 'results' });
  let items = [];
  let index = 0;
  const render = () => {
    const q = input.value.trim().toLowerCase();
    items = state.files
      .map((f) => ({ f, score: fuzzyScore(f.toLowerCase(), q) }))
      .filter((x) => x.score > -1)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
      .map((x) => x.f);
    index = Math.min(index, Math.max(0, items.length - 1));
    results.replaceChildren(...items.map((f, i) => h('div', { class: `pop-item${i === index ? ' active' : ''}`, onclick: () => (close(), openFile(f)) }, f)));
  };
  const close = modal([input, results]);
  input.addEventListener('input', () => ((index = 0), render()));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') (index = Math.min(index + 1, items.length - 1)), render(), e.preventDefault();
    else if (e.key === 'ArrowUp') (index = Math.max(index - 1, 0)), render(), e.preventDefault();
    else if (e.key === 'Enter' && items[index]) close(), openFile(items[index]);
  });
  render();
  input.focus();
}

function inlineEdit() {
  const info = selectionInfo();
  if (!info) return;
  const input = h('input', { class: 'big', placeholder: `Edit ${info.rel}:${info.start}-${info.end} — describe the change`, spellcheck: 'false' });
  const close = modal([input, h('div', { class: 'hint' }, 'Enter sends this to Claude in Agent mode. The change shows up in the chat with Undo.')]);
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !input.value.trim()) return;
    close();
    const prompt = `Edit \`${info.rel}\` lines ${info.start}-${info.end}. ${input.value.trim()}\n\nThe current code there is:\n\`\`\`${info.lang}\n${info.text}\n\`\`\`\nOnly change what's needed for this request.`;
    send(prompt, 'agent', `✎ ${info.rel}:${info.start}-${info.end}: ${input.value.trim()}`);
  });
  input.focus();
}

let toastTimer;
function toast(text) {
  let el = $('#toast');
  if (!el) {
    el = h('div', { id: 'toast', style: 'position:fixed;bottom:36px;left:50%;transform:translateX(-50%);background:var(--bg-elev);border:1px solid var(--border);padding:8px 14px;border-radius:8px;z-index:60;max-width:70vw;box-shadow:0 8px 24px rgba(0,0,0,.3)' });
    document.body.append(el);
  }
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4500);
}

let cliState = null;

async function checkCli({ showSetupIfNeeded = false } = {}) {
  const s = await desk.cliStatus();
  cliState = s;
  if (s.found) acct.status.set(acct.folderAccount, s.auth || { loggedIn: true });
  const el = $('#status-cli');
  const signedIn = s.found && (s.auth ? s.auth.loggedIn : true);
  el.replaceChildren();
  if (!s.found) el.append(h('span', { class: 'bad' }, '●'), ' Claude Code not installed · click to set up');
  else
    el.append(
      h('span', { class: signedIn ? 'ok' : 'bad' }, '●'),
      ` Claude Code ${s.version.replace(/\s*\(Claude Code\)/, '')}`,
      signedIn ? ` · ${s.auth && s.auth.authMethod === 'claude.ai' ? 'subscription' : (s.auth && s.auth.authMethod) || 'signed in'}` : ' · not signed in · click to sign in',
      multiAccount() ? ` · ${accountName(acct.folderAccount)}${s.auth && s.auth.email ? ` (${s.auth.email})` : ''}` : ''
    );
  renderAccountPill();
  el.style.cursor = signedIn ? 'default' : 'pointer';
  $('#cli-check').textContent = '';
  if (showSetupIfNeeded && !signedIn) showSetup();
  return { ...s, signedIn };
}

// First-run setup: install Claude Code and sign in, without touching a terminal.
let setupOpen = false;
async function showSetup() {
  if (setupOpen) return;
  setupOpen = true;
  const log = h('pre', { class: 'setup-log hidden' });
  const appendLog = (t) => {
    log.classList.remove('hidden');
    log.textContent += t.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
    log.scrollTop = log.scrollHeight;
  };
  const step1 = h('div', { class: 'setup-step' });
  const step2 = h('div', { class: 'setup-step' });
  const finish = h('button', { class: 'btn primary big-btn' }, 'Start using Switchdesk');
  const root = h(
    'div',
    { class: 'setup-backdrop' },
    h(
      'div',
      { class: 'setup-card' },
      h('h2', {}, 'Set up Switchdesk'),
      h('p', { class: 'muted' }, 'Two quick steps. Switchdesk runs Claude Code on this computer with your own Claude subscription (Pro, Max, Team or Enterprise).'),
      step1,
      step2,
      log,
      h('div', { class: 'setup-foot' }, h('button', { class: 'btn', title: 'Codex, Kimi, Gemini, Qwen or DeepSeek', onclick: () => (close(), openSettings('agents')) }, 'Use another agent instead'), finish)
    )
  );
  document.body.append(root);
  const offLog = desk.onSetupLog(appendLog);
  let offUrl = null;
  let offExit = null;
  const close = () => {
    offLog();
    offUrl && offUrl();
    offExit && offExit();
    root.remove();
    setupOpen = false;
  };
  finish.addEventListener('click', close);

  const stepHead = (n, title, done) => h('div', { class: 'setup-head' }, h('span', { class: `setup-num${done ? ' done' : ''}` }, done ? '✓' : String(n)), h('b', {}, title));

  const render = async () => {
    const s = await checkCli();
    // Step 1: install
    if (s.found) {
      step1.replaceChildren(stepHead(1, 'Claude Code is installed', true), h('div', { class: 'muted small' }, s.version));
    } else {
      const btn = h('button', { class: 'btn primary' }, 'Install Claude Code');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Installing… this can take a minute';
        const r = await desk.installClaude();
        if (!r.ok) {
          btn.disabled = false;
          btn.textContent = 'Try again';
          appendLog('\nThe installer did not finish. Check your internet connection and try again.\n');
        }
        render();
      });
      step1.replaceChildren(stepHead(1, 'Install Claude Code'), h('div', { class: 'muted small' }, "Downloads Anthropic's official installer. No admin rights needed."), btn);
    }
    // Step 2: sign in
    if (!s.found) {
      step2.replaceChildren(stepHead(2, 'Sign in with your Claude account'), h('div', { class: 'muted small' }, 'Available after step 1.'));
    } else if (s.signedIn) {
      step2.replaceChildren(stepHead(2, 'Signed in', true), h('div', { class: 'muted small' }, s.auth && s.auth.authMethod === 'claude.ai' ? 'Using your Claude subscription.' : `Signed in (${(s.auth && s.auth.authMethod) || 'ok'}).`));
    } else {
      const btn = h('button', { class: 'btn primary' }, 'Sign in with Claude');
      const waiting = h('div', { class: 'setup-wait hidden' });
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Waiting for you to sign in…';
        const urlBtn = h('button', { class: 'btn small' }, 'Open the sign-in page');
        let url = null;
        urlBtn.addEventListener('click', () => url && desk.openExternal(url));
        const code = h('input', { type: 'text', placeholder: 'Paste the code here', spellcheck: 'false' });
        const submit = h('button', { class: 'btn small primary' }, 'Submit code');
        const sendCode = () => code.value.trim() && (desk.sendLoginCode(code.value), (submit.textContent = 'Checking…'));
        submit.addEventListener('click', sendCode);
        code.addEventListener('keydown', (e) => e.key === 'Enter' && sendCode());
        const cancel = h('button', { class: 'btn small' }, 'Cancel');
        cancel.addEventListener('click', () => desk.cancelLogin());
        waiting.replaceChildren(
          h('div', {}, 'Your browser should open. Sign in there and click ', h('b', {}, 'Authorize'), '.'),
          h('div', { class: 'row' }, urlBtn, cancel),
          h('div', { class: 'muted small' }, 'If the page shows you a code instead, paste it here:'),
          h('div', { class: 'row' }, code, submit)
        );
        waiting.classList.remove('hidden');
        offUrl && offUrl();
        offExit && offExit();
        offUrl = desk.onLoginUrl((u) => {
          url = u;
        });
        offExit = desk.onLoginExit(() => render());
        try {
          await desk.startLogin();
        } catch (e) {
          appendLog(String(e.message || e) + '\n');
          render();
        }
      });
      step2.replaceChildren(stepHead(2, 'Sign in with your Claude account'), h('div', { class: 'muted small' }, "Opens claude.ai in your browser. It's the same sign-in Claude Code uses."), btn, waiting);
    }
    finish.disabled = !(s.found && s.signedIn);
  };
  render();
}

// ------------------------------------------------------------------ wiring

function wire() {
  $('#input').addEventListener('input', () => queueSaveWorkspace());
  addEventListener('beforeunload', () => {
    clearTimeout(saveWorkspaceTimer);
    saveWorkspace();
  });
  $('#btn-open-folder').addEventListener('click', async () => setFolder(await desk.pickFolder()));
  $('#btn-quickopen').addEventListener('click', quickOpen);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-theme').addEventListener('click', toggleTheme);
  $('#status-cli').addEventListener('click', () => {
    if (!cliState || (cliState.found && (cliState.auth ? cliState.auth.loggedIn : true))) return;
    if (cliState.found && multiAccount()) signInAccount(acct.folderAccount).then(() => checkCli());
    else showSetup();
  });
  $('#btn-sidebar').addEventListener('click', () => $('#workbench').classList.toggle('no-sidebar'));
  $('#btn-refresh').addEventListener('click', refreshFiles);
  $('#file-filter').addEventListener('input', renderTree);
  $('#btn-new-chat').addEventListener('click', newChat);
  $('#btn-new-copy').addEventListener('click', newChatInCopy);
  $('#btn-new-chat-side').addEventListener('click', newChat);
  $('#btn-history').addEventListener('click', () => showSidePanel('history'));
  for (const tab of document.querySelectorAll('.side-tab')) tab.addEventListener('click', () => showSidePanel(tab.dataset.panel));


  const modeBtn = $('#mode-btn');
  const modeMenu = $('#mode-menu');
  modeBtn.addEventListener('click', () => modeMenu.classList.toggle('hidden'));
  for (const b of modeMenu.querySelectorAll('button')) b.addEventListener('click', () => (setMode(b.dataset.mode), modeMenu.classList.add('hidden')));
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.mode-wrap')) modeMenu.classList.add('hidden');
  });

  const input = $('#input');
  input.addEventListener('input', () => (autoGrow(), updateMention()));
  input.addEventListener('click', updateMention);
  input.addEventListener('keydown', (e) => {
    if (mention && mention.items.length) {
      if (e.key === 'ArrowDown') return (mention.index = (mention.index + 1) % mention.items.length), renderMention(), e.preventDefault();
      if (e.key === 'ArrowUp') return (mention.index = (mention.index - 1 + mention.items.length) % mention.items.length), renderMention(), e.preventDefault();
      if (e.key === 'Enter' || e.key === 'Tab') return e.preventDefault(), pickMention(mention.items[mention.index]);
      if (e.key === 'Escape') return (mention = null), $('#mention-popup').classList.add('hidden');
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      setMode(MODES[(MODES.indexOf(state.mode) + 1) % MODES.length]);
    }
  });
  $('#send-btn').addEventListener('click', () => ($('#send-btn').classList.contains('stop') ? stop() : send()));
  $('#input').addEventListener('input', updateSendButton);
  // The "no choice" entry reads Model / Effort in the chat box, and Default in the open list.
  for (const [id, name] of [['#model-select', 'Model'], ['#effort-select', 'Effort']]) {
    const sel = $(id);
    const label = (text) => sel.querySelector('option[value=""]') && (sel.querySelector('option[value=""]').textContent = text);
    sel.addEventListener('mousedown', () => label('Default'));
    sel.addEventListener('keydown', (e) => [' ', 'Enter', 'ArrowDown', 'ArrowUp'].includes(e.key) && label('Default'));
    for (const ev of ['change', 'blur']) sel.addEventListener(ev, () => label(name));
  }
  $('#model-select').addEventListener('change', (e) => saveModelChoice(e.target.value));
  $('#effort-select').addEventListener('change', (e) => desk.setSettings({ effort: e.target.value }));

  desk.onMenu((cmd) => {
    if (cmd === 'open-folder') desk.pickFolder().then(setFolder);
    else if (cmd === 'add-folder') addWorkspaceFolder();
    else if (cmd === 'save') saveActive();
    else if (cmd === 'close-tab') state.activeTab && closeTab(state.activeTab);
    else if (cmd === 'quick-open') quickOpen();
    else if (cmd === 'new-chat') newChat();
    else if (cmd === 'add-selection') addSelectionToChat();
    else if (cmd === 'inline-edit') inlineEdit();
    else if (cmd === 'cycle-mode') setMode(MODES[(MODES.indexOf(state.mode) + 1) % MODES.length]);
    else if (cmd === 'toggle-sidebar') $('#workbench').classList.toggle('no-sidebar');
    else if (cmd === 'toggle-terminal') toggleTerminal();
    else if (cmd === 'split') toggleSplit();
    else if (cmd === 'compare') compareActiveWith();
    else if (cmd === 'source-control') showSidePanel('git');
    else if (cmd === 'search') openSearch();
    else if (cmd === 'settings') openSettings();
    else if (cmd === 'preview') openPreview();
    else if (cmd === 'new-copy-chat') newChatInCopy();
    else if (cmd === 'palette') commandPalette();
  });

  desk.onOpenFolder(async (dir) => setFolder(await desk.openFolder(dir)));
  // Another window changed a setting.
  desk.onSettingsChanged((s) => {
    state.settings = s;
    applyTheme();
    renderPermissionBadge();
    if (!state.folder) renderRecent();
  });
  $('#btn-add-folder').addEventListener('click', () => addWorkspaceFolder());

  let updateVersion = '';
  desk.onUpdateStatus((u) => {
    const el = $('#status-update');
    if (u.state === 'downloading') {
      if (u.version) updateVersion = u.version;
      el.textContent = `Downloading update${updateVersion ? ' ' + updateVersion : ''}…${u.percent != null ? ' ' + u.percent + '%' : ''}`;
      el.className = '';
    } else if (u.state === 'ready') {
      el.textContent = `⬆ Restart to update to ${u.version}`;
      el.className = 'ready';
      el.title = 'Installs the update and reopens Switchdesk';
    } else if (u.state === 'available') {
      el.textContent = `⬆ Switchdesk ${u.version} is out`;
      el.className = 'ready';
      el.dataset.url = u.url;
      el.title = 'Opens the download page';
    } else el.className = 'hidden';
  });
  $('#status-update').addEventListener('click', () => {
    if (!$('#status-update').classList.contains('ready')) return;
    if ($('#status-update').dataset.url) return desk.openExternal($('#status-update').dataset.url);
    if (chats.some((c) => c.busy) && !confirm('Claude is still working in a chat. Restart and update anyway?')) return;
    desk.installUpdate();
  });

  let fsTimer;
  let gitTimer;
  desk.onFsChanged((paths) => {
    reloadOpenFiles(paths);
    clearTimeout(gitTimer);
    gitTimer = setTimeout(refreshGit, 800);
    if (paths.some((p) => !state.fileSet.has(p))) {
      clearTimeout(fsTimer);
      fsTimer = setTimeout(refreshFiles, 400);
    }
  });

  // Resizable panels
  for (const r of document.querySelectorAll('.resizer')) {
    r.addEventListener('mousedown', (e) => {
      e.preventDefault();
      r.classList.add('dragging');
      const which = r.dataset.resize;
      const move = (ev) => {
        if (which === 'sidebar') document.documentElement.style.setProperty('--sidebar-w', Math.max(160, Math.min(520, ev.clientX)) + 'px');
        else document.documentElement.style.setProperty('--chat-w', Math.max(320, Math.min(900, window.innerWidth - ev.clientX)) + 'px');
      };
      const up = () => {
        r.classList.remove('dragging');
        removeEventListener('mousemove', move);
        removeEventListener('mouseup', up);
      };
      addEventListener('mousemove', move);
      addEventListener('mouseup', up);
    });
  }
}

function showSidePanel(name) {
  state.sidePanel = name;
  queueSaveWorkspace();
  $('#workbench').classList.remove('no-sidebar');
  for (const t of document.querySelectorAll('.side-tab')) t.classList.toggle('active', t.dataset.panel === name);
  $('#panel-explorer').classList.toggle('hidden', name !== 'explorer');
  $('#panel-history').classList.toggle('hidden', name !== 'history');
  $('#panel-git').classList.toggle('hidden', name !== 'git');
  $('#panel-search').classList.toggle('hidden', name !== 'search');
  $('#panel-debug').classList.toggle('hidden', name !== 'debug');
  if (name === 'history') loadHistory();
  if (name === 'debug') renderDebug();
  if (name === 'git') refreshGit();
}
