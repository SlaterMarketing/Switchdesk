/* global $, h, state, desk, monaco, editor, openFile, activeTab, showSidePanel, toast, reloadOpenFiles, refreshGit, renderTree */
'use strict';

// ------------------------------------------------------------------ search across files (Ctrl+Shift+F)

const searchOpts = { caseSensitive: false, wholeWord: false, regex: false, meaning: false };
let searchTimer = null;
let searchSeq = 0;
const collapsedResults = new Set();
// Replace: matches you've dismissed ("rel:line:col") stay as they are, and the last replace can be undone.
const replaceState = { open: false, skip: new Set(), files: [], undo: null };

function openSearch() {
  showSidePanel('search');
  const input = $('#search-query');
  // Start from the editor selection, like VS Code.
  const t = activeTab();
  if (t && t.kind === 'file' && editor) {
    const sel = editor.getSelection();
    if (sel && !sel.isEmpty() && sel.startLineNumber === sel.endLineNumber) {
      input.value = t.model.getValueInRange(sel);
      runSearch();
    }
  }
  input.focus();
  input.select();
}

// Ctrl+Shift+H: search with the replace box open.
function openReplace() {
  openSearch();
  if (!replaceState.open) $('.replace-toggle').click();
  else $('#replace-with').focus();
}

function queueSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 250);
}

async function runSearch() {
  const query = $('#search-query').value;
  const summary = $('#search-summary');
  const host = $('#search-results');
  const seq = ++searchSeq;
  if (!query || !state.folder) {
    summary.textContent = '';
    host.replaceChildren();
    return;
  }
  if (searchOpts.meaning) return runMeaningSearch(query, summary, host, seq, () => searchSeq);
  summary.textContent = 'Searching…';
  const res = await desk.searchFiles(query, { ...searchOpts, include: $('#search-include').value.trim() });
  if (seq !== searchSeq || res.cancelled) return;
  if (res.error) {
    summary.textContent = res.error;
    host.replaceChildren();
    return;
  }
  const files = res.results;
  const total = files.reduce((n, f) => n + f.matches.length, 0);
  summary.textContent = total
    ? `${total}${res.truncated ? '+' : ''} result${total === 1 ? '' : 's'} in ${files.length} file${files.length === 1 ? '' : 's'}${res.truncated ? ' (showing the first 2,000)' : ''}`
    : 'No results.';
  replaceState.files = files;
  replaceState.skip = new Set([...replaceState.skip].filter((k) => files.some((f) => k.startsWith(f.rel + ':'))));
  host.replaceChildren(...files.map((f) => searchFileGroup(f)));
  renderReplaceBar();
}

function searchFileGroup(f) {
  const open = !collapsedResults.has(f.rel);
  const name = f.rel.split('/').pop();
  const dir = f.rel.includes('/') ? f.rel.slice(0, f.rel.lastIndexOf('/')) : '';
  const body = h(
    'div',
    { class: `search-matches${open ? '' : ' hidden'}` },
    ...f.matches.map((m) => {
      const key = `${f.rel}:${m.line}:${m.col}`;
      if (replaceState.skip.has(key)) return null;
      const with_ = replaceState.open ? replaceText() : null;
      const row = h(
        'div',
        { class: 'search-match', title: `${f.rel}:${m.line}`, onclick: () => revealMatch(f.rel, m) },
        h('span', { class: 'ln' }, String(m.line)),
        h('span', { class: 'txt' }, m.text.slice(0, m.offset), h('mark', { class: with_ != null ? 'old' : '' }, m.text.slice(m.offset, m.offset + m.len)), with_ != null && !searchOpts.regex ? h('mark', { class: 'new' }, with_) : null, m.text.slice(m.offset + m.len)),
        replaceState.open ? h('button', { class: 'icon-btn match-x', title: 'Leave this one as it is', onclick: (e) => (e.stopPropagation(), replaceState.skip.add(key), runSearch()) }, '✕') : null
      );
      return row;
    })
  );
  const head = h(
    'div',
    {
      class: 'search-file',
      onclick: () => {
        body.classList.toggle('hidden');
        if (body.classList.contains('hidden')) collapsedResults.add(f.rel);
        else collapsedResults.delete(f.rel);
        $('.twisty', head).textContent = body.classList.contains('hidden') ? '▸' : '▾';
      },
    },
    h('span', { class: 'twisty' }, open ? '▾' : '▸'),
    h('span', { class: 'name' }, name),
    h('span', { class: 'dir' }, dir),
    h('span', { class: 'spacer' }),
    replaceState.open ? h('button', { class: 'icon-btn', title: `Replace in ${name}`, onclick: (e) => (e.stopPropagation(), doReplace([f.rel])) }, '⇄') : null,
    h('span', { class: 'count' }, String(f.matches.filter((m) => !replaceState.skip.has(`${f.rel}:${m.line}:${m.col}`)).length))
  );
  return h('div', {}, head, body);
}

async function revealMatch(rel, m) {
  await openFile(rel, m.line);
  const t = activeTab();
  if (!t || t.kind !== 'file' || t.rel !== rel) return;
  const range = new monaco.Range(m.line, m.col, m.line, m.col + m.len);
  editor.setSelection(range);
  editor.revealRangeInCenter(range);
}

