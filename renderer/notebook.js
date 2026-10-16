/* global $, h, state, desk, toast, monaco, editor, activeTab, renderTabs, renderMarkdown, DOMPurify, runInTerminal, send, activeChat, agentLabel, saveActive */
'use strict';

// ------------------------------------------------------------------ Jupyter notebooks
//
// An .ipynb file opens as a notebook: markdown cells shown formatted, code cells each with their own
// small editor, and outputs (text, tables, images, errors) under them. Cells run in a real Jupyter
// kernel (jupyter.js in the main process). The notebook is still the file's Monaco model underneath,
// so saving, unsaved-changes dots, and an agent editing the file all work as for any other file;
// "Edit JSON" shows that model directly.

const isNotebook = (t) => !!(t && t.kind === 'file' && /\.ipynb$/i.test(t.rel));
const NB_EMPTY = { cells: [], metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' }, language_info: { name: 'python' } }, nbformat: 4, nbformat_minor: 5 };
let nbRun = 0;

const lines = (src) => (Array.isArray(src) ? src.join('') : String(src || ''));
const toLines = (text) => (text ? text.split(/(?<=\n)/) : []);
const stripAnsi = (s) => String(s || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
const newCellId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 8);

function parseNotebook(text) {
  if (!text.trim()) return structuredClone(NB_EMPTY);
  const doc = JSON.parse(text);
  if (!Array.isArray(doc.cells)) throw new Error('No cells: this is not a notebook in the current format (nbformat 4).');
  for (const c of doc.cells) if (!c.id) c.id = newCellId();
  return doc;
}

// The view's state for a notebook tab, set up on first show.
function notebookOf(t) {
  if (t.nb) return t.nb;
  const nb = { doc: null, error: null, json: false, writing: false, editors: new Map(), kernel: { state: 'off', display: '' }, runs: new Map(), selected: null, queue: [] };
  t.nb = nb;
  const reread = () => {
    try {
      nb.doc = parseNotebook(t.model.getValue());
      nb.error = null;
    } catch (err) {
      nb.error = err.message;
    }
  };
  reread();
  // A change that didn't come from the view (the file changed on disk, or Edit JSON) redraws it.
  t.model.onDidChangeContent(() => {
    if (nb.writing) return;
    reread();
    if (activeTab() === t && !nb.json) renderNotebook(t);
  });
  return nb;
}

// The view changed the notebook: put it back in the model, as one undoable edit.
function writeNotebook(t) {
  const nb = t.nb;
  nb.writing = true;
  try {
    for (const c of nb.doc.cells) {
      const ed = nb.editors.get(c.id);
      if (ed) c.source = toLines(ed.getValue());
    }
    const text = JSON.stringify(nb.doc, null, 1) + '\n';
    if (text !== t.model.getValue()) t.model.pushEditOperations([], [{ range: t.model.getFullModelRange(), text }], () => null);
  } finally {
    nb.writing = false;
  }
}

let nbWriteTimer = null;
const queueWrite = (t) => (clearTimeout(nbWriteTimer), (nbWriteTimer = setTimeout(() => writeNotebook(t), 300)));

function showNotebook(t) {
  const on = isNotebook(t);
  const view = $('#nb-view');
  view.classList.toggle('hidden', !on || notebookOf(t).json);
  $('#nb-bar').classList.toggle('hidden', !on);
  $('#editor-host').classList.toggle('with-nb', on);
  if (!on) return;
  renderNotebookBar(t);
  if (!t.nb.json) renderNotebook(t);
}

function kernelName(t) {
  const ks = (t.nb.doc && t.nb.doc.metadata && t.nb.doc.metadata.kernelspec) || {};
  return ks.name || 'python3';
}

function renderNotebookBar(t) {
  const nb = t.nb;
  const k = nb.kernel;
  const label = { off: 'Not started', starting: 'Starting…', idle: 'Idle', busy: 'Busy', restarting: 'Restarting…', dead: 'Stopped', stopped: 'Stopped', error: 'Not running' }[k.state] || k.state;
  $('#nb-bar').replaceChildren(
    ...[
      h('span', { class: 'nb-kernel', title: k.python ? `${k.display} (${k.python})` : '' }, h('span', { class: `nb-dot ${k.state}` }), `${k.display || kernelName(t)} · ${label}`),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', title: 'Run every cell from the top', onclick: () => runAll(t) }, '▶▶ Run all'),
      h('button', { class: 'btn small', title: 'Stop the running cell', disabled: k.state !== 'busy', onclick: () => desk.notebook.send(t.rel, { op: 'interrupt' }) }, '■ Interrupt'),
      h('button', { class: 'btn small', title: 'Restart the kernel (its variables are lost)', disabled: k.state === 'off', onclick: () => restartKernel(t) }, '↻ Restart'),
      h('button', { class: 'btn small', onclick: () => clearOutputs(t) }, 'Clear outputs'),
      h('button', { class: 'btn small', title: nb.json ? 'Back to the notebook' : 'Edit the file as JSON', onclick: () => ((nb.json = !nb.json), nb.json && writeNotebook(t), showNotebook(t), nb.json && editor.focus()) }, nb.json ? 'Notebook' : 'Edit JSON'),
    ].filter(Boolean)
  );
}

function renderNotebook(t) {
  const nb = t.nb;
  const view = $('#nb-view');
  for (const ed of nb.editors.values()) ed.dispose();
  nb.editors.clear();
  if (nb.error) {
    view.replaceChildren(h('div', { class: 'nb-error' }, h('b', {}, "This notebook couldn't be read."), h('div', { class: 'muted small' }, nb.error), h('button', { class: 'btn small', onclick: () => ((nb.json = true), showNotebook(t)) }, 'Edit JSON')));
    return;
  }
  const cells = nb.doc.cells.map((c, i) => cellEl(t, c, i));
  view.replaceChildren(...cells, adder(t, nb.doc.cells.length));
  if (!nb.doc.cells.length) view.prepend(h('div', { class: 'muted nb-empty' }, 'An empty notebook. Add a cell to start.'));
}

function adder(t, at) {
  return h(
    'div',
    { class: 'nb-adder' },
    h('button', { class: 'btn small ghost', onclick: () => addCell(t, at, 'code') }, '＋ Code'),
    h('button', { class: 'btn small ghost', onclick: () => addCell(t, at, 'markdown') }, '＋ Markdown')
  );
}

function addCell(t, at, type) {
  const c = type === 'code' ? { cell_type: 'code', id: newCellId(), metadata: {}, source: [], outputs: [], execution_count: null } : { cell_type: 'markdown', id: newCellId(), metadata: {}, source: [] };
  t.nb.doc.cells.splice(at, 0, c);
  writeNotebook(t);
  renderNotebook(t);
  t.nb.editing = c.id;
  focusCell(t, c.id);
}

function focusCell(t, id) {
  const ed = t.nb.editors.get(id);
  if (ed) return ed.focus();
  const el = $(`#nb-view [data-cell="${id}"]`);
  if (el && el.querySelector('.nb-md')) el.querySelector('.nb-md').dispatchEvent(new MouseEvent('dblclick'));
}

function moveCell(t, i, by) {
  const cells = t.nb.doc.cells;
  const j = i + by;
  if (j < 0 || j >= cells.length) return;
  writeNotebook(t);
  [cells[i], cells[j]] = [cells[j], cells[i]];
  writeNotebook(t);
  renderNotebook(t);
}

function deleteCell(t, i) {
  writeNotebook(t);
  t.nb.doc.cells.splice(i, 1);
  writeNotebook(t);
  renderNotebook(t);
}

function cellEl(t, c, i) {
  const nb = t.nb;
  const tools = h(
    'div',
    { class: 'nb-tools' },
    c.cell_type === 'code' ? h('button', { class: 'icon-btn', title: 'Run (Shift+Enter)', onclick: () => runCell(t, c.id) }, '▶') : null,
    h('button', { class: 'icon-btn', title: 'Move up', onclick: () => moveCell(t, i, -1) }, '↑'),
    h('button', { class: 'icon-btn', title: 'Move down', onclick: () => moveCell(t, i, 1) }, '↓'),
    h('button', { class: 'icon-btn', title: 'Delete the cell', onclick: () => deleteCell(t, i) }, '✕')
  );
  const box = h('div', { class: `nb-cell ${c.cell_type}`, 'data-cell': c.id });
  if (c.cell_type === 'code') {
    const running = [...nb.runs.values()].some((r) => r.cell === c.id);
    const queued = nb.queue.includes(c.id);
    const count = h('div', { class: 'nb-count' }, running ? '[*]' : queued ? '[ ]' : `[${c.execution_count == null ? ' ' : c.execution_count}]`);
    const host = h('div', { class: 'nb-code' });
    const outs = h('div', { class: 'nb-outputs' }, ...(c.outputs || []).map((o) => outputEl(t, c, o)));
    box.append(h('div', { class: 'nb-row' }, count, host, tools), outs);
    requestAnimationFrame(() => mountEditor(t, c, host));
  } else if (c.cell_type === 'markdown') {
    const md = h('div', { class: 'nb-md msg-text', title: 'Double-click to edit' });
    const show = () => {
      renderMarkdown(md, lines(c.source) || '*Empty markdown cell. Double-click to write.*');
      md.classList.toggle('muted', !lines(c.source));
    };
    show();
    md.addEventListener('dblclick', () => {
      const host = h('div', { class: 'nb-code' });
      md.replaceWith(host);
      mountEditor(t, c, host, 'markdown', () => {
        writeNotebook(t);
        const ed = nb.editors.get(c.id);
        if (ed) ed.dispose(), nb.editors.delete(c.id);
        host.replaceWith(md);
        show();
      });
      requestAnimationFrame(() => nb.editors.get(c.id) && nb.editors.get(c.id).focus());
    });
    box.append(h('div', { class: 'nb-row' }, h('div', { class: 'nb-count' }), md, tools));
    if (nb.editing === c.id) (nb.editing = null), requestAnimationFrame(() => md.dispatchEvent(new MouseEvent('dblclick')));
  } else {
    box.append(h('div', { class: 'nb-row' }, h('div', { class: 'nb-count' }), h('pre', { class: 'nb-raw' }, lines(c.source)), tools));
  }
  return box;
}

// A small editor sized to its cell. done() (markdown) ends editing.
function mountEditor(t, c, host, lang, done) {
  const nb = t.nb;
  if (!host.isConnected || nb.editors.has(c.id)) return;
  const language = lang || ((nb.doc.metadata && nb.doc.metadata.language_info && nb.doc.metadata.language_info.name) || 'python');
  const ed = monaco.editor.create(host, {
    value: lines(c.source),
    language,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    lineNumbers: 'off',
    glyphMargin: false,
    folding: false,
    lineDecorationsWidth: 6,
    renderLineHighlight: 'none',
    overviewRulerLanes: 0,
    scrollbar: { vertical: 'hidden', alwaysConsumeMouseWheel: false },
    fontSize: 13,
    automaticLayout: true,
    wordWrap: lang === 'markdown' ? 'on' : 'off',
  });
  nb.editors.set(c.id, ed);
  if (nb.editing === c.id) (nb.editing = null), requestAnimationFrame(() => ed.focus());
  const fit = () => (host.style.height = `${Math.max(22, ed.getContentHeight())}px`);
  ed.onDidContentSizeChange(fit);
  fit();
  ed.onDidChangeModelContent(() => queueWrite(t));
  ed.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => (done ? done() : runCell(t, c.id, true)));
  ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => (done ? done() : runCell(t, c.id)));
  ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => (writeNotebook(t), saveActive(t)));
  if (done) {
    ed.addCommand(monaco.KeyCode.Escape, done);
    ed.onDidBlurEditorText(() => setTimeout(() => !ed.hasTextFocus() && nb.editors.get(c.id) === ed && done(), 100));
  }
}

