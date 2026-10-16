/* global $, h, state, desk, toast, openDiff, openFile, reloadOpenFiles, refreshFiles, showSidePanel, modal, autoGrow, setMode */
'use strict';

// ------------------------------------------------------------------ source control panel

const git = { status: null, busy: false, message: '', repos: [], history: null, historyOpen: false, fileHistory: null, openCommits: new Set() };
const STATUS_LABEL = { M: 'Modified', A: 'Added', D: 'Deleted', U: 'New file', C: 'Conflict' };
const OP_LABEL = { merge: 'Merge', rebase: 'Rebase', 'cherry-pick': 'Cherry-pick', revert: 'Revert' };
const pathOf = (f) => f.path || f.rel;

const cleanErr = (e) => String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

let gitRefreshing = null;
async function refreshGit() {
  if (!state.folder) return;
  if (gitRefreshing) return gitRefreshing;
  gitRefreshing = (async () => {
    try {
      [git.status, git.repos] = await Promise.all([desk.git.status(), desk.git.repos().catch(() => [])]);
    } catch {
      git.status = { repo: false };
    }
    if (git.historyOpen || git.fileHistory) await loadGitLog();
    if (typeof blameCache !== 'undefined') blameCache.clear(); // a commit, pull or checkout changes who wrote what
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
  const repoSel =
    git.repos.length > 1
      ? h(
          'select',
          { class: 'git-branch', title: 'Repository', onchange: (e) => desk.git.use(e.target.value).then(() => ((git.history = null), refreshGit())) },
          ...git.repos.map((r) => h('option', { value: r.dir, selected: r.current }, r.name))
        )
      : null;
  const prBtn =
    s.hasRemote && s.branch && !/^(main|master|trunk|develop)$/.test(s.branch) && !s.operation
      ? h('button', { class: 'icon-btn', title: 'Write a pull request description for this branch', disabled: !!git.busy, onclick: pullRequest }, '✨PR')
      : null;
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
      { class: 'git-file', title: `${STATUS_LABEL[f.status] || f.status}: ${f.rel}`, onclick: () => (f.status === 'C' ? openFile(pathOf(f)) : showGitDiff(f)) },
      h('span', { class: `git-st st-${f.status}` }, f.status),
      h('span', { class: 'name' }, f.rel.split('/').pop()),
      h('span', { class: 'dir' }, f.rel.includes('/') ? f.rel.slice(0, f.rel.lastIndexOf('/')) : ''),
      h('span', { class: 'spacer' }),
      f.status === 'C' ? h('button', { class: 'icon-btn', title: 'Ask the agent in the chat to resolve this conflict', onclick: (e) => (e.stopPropagation(), fixConflictsWithAgent([pathOf(f)])) }, '✨') : null,
      f.status === 'C' ? h('button', { class: 'icon-btn', title: 'Mark as resolved (stage it)', onclick: (e) => (e.stopPropagation(), markResolved(f)) }, '✓') : null,
      f.status !== 'D' && f.status !== 'C' ? h('button', { class: 'icon-btn', title: 'Open file', onclick: (e) => (e.stopPropagation(), openFile(pathOf(f))) }, '↗') : null,
      f.status !== 'C' ? h('button', { class: 'icon-btn', title: 'Discard changes', onclick: (e) => (e.stopPropagation(), discard(f)) }, '↺') : null
    )
  );
  const conflicts = s.files.filter((f) => f.status === 'C');
  const others = files.filter((_, i) => s.files[i].status !== 'C');
  const conflictRows = files.filter((_, i) => s.files[i].status === 'C');
  const op = s.operation;
  const opBar = op
    ? h(
        'div',
        { class: 'git-op' },
        h('div', {}, h('b', {}, `${OP_LABEL[op]} in progress. `), conflicts.length ? `${conflicts.length} file${conflicts.length === 1 ? ' has' : 's have'} conflicts: open each one, pick which side to keep, then mark it resolved.` : 'Every conflict is resolved.'),
        h(
          'div',
          { class: 'row' },
          conflicts.length ? h('button', { class: 'btn small', onclick: () => fixConflictsWithAgent(conflicts.map(pathOf)) }, '✨ Resolve with the agent') : null,
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn small', disabled: !!git.busy, onclick: () => confirm(`Abort the ${op}? Your branch goes back to how it was before it started.`) && gitAction('abort', async () => (await desk.git.abort(), reloadAll())) }, 'Abort'),
          h('button', { class: 'btn small primary', disabled: !!git.busy || conflicts.length > 0, title: conflicts.length ? 'Resolve every conflict first' : '', onclick: () => gitAction('continue', async () => (await desk.git.continue(), toast(`${OP_LABEL[op]} finished.`), reloadAll())) }, `Continue ${op}`)
        )
      )
    : null;

  panel.replaceChildren(
    ...[
    h('div', { class: 'git-head' }, repoSel, h('span', { class: 'muted small' }, '⎇'), branchSel, h('span', { class: 'spacer' }), prBtn, ...syncBtns, h('button', { class: 'icon-btn', title: 'Refresh', onclick: refreshGit }, '⟳')),
    git.busy && !['suggest', 'commit'].includes(git.busy) ? h('div', { class: 'muted small', style: 'padding:0 10px 6px' }, git.busy === 'pr' ? 'Writing the pull request…' : `Running git ${git.busy}…`) : null,
    opBar,
    op ? null : h('div', { class: 'git-commit' }, msg, h('div', { class: 'row' }, suggest, h('span', { class: 'spacer' }), commitBtn)),
    conflictRows.length ? h('div', { class: 'git-section muted small' }, 'Conflicts') : null,
    conflictRows.length ? h('div', { class: 'git-files' }, ...conflictRows) : null,
    h('div', { class: 'git-section muted small' }, others.length ? 'Changes' : conflictRows.length ? '' : 'No changes since the last commit.'),
    h('div', { class: 'git-files' }, ...others),
    historySection(),
    ].filter(Boolean)
  );
}

