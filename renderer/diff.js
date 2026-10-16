/* global $, h, state, desk, monaco, diffEditor, toast, activeTab, activateTab, closeTab, languageFor, reloadOpenFiles, refreshGit, changeCards */
'use strict';

// ------------------------------------------------------------------ diff review
//
// A diff tab shows one file before and after a Claude turn (or HEAD vs. disk for the git panel).
// Every hunk gets its own Undo / Keep buttons; Undo writes the file straight away.

function openDiff(change) {
  const source = change.source || 'claude';
  const id = `d:${source === 'git' ? 'git' : source === 'worktree' ? 'wt:' + change.turnId : source === 'compare' ? 'cmp:' + (change.key || '') : change.turnId}:${change.rel}`;
  let t = state.tabs.find((x) => x.id === id);
  if (t && (source === 'git' || source === 'worktree' || source === 'compare')) {
    // Git diffs always show the current state, so rebuild them.
    t.original.setValue(change.before);
    t.modified.setValue(change.after);
    t.change = change;
    t.kept = false;
  }
  if (!t) {
    const lang = languageFor(change.rel);
    t = {
      id,
      kind: 'diff',
      rel: change.rel,
      change,
      kept: false,
      original: monaco.editor.createModel(change.before, lang),
      modified: monaco.editor.createModel(change.after, lang),
    };
    state.tabs.push(t);
  }
  activateTab(t.id);
}

function renderDiffBar(t) {
  const git = t.change.source === 'git';
  // Read-only comparisons: a commit's change, or two files side by side.
  if (t.change.source === 'compare') {
    $('#diff-title').textContent = t.change.title || t.rel;
    $('#diff-hint').textContent = t.change.hint || '';
    $('#diff-undo').classList.add('hidden');
    $('#diff-keep').textContent = 'Close';
    queueHunkWidgets();
    return;
  }
  if (t.change.source === 'worktree') {
    // Read-only: the copy's changes come into your folder through Merge in the chat.
    $('#diff-title').textContent = `${t.rel} · in Claude's copy`;
    $('#diff-hint').textContent = 'Use Merge in the chat to bring this into your folder.';
    $('#diff-undo').classList.add('hidden');
    $('#diff-keep').textContent = 'Close';
    queueHunkWidgets();
    return;
  }
  $('#diff-undo').classList.remove('hidden');
  $('#diff-title').textContent = `${t.rel} · ${git ? 'uncommitted changes' : 'changes from Claude'}`;
  $('#diff-hint').textContent = git ? '' : 'Each change has its own Undo and Keep.';
  $('#diff-undo').textContent = git ? 'Discard file' : 'Undo this file';
  $('#diff-keep').textContent = git ? 'Close' : 'Keep all';
  const undone = !!t.change.undone;
  $('#diff-undo').disabled = undone;
  $('#diff-keep').disabled = false;
  queueHunkWidgets();
}

// Replaces lines start..end (1-based, inclusive) with newLines. end === 0 means "insert after line start".
function spliceLines(model, start, end, newLines) {
  const lines = model.getLinesContent();
  if (end === 0) lines.splice(start, 0, ...newLines);
  else lines.splice(start - 1, end - start + 1, ...newLines);
  model.setValue(lines.join(model.getEOL()));
}

function linesOf(model, start, end) {
  if (end === 0) return [];
  const out = [];
  for (let i = start; i <= end; i++) out.push(model.getLineContent(i));
  return out;
}

async function diskMatches(t) {
  try {
    const res = await desk.readFile(t.rel);
    return res.content === t.modified.getValue();
  } catch {
    return t.modified.getValue() === '' && !!t.change.deleted;
  }
}

async function revertHunk(t, c) {
  if (!(await diskMatches(t))) return toast(`${t.rel} has changed since this diff was opened. Close the tab and review it again.`);
  spliceLines(t.modified, c.modifiedStartLineNumber, c.modifiedEndLineNumber, linesOf(t.original, c.originalStartLineNumber, c.originalEndLineNumber));
  await writeModified(t);
}

function keepHunk(t, c) {
  spliceLines(t.original, c.originalStartLineNumber, c.originalEndLineNumber, linesOf(t.modified, c.modifiedStartLineNumber, c.modifiedEndLineNumber));
  t.kept = true;
}

async function writeModified(t) {
  const value = t.modified.getValue();
  await desk.writeFile(t.rel, value);
  t.change.after = value;
  if (value === t.original.getValue() && !t.kept && t.change.source !== 'git') markUndone(t.change);
  await reloadOpenFiles([t.rel]);
  refreshGit();
}

function markUndone(change) {
  change.undone = true;
  if (change.row) {
    change.row.classList.add('undone');
    const b = $('button', change.row);
    if (b) b.disabled = true;
  }
  state.changedFiles.delete(change.rel);
}

let hunkZones = [];
let hunkTimer = null;
function queueHunkWidgets() {
  clearTimeout(hunkTimer);
  hunkTimer = setTimeout(renderHunkWidgets, 30);
}

function renderHunkWidgets() {
  const ed = diffEditor.getModifiedEditor();
  const t = activeTab();
  ed.changeViewZones((acc) => {
    for (const id of hunkZones) acc.removeZone(id);
    hunkZones = [];
    if (!t || t.kind !== 'diff' || t.change.undone || t.change.source === 'worktree' || t.change.source === 'compare') return;
    const git = t.change.source === 'git';
    for (const c of diffEditor.getLineChanges() || []) {
      const after = c.modifiedEndLineNumber === 0 ? c.modifiedStartLineNumber : c.modifiedStartLineNumber - 1;
      const stop = (e) => e.stopPropagation();
      const bar = h(
        'div',
        { class: 'hunk-bar', onmousedown: stop },
        h('button', { class: 'hunk-btn undo', title: 'Put this part back how it was', onmousedown: stop, onclick: () => revertHunk(t, c) }, git ? 'Revert' : 'Undo'),
        git ? null : h('button', { class: 'hunk-btn keep', title: 'Accept this part', onmousedown: stop, onclick: () => keepHunk(t, c) }, 'Keep')
      );
      hunkZones.push(acc.addZone({ afterLineNumber: after, heightInPx: 24, domNode: bar, suppressMouseDown: false }));
    }
  });
  if (t && t.kind === 'diff' && !t.change.undone && !(diffEditor.getLineChanges() || []).length && t.kept) $('#diff-hint').textContent = 'Every change reviewed.';
}

function wireDiff() {
  diffEditor.updateOptions({ ignoreTrimWhitespace: false, renderMarginRevertIcon: false });
  diffEditor.onDidUpdateDiff(queueHunkWidgets);

  $('#diff-keep').addEventListener('click', () => {
    const t = activeTab();
    if (t && t.kind === 'diff') closeTab(t.id);
  });
  $('#diff-undo').addEventListener('click', async () => {
    const t = activeTab();
    if (!t || t.kind !== 'diff') return;
    if (t.change.source === 'git') {
      if (!confirm(`Discard all uncommitted changes to ${t.rel}? This can't be undone.`)) return;
      await desk.git.discard(t.rel, t.change.untracked);
      await reloadOpenFiles([t.rel]);
      refreshGit();
      return closeTab(t.id);
    }
    if (t.kept) {
      // Some parts were kept, so only put back what's still showing as changed.
      if (!(await diskMatches(t))) return toast(`${t.rel} has changed since this diff was opened.`);
      t.modified.setValue(t.original.getValue());
      await writeModified(t);
      return closeTab(t.id);
    }
    const card = changeCards.get(t.change.turnId);
    if (card) await card.undo([t.change]);
    closeTab(t.id);
  });
}