function outputEl(t, c, o) {
  const data = o.data || {};
  if (o.output_type === 'stream') return h('pre', { class: `nb-out stream ${o.name || ''}` }, stripAnsi(lines(o.text)));
  if (o.output_type === 'error')
    return h(
      'div',
      { class: 'nb-out error' },
      h('pre', {}, stripAnsi((o.traceback || []).join('\n')) || `${o.ename}: ${o.evalue}`),
      h('button', { class: 'btn small', onclick: () => fixCellWithAgent(t, c, o) }, 'Fix with the agent')
    );
  for (const type of ['image/png', 'image/jpeg', 'image/gif']) if (data[type]) return h('img', { class: 'nb-out image', src: `data:${type};base64,${lines(data[type]).replace(/\s/g, '')}` });
  if (data['image/svg+xml']) {
    const el = h('div', { class: 'nb-out svg' });
    el.innerHTML = DOMPurify.sanitize(lines(data['image/svg+xml']), { USE_PROFILES: { svg: true } });
    return el;
  }
  if (data['text/html']) {
    // Tables from pandas and the like; scripts are removed.
    const el = h('div', { class: 'nb-out html' });
    el.innerHTML = DOMPurify.sanitize(lines(data['text/html']));
    return el;
  }
  if (data['text/markdown']) {
    const el = h('div', { class: 'nb-out msg-text' });
    renderMarkdown(el, lines(data['text/markdown']));
    return el;
  }
  if (data['application/json']) return h('pre', { class: 'nb-out' }, JSON.stringify(data['application/json'], null, 2));
  if (data['text/plain']) return h('pre', { class: 'nb-out' }, stripAnsi(lines(data['text/plain'])));
  return h('div', { class: 'nb-out muted small' }, `(${Object.keys(data).join(', ') || o.output_type} output)`);
}

