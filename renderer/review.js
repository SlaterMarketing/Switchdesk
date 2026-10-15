/* global $, h, state, desk, monaco, editor, activeTab, openFile, openDiff, renderTabs, refreshGit, renderTree, toast */
'use strict';

// ------------------------------------------------------------------ inline review
//
// After a Claude turn, each changed file shows Claude's edits right in the editor: added lines in
// green, removed lines in red above them, and Keep / Undo on every change. "base" is the version
// you've accepted so far; anything that differs from it is still up for review.

const reviews = new Map(); // rel -> { base, change }
let reviewZones = [];
let reviewDecos = null;
let reviewHunks = [];
let reviewIndex = 0;
let reviewTimer = null;

function splitLines(text) {
  return text === '' ? [] : text.split(/\r?\n/);
}

// Line hunks between a and b: [{ aStart, aEnd, bStart, bEnd }], 0-based, end exclusive.
function lineHunks(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const x = a.slice(pre, a.length - suf);
  const y = b.slice(pre, b.length - suf);
  if (!x.length && !y.length) return [];
  const n = x.length;
  const m = y.length;
  if (!n || !m || (n + 1) * (m + 1) > 4e6) return [{ aStart: pre, aEnd: pre + n, bStart: pre, bEnd: pre + m }];
  // Longest common subsequence table, then walk it to find the runs that differ.
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) t[i * w + j] = x[i] === y[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
  const hunks = [];
  let i = 0;
  let j = 0;
  let open = null;
  const flush = () => {
    if (open) hunks.push({ aStart: pre + open.i, aEnd: pre + i, bStart: pre + open.j, bEnd: pre + j });
    open = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      flush();
      i++;
      j++;
    } else {
      if (!open) open = { i, j };
      if (j < m && (i >= n || t[i * w + j + 1] >= t[(i + 1) * w + j])) j++;
      else i++;
    }
  }
  flush();
  return hunks;
}

// Called when a turn ends. A file already under review keeps its older base, so changes from
// several turns stack up until you review them.
function addReviews(changes) {
  for (const c of changes) {
    if (c.binary || c.deleted) {
      reviews.delete(c.rel);
      continue;
    }
    const r = reviews.get(c.rel);
    if (r) r.change = c;
    else reviews.set(c.rel, { base: c.created ? '' : c.before, change: c });
    if (reviews.get(c.rel).base === c.after) reviews.delete(c.rel);
  }
  queueReview();
}

function dropReviews(rels) {
  for (const rel of rels) reviews.delete(rel);
  queueReview();
}

function queueReview() {
  clearTimeout(reviewTimer);
  reviewTimer = setTimeout(renderReview, 40);
}

function reviewTab() {
  const t = activeTab();
  return t && t.kind === 'file' && reviews.has(t.rel) ? t : null;
}

function renderReview() {
  if (!editor) return;
  if (!reviewDecos) reviewDecos = editor.createDecorationsCollection();
  const t = reviewTab();
  const r = t && reviews.get(t.rel);
  reviewHunks = [];
  if (r) {
    const base = splitLines(r.base);
    const cur = t.model.getLinesContent();
    if (cur.length === 1 && cur[0] === '') cur.length = 0;
    reviewHunks = lineHunks(base, cur);
    if (!reviewHunks.length) {
      reviews.delete(t.rel);
      return renderReview();
    }
    r.baseLines = base;
  }
  const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
  const decos = [];
  editor.changeViewZones((acc) => {
    for (const id of reviewZones) acc.removeZone(id);
    reviewZones = [];
    reviewHunks.forEach((hk, n) => {
      for (let line = hk.bStart + 1; line <= hk.bEnd; line++)
        decos.push({ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: 'rv-add', linesDecorationsClassName: 'rv-add-gutter' } });
      const removed = r.baseLines.slice(hk.aStart, hk.aEnd);
      const stop = (e) => e.stopPropagation();
      const zone = h(
        'div',
        { class: 'rv-zone', onmousedown: stop },
        removed.length ? h('div', { class: 'rv-del' }, ...removed.map((l) => h('div', { class: 'rv-del-line', style: `height:${lineHeight}px;line-height:${lineHeight}px` }, l || ' '))) : null,
        h(
          'div',
          { class: 'hunk-bar rv-bar' },
          h('button', { class: 'hunk-btn undo', title: 'Put this part back how it was', onmousedown: stop, onclick: () => undoReviewHunk(t, n) }, 'Undo'),
          h('button', { class: 'hunk-btn keep', title: 'Accept this part', onmousedown: stop, onclick: () => keepReviewHunk(t, n) }, 'Keep')
        )
      );
      // The removed lines sit above the new ones; the buttons follow them.
      reviewZones.push(acc.addZone({ afterLineNumber: hk.bStart, heightInPx: removed.length * lineHeight + 24, domNode: zone, suppressMouseDown: false }));
    });
  });
  reviewDecos.set(decos);
  reviewIndex = Math.min(reviewIndex, Math.max(0, reviewHunks.length - 1));
  renderReviewBar();
}

