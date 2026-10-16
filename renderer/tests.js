/* global h, monaco, state, desk, toast, send, modal, saveActive */
'use strict';

// ------------------------------------------------------------------ run tests from the editor
//
// Test files get ▶ Run above each test (and above the first line, for the whole file): Vitest, Jest,
// Mocha or Node's own runner for JavaScript and TypeScript, pytest or unittest for Python. The result
// goes on the line, and a failure has ✨ Fix with the agent, which hands the output to the chat.

const testResults = new Map(); // `${rel}::${name}` -> { state: 'running'|'passed'|'failed', output, ms, command }
let testsChanged = null; // a monaco.Emitter, once the editor has loaded

const isTestFile = (rel) => /(^|\/)(test_[^/]*\.py|[^/]*_test\.py|[^/]*[._-](test|spec)\.[cm]?[jt]sx?)$/.test(rel) || /(^|\/)(__tests__|tests?)\/[^/]+\.([cm]?[jt]sx?|py)$/.test(rel);

// [{ line, name, cls?, kind: 'test'|'suite' }] for a test file.
function findTests(model, rel) {
  const out = [];
  const py = rel.endsWith('.py');
  let cls = null;
  for (let i = 1; i <= model.getLineCount(); i++) {
    const text = model.getLineContent(i);
    if (py) {
      const c = /^class\s+(\w+)/.exec(text);
      if (c) cls = /^Test|Test$|Tests$/.test(c[1]) ? c[1] : null;
      else if (/^\S/.test(text) && !/^(@|def |async def |#)/.test(text)) cls = null;
      const d = /^(\s*)(?:async\s+)?def\s+(test\w*)\s*\(/.exec(text);
      if (d) out.push({ line: i, name: d[2], cls: d[1] ? cls : null, kind: 'test' });
      if (c && cls) out.push({ line: i, name: null, cls, kind: 'suite' });
    } else {
      const m = /^\s*(describe|it|test)(?:\.(?:only|concurrent|sequential))?\s*\(\s*(['"`])((?:\\.|(?!\2).)*)\2/.exec(text);
      if (m && !m[3].includes('${')) out.push({ line: i, name: m[3].replace(/\\(.)/g, '$1'), kind: m[1] === 'describe' ? 'suite' : 'test' });
    }
  }
  return out;
}

const resultKey = (rel, t) => `${rel}::${t ? `${t.cls || ''}::${t.name || ''}` : '*'}`;

async function runTest(rel, t) {
  const key = resultKey(rel, t);
  const tab = state.tabs.find((x) => x.kind === 'file' && x.rel === rel);
  if (tab && tab.dirty) await saveActive(tab);
  testResults.set(key, { state: 'running' });
  testsChanged.fire();
  try {
    const r = await desk.tests.run({ rel, name: t ? t.name : null, cls: t ? t.cls : null, key });
    testResults.set(key, { state: r.passed ? 'passed' : 'failed', output: r.output, ms: r.ms, command: r.command, none: r.none });
    if (!r.passed && r.none) toast(`${r.runner} didn't find ${t && t.name ? `"${t.name}"` : 'any tests'} to run.`);
  } catch (e) {
    testResults.set(key, { state: 'failed', output: String(e.message || e), ms: 0, command: '' });
  }
  testsChanged.fire();
}

function showTestOutput(rel, t) {
  const r = testResults.get(resultKey(rel, t));
  if (!r) return;
  const close = modal([
    h('div', { class: 'body' }, h('h3', {}, `${r.state === 'passed' ? '✓' : '✗'} ${t && t.name ? t.name : rel.split('/').pop()}`), h('div', { class: 'muted small' }, r.command), h('pre', { class: 'test-output' }, r.output.trim() || '(no output)')),
    h('div', { class: 'foot' }, r.state === 'failed' ? h('button', { class: 'btn primary', onclick: () => (close(), fixTest(rel, t)) }, '✨ Fix with the agent') : null, h('button', { class: 'btn', onclick: () => close() }, 'Close')),
  ]);
}

function fixTest(rel, t) {
  const r = testResults.get(resultKey(rel, t));
  if (!r) return;
  const out = r.output.trim().split('\n').slice(-150).join('\n');
  const what = t && t.name ? `The test "${t.name}"${t.cls ? ` (in ${t.cls})` : ''} in @${rel}` : `The tests in @${rel}`;
  const mode = ['ask', 'plan'].includes(state.mode) ? 'agent' : undefined;
  send(`${what} failed. I ran \`${r.command}\`:\n\n\`\`\`\n${out}\n\`\`\`\n\nWork out whether the code or the test is wrong, and fix it. Then run the test again to check.`, mode, `✨ Fix the failing test ${t && t.name ? `"${t.name}"` : rel.split('/').pop()}`);
}

function lensTitle(r) {
  if (!r) return null;
  if (r.state === 'running') return '⏳ Running…';
  const secs = r.ms >= 1000 ? `${(r.ms / 1000).toFixed(1)}s` : `${r.ms}ms`;
  return r.state === 'passed' ? `✓ Passed · ${secs}` : r.none ? '✗ Not found' : `✗ Failed · ${secs}`;
}

function wireTests() {
  testsChanged = new monaco.Emitter();
  monaco.editor.registerCommand('switchdesk.test', (_acc, rel, t, what) => {
    if (what === 'run') runTest(rel, t);
    else if (what === 'output') showTestOutput(rel, t);
    else if (what === 'fix') fixTest(rel, t);
  });
  monaco.languages.registerCodeLensProvider('*', {
    onDidChange: testsChanged.event,
    provideCodeLenses(model) {
      const tab = state.tabs.find((x) => x.kind === 'file' && x.model === model);
      if (!tab || !isTestFile(tab.rel)) return { lenses: [], dispose() {} };
      const rel = tab.rel;
      const list = findTests(model, rel);
      if (!list.length) return { lenses: [], dispose() {} };
      const lenses = [];
      const at = (line, title, t, what, tooltip) => lenses.push({ range: new monaco.Range(line, 1, line, 1), command: { id: 'switchdesk.test', title, tooltip, arguments: [rel, t, what] } });
      const add = (line, t, label) => {
        const r = testResults.get(resultKey(rel, t));
        at(line, r && r.state === 'running' ? '⏳ Running…' : label, t, 'run', 'Run in the background; the result shows here');
        const title = lensTitle(r);
        if (title && r.state !== 'running') at(line, title, t, 'output', 'Show the output');
        if (r && r.state === 'failed') at(line, '✨ Fix with the agent', t, 'fix', 'Send the failure to the chat');
      };
      add(1, null, '▶ Run all tests in this file');
      for (const t of list) {
        if (t.kind === 'suite' && !(t.cls && rel.endsWith('.py'))) add(t.line, { name: t.name, kind: 'suite' }, '▶ Run these tests');
        else if (t.kind === 'suite') add(t.line, { name: null, cls: t.cls }, '▶ Run class');
        else add(t.line, { name: t.name, cls: t.cls }, '▶ Run test');
      }
      return { lenses, dispose() {} };
    },
    resolveCodeLens: (_m, lens) => lens,
  });
  const timers = new WeakMap();
  monaco.editor.onDidCreateModel((model) =>
    model.onDidChangeContent(() => {
      clearTimeout(timers.get(model));
      timers.set(model, setTimeout(() => testsChanged.fire(), 400));
    })
  );
}
