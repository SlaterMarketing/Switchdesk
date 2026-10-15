/* global $, h, state, desk, toast, openDiff, openFile, reloadOpenFiles, refreshFiles, showSidePanel, modal */
'use strict';

// ------------------------------------------------------------------ source control panel

const git = { status: null, busy: false, message: '' };
const STATUS_LABEL = { M: 'Modified', A: 'Added', D: 'Deleted', U: 'New file' };

const cleanErr = (e) => String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

let gitRefreshing = null;
async function refreshGit() {
  if (!state.folder) return;
  if (gitRefreshing) return gitRefreshing;
  gitRefreshing = (async () => {
    try {
      git.status = await desk.git.status();
    } catch {
      git.status = { repo: false };
    }
    renderGit();
  })();
  try {
    await gitRefreshing;
  } finally {
    gitRefreshing = null;
  }
}

async function gitAction(label, fn) {
  if (git.busy) return;
  git.busy = label;
  renderGit();
  try {
    return await fn();
  } catch (e) {
    toast(cleanErr(e).split('\n').slice(0, 4).join('\n'));
  } finally {
    git.busy = false;
    await refreshGit();
  }
}

function renderStatusBranch() {
  const el = $('#status-branch');
  const s = git.status;
  if (!s || !s.repo) return el.classList.add('hidden');
  el.classList.remove('hidden');
  el.textContent = `⎇ ${s.branch || 'no branch'}${s.ahead ? ` ↑${s.ahead}` : ''}${s.behind ? ` ↓${s.behind}` : ''}${s.files.length ? ` · ${s.files.length} changed` : ''}`;
  const count = $('#git-count');
  count.textContent = String(s.files.length);
  count.classList.toggle('hidden', !s.files.length);
}

function renderGit() {
  const panel = $('#panel-git');
  const s = git.status;
  renderStatusBranch();
  if (!s) return panel.replaceChildren();
  if (!s.repo) {
    $('#git-count').classList.add('hidden');
    return panel.replaceChildren(
      h(
        'div',
        { class: 'git-empty' },
        h('p', {}, "This folder isn't a git repository yet."),
        h('p', { class: 'muted small' }, 'Git keeps a history of your changes so you can always go back.'),
        h('button', { class: 'btn small primary', onclick: () => gitAction('init', () => desk.git.init()) }, 'Start tracking with git')
      )
    );
  }

  // Branch row
  const branchSel = h(
    'select',
    {
      class: 'git-branch',
      title: 'Switch branch',
      disabled: !!git.busy,
      onchange: (e) => {
        const v = e.target.value;
        if (v === '__new') {
          e.target.value = s.branch;
          return newBranch();
        }
        gitAction('checkout', () => desk.git.checkout(v, false));
      },
    },
    ...(s.branches.length ? s.branches : [s.branch]).map((b) => h('option', { value: b, selected: b === s.branch }, b)),
    h('option', { value: '__new' }, '+ New branch…')
  );
  const syncBtns = s.hasRemote
    ? [
        h('button', { class: 'icon-btn', title: `Pull${s.behind ? ` (${s.behind} new)` : ''}`, disabled: !!git.busy, onclick: () => gitAction('pull', () => desk.git.sync('pull')) }, `↓${s.behind || ''}`),
        h('button', { class: 'icon-btn', title: `Push${s.ahead ? ` (${s.ahead} to send)` : ''}`, disabled: !!git.busy, onclick: () => gitAction('push', () => desk.git.sync('push')) }, `↑${s.ahead || ''}`),
      ]
    : [];

  // Commit box
  const msg = h('textarea', { class: 'git-msg', rows: 3, placeholder: s.files.length ? 'Commit message' : 'Nothing to commit', spellcheck: 'false' });
  msg.value = git.message;
  msg.addEventListener('input', () => (git.message = msg.value));
  msg.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commit();
  });
  const suggest = h(
    'button',
    {
      class: 'btn small',
      title: 'Ask Claude (Haiku) to write the message',
      disabled: !s.files.length || !!git.busy,
      onclick: () =>
        gitAction('suggest', async () => {
          const m = await desk.git.suggest();
          if (m) git.message = m;
        }),
    },
    git.busy === 'suggest' ? 'Writing…' : '✨ Write message'
  );
  const commitBtn = h('button', { class: 'btn small primary', disabled: !s.files.length || !!git.busy, onclick: () => commit() }, git.busy === 'commit' ? 'Committing…' : `Commit ${s.files.length || ''} file${s.files.length === 1 ? '' : 's'}`);

  const files = s.files.map((f) =>
    h(
      'div',
      { class: 'git-file', title: `${STATUS_LABEL[f.status] || f.status}: ${f.rel}`, onclick: () => showGitDiff(f) },
      h('span', { class: `git-st st-${f.status}` }, f.status),
      h('span', { class: 'name' }, f.rel.split('/').pop()),
      h('span', { class: 'dir' }, f.rel.includes('/') ? f.rel.slice(0, f.rel.lastIndexOf('/')) : ''),
      h('span', { class: 'spacer' }),
      f.status !== 'D' ? h('button', { class: 'icon-btn', title: 'Open file', onclick: (e) => (e.stopPropagation(), openFile(f.rel)) }, '↗') : null,
      h('button', { class: 'icon-btn', title: 'Discard changes', onclick: (e) => (e.stopPropagation(), discard(f)) }, '↺')
    )
  );

  panel.replaceChildren(
    ...[
    h('div', { class: 'git-head' }, h('span', { class: 'muted small' }, '⎇'), branchSel, h('span', { class: 'spacer' }), ...syncBtns, h('button', { class: 'icon-btn', title: 'Refresh', onclick: refreshGit }, '⟳')),
    git.busy && !['suggest', 'commit'].includes(git.busy) ? h('div', { class: 'muted small', style: 'padding:0 10px 6px' }, `Running git ${git.busy}…`) : null,
    h('div', { class: 'git-commit' }, msg, h('div', { class: 'row' }, suggest, h('span', { class: 'spacer' }), commitBtn)),
    h('div', { class: 'git-section muted small' }, s.files.length ? 'Changes' : 'No changes since the last commit.'),
    h('div', { class: 'git-files' }, ...files),
    ].filter(Boolean)
  );
}