async function showGitDiff(f) {
  let before = '';
  let after = '';
  const rel = pathOf(f);
  if (f.status !== 'U' && f.status !== 'A') before = await desk.git.head(rel);
  if (f.status !== 'D') {
    try {
      const r = await desk.readFile(rel);
      if (r.binary || r.tooLarge) return toast(`${rel} is ${r.binary ? 'a binary file' : 'too large'} to diff here.`);
      after = r.content;
    } catch {
      after = '';
    }
  }
  openDiff({ source: 'git', rel, before, after, untracked: f.status === 'U' || f.status === 'A' });
}

async function discard(f) {
  const what = f.status === 'U' || f.status === 'A' ? `Delete the new file ${f.rel}?` : `Discard your changes to ${f.rel}?`;
  if (!confirm(`${what} This can't be undone.`)) return;
  await gitAction('discard', () => desk.git.discard(pathOf(f), f.status === 'U' || f.status === 'A'));
  await reloadOpenFiles([pathOf(f)]);
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

async function reloadAll() {
  await reloadOpenFiles(state.tabs.filter((t) => t.kind === 'file').map((t) => t.rel));
  refreshFiles();
}

// ---------- conflicts

async function markResolved(f) {
  const r = await desk.readFile(pathOf(f)).catch(() => null);
  if (r && /^(<{7}|>{7})( |$)/m.test(r.content) && !confirm(`${f.rel} still has conflict markers (<<<<<<< and >>>>>>>). Mark it resolved anyway?`)) return;
  await gitAction('resolve', () => desk.git.resolved(pathOf(f)));
}

function fixConflictsWithAgent(paths) {
  const list = paths.map((p) => `- ${p}`).join('\n');
  const op = (git.status && git.status.operation) || 'merge';
  $('#input').value = `There are ${op} conflicts in:\n${list}\n\nResolve them: read both sides of each conflict, keep what each side intended (combining them where both are needed), remove every conflict marker, and make sure the result still works. Don't stage, commit or continue the ${op}; I'll review the result first.`;
  autoGrow();
  setMode('agent');
  $('#input').focus();
  toast('Check the message, then send it.');
}

// ---------- history

const ago = (t) => {
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [u, n] of units) if (s >= n) return `${Math.floor(s / n)} ${u}${Math.floor(s / n) > 1 ? 's' : ''} ago`;
  return 'just now';
};

async function loadGitLog() {
  git.history = await desk.git.log(git.fileHistory ? { rel: git.fileHistory, limit: 100 } : { limit: 50 }).catch(() => []);
}

// The history of one file: every commit that changed it.
async function showFileHistory(rel, sha) {
  if (!rel) return toast('Open a file first.');
  git.fileHistory = rel;
  git.historyOpen = true;
  git.openCommits.clear();
  if (sha) git.openCommits.add(sha);
  showSidePanel('git');
  await loadGitLog();
  renderGit();
}

