/* global monaco, editor, state, toast, openDiff, activeTab */
'use strict';

// ------------------------------------------------------------------ merge conflicts in the editor
//
// A file with <<<<<<< / ======= / >>>>>>> markers gets each side coloured, and above each conflict
// Accept current, Accept incoming, Accept both and Compare, like VS Code.

function findConflicts(model) {
  const out = [];
  const n = model.getLineCount();
  let cur = null;
  for (let i = 1; i <= n; i++) {
    const line = model.getLineContent(i);
    if (/^<{7}(\s|$)/.test(line)) cur = { start: i, label: line.slice(8).trim() || 'current' };
    else if (cur && /^\|{7}(\s|$)/.test(line)) cur.base = i;
    else if (cur && /^={7}$/.test(line)) cur.mid = i;
    else if (cur && cur.mid && /^>{7}(\s|$)/.test(line)) {
      cur.end = i;
      cur.incomingLabel = line.slice(8).trim() || 'incoming';
      out.push(cur);
      cur = null;
    }
  }
  return out;
}

const linesBetween = (model, a, b) => {
  const out = [];
  for (let i = a; i <= b; i++) out.push(model.getLineContent(i));
  return out;
};
// The two sides of a conflict, as lists of lines.
const currentSide = (model, c) => (c.start + 1 <= (c.base || c.mid) - 1 ? linesBetween(model, c.start + 1, (c.base || c.mid) - 1) : []);
const incomingSide = (model, c) => (c.mid + 1 <= c.end - 1 ? linesBetween(model, c.mid + 1, c.end - 1) : []);

function acceptConflict(model, index, choice) {
  const c = findConflicts(model)[index];
  if (!c) return;
  const cur = currentSide(model, c);
  const inc = incomingSide(model, c);
  const lines = choice === 'current' ? cur : choice === 'incoming' ? inc : [...cur, ...inc];
  const last = model.getLineCount();
  // Replace the whole block, including the line break after it, with the chosen lines.
  const range = c.end < last ? new monaco.Range(c.start, 1, c.end + 1, 1) : new monaco.Range(c.start, 1, c.end, model.getLineMaxColumn(c.end));
  const eol = model.getEOL();
  const text = lines.length ? lines.join(eol) + (c.end < last ? eol : '') : '';
  model.pushEditOperations([], [{ range, text }], () => null);
  model.pushStackElement();
  if (!findConflicts(model).length) {
    const t = state.tabs.find((x) => x.model === model);
    toast(`No conflicts left${t ? ` in ${t.rel}` : ''}. Save it, then mark it resolved with ✓ in Git.`);
  }
}

function compareConflict(model, index) {
  const c = findConflicts(model)[index];
  const t = state.tabs.find((x) => x.model === model);
  if (!c || !t) return;
  openDiff({ source: 'compare', key: `conflict:${index}`, rel: t.rel, before: currentSide(model, c).join('\n'), after: incomingSide(model, c).join('\n'), title: `${t.rel} · conflict ${index + 1}: ${c.label} ↔ ${c.incomingLabel}`, hint: 'Left is the current side, right is the incoming side.' });
}

const conflictDecorations = new WeakMap(); // model -> decoration collection ids

function decorateConflicts(model) {
  if (!model || model.isDisposed()) return;
  const list = findConflicts(model);
  const decos = [];
  for (const c of list) {
    const whole = (a, b, className) => a <= b && decos.push({ range: new monaco.Range(a, 1, b, 1), options: { isWholeLine: true, className } });
    whole(c.start, c.start, 'conflict-marker current');
    whole(c.start + 1, (c.base || c.mid) - 1, 'conflict-current');
    if (c.base) whole(c.base, c.mid - 1, 'conflict-base');
    whole(c.mid, c.mid, 'conflict-marker');
    whole(c.mid + 1, c.end - 1, 'conflict-incoming');
    whole(c.end, c.end, 'conflict-marker incoming');
  }
  conflictDecorations.set(model, model.deltaDecorations(conflictDecorations.get(model) || [], decos));
}

function wireConflicts() {
  monaco.editor.registerCommand('switchdesk.conflict', (_acc, uri, index, choice) => {
    const model = monaco.editor.getModel(uri);
    if (!model) return;
    if (choice === 'compare') compareConflict(model, index);
    else acceptConflict(model, index, choice);
  });
  const changed = new monaco.Emitter();
  monaco.languages.registerCodeLensProvider('*', {
    onDidChange: changed.event,
    provideCodeLenses(model) {
      const lenses = [];
      findConflicts(model).forEach((c, i) => {
        const range = new monaco.Range(c.start, 1, c.start, 1);
        const cmd = (title, choice, tooltip) => ({ range, command: { id: 'switchdesk.conflict', title, tooltip, arguments: [model.uri, i, choice] } });
        lenses.push(cmd('Accept current', 'current', `Keep ${c.label}`), cmd('Accept incoming', 'incoming', `Keep ${c.incomingLabel}`), cmd('Accept both', 'both', 'Keep both, current first'), cmd('Compare', 'compare', 'Show the two sides side by side'));
      });
      return { lenses, dispose() {} };
    },
    resolveCodeLens: (_m, lens) => lens,
  });
  const timers = new WeakMap();
  const watch = (model) => {
    decorateConflicts(model);
    model.onDidChangeContent(() => {
      clearTimeout(timers.get(model));
      timers.set(model, setTimeout(() => (decorateConflicts(model), changed.fire()), 150));
    });
  };
  monaco.editor.getModels().forEach(watch);
  monaco.editor.onDidCreateModel(watch);
}
