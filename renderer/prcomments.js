/* global $, h, state, desk, monaco, editor, diffEditor, toast, git, gh, activeTab, openDiff, renderMarkdown, ago, cleanErr, fixPr, refreshPrTab */
'use strict';

// ------------------------------------------------------------------ pull request comments in the editor
//
// A pull request's files open from its tab as a diff of what it changes, with its review comments
// under the lines they're on. Reply to one or hand it to the agent from there, or comment on any
// line yourself. Files you open while your folder is on a pull request's branch show its comments too.

const prCache = new Map(); // number -> { at, data }
const commentZones = new Map(); // editor -> [{ id, zone, node }]
let editorPrTimer = null;

function cachePr(p) {
  prCache.set(p.number, { at: Date.now(), data: p });
}

async function prData(n, fresh) {
  const hit = prCache.get(n);
  if (hit && !fresh && Date.now() - hit.at < 60e3) return hit.data;
  const p = await desk.github.pr(n);
  cachePr(p);
  return p;
}

// One of the pull request's files, as a diff from where its branch started to its latest commit.
async function openPrFile(p, f) {
  try {
    const [before, after] = await Promise.all([f.status === 'added' ? '' : desk.github.fileAt(f.from || f.path, p.mergeBase || p.base), f.status === 'removed' ? '' : desk.github.fileAt(f.path, p.headSha)]);
    cachePr(p);
    openDiff({ source: 'pr', key: String(p.number), pr: p.number, rel: f.path, before: before || '', after: after || '', title: `${f.path} · PR #${p.number}` });
  } catch (e) {
    toast(`Couldn't open ${f.path}: ${cleanErr(e)}`);
  }
}

// ------------------------------------------------------------------ the comments, as view zones

// Puts each node under its line. The editor needs each zone's height up front, so it's measured first.
function setCommentZones(ed, items) {
  const width = Math.max(200, ed.getLayoutInfo().contentWidth - 40);
  const measure = h('div', { class: 'pr-zone-measure', style: `width:${width}px` });
  document.body.append(measure);
  ed.changeViewZones((acc) => {
    for (const z of commentZones.get(ed) || []) acc.removeZone(z.id);
    const list = [];
    for (const it of items) {
      measure.append(it.node);
      const zone = { afterLineNumber: it.after, heightInPx: it.node.offsetHeight + 12, domNode: h('div', { class: 'pr-zone' }), suppressMouseDown: false };
      zone.domNode.append(it.node);
      // Keep the editor from taking clicks and keys meant for the comment.
      for (const type of ['mousedown', 'keydown', 'keypress', 'keyup', 'wheel']) zone.domNode.addEventListener(type, (e) => e.stopPropagation());
      const z = { zone, node: it.node };
      z.id = acc.addZone(zone);
      it.node.relayout = () => relayoutZone(ed, z);
      list.push(z);
    }
    commentZones.set(ed, list);
  });
  measure.remove();
}

function relayoutZone(ed, z) {
  const height = z.node.offsetHeight + 12;
  if (Math.abs(height - z.zone.heightInPx) < 2) return;
  z.zone.heightInPx = height;
  ed.changeViewZones((acc) => acc.layoutZone(z.id));
}

const clearCommentZones = (ed) => setCommentZones(ed, []);

// The zones for one file of one pull request: its threads, and the comment you're writing.
// view: { ed, n, path, draftLine, render }
function renderCommentsIn(view, p) {
  const threads = p.threads.filter((th) => th.path === view.path && th.line && !th.outdated);
  const max = view.ed.getModel() ? view.ed.getModel().getLineCount() : 0;
  const items = threads.filter((th) => th.line <= max).map((th) => ({ after: th.line, node: threadCard(view, p, th) }));
  if (view.draftLine) items.push({ after: view.draftLine, node: draftCard(view, p) });
  setCommentZones(view.ed, items);
}

function threadCard(view, p, th) {
  const md = (text) => {
    const el = h('div', { class: 'msg-text' });
    renderMarkdown(el, text || '');
    return el;
  };
  const box = h('textarea', { rows: 2, class: 'hidden', placeholder: 'Reply on GitHub' });
  const send = h('button', { class: 'btn small primary hidden' }, 'Send reply');
  const card = h(
    'div',
    { class: 'pr-inline-thread' },
    ...th.replies.map((r) => h('div', { class: 'pr-comment' }, h('div', { class: 'muted small' }, `${r.author} · ${ago(new Date(r.at).getTime())}`), md(r.body))),
    box,
    h(
      'div',
      { class: 'actions' },
      h('span', { class: 'muted small' }, `PR #${p.number}`),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', onclick: () => (box.classList.remove('hidden'), send.classList.remove('hidden'), box.focus(), card.relayout && card.relayout()) }, 'Reply'),
      send,
      h('button', { class: 'btn small', onclick: () => fixPr(p, [{ kind: 'comment', thread: th }]) }, 'Fix with the agent')
    )
  );
  box.addEventListener('input', () => card.relayout && card.relayout());
  send.addEventListener('click', async () => {
    if (!box.value.trim()) return box.focus();
    send.disabled = true;
    try {
      await desk.github.reply(p.number, th.id, box.value.trim());
      await afterPost(view, p.number);
    } catch (e) {
      send.disabled = false;
      toast(cleanErr(e));
    }
  });
  return card;
}

