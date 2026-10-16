/* global $, h, monaco, editor, state, desk, activeTab, showFileHistory, git */
'use strict';

// ------------------------------------------------------------------ line blame
//
// Who last changed the line the cursor is on, and when, in grey at the end of the line, with the
// whole commit in the status bar. Click the status bar to see that file's history.

const blameCache = new Map(); // rel -> { at, lines }
let blameDecos = [];
let blameTimer = null;
let blameShown = null;

const blameOn = () => state.settings.blame !== false;

async function blameFor(rel) {
  const hit = blameCache.get(rel);
  if (hit && Date.now() - hit.at < 60000) return hit.lines;
  const lines = await desk.git.blame(rel).catch(() => null);
  blameCache.set(rel, { at: Date.now(), lines });
  return lines;
}

function clearBlame() {
  blameDecos = editor ? editor.deltaDecorations(blameDecos, []) : [];
  blameShown = null;
  const el = $('#status-blame');
  if (el) el.classList.add('hidden');
}

async function showBlame() {
  const t = activeTab();
  if (!blameOn() || !t || t.kind !== 'file' || t.dirty || !editor || !git.status || !git.status.repo) return clearBlame();
  const pos = editor.getPosition();
  if (!pos) return clearBlame();
  const lines = await blameFor(t.rel);
  if (activeTab() !== t || !editor.getPosition() || editor.getPosition().lineNumber !== pos.lineNumber) return;
  const b = lines && lines[pos.lineNumber - 1];
  if (!b) return clearBlame();
  const mine = /^0{40}$/.test(b.sha);
  const text = mine ? 'You · not committed yet' : `${b.author}, ${ago(b.time)} · ${b.summary}`;
  const col = t.model.getLineMaxColumn(pos.lineNumber);
  // The text goes in through a CSS variable, since there's only ever the one line showing it.
  editor.getDomNode().style.setProperty('--blame', JSON.stringify(text.length > 90 ? text.slice(0, 89) + '…' : text));
  blameDecos = editor.deltaDecorations(blameDecos, [{ range: new monaco.Range(pos.lineNumber, col, pos.lineNumber, col), options: { afterContentClassName: 'blame-after' } }]);
  blameShown = { rel: t.rel, ...b };
  const el = $('#status-blame');
  el.textContent = mine ? '' : `${b.author}, ${ago(b.time)}`;
  el.title = mine ? '' : `${b.summary}\n${b.sha.slice(0, 8)} · ${new Date(b.time).toLocaleString()}\nClick to see this file's history`;
  el.classList.toggle('hidden', mine);
}

function queueBlame() {
  clearTimeout(blameTimer);
  blameTimer = setTimeout(showBlame, 120);
}

function toggleBlame() {
  desk.setSettings({ blame: !blameOn() }).then((s) => {
    state.settings = s;
    blameOn() ? showBlame() : clearBlame();
  });
}

function wireBlame() {
  editor.onDidChangeCursorPosition(queueBlame);
  editor.onDidChangeModel(queueBlame);
  editor.onDidChangeModelContent(() => clearBlame());
  desk.onFsChanged((paths) => {
    for (const p of paths) blameCache.delete(p);
    queueBlame();
  });
  $('#status-blame').addEventListener('click', () => {
    if (!blameShown) return;
    showFileHistory(blameShown.rel, blameShown.sha);
  });
}