async function showGitDiff(f) {
  let before = '';
  let after = '';
  if (f.status !== 'U' && f.status !== 'A') before = await desk.git.head(f.rel);
  if (f.status !== 'D') {
    try {
      const r = await desk.readFile(f.rel);
      if (r.binary || r.tooLarge) return toast(`${f.rel} is ${r.binary ? 'a binary file' : 'too large'} to diff here.`);
      after = r.content;
    } catch {
      after = '';
    }
  }
  openDiff({ source: 'git', rel: f.rel, before, after, untracked: f.status === 'U' || f.status === 'A' });
}

async function discard(f) {
  const what = f.status === 'U' || f.status === 'A' ? `Delete the new file ${f.rel}?` : `Discard your changes to ${f.rel}?`;
  if (!confirm(`${what} This can't be undone.`)) return;
  await gitAction('discard', () => desk.git.discard(f.rel, f.status === 'U' || f.status === 'A'));
  await reloadOpenFiles([f.rel]);
  refreshFiles();
}

function commit() {
  const m = git.message.trim();
  if (!m) {
    toast('Write a commit message first, or click ✨ Write message.');
    return $('.git-msg')?.focus();
  }
  return gitAction('commit', async () => {
    await desk.git.commit(m);
    git.message = '';
    toast('Committed.');
  });
}

function newBranch() {
  // Electron has no prompt(), so this uses the app's own modal.
  const input = h('input', { class: 'big', placeholder: 'New branch name, then Enter', spellcheck: 'false' });
  const close = modal([input, h('div', { class: 'hint' }, 'Creates the branch from where you are now and switches to it. Your uncommitted changes come with you.')]);
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !input.value.trim()) return;
    close();
    gitAction('checkout', () => desk.git.checkout(input.value.trim().replace(/\s+/g, '-'), true));
  });
  input.focus();
}

function wireGit() {
  $('#status-branch').addEventListener('click', () => showSidePanel('git'));
}