const replaceText = () => ($('#replace-with') ? $('#replace-with').value : '');
const liveCount = () => replaceState.files.reduce((n, f) => n + f.matches.filter((m) => !replaceState.skip.has(`${f.rel}:${m.line}:${m.col}`)).length, 0);

function renderReplaceBar() {
  const btn = $('#replace-all');
  if (!btn) return;
  const n = liveCount();
  btn.disabled = !n;
  btn.textContent = n ? `Replace ${n}` : 'Replace all';
  $('#replace-undo').classList.toggle('hidden', !replaceState.undo);
}

async function doReplace(rels) {
  const query = $('#search-query').value;
  if (!query || !rels.length) return;
  // Files open with unsaved edits are left alone, so nothing you typed is lost.
  const dirty = new Set(state.tabs.filter((t) => t.kind === 'file' && t.dirty).map((t) => t.rel));
  const skipped = rels.filter((r) => dirty.has(r));
  rels = rels.filter((r) => !dirty.has(r));
  if (!rels.length) return toast(`Save ${skipped.join(', ')} first, then replace.`);
  const res = await desk.replaceInFiles(rels, query, replaceText(), { ...searchOpts, skip: [...replaceState.skip] });
  if (res.error) return toast(res.error);
  const n = res.files.reduce((a, f) => a + f.count, 0);
  replaceState.undo = res.files.map((f) => ({ rel: f.rel, before: f.before, after: f.after }));
  await reloadOpenFiles(res.files.map((f) => f.rel));
  refreshGit();
  renderTree();
  toast(`Replaced ${n} match${n === 1 ? '' : 'es'} in ${res.files.length} file${res.files.length === 1 ? '' : 's'}.${skipped.length ? ` Skipped ${skipped.join(', ')}: it has unsaved changes.` : ''}`);
  runSearch();
}

async function undoReplace() {
  const list = replaceState.undo;
  if (!list) return;
  replaceState.undo = null;
  let changed = 0;
  for (const f of list) {
    // Only put a file back if nothing else has changed it since.
    const now = await desk.readFile(f.rel).catch(() => null);
    if (!now || now.content !== f.after) continue;
    await desk.writeFile(f.rel, f.before);
    changed++;
  }
  await reloadOpenFiles(list.map((f) => f.rel));
  refreshGit();
  toast(changed === list.length ? 'Undid the replace.' : `Undid the replace in ${changed} of ${list.length} files; the others changed since.`);
  runSearch();
}

function wireSearch() {
  const panel = $('#panel-search');
  const toggle = (key, label, title) => {
    const b = h('button', { class: `opt-btn${searchOpts[key] ? ' on' : ''}`, title }, label);
    b.addEventListener('click', () => {
      searchOpts[key] = !searchOpts[key];
      b.classList.toggle('on', searchOpts[key]);
      runSearch();
    });
    return b;
  };
  const query = h('input', { id: 'search-query', placeholder: 'Search', spellcheck: 'false' });
  const include = h('input', { id: 'search-include', placeholder: 'Files to include, e.g. *.ts, src/', spellcheck: 'false' });
  query.addEventListener('input', queueSearch);
  include.addEventListener('input', queueSearch);
  query.addEventListener('keydown', (e) => e.key === 'Enter' && runSearch());
  const replaceInput = h('input', { id: 'replace-with', placeholder: 'Replace', spellcheck: 'false' });
  replaceInput.addEventListener('input', queueSearch);
  replaceInput.addEventListener('keydown', (e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && doReplace(replaceState.files.map((f) => f.rel)));
  const replaceRow = h(
    'div',
    { class: `search-row replace-row${replaceState.open ? '' : ' hidden'}` },
    replaceInput,
    h('button', { id: 'replace-all', class: 'btn small', title: 'Replace every match shown (Ctrl+Enter)', onclick: () => doReplace(replaceState.files.map((f) => f.rel)) }, 'Replace all'),
    h('button', { id: 'replace-undo', class: 'btn small hidden', title: 'Put the files back how they were', onclick: undoReplace }, 'Undo')
  );
  const twist = h(
    'button',
    {
      class: 'icon-btn replace-toggle',
      title: 'Replace',
      onclick: () => {
        replaceState.open = !replaceState.open;
        replaceRow.classList.toggle('hidden', !replaceState.open);
        twist.textContent = replaceState.open ? '▾' : '▸';
        if (replaceState.open) replaceInput.focus();
        runSearch();
      },
    },
    '▸'
  );
  panel.replaceChildren(
    h(
      'div',
      { class: 'search-box' },
      h('div', { class: 'search-row' }, twist, query, toggle('caseSensitive', 'Aa', 'Match case'), toggle('wholeWord', 'ab', 'Match whole word'), toggle('regex', '.*', 'Use regular expression'), toggle('meaning', '≈', 'Search by meaning: find code by what it does')),
      replaceRow,
      include,
      h('div', { id: 'search-summary', class: 'muted small' })
    ),
    h('div', { id: 'search-results' })
  );
}