function draftCard(view, p) {
  const box = h('textarea', { rows: 3, placeholder: `Comment on line ${view.draftLine} in PR #${p.number}` });
  const go = h('button', { class: 'btn small primary' }, 'Comment');
  const card = h('div', { class: 'pr-inline-thread draft' }, h('div', { class: 'muted small' }, `New comment on line ${view.draftLine}`), box, h('div', { class: 'actions' }, h('span', { class: 'spacer' }), h('button', { class: 'btn small', onclick: () => ((view.draftLine = 0), view.render()) }, 'Cancel'), go));
  box.addEventListener('input', () => card.relayout && card.relayout());
  go.addEventListener('click', async () => {
    if (!box.value.trim()) return box.focus();
    go.disabled = true;
    go.textContent = 'Posting…';
    try {
      await desk.github.comment(p.number, { sha: p.headSha, path: view.path, line: view.draftLine, body: box.value.trim() });
      view.draftLine = 0;
      await afterPost(view, p.number);
    } catch (e) {
      go.disabled = false;
      go.textContent = 'Comment';
      toast(`Couldn't post the comment: ${cleanErr(e)}`);
    }
  });
  setTimeout(() => box.focus(), 0);
  return card;
}

async function afterPost(view, n) {
  await prData(n, true).catch(() => null);
  view.render();
  refreshPrTab(n);
}

// ------------------------------------------------------------------ in a pull request's diff tab

function prDiffView(t) {
  t.prView ||= { ed: diffEditor.getModifiedEditor(), n: t.change.pr, path: t.rel, draftLine: 0, render: () => activeTab() === t && renderPrDiffComments(t) };
  return t.prView;
}

// Called whenever a diff tab's widgets are drawn: the comments for a pull request's file, else none.
function prDiffComments(t) {
  const on = !!(t && t.kind === 'diff' && t.change.source === 'pr');
  if (prDiffKey) prDiffKey.set(on);
  if (on) renderPrDiffComments(t);
  else if ((commentZones.get(diffEditor.getModifiedEditor()) || []).length) clearCommentZones(diffEditor.getModifiedEditor());
}

async function renderPrDiffComments(t) {
  const view = prDiffView(t);
  const p = await prData(view.n).catch(() => null);
  if (activeTab() !== t) return;
  if (!p) return clearCommentZones(view.ed);
  renderCommentsIn(view, p);
}

function commentOnDiffLine() {
  const t = activeTab();
  if (!t || t.kind !== 'diff' || t.change.source !== 'pr') return;
  const view = prDiffView(t);
  const pos = view.ed.getPosition();
  view.draftLine = pos ? pos.lineNumber : 1;
  view.render();
  view.ed.revealLineInCenterIfOutsideViewport(view.draftLine);
}

// ------------------------------------------------------------------ in your own files
//
// When your folder is on a pull request's branch, a file it touches shows that pull request's
// comments. You can comment on a line too, as long as the file here is what's on GitHub.

const editorView = { ed: null, n: 0, path: '', draftLine: 0, render: () => showEditorComments() };

function branchPr() {
  const branch = git.status && git.status.branch;
  return branch && (gh.prs || []).find((p) => p.head === branch);
}

function queueEditorComments() {
  clearTimeout(editorPrTimer);
  editorPrTimer = setTimeout(showEditorComments, 150);
}

async function showEditorComments() {
  if (!editor) return;
  editorView.ed = editor;
  const t = activeTab();
  const listed = t && t.kind === 'file' && branchPr();
  if (!listed) {
    prFileKey && prFileKey.set(false);
    return clearCommentZones(editor);
  }
  const p = await prData(listed.number).catch(() => null);
  if (activeTab() !== t) return;
  const inPr = p && p.files.some((f) => f.path === t.rel);
  prFileKey && prFileKey.set(!!inPr);
  if (!inPr) return clearCommentZones(editor);
  if (editorView.path !== t.rel || editorView.n !== p.number) editorView.draftLine = 0;
  editorView.n = p.number;
  editorView.path = t.rel;
  renderCommentsIn(editorView, p);
}

function commentOnEditorLine() {
  const t = activeTab();
  if (!t || t.kind !== 'file' || editorView.path !== t.rel) return;
  const changed = t.dirty || (git.status && (git.status.ahead > 0 || (git.status.files || []).some((f) => f.rel === t.rel)));
  if (changed) return toast(`${t.rel} has changes that aren't on PR #${editorView.n} yet, so its lines may not match. Comment from the file in the pull request's tab instead.`);
  editorView.draftLine = editor.getPosition().lineNumber;
  showEditorComments();
}

let prFileKey = null;
let prDiffKey = null;

function wirePrComments() {
  prFileKey = editor.createContextKey('switchdeskPrFile', false);
  editor.addAction({ id: 'switchdesk.prComment', label: 'Comment on this line in the pull request', contextMenuGroupId: 'navigation', contextMenuOrder: 0.5, precondition: 'switchdeskPrFile', run: commentOnEditorLine });
  prDiffKey = diffEditor.getModifiedEditor().createContextKey('switchdeskPrDiff', false);
  diffEditor.getModifiedEditor().addAction({ id: 'switchdesk.prDiffComment', label: 'Comment on this line in the pull request', contextMenuGroupId: 'navigation', contextMenuOrder: 0.5, precondition: 'switchdeskPrDiff', run: commentOnDiffLine });
  editor.onDidChangeModel(queueEditorComments);
  $('#diff-comment').addEventListener('click', commentOnDiffLine);
}
