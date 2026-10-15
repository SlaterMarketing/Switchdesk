/* global $, h, state, desk, toast, Terminal, FitAddon, send, noticeLocalUrl */
'use strict';

// ------------------------------------------------------------------ terminal panel

const terms = []; // { id, title, xterm, fit, el, exited }
let activeTermId = null;
let termSeq = 0;

function termTheme() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  return { background: v('--bg'), foreground: v('--text'), cursor: v('--accent'), selectionBackground: v('--bg-active') };
}

function terminalOpen() {
  return !$('#terminal-panel').classList.contains('hidden');
}

function toggleTerminal(force) {
  const show = force ?? !terminalOpen();
  $('#terminal-panel').classList.toggle('hidden', !show);
  $('#terminal-resizer').classList.toggle('hidden', !show);
  $('#editor-area').classList.toggle('with-terminal', show);
  if (show) {
    if (!terms.length) newTerminal();
    else focusTerminal(activeTermId);
  }
}

async function newTerminal() {
  if (!state.folder) return toast('Open a folder first.');
  const id = `t${++termSeq}`;
  const el = h('div', { class: 'term-pane' });
  $('#term-host').append(el);
  const xterm = new Terminal({
    fontFamily: "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace",
    fontSize: 12,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: false,
    theme: termTheme(),
  });
  const fit = new FitAddon.FitAddon();
  xterm.loadAddon(fit);
  xterm.open(el);
  const t = { id, title: `Terminal ${termSeq}`, xterm, fit, el, exited: false };
  terms.push(t);
  focusTerminal(id);
  fit.fit();
  xterm.onData((d) => !t.exited && desk.term.write(id, d));
  xterm.onResize(({ cols, rows }) => !t.exited && desk.term.resize(id, cols, rows));
  try {
    await desk.term.create(id, xterm.cols, xterm.rows);
  } catch (e) {
    t.exited = true;
    xterm.write(`\x1b[31m${String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}\x1b[0m\r\n`);
  }
  return t;
}

function focusTerminal(id) {
  activeTermId = id;
  for (const t of terms) t.el.classList.toggle('hidden', t.id !== id);
  renderTermTabs();
  const t = terms.find((x) => x.id === id);
  if (t) {
    requestAnimationFrame(() => {
      fitTerminal(t);
      t.xterm.focus();
    });
  }
}

function fitTerminal(t) {
  if (!t || !terminalOpen()) return;
  try {
    t.fit.fit();
  } catch {
    /* hidden */
  }
}

function closeTerminal(id) {
  const i = terms.findIndex((t) => t.id === id);
  if (i < 0) return;
  const [t] = terms.splice(i, 1);
  desk.term.kill(id);
  t.xterm.dispose();
  t.el.remove();
  if (!terms.length) return toggleTerminal(false);
  if (activeTermId === id) focusTerminal(terms[Math.min(i, terms.length - 1)].id);
  else renderTermTabs();
}

function renderTermTabs() {
  $('#term-tabs').replaceChildren(
    ...terms.map((t) =>
      h(
        'div',
        { class: `term-tab${t.id === activeTermId ? ' active' : ''}${t.exited ? ' exited' : ''}`, onclick: () => focusTerminal(t.id) },
        t.title,
        h('button', { class: 'close', title: 'Close terminal', onclick: (e) => (e.stopPropagation(), closeTerminal(t.id)) }, '×')
      )
    )
  );
}

function wireTerminal() {
  $('#btn-term-new').addEventListener('click', newTerminal);
  $('#btn-term-hide').addEventListener('click', () => toggleTerminal(false));
  desk.term.onData(({ id, data }) => {
    const t = terms.find((x) => x.id === id);
    if (!t) return;
    t.xterm.write(data);
    watchForErrors(t, data);
    noticeLocalUrl(data);
  });
  $('#btn-term-fix').addEventListener('click', fixWithClaude);
  desk.term.onExit(({ id, code }) => {
    const t = terms.find((x) => x.id === id);
    if (!t) return;
    t.exited = true;
    t.xterm.write(`\r\n\x1b[2m[process exited with code ${code}]\x1b[0m\r\n`);
    renderTermTabs();
  });
  new ResizeObserver(() => fitTerminal(terms.find((t) => t.id === activeTermId))).observe($('#term-host'));
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', retheme);

  // Drag the bar above the panel to resize it.
  const r = $('#terminal-resizer');
  r.addEventListener('mousedown', (e) => {
    e.preventDefault();
    r.classList.add('dragging');
    const area = $('#editor-area').getBoundingClientRect();
    const move = (ev) => document.documentElement.style.setProperty('--term-h', Math.max(100, Math.min(area.height - 120, area.bottom - ev.clientY)) + 'px');
    const up = () => {
      r.classList.remove('dragging');
      removeEventListener('mousemove', move);
      removeEventListener('mouseup', up);
    };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  });
}

// ------------------------------------------------------------------ Fix with Claude

const ERROR_RE = /\b(error|errors|failed|failure|exception|traceback|fatal|panic|ERR!|cannot find|not found|not recognized|undefined reference|segmentation fault)\b/i;
let fixTimer = null;

// Light up the button when a command prints something that looks like an error.
function watchForErrors(t, data) {
  const plain = data.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  if (!ERROR_RE.test(plain)) return;
  clearTimeout(fixTimer);
  fixTimer = setTimeout(() => {
    if (t.id === activeTermId) $('#btn-term-fix').classList.add('alert');
  }, 500);
}

function terminalText(t, maxLines = 80) {
  const sel = t.xterm.getSelection();
  if (sel && sel.trim()) return sel.trim();
  const buf = t.xterm.buffer.active;
  const lines = [];
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.slice(-maxLines).join('\n').trim();
}

function fixWithClaude() {
  const t = terms.find((x) => x.id === activeTermId);
  if (!t) return;
  const out = terminalText(t);
  if (!out) return toast('The terminal is empty.');
  $('#btn-term-fix').classList.remove('alert');
  const prompt = `Something went wrong in my terminal. Here's the output:\n\n\`\`\`\n${out}\n\`\`\`\n\nWork out what caused it and fix it. If it's a problem with the command rather than the code, tell me the right command.`;
  const tail = out.split('\n').slice(-4).join('\n');
  send(prompt, undefined, `✨ Fix this terminal error\n${tail}`);
}

function retheme() {
  for (const t of terms) t.xterm.options.theme = termTheme();
}