function fixCellWithAgent(t, c, o) {
  const i = t.nb.doc.cells.indexOf(c) + 1;
  const prompt = `In the notebook @${t.rel}, cell ${i} fails:\n\n\`\`\`python\n${lines(c.source)}\n\`\`\`\n\n\`\`\`\n${stripAnsi((o.traceback || []).join('\n')).slice(-4000) || `${o.ename}: ${o.evalue}`}\n\`\`\`\n\nFind the cause and fix the cell in the notebook file. Keep the change small.`;
  send(prompt, 'agent', `Fix cell ${i} of ${t.rel.split('/').pop()}`);
}

// ---------- running cells

async function ensureKernel(t) {
  const nb = t.nb;
  if (nb.kernel.state !== 'off' && nb.kernel.state !== 'error' && nb.kernel.state !== 'stopped') return nb.kernel.ready;
  nb.kernel = { state: 'starting', display: nb.kernel.display };
  renderNotebookBar(t);
  nb.kernel.ready = desk.notebook.start(t.rel, kernelName(t)).then((r) => {
    if (r.error) {
      nb.kernel = { state: 'error', display: '' };
      renderNotebookBar(t);
      kernelProblem(t, r);
      return false;
    }
    nb.kernel = { ...nb.kernel, state: 'idle', display: r.display, python: r.python };
    renderNotebookBar(t);
    return true;
  });
  return nb.kernel.ready;
}