function renderReviewBar() {
  const bar = $('#review-bar');
  const t = reviewTab();
  if (!t || !reviewHunks.length) return bar.classList.add('hidden');
  const others = [...reviews.keys()].filter((rel) => rel !== t.rel);
  bar.classList.remove('hidden');
  bar.replaceChildren(
    h('span', { class: 'rv-count' }, `${reviewHunks.length} change${reviewHunks.length > 1 ? 's' : ''} from Claude`),
    h('button', { class: 'rv-nav', title: 'Previous change', onclick: () => gotoHunk(reviewIndex - 1) }, '↑'),
    h('button', { class: 'rv-nav', title: 'Next change', onclick: () => gotoHunk(reviewIndex + 1) }, '↓'),
    h('span', { class: 'sep' }),
    h('button', { class: 'btn small danger', onclick: () => undoAll(t) }, 'Undo file'),
    h('button', { class: 'btn small primary', onclick: () => keepAll(t) }, 'Keep file'),
    h('button', { class: 'btn small', title: 'Open a side-by-side diff', onclick: () => openDiff({ ...reviews.get(t.rel).change, before: reviews.get(t.rel).base, after: t.model.getValue() }) }, 'Compare'),
    ...(others.length ? [h('button', { class: 'btn small', title: others.join('\n'), onclick: () => openFile(others[0]) }, `Next file (${others.length}) →`)] : [])
  );
}

function gotoHunk(n) {
  if (!reviewHunks.length) return;
  reviewIndex = (n + reviewHunks.length) % reviewHunks.length;
  const hk = reviewHunks[reviewIndex];
  const line = Math.max(1, hk.bStart + (hk.bEnd > hk.bStart ? 1 : 0));
  editor.revealLineInCenter(line);
  editor.setPosition({ lineNumber: line, column: 1 });
}

function revealFirstChange() {
  clearTimeout(reviewTimer);
  reviewIndex = 0;
  renderReview();
  gotoHunk(0);
}

function keepReviewHunk(t, n) {
  const r = reviews.get(t.rel);
  const hk = reviewHunks[n];
  if (!r || !hk) return;
  const base = r.baseLines.slice();
  base.splice(hk.aStart, hk.aEnd - hk.aStart, ...t.model.getLinesContent().slice(hk.bStart, hk.bEnd));
  r.base = base.join('\n');
  reviewIndex = n;
  finishReviewStep(t);
}

async function undoReviewHunk(t, n) {
  const r = reviews.get(t.rel);
  const hk = reviewHunks[n];
  if (!r || !hk) return;
  const lines = t.model.getLinesContent();
  if (lines.length === 1 && lines[0] === '') lines.length = 0;
  lines.splice(hk.bStart, hk.bEnd - hk.bStart, ...r.baseLines.slice(hk.aStart, hk.aEnd));
  reviewIndex = n;
  await replaceModel(t, lines.join(t.model.getEOL()));
  finishReviewStep(t);
}

// Swaps in new text as one undoable edit, keeping the scroll position. Saves straight away unless
// the file already had unsaved edits of yours.
async function replaceModel(t, text) {
  const wasDirty = t.model.getAlternativeVersionId() !== t.savedVersion;
  const vs = editor.getModel() === t.model ? editor.saveViewState() : null;
  t.model.pushEditOperations([], [{ range: t.model.getFullModelRange(), text }], () => null);
  if (vs) editor.restoreViewState(vs);
  if (!wasDirty) await saveReviewed(t);
}

async function saveReviewed(t) {
  await desk.writeFile(t.rel, t.model.getValue());
  t.savedVersion = t.model.getAlternativeVersionId();
  t.dirty = false;
  renderTabs();
  refreshGit();
}

function keepAll(t) {
  reviews.delete(t.rel);
  finishReviewStep(t);
}

async function undoAll(t) {
  const r = reviews.get(t.rel);
  if (!r) return;
  reviews.delete(t.rel);
  await replaceModel(t, splitLines(r.base).join(t.model.getEOL()));
  finishReviewStep(t);
}

function finishReviewStep(t) {
  renderReview();
  if (!reviews.has(t.rel)) {
    state.changedFiles.delete(t.rel);
    renderTree();
    const next = reviews.keys().next().value;
    if (next) toast(`Done with ${t.rel}. ${reviews.size} more file${reviews.size > 1 ? 's' : ''} to review.`);
  }
}

function wireReview() {
  editor.onDidChangeModel(() => {
    reviewIndex = 0;
    queueReview();
  });
  editor.onDidChangeModelContent(queueReview);
  editor.onDidChangeConfiguration(queueReview);
}
