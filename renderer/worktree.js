/* global $, h, state, desk, toast, modal, chats, activeChat, createChat, switchChat, renderChatTabs, appendChat, openDiff, addReviews,
   reloadOpenFiles, refreshFiles, refreshGit, renderTree, queueSaveWorkspace, renderCompareBar, useComparison, canPushTo, issueRef, longRunBusy */
'use strict';

// ------------------------------------------------------------------ parallel agents (own copies)
//
// A chat can work in its own copy of the project: a git worktree on a branch of its own. Several
// can run at once without touching your folder. Merge brings a copy's changes into your folder,
// where they show up for inline review like any other change.

function newChatInCopy() {
  if (!state.folder) return toast('Open a folder first.');
  const input = h('input', { class: 'big', placeholder: 'What will this chat work on? e.g. "dark mode"', spellcheck: 'false' });
  const close = modal([
    input,
    h('div', { class: 'hint' }, "Claude works in its own copy of this folder (a git worktree, on its own branch), starting from your files as they are now. Your folder isn't touched until you merge."),
  ]);
  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const name = input.value.trim() || 'parallel task';
    close();
    const chat = createChat({ title: name.slice(0, 60) });
    chat.making = true;
    renderWorktreeBar();
    try {
      chat.worktree = await desk.worktree.create(name);
      chat.wtCount = 0;
    } catch (err) {
      toast(String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
    chat.making = false;
    renderChatTabs();
    renderWorktreeBar();
    $('#input').focus();
  });
  input.focus();
}

async function refreshWorktree(chat) {
  if (!chat.worktree || chat.worktree.removed) return;
  try {
    chat.wtChanges = await desk.worktree.changes(chat.worktree);
    // A pull request's copy: whether there's anything new to push.
    if (chat.pr) chat.wtHead = await desk.worktree.head(chat.worktree);
  } catch {
    chat.worktree.removed = true;
  }
  if (chat === activeChat()) renderWorktreeBar();
  if (chat.compare) renderCompareBar();
}

function renderWorktreeBar() {
  const bar = $('#worktree-bar');
  const chat = activeChat();
  renderCompareBar();
  if (!chat || (!chat.worktree && !chat.making)) return bar.classList.add('hidden');
  bar.classList.remove('hidden');
  if (chat.making) return bar.replaceChildren(h('span', { class: 'spinner' }), h('span', {}, 'Making a copy of your folder…'));
  const wt = chat.worktree;
  if (wt.removed) return bar.replaceChildren(h('span', { class: 'wt-icon' }, '⑂'), h('span', { class: 'muted' }, 'This copy was removed. Start a new chat to keep going.'));
  const n = (chat.wtChanges || []).length;
  // A pull request's copy pushes to it; an issue's copy opens one.
  const github = chat.pr && canPushTo(chat.pr) ? 'push' : chat.issue && !chat.pr ? 'open' : null;
  const unpushed = !chat.pr || !chat.wtHead || chat.wtHead.dirty || chat.wtHead.sha !== chat.pr.pushedSha;
  bar.replaceChildren(
    ...[
      h('span', { class: 'wt-icon' }, '⑂'),
      h('span', { class: 'wt-label', title: `Branch ${wt.branch}\n${wt.root}` }, chat.pr ? `PR #${chat.pr.number}` : chat.issue ? `Issue ${issueRef(chat.issue)}` : 'Own copy'),
      h('span', { class: 'muted' }, n ? `${n} file${n > 1 ? 's' : ''} changed` : 'no changes yet'),
      h('span', { class: 'spacer' }),
      n ? h('button', { class: 'btn small', onclick: () => reviewWorktree(chat) }, 'Review') : null,
      chat.pr ? h('button', { class: 'btn small', title: 'Open the pull request', onclick: () => openPr(chat.pr.number) }, 'View PR') : null,
      chat.pr && chat.pr.watch ? h('span', { class: 'muted small', title: chat.pr.watch.babysit ? "Switchdesk fixes its checks, comments and conflicts until it's merged" : 'Switchdesk tells you when its checks pass or fail' }, chat.pr.watch.babysit ? '● babysitting' : '● watching checks') : null,
      github === 'push' && n && unpushed ? h('button', { class: 'btn small primary', title: `Push the agent's commits to ${chat.pr.head} on GitHub`, onclick: () => pushToPr(chat) }, `Push to PR #${chat.pr.number}`) : null,
      github === 'open' && n ? h('button', { class: 'btn small primary', title: 'Push this branch and open a pull request that closes the issue', onclick: () => openPrFromCopy(chat) }, 'Open pull request') : null,
      n && !github ? h('button', { class: 'btn small primary', title: 'Bring these changes into your folder', onclick: () => (chat.compare ? useComparison(chat) : mergeWorktree(chat)) }, chat.compare ? 'Use this one' : 'Merge into my folder') : null,
      h('button', { class: 'btn small danger', title: 'Delete this copy and its branch', onclick: () => discardWorktree(chat) }, 'Discard'),
    ].filter(Boolean)
  );
}

