/* global $, h, monaco, editor, state, desk, toast, openFile, activeTab, showSidePanel, autoGrow, setMode, runInTerminal */
'use strict';

// ------------------------------------------------------------------ run and debug
//
// Click in the margin (or F9) for a breakpoint, then F5 runs the file under the debugger:
// JavaScript and TypeScript with Node's own inspector, Python with debugpy. When it stops you get
// the call stack, variables, watches, a console that evaluates in the paused frame, values on
// hover, and ✨ Ask the agent, which hands the stop to the chat.

const dbg = {
  running: null, // { rel, kind }
  stopped: null, // { reason, exception, frames }
  frame: 0, // index into stopped.frames
  scopes: [],
  open: new Set(), // expanded variable paths
  children: new Map(), // ref -> variables
  watches: [],
  watchValues: new Map(),
  output: [],
  target: null, // file to run; the active file when null
  args: '',
  exceptions: 'uncaught',
};
const bpDecos = new WeakMap(); // model -> { ids, lines }
let lineDecos = [];

// ---------- breakpoints (kept per folder in settings)

function allBreakpoints() {
  return (state.folder && state.settings.breakpoints && state.settings.breakpoints[folderId()]) || {};
}

function saveBreakpoints(map) {
  if (!state.folder) return;
  const clean = Object.fromEntries(Object.entries(map).filter(([, l]) => l.length));
  desk.setSettings({ breakpoints: { ...(state.settings.breakpoints || {}), [folderId()]: clean } }).then((s) => (state.settings = s));
  state.settings.breakpoints = { ...(state.settings.breakpoints || {}), [folderId()]: clean };
}

function linesFor(rel) {
  return allBreakpoints()[rel] || [];
}

function setLines(rel, lines) {
  const map = { ...allBreakpoints(), [rel]: [...new Set(lines)].sort((a, b) => a - b) };
  saveBreakpoints(map);
  if (dbg.running) desk.debug.breakpoints(rel, map[rel]);
  renderBreakpointDecos();
  renderDebug();
}

function toggleBreakpoint(rel, line) {
  const lines = linesFor(rel);
  setLines(rel, lines.includes(line) ? lines.filter((l) => l !== line) : [...lines, line]);
}

function renderBreakpointDecos() {
  const t = activeTab();
  if (!editor || !t || t.kind !== 'file') return;
  const model = t.model;
  const prev = bpDecos.get(model);
  const lines = linesFor(t.rel).filter((l) => l <= model.getLineCount());
  const ids = model.deltaDecorations(prev ? prev.ids : [], lines.map((l) => ({ range: new monaco.Range(l, 1, l, 1), options: { glyphMarginClassName: 'bp-glyph', glyphMarginHoverMessage: { value: 'Breakpoint (click to remove)' }, stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges } })));
  bpDecos.set(model, { ids, rel: t.rel });
}

// Breakpoints move with the code as you type above them.
function followEdits(model) {
  const d = bpDecos.get(model);
  if (!d || !d.ids.length) return;
  const lines = d.ids.map((id) => model.getDecorationRange(id)).filter(Boolean).map((r) => r.startLineNumber);
  const before = linesFor(d.rel);
  if (lines.length === before.length && lines.every((l, i) => l === before[i])) return;
  setLines(d.rel, lines);
}

// ---------- running

const kindOfFile = (rel) => (/\.(py|pyw)$/i.test(rel) ? 'python' : /\.(m?js|cjs|ts|mts|cts)$/i.test(rel) ? 'node' : null);

function targetFile() {
  if (dbg.target) return dbg.target;
  const t = activeTab();
  return t && t.kind === 'file' && kindOfFile(t.rel) ? t.rel : null;
}