function kernelProblem(t, r) {
  const view = $('#nb-view');
  const old = $('.nb-banner', view);
  if (old) old.remove();
  const install = r.missing === 'jupyter' ? h('button', { class: 'btn small primary', onclick: async () => (runInTerminal(await desk.notebook.installCommand()), toast('Installing in the terminal. Run the cell again when it finishes.')) }, 'Install it in the terminal') : null;
  view.prepend(h('div', { class: 'nb-banner' }, h('b', {}, "The cells can't run yet. "), r.error, r.missing === 'jupyter' ? ' It needs the ipykernel and jupyter_client packages.' : '', ' ', install));
}

async function runCell(t, id, advance) {
  const nb = t.nb;
  writeNotebook(t);
  const c = nb.doc.cells.find((x) => x.id === id);
  if (!c) return;
  if (advance) {
    const i = nb.doc.cells.indexOf(c);
    const next = nb.doc.cells[i + 1];
    if (next) focusCell(t, next.id);
    else addCell(t, i + 1, 'code');
  }
  if (c.cell_type !== 'code') return;
  nb.queue.push(id);
  refreshCell(t, id);
  if (!(await ensureKernel(t))) {
    nb.queue = [];
    return refreshCell(t, id);
  }
  nb.queue = nb.queue.filter((x) => x !== id);
  const run = `r${++nbRun}`;
  nb.runs.set(run, { cell: id });
  c.outputs = [];
  c.execution_count = null;
  writeNotebook(t);
  refreshCell(t, id);
  desk.notebook.send(t.rel, { op: 'execute', id: run, code: lines(c.source) });
  return new Promise((resolve) => (nb.runs.get(run).resolve = resolve));
}

