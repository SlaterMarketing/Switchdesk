/* global $, h, state, desk, monaco, editor, openFile, activeTab, showSidePanel */
'use strict';

// ------------------------------------------------------------------ search across files (Ctrl+Shift+F)

const searchOpts = { caseSensitive: false, wholeWord: false, regex: false };
let searchTimer = null;
let searchSeq = 0;
const collapsedResults = new Set();

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
  host.replaceChildren(...files.map((f) => searchFileGroup(f)));
}

function searchFileGroup(f) {
  const open = !collapsedResults.has(f.rel);
  const name = f.rel.split('/').pop();
  const dir = f.rel.includes('/') ? f.rel.slice(0, f.rel.lastIndexOf('/')) : '';
  const body = h(
    'div',
    { class: `search-matches${open ? '' : ' hidden'}` },
    ...f.matches.map((m) =>
      h(
        'div',
        { class: 'search-match', title: `${f.rel}:${m.line}`, onclick: () => revealMatch(f.rel, m) },
        h('span', { class: 'ln' }, String(m.line)),
        h('span', { class: 'txt' }, m.text.slice(0, m.offset), h('mark', {}, m.text.slice(m.offset, m.offset + m.len)), m.text.slice(m.offset + m.len))
      )
    )
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
    h('span', { class: 'count' }, String(f.matches.length))
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
  panel.replaceChildren(
    h(
      'div',
      { class: 'search-box' },
      h('div', { class: 'search-row' }, query, toggle('caseSensitive', 'Aa', 'Match case'), toggle('wholeWord', 'ab', 'Match whole word'), toggle('regex', '.*', 'Use regular expression')),
      include,
      h('div', { id: 'search-summary', class: 'muted small' })
    ),
    h('div', { id: 'search-results' })
  );
}
