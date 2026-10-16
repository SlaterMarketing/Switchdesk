/* global $, h, monaco, editor, state, desk, toast, modal, fuzzyScore, loadFileTab, openFile, openDiff, activeTab, saveActive, renderTabs, closeTab, showFileHistory, addSelectionToChat */
'use strict';

// ------------------------------------------------------------------ split editor and comparing files
//
// Ctrl+\ opens the current file in a second editor beside the first (the same file in both stays in
// sync, so you can look at two places at once). Compare puts any two files, or a file and the
// clipboard, side by side as a read-only diff. Right-click a tab or a file for both.

let sideEditor = null;
const side = { rel: null };

function sideTab() {
  return side.rel ? state.tabs.find((t) => t.kind === 'file' && t.rel === side.rel) : null;
}

function renderSideHead() {
  const sel = $('#side-file');
  const files = state.tabs.filter((t) => t.kind === 'file');
  sel.replaceChildren(...files.map((t) => h('option', { value: t.rel, selected: t.rel === side.rel }, `${t.dirty ? '● ' : ''}${t.rel}`)));
}

async function openToSide(rel) {
  const t = await loadFileTab(rel);
  if (!t) return;
  if (!sideEditor) createSideEditor();
  side.rel = t.rel;
  $('#editor-host').classList.add('split');
  $('#editor-side').classList.remove('hidden');
  $('#side-resizer').classList.remove('hidden');
  sideEditor.setModel(t.model);
  renderSideHead();
  sideEditor.focus();
}

function closeSide() {
  side.rel = null;
  if (sideEditor) sideEditor.setModel(null);
  $('#editor-host').classList.remove('split');
  $('#editor-side').classList.add('hidden');
  $('#side-resizer').classList.add('hidden');
  editor.focus();
}

// Ctrl+\: the active file to the side, or closes the side if it's already split.
function toggleSplit() {
  if (side.rel) return closeSide();
  const t = activeTab();
  if (!t || t.kind !== 'file') return toast('Open a file to split.');
  openToSide(t.rel);
}

// The two editors trade files.
async function swapSides() {
  const main = activeTab();
  const s = sideTab();
  if (!main || main.kind !== 'file' || !s) return;
  const mainRel = main.rel;
  await openFile(s.rel);
  openToSide(mainRel);
}

function createSideEditor() {
  sideEditor = monaco.editor.create($('#side-editor'), {
    automaticLayout: true,
    fontSize: 13,
    fontFamily: "'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace",
    minimap: { enabled: false },
    smoothScrolling: true,
    scrollBeyondLastLine: false,
    renderLineHighlight: 'all',
    padding: { top: 8 },
    model: null,
  });
  sideEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveActive(sideTab()));
  sideEditor.onDidChangeModelContent(() => setTimeout(renderSideHead, 0));
  $('#side-file').addEventListener('change', (e) => openToSide(e.target.value));
  $('#side-swap').addEventListener('click', swapSides);
  $('#side-close').addEventListener('click', closeSide);
}

// A tab that's closed can't stay on the side.
function sideTabClosed(t) {
  if (t.kind === 'file' && t.rel === side.rel) closeSide();
  else if (side.rel) renderSideHead();
}

// ---------- compare

async function textOf(rel) {
  const t = state.tabs.find((x) => x.kind === 'file' && x.rel === rel);
  if (t) return t.model.getValue();
  const r = await desk.readFile(rel);
  if (r.binary || r.tooLarge) throw new Error(`${rel} is ${r.binary ? 'a binary file' : 'too large'} to compare.`);
  return r.content;
}

async function compareFiles(a, b) {
  try {
    const [left, right] = await Promise.all([textOf(a), textOf(b)]);
    openDiff({ source: 'compare', key: `${a}|${b}`, rel: a, before: left, after: right, title: `${a} ↔ ${b}`, hint: `Left: ${a.split('/').pop()}. Right: ${b.split('/').pop()}.` });
  } catch (e) {
    toast(String(e.message || e));
  }
}

async function compareWithClipboard(rel) {
  const clip = await navigator.clipboard.readText().catch(() => '');
  if (!clip) return toast('The clipboard is empty.');
  try {
    openDiff({ source: 'compare', key: `clip:${rel}`, rel, before: await textOf(rel), after: clip, title: `${rel} ↔ clipboard`, hint: 'Left: the file. Right: what you copied.' });
  } catch (e) {
    toast(String(e.message || e));
  }
}