async function runAll(t) {
  writeNotebook(t);
  for (const c of [...t.nb.doc.cells]) if (c.cell_type === 'code') if ((await runCell(t, c.id)) !== 'ok') break;
}

async function restartKernel(t) {
  if (!(await ensureKernel(t))) return;
  desk.notebook.send(t.rel, { op: 'restart' });
}

function clearOutputs(t) {
  writeNotebook(t);
  for (const c of t.nb.doc.cells) if (c.cell_type === 'code') (c.outputs = []), (c.execution_count = null);
  writeNotebook(t);
  renderNotebook(t);
}

// Redraws one cell's count and outputs without touching its editor.
function refreshCell(t, id) {
  if (activeTab() !== t || t.nb.json) return;
  const box = $(`#nb-view [data-cell="${id}"]`);
  const c = t.nb.doc.cells.find((x) => x.id === id);
  if (!box || !c) return;
  const running = [...t.nb.runs.values()].some((r) => r.cell === id);
  const queued = t.nb.queue.includes(id);
  $('.nb-count', box).textContent = running ? '[*]' : queued ? '[ ]' : `[${c.execution_count == null ? ' ' : c.execution_count}]`;
  $('.nb-outputs', box).replaceChildren(...(c.outputs || []).map((o) => outputEl(t, c, o)));
}

function onKernelEvent(m) {
  const t = state.tabs.find((x) => isNotebook(x) && x.rel === m.rel && x.nb);
  if (!t) return;
  const nb = t.nb;
  if (m.type === 'status') {
    nb.kernel.state = m.state === 'starting' ? 'starting' : m.state;
    if (m.state === 'stopped' || m.state === 'dead') for (const [k, r] of nb.runs) nb.runs.delete(k), r.resolve && r.resolve('aborted');
    if (activeTab() === t) renderNotebookBar(t);
    return;
  }
  const r = nb.runs.get(m.id);
  if (!r) return;
  const c = nb.doc.cells.find((x) => x.id === r.cell);
  if (m.type === 'done') {
    nb.runs.delete(m.id);
    r.resolve && r.resolve(m.status);
  } else if (c && m.type === 'count') c.execution_count = m.count;
  else if (c && m.type === 'clear') c.outputs = [];
  else if (c && m.type === 'output') {
    // Text printed in pieces joins up into one output, as Jupyter shows it.
    const last = c.outputs[c.outputs.length - 1];
    if (m.output.output_type === 'stream' && last && last.output_type === 'stream' && last.name === m.output.name) last.text = toLines(lines(last.text) + lines(m.output.text));
    else c.outputs.push({ ...m.output, ...(m.output.text != null ? { text: toLines(lines(m.output.text)) } : {}) });
  }
  if (c) {
    writeNotebook(t);
    refreshCell(t, c.id);
  }
}

function wireNotebooks() {
  desk.notebook.onEvent(onKernelEvent);
}

// The tab closed: its kernel goes too.
function notebookClosed(t) {
  if (!isNotebook(t) || !t.nb) return;
  for (const ed of t.nb.editors.values()) ed.dispose();
  if (t.nb.kernel.state !== 'off') desk.notebook.stop(t.rel);
}