async function startDebugging(rel = targetFile()) {
  if (!rel) {
    showSidePanel('debug');
    return toast('Open a JavaScript, TypeScript or Python file to debug.');
  }
  const t = state.tabs.find((x) => x.kind === 'file' && x.rel === rel);
  if (t && t.dirty) await saveActive(t);
  dbg.output = [];
  dbg.stopped = null;
  dbg.running = { rel, kind: kindOfFile(rel) };
  showSidePanel('debug');
  renderDebug();
  const args = (dbg.args.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((a) => a.replace(/^["']|["']$/g, ''));
  let r;
  try {
    r = await desk.debug.start({ rel, args, breakpoints: allBreakpoints(), exceptions: dbg.exceptions });
  } catch (e) {
    dbg.running = null;
    addOutput('stderr', String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') + '\n');
    return renderDebug();
  }
  if (r && r.missing) {
    dbg.running = null;
    renderDebug();
    if (r.missing === 'debugpy') {
      if (confirm('Debugging Python needs debugpy (the debugger VS Code uses). Install it now in the terminal?')) runInTerminal(`"${r.python}" -m pip install debugpy`);
    } else toast(r.missing === 'node' ? "Node.js isn't installed (or isn't on your PATH)." : "Python isn't installed (or isn't on your PATH).");
    return;
  }
  addOutput('console', `Debugging ${rel} with ${r.kind === 'node' ? 'Node' : 'Python'}\n`);
}

function debugCmd(cmd) {
  if (!dbg.running) return cmd === 'continue' ? startDebugging() : null;
  if (cmd !== 'pause' && cmd !== 'stop' && !dbg.stopped) return;
  desk.debug.cmd(cmd);
}

function restartDebugging() {
  const rel = dbg.running && dbg.running.rel;
  if (!rel) return startDebugging();
  dbg.restartRel = rel;
  desk.debug.cmd('stop');
}

function addOutput(category, text) {
  const last = dbg.output[dbg.output.length - 1];
  if (last && last.category === category && category !== 'eval' && last.text.length < 20000) last.text += text;
  else dbg.output.push({ category, text });
  if (dbg.output.length > 500) dbg.output.splice(0, dbg.output.length - 500);
  renderConsole();
}

async function onDebugEvent(e) {
  if (e.type === 'output') return addOutput(e.category, e.text);
  if (e.type === 'continued') {
    dbg.stopped = null;
    clearLineDeco();
    return renderDebug();
  }
  if (e.type === 'terminated') {
    dbg.stopped = null;
    clearLineDeco();
    addOutput('console', `\nFinished${e.code != null ? ` (exit code ${e.code})` : ''}.\n`);
    dbg.running = null;
    renderDebug();
    if (dbg.restartRel) {
      const rel = dbg.restartRel;
      dbg.restartRel = null;
      startDebugging(rel);
    }
    return;
  }
  if (e.type === 'stopped') {
    dbg.stopped = e;
    // Start on the first frame that's your code, not Node's or a library's.
    const mine = e.frames.findIndex((f) => !f.internal && f.rel);
    dbg.frame = mine >= 0 ? mine : 0;
    dbg.open.clear();
    dbg.children.clear();
    await selectFrame(dbg.frame);
    if (!document.hasFocus()) desk.flashWindow();
  }
}

async function selectFrame(i) {
  dbg.frame = i;
  const f = dbg.stopped && dbg.stopped.frames[i];
  if (!f) return renderDebug();
  dbg.scopes = await desk.debug.scopes(f.id).catch(() => []);
  // The first scope starts open, like VS Code.
  if (dbg.scopes[0]) {
    dbg.open.add(`s${dbg.scopes[0].ref}`);
    dbg.children.set(dbg.scopes[0].ref, await desk.debug.variables(dbg.scopes[0].ref).catch(() => []));
  }
  await refreshWatches();
  renderDebug();
  if (f.rel) {
    await openFile(f.rel, f.line);
    showLineDeco(f);
  }
}

function showLineDeco(f) {
  const t = activeTab();
  if (!t || t.kind !== 'file' || t.rel !== f.rel) return;
  const top = dbg.frame === dbg.stopped.frames.findIndex((x) => !x.internal && x.rel);
  lineDecos = editor.deltaDecorations(lineDecos, [{ range: new monaco.Range(f.line, 1, f.line, 1), options: { isWholeLine: true, className: top ? 'debug-line' : 'debug-line frame', glyphMarginClassName: top ? 'debug-arrow' : 'debug-arrow frame' } }]);
}

function clearLineDeco() {
  if (editor) lineDecos = editor.deltaDecorations(lineDecos, []);
}

async function refreshWatches() {
  const f = dbg.stopped && dbg.stopped.frames[dbg.frame];
  for (const w of dbg.watches) dbg.watchValues.set(w, await desk.debug.evaluate(w, f ? f.id : undefined).catch((e) => ({ error: e.message })));
}

// ---------- the panel

async function toggleVar(key, ref) {
  if (dbg.open.has(key)) dbg.open.delete(key);
  else {
    dbg.open.add(key);
    if (!dbg.children.has(ref)) dbg.children.set(ref, await desk.debug.variables(ref).catch(() => []));
  }
  renderDebug();
}

function varRows(list, depth, prefix) {
  const out = [];
  for (const v of list || []) {
    const key = `${prefix}/${v.name}`;
    const open = v.ref && dbg.open.has(key);
    out.push(
      h(
        'div',
        { class: 'dbg-var', style: `padding-left:${8 + depth * 12}px`, title: `${v.name}: ${v.value}`, onclick: () => v.ref && toggleVar(key, v.ref) },
        h('span', { class: 'twisty' }, v.ref ? (open ? '▾' : '▸') : ''),
        h('span', { class: 'name' }, v.name),
        h('span', { class: 'muted' }, ': '),
        h('span', { class: `val t-${(v.type || '').toLowerCase()}` }, v.value)
      )
    );
    if (open) out.push(...varRows(dbg.children.get(v.ref), depth + 1, key));
  }
  return out;
}

function section(title, ...body) {
  return h('div', { class: 'dbg-section' }, h('div', { class: 'git-section muted small' }, title), ...body);
}

function renderDebug() {
  const panel = $('#panel-debug');
  if (!panel) return;
  const rel = dbg.running ? dbg.running.rel : targetFile();
  const btn = (label, title, cmd, enabled = true) => h('button', { class: 'icon-btn dbg-btn', title, disabled: !enabled, onclick: () => (cmd === 'restart' ? restartDebugging() : debugCmd(cmd)) }, label);
  const paused = !!dbg.stopped;
  const tools = dbg.running
    ? h(
        'div',
        { class: 'dbg-tools' },
        paused ? btn('▶', 'Continue (F5)', 'continue') : btn('⏸', 'Pause', 'pause'),
        btn('⤼', 'Step over (F10)', 'next', paused),
        btn('⤓', 'Step into (F11)', 'stepIn', paused),
        btn('⤒', 'Step out (Shift+F11)', 'stepOut', paused),
        btn('⟲', 'Restart', 'restart'),
        btn('■', 'Stop (Shift+F5)', 'stop')
      )
    : null;
  const argsIn = h('input', { class: 'dbg-args', placeholder: 'Arguments (optional)', value: dbg.args, spellcheck: 'false' });
  argsIn.addEventListener('change', () => (dbg.args = argsIn.value));
  const exc = h('select', { class: 'dbg-exc', title: 'When to stop on an error' }, ...[['uncaught', 'Stop on uncaught errors'], ['all', 'Stop on every error'], ['none', "Don't stop on errors"]].map(([v, l]) => h('option', { value: v, selected: dbg.exceptions === v }, l)));
  exc.addEventListener('change', () => {
    dbg.exceptions = exc.value;
    desk.debug.exceptions(exc.value);
  });
  const head = h(
    'div',
    { class: 'dbg-head' },
    dbg.running
      ? h('div', { class: 'small' }, h('b', {}, paused ? (dbg.stopped.reason === 'exception' ? 'Stopped on an error' : dbg.stopped.reason === 'breakpoint' ? 'Paused on a breakpoint' : 'Paused') : 'Running'), ` · ${dbg.running.rel.split('/').pop()}`)
      : h('button', { class: 'btn small primary', disabled: !rel, onclick: () => startDebugging() }, rel ? `▶ Debug ${rel.split('/').pop()}` : '▶ Run and debug'),
    tools,
    dbg.running ? null : h('div', { class: 'muted small' }, rel ? 'F5 starts it. Click left of a line number (or F9) to add a breakpoint.' : 'Open a JavaScript, TypeScript or Python file, add breakpoints in the margin, then press F5.'),
    dbg.running ? null : argsIn,
    exc
  );
  const exception = paused && dbg.stopped.exception ? h('div', { class: 'dbg-exception' }, dbg.stopped.exception) : null;
  const ask = paused ? h('button', { class: 'btn small', onclick: askAgentAboutStop, title: 'Give the agent the stack, the variables and the error, and ask it to find the cause' }, '✨ Ask the agent') : null;

  const frames = paused ? dbg.stopped.frames : [];
  const shownFrames = frames.map((f, i) => ({ f, i })).filter(({ f }) => !f.internal || frames.length < 4);
  const stack = paused
    ? section(
        'Call stack',
        ...shownFrames.map(({ f, i }) => h('div', { class: `dbg-frame${i === dbg.frame ? ' active' : ''}${f.internal ? ' internal' : ''}`, onclick: () => selectFrame(i), title: f.file || f.url || '' }, h('span', { class: 'name' }, f.name), h('span', { class: 'muted small' }, f.rel ? `${f.rel.split('/').pop()}:${f.line}` : f.url ? f.url.replace(/^node:/, '') : ''))),
        frames.length > shownFrames.length ? h('div', { class: 'muted small', style: 'padding:2px 10px' }, `${frames.length - shownFrames.length} more in Node and libraries`) : null
      )
    : null;
  const vars = paused
    ? section(
        'Variables',
        ...dbg.scopes.flatMap((s) => {
          const key = `s${s.ref}`;
          const open = dbg.open.has(key);
          return [h('div', { class: 'dbg-var scope', onclick: () => toggleVar(key, s.ref) }, h('span', { class: 'twisty' }, open ? '▾' : '▸'), h('b', { class: 'small' }, s.name)), ...(open ? varRows(dbg.children.get(s.ref), 1, key) : [])];
        })
      )
    : null;
  const watchIn = h('input', { class: 'dbg-args', placeholder: '+ Watch an expression', spellcheck: 'false' });
  watchIn.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || !watchIn.value.trim()) return;
    dbg.watches.push(watchIn.value.trim());
    if (dbg.running) await refreshWatches();
    renderDebug();
  });
  const watches = section(
    'Watch',
    ...dbg.watches.map((w, i) => {
      const r = dbg.watchValues.get(w);
      return h('div', { class: 'dbg-var' }, h('span', { class: 'name' }, w), h('span', { class: 'muted' }, ': '), h('span', { class: r && r.error ? 'val err' : 'val' }, !dbg.stopped ? '…' : r ? r.error || r.value : ''), h('span', { class: 'spacer' }), h('button', { class: 'icon-btn', title: 'Remove', onclick: (e) => (e.stopPropagation(), dbg.watches.splice(i, 1), renderDebug()) }, '✕'));
    }),
    watchIn
  );
  const bps = Object.entries(allBreakpoints()).flatMap(([file, lines]) => lines.map((l) => ({ file, l })));
  const bpList = section(
    'Breakpoints',
    ...bps.map(({ file, l }) => h('div', { class: 'dbg-frame', onclick: () => openFile(file, l), title: `${file}:${l}` }, h('span', { class: 'bp-dot' }), h('span', { class: 'name' }, `${file.split('/').pop()}:${l}`), h('span', { class: 'muted small' }, file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : ''), h('span', { class: 'spacer' }), h('button', { class: 'icon-btn', title: 'Remove', onclick: (e) => (e.stopPropagation(), toggleBreakpoint(file, l)) }, '✕'))),
    bps.length ? h('button', { class: 'btn small', style: 'margin:4px 10px', onclick: () => (saveBreakpoints({}), renderBreakpointDecos(), renderDebug(), dbg.running && bps.forEach(({ file }) => desk.debug.breakpoints(file, []))) }, 'Remove all') : h('div', { class: 'muted small', style: 'padding:2px 10px' }, 'None yet.')
  );
  const consoleIn = h('input', { class: 'dbg-args', placeholder: dbg.running ? (paused ? 'Evaluate in the paused frame' : 'Evaluate') : 'Start debugging to evaluate', spellcheck: 'false', disabled: !dbg.running });
  consoleIn.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || !consoleIn.value.trim()) return;
    const expr = consoleIn.value.trim();
    consoleIn.value = '';
    const f = dbg.stopped && dbg.stopped.frames[dbg.frame];
    addOutput('eval', `› ${expr}\n`);
    const r = await desk.debug.evaluate(expr, f ? f.id : undefined);
    addOutput(r.error ? 'stderr' : 'result', `${r.error || r.value}\n`);
  });
  const out = h('div', { class: 'dbg-console', id: 'dbg-console' });
  panel.replaceChildren(...[head, exception, ask ? h('div', { style: 'padding:0 10px 6px' }, ask) : null, stack, vars, watches, bpList, section('Console', out, consoleIn)].filter(Boolean));
  renderConsole();
}