// A file picker over the project's files, like quick open.
function pickFile(placeholder, onPick, except) {
  const input = h('input', { class: 'big', placeholder, spellcheck: 'false' });
  const results = h('div', { class: 'results' });
  let items = [];
  let index = 0;
  const pick = (f) => (close(), onPick(f));
  const render = () => {
    const q = input.value.trim().toLowerCase();
    items = state.files
      .filter((f) => f !== except)
      .map((f) => ({ f, score: fuzzyScore(f.toLowerCase(), q) }))
      .filter((x) => x.score > -1)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
      .map((x) => x.f);
    index = Math.min(index, Math.max(0, items.length - 1));
    results.replaceChildren(...items.map((f, i) => h('div', { class: `pop-item${i === index ? ' active' : ''}`, onclick: () => pick(f) }, f)));
  };
  const close = modal([input, results]);
  input.addEventListener('input', () => ((index = 0), render()));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') (index = Math.min(index + 1, items.length - 1)), render(), e.preventDefault();
    else if (e.key === 'ArrowUp') (index = Math.max(index - 1, 0)), render(), e.preventDefault();
    else if (e.key === 'Enter' && items[index]) pick(items[index]);
  });
  render();
  input.focus();
}

function compareActiveWith() {
  let t = activeTab();
  if (!t || t.kind !== 'file') t = (sideEditor && sideEditor.hasTextFocus() && sideTab()) || [...state.tabs].reverse().find((x) => x.kind === 'file');
  if (!t) return toast('Open a file to compare.');
  pickFile(`Compare ${t.rel.split('/').pop()} with…`, (b) => compareFiles(t.rel, b), t.rel);
}

// ---------- right-click menu on tabs and files

let compareFirst = null; // "Select for Compare" in the explorer

function contextMenu(x, y, items) {
  document.querySelector('.ctx-menu')?.remove();
  const menu = h(
    'div',
    { class: 'ctx-menu', style: `left:${x}px;top:${y}px` },
    ...items.filter(Boolean).map((it) => (it === '-' ? h('div', { class: 'sep' }) : h('button', { onclick: () => (menu.remove(), it[1]()) }, it[0])))
  );
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  if (r.right > innerWidth) menu.style.left = `${Math.max(4, innerWidth - r.width - 4)}px`;
  if (r.bottom > innerHeight) menu.style.top = `${Math.max(4, innerHeight - r.height - 4)}px`;
  const away = (e) => {
    if (menu.contains(e.target)) return;
    menu.remove();
    removeEventListener('mousedown', away, true);
  };
  addEventListener('mousedown', away, true);
}

function fileMenuItems(rel) {
  return [
    ['Open to the side', () => openToSide(rel)],
    '-',
    ['Compare with…', () => pickFile(`Compare ${rel.split('/').pop()} with…`, (b) => compareFiles(rel, b), rel)],
    compareFirst && compareFirst !== rel ? [`Compare with ${compareFirst.split('/').pop()}`, () => compareFiles(compareFirst, rel)] : null,
    ['Select for compare', () => ((compareFirst = rel), toast(`Now right-click another file and choose "Compare with ${rel.split('/').pop()}".`))],
    ['Compare with clipboard', () => compareWithClipboard(rel)],
    '-',
    ['Show file history', () => showFileHistory(rel)],
    ['Copy path', () => navigator.clipboard.writeText(rel)],
  ];
}

function wireSplit() {
  // Tabs and explorer rows get the menu. Both are re-rendered often, so listen on their containers.
  $('#tabs').addEventListener('contextmenu', (e) => {
    const el = e.target.closest('.tab');
    if (!el) return;
    const t = state.tabs.find((x) => x.id === el.dataset.id);
    if (!t || t.kind !== 'file') return;
    e.preventDefault();
    contextMenu(e.clientX, e.clientY, [...fileMenuItems(t.rel), '-', ['Close', () => closeTab(t.id)]]);
  });
  $('#tree').addEventListener('contextmenu', (e) => {
    const el = e.target.closest('.tree-row.file');
    if (!el || !el.dataset.path) return;
    e.preventDefault();
    contextMenu(e.clientX, e.clientY, fileMenuItems(el.dataset.path));
  });
  // Dragging the line between the two editors.
  const res = $('#side-resizer');
  res.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const host = $('#editor-host').getBoundingClientRect();
    const move = (ev) => {
      const w = Math.min(host.width - 200, Math.max(200, host.right - ev.clientX));
      $('#editor-host').style.setProperty('--side-w', `${w}px`);
    };
    const up = () => (removeEventListener('mousemove', move), removeEventListener('mouseup', up));
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  });
}