const WT_STATUS = { A: 'new', D: 'deleted', M: '' };

function fileList(chat, onPick) {
  return h(
    'div',
    { class: 'wt-files' },
    ...(chat.wtChanges || []).map((c) =>
      h('div', { class: 'pop-item', onclick: () => onPick && onPick(c) }, c.rel, WT_STATUS[c.status] ? h('span', { class: 'muted small' }, ` (${WT_STATUS[c.status]})`) : null)
    )
  );
}

async function openWorktreeDiff(chat, c) {
  const d = await desk.worktree.diff(chat.worktree, c.rel);
  openDiff({ source: 'worktree', turnId: `wt-${chat.id}`, rel: c.rel, before: d.before, after: d.after, branch: chat.worktree.branch });
}

async function reviewWorktree(chat) {
  await refreshWorktree(chat);
  const close = modal([h('div', { class: 'body' }, h('h3', {}, "Changes in Claude's copy"), h('p', { class: 'muted small' }, 'Click a file to see its diff.'), fileList(chat, (c) => (close(), openWorktreeDiff(chat, c))))]);
}

async function mergeWorktree(chat, { after } = {}) {
  if (chat.busy) return toast('Wait for Claude to finish before merging.');
  await refreshWorktree(chat);
  if (!(chat.wtChanges || []).length) return toast('Nothing to merge yet.');
  const go = h('button', { class: 'btn primary' }, 'Merge');
  const cancel = h('button', { class: 'btn' }, 'Cancel');
  const close = modal([
    h(
      'div',
      { class: 'body' },
      h('h3', {}, 'Merge into your folder?'),
      h('p', { class: 'muted' }, "These changes are copied into your folder as normal edits, ready to review. Nothing is committed. If you've changed a file too, both versions are combined, and any clash is marked in the file."),
      fileList(chat)
    ),
    h('div', { class: 'foot' }, cancel, go),
  ]);
  cancel.addEventListener('click', close);
  go.focus();
  go.addEventListener('click', async () => {
    close();
    let r;
    try {
      r = await desk.worktree.merge(chat.worktree);
    } catch (err) {
      return toast(`Merge failed: ${String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`);
    }
    chat.worktree.base = r.base;
    queueSaveWorkspace();
    const text = r.merged.filter((c) => !c.binary);
    addReviews(text);
    for (const c of r.merged) state.changedFiles.add(c.rel);
    await reloadOpenFiles(r.merged.map((c) => c.rel));
    refreshFiles();
    refreshGit();
    renderTree();
    const clashes = r.merged.filter((c) => c.conflicts);
    appendChat(
      h(
        'div',
        { class: 'notice' },
        `Merged ${r.merged.length} file${r.merged.length === 1 ? '' : 's'} into your folder. They're highlighted in the editor for review.` +
          (clashes.length ? ` ${clashes.length} file${clashes.length > 1 ? 's have' : ' has'} clashes marked with <<<<<<< : ${clashes.map((c) => c.rel).join(', ')}.` : '')
      ),
      chat
    );
    await refreshWorktree(chat);
    if (after) after(r);
  });
}

async function discardWorktree(chat, { silent } = {}) {
  if (chat.busy) return toast('Stop Claude before discarding its copy.');
  if (!silent && longRunBusy(chat)) return toast('A long run is working in this copy. Stop the run first.');
  if (!silent && !confirm("Delete Claude's copy and its branch? Changes you haven't merged are lost.")) return false;
  desk.chatClose(chat.id);
  await desk.worktree.remove(chat.worktree).catch(() => {});
  chat.worktree.removed = true;
  queueSaveWorkspace();
  if (!silent) appendChat(h('div', { class: 'notice' }, 'Copy deleted.'), chat);
  renderWorktreeBar();
  renderChatTabs();
  return true;
}

// Closing a chat tab that has its own copy deletes the copy, after asking if it has unmerged work.
async function closeWorktreeChat(chat) {
  if (!chat.worktree || chat.worktree.removed) return true;
  // A long run's chats share its copy: that goes when you discard it from the run's own chat.
  if (chat.longRun && chat.longRun.role !== 'plan') return true;
  await refreshWorktree(chat);
  const n = (chat.wtChanges || []).length;
  if (n && !confirm(`This chat's copy has ${n} changed file${n > 1 ? 's' : ''} you haven't merged. Close the chat and delete the copy?`)) return false;
  await discardWorktree(chat, { silent: true });
  return true;
}