function renderConsole() {
  const out = $('#dbg-console');
  if (!out) return;
  out.replaceChildren(...dbg.output.map((o) => h('span', { class: `c-${o.category}` }, o.text)));
  out.scrollTop = out.scrollHeight;
}

// ✨ Ask the agent: the stop, with its stack and variables, into the chat box.
async function askAgentAboutStop() {
  const s = dbg.stopped;
  if (!s) return;
  const frames = s.frames.filter((f) => !f.internal).slice(0, 8);
  const f = s.frames[dbg.frame];
  const wrapper = /^(exports|require|module|__filename|__dirname|__builtins__|__name__|__doc__|__file__|__spec__|__loader__|__package__|__cached__|__annotations__)$/;
  const locals = (dbg.children.get(dbg.scopes[0] && dbg.scopes[0].ref) || []).filter((v) => !wrapper.test(v.name)).slice(0, 30).map((v) => `  ${v.name} = ${String(v.value).slice(0, 200)}`);
  const what = s.reason === 'exception' ? `stopped on an error${s.exception ? `: ${s.exception}` : ''}` : `is paused at a breakpoint`;
  $('#input').value =
    `My program (${dbg.running.rel}) ${what}, at ${f && f.rel ? `${f.rel}:${f.line}` : 'this point'}.\n\n` +
    `Call stack:\n${frames.map((x) => `  ${x.name} (${x.rel || x.file || x.url}:${x.line})`).join('\n')}\n\n` +
    (locals.length ? `Variables in ${f ? f.name : 'this frame'}:\n${locals.join('\n')}\n\n` : '') +
    (s.reason === 'exception' ? 'Find the cause and fix it.' : 'Explain what is happening here and whether anything looks wrong.');
  autoGrow();
  setMode(s.reason === 'exception' ? 'agent' : 'ask');
  $('#input').focus();
  toast('Check the message, then send it.');
}