function historySection() {
  const s = git.status;
  if (!s || !s.repo) return null;
  const open = git.historyOpen || !!git.fileHistory;
  const head = h(
    'div',
    {
      class: 'git-section git-history-head muted small',
      onclick: async () => {
        if (git.fileHistory) return;
        git.historyOpen = !git.historyOpen;
        if (git.historyOpen && !git.history) await loadGitLog();
        renderGit();
      },
    },
    git.fileHistory ? `History of ${git.fileHistory.split('/').pop()}` : `${open ? '▾' : '▸'} History`,
    git.fileHistory ? h('button', { class: 'icon-btn', title: 'Show the whole history', onclick: async (e) => (e.stopPropagation(), (git.fileHistory = null), await loadGitLog(), renderGit()) }, '✕') : null
  );
  if (!open) return head;
  const rows = (git.history || []).map((c) => {
    const expanded = git.openCommits.has(c.sha);
    const files = h('div', { class: `git-commit-files${expanded ? '' : ' hidden'}` });
    if (expanded) commitFileRows(c, files);
    return h(
      'div',
      { class: 'git-log-row' },
      h(
        'div',
        {
          class: 'git-log-commit',
          title: `${c.subject}${c.body ? '\n\n' + c.body : ''}\n\n${c.sha.slice(0, 8)} · ${c.author} · ${new Date(c.time).toLocaleString()}`,
          onclick: () => {
            if (git.openCommits.has(c.sha)) git.openCommits.delete(c.sha);
            else git.openCommits.add(c.sha);
            renderGit();
          },
        },
        h('div', { class: 'subject' }, c.subject),
        h('div', { class: 'muted small' }, `${c.author} · ${ago(c.time)} · ${c.sha.slice(0, 7)}`)
      ),
      files
    );
  });
  return h('div', {}, head, h('div', { class: 'git-log' }, ...(rows.length ? rows : [h('div', { class: 'muted small', style: 'padding:4px 10px' }, git.history ? 'No commits yet.' : 'Loading…')])));
}

async function commitFileRows(c, host) {
  const { files } = await desk.git.commitFiles(c.sha, git.fileHistory || undefined).catch(() => ({ files: [] }));
  host.replaceChildren(
    ...files.map((f) =>
      h(
        'div',
        { class: 'git-file', title: `${STATUS_LABEL[f.status] || f.status}: ${f.from ? f.from + ' → ' : ''}${f.rel}`, onclick: () => showCommitDiff(c, f) },
        h('span', { class: `git-st st-${f.status === 'R' ? 'M' : f.status}` }, f.status),
        h('span', { class: 'name' }, f.rel.split('/').pop()),
        h('span', { class: 'dir' }, f.rel.includes('/') ? f.rel.slice(0, f.rel.lastIndexOf('/')) : '')
      )
    )
  );
}

async function showCommitDiff(c, f) {
  const at = (rev, rel) => desk.git.fileAt(rev, rel, { top: true, near: git.fileHistory || undefined });
  const before = f.status === 'A' ? '' : await at(`${c.sha}^`, f.from || f.rel);
  const after = f.status === 'D' ? '' : await at(c.sha, f.rel);
  openDiff({ source: 'compare', key: `${c.sha}:${f.rel}`, rel: f.rel, before, after, title: `${f.rel} · ${c.sha.slice(0, 7)} ${c.subject}`, hint: `${c.author}, ${ago(c.time)}` });
}

// ---------- pull request

async function pullRequest() {
  const pr = await gitAction('pr', () => desk.git.pr());
  if (!pr) return;
  const title = h('input', { class: 'big', value: pr.title, spellcheck: 'true' });
  const body = h('textarea', { class: 'pr-body', rows: 14, spellcheck: 'true' });
  body.value = pr.body;
  const copy = h('button', { class: 'btn' }, 'Copy');
  const openBtn = pr.url ? h('button', { class: 'btn primary' }, 'Open on GitHub') : null;
  const close = modal([
    h('div', { class: 'body' }, h('h3', {}, `Pull request: ${pr.branch} → ${pr.base.replace(/^origin\//, '')}`), title, body, h('p', { class: 'muted small' }, pr.url ? 'Open on GitHub fills in a new pull request with this. Push the branch first if you haven\'t.' : 'Copy it into your pull request.')),
    h('div', { class: 'foot' }, copy, openBtn),
  ]);
  copy.addEventListener('click', () => {
    navigator.clipboard.writeText(`${title.value}\n\n${body.value}`);
    toast('Copied.');
  });
  if (openBtn)
    openBtn.addEventListener('click', () => {
      desk.openExternal(`${pr.url}&title=${encodeURIComponent(title.value)}&body=${encodeURIComponent(body.value)}`);
      close();
    });
}

function wireGit() {
  $('#status-branch').addEventListener('click', () => showSidePanel('git'));
}