// ---------- hover: the value of what's under the mouse, while paused

function hoverExpression(model, pos) {
  const line = model.getLineContent(pos.lineNumber);
  const word = model.getWordAtPosition(pos);
  if (!word) return null;
  // Take in a.b.c to the left of the word, so hovering c shows a.b.c.
  let start = word.startColumn - 1;
  while (start > 1 && line[start - 1] === '.' && /[\w$]/.test(line[start - 2] || '')) {
    let s = start - 1;
    while (s > 0 && /[\w$]/.test(line[s - 1])) s--;
    start = s;
  }
  return { expr: line.slice(start, word.endColumn - 1), range: new monaco.Range(pos.lineNumber, start + 1, pos.lineNumber, word.endColumn) };
}

function wireDebug() {
  editor.updateOptions({ glyphMargin: true });
  editor.onMouseDown((e) => {
    const t = activeTab();
    if (!t || t.kind !== 'file' || !e.target.position) return;
    if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) toggleBreakpoint(t.rel, e.target.position.lineNumber);
  });
  editor.onDidChangeModel(() => {
    renderBreakpointDecos();
    if (dbg.stopped) {
      const f = dbg.stopped.frames[dbg.frame];
      if (f) showLineDeco(f);
      else clearLineDeco();
    }
    if (!dbg.running) renderDebug();
  });
  editor.onDidChangeModelContent(() => {
    const m = editor.getModel();
    if (m) setTimeout(() => followEdits(m), 0);
  });
  monaco.languages.registerHoverProvider(['javascript', 'typescript', 'python'], {
    async provideHover(model, pos) {
      if (!dbg.stopped) return null;
      const e = hoverExpression(model, pos);
      if (!e || /^(const|let|var|function|return|if|else|for|while|def|class|import|from|in|of|new|await|async|True|False|None|null|undefined|true|false)$/.test(e.expr)) return null;
      const f = dbg.stopped.frames[dbg.frame];
      const r = await desk.debug.evaluate(e.expr, f ? f.id : undefined).catch(() => null);
      if (!r || r.error) return null;
      return { range: e.range, contents: [{ value: '```\n' + `${e.expr} = ${String(r.value).slice(0, 2000)}` + '\n```' }] };
    },
  });
  desk.debug.onEvent(onDebugEvent);
  // F5, F9, F10, F11 work wherever the focus is.
  addEventListener(
    'keydown',
    (e) => {
      const k = e.key;
      if (!/^F(5|9|10|11)$/.test(k)) return;
      e.preventDefault();
      e.stopPropagation();
      if (k === 'F5') return e.shiftKey ? debugCmd('stop') : e.ctrlKey || e.metaKey ? restartDebugging() : debugCmd('continue');
      if (k === 'F9') {
        const t = activeTab();
        const p = editor.getPosition();
        if (t && t.kind === 'file' && p) toggleBreakpoint(t.rel, p.lineNumber);
        return;
      }
      if (k === 'F10') return debugCmd('next');
      if (k === 'F11') return debugCmd(e.shiftKey ? 'stepOut' : 'stepIn');
    },
    true
  );
  renderDebug();
}
