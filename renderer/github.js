/* global $, h, state, desk, toast, modal, git, renderGit, renderMarkdown, activeTab, activateTab, renderTabs, chats, activeChat, createChat, switchChat,
   renderChatTabs, renderWorktreeBar, refreshWorktree, appendChat, send, compareChoices, agentOf, agentLabel, setMode, queueSaveWorkspace, ago, cleanErr,
   discardWorktree, refreshGit, diffEditor, cachePr, openPrFile, queueEditorComments */
'use strict';

// ------------------------------------------------------------------ GitHub: pull requests and issues
//
// The Git panel lists the repository's open pull requests and issues. A pull request opens in its
// own tab with its description, checks, review comments, conversation and changed files. A failing
// check or a review comment goes to an agent in its own copy of the folder, at the pull request's
// latest commit; Push sends the fix to the pull request's branch. Review with an agent has another
// agent read the pull request and post what it finds as review comments. An issue starts a chat in
// its own copy on a new branch, which ends in a pull request.

const gh = { status: null, prs: null, issues: null, loading: false, error: '', at: 0, open: { prs: true, issues: false } };
const CHECK_ICON = { passing: '✓', failing: '✗', running: '●', none: '' };

async function refreshGithub(force) {
  if (!state.folder || gh.loading) return;
  if (!force && Date.now() - gh.at < 60e3) return renderGit();
  gh.loading = true;
  renderGit();
  try {
    gh.status = await desk.github.status();
    gh.error = gh.status.error || '';
    if (gh.status.repo && gh.status.signedIn) [gh.prs, gh.issues] = await Promise.all([desk.github.prs(), desk.github.issues()]);
  } catch (e) {
    gh.error = cleanErr(e);
  }
  gh.at = Date.now();
  gh.loading = false;
  renderGit();
  queueEditorComments();
}

function githubFolderOpened() {
  Object.assign(gh, { status: null, prs: null, issues: null, at: 0, error: '' });
  refreshGithub(true);
}

// The Git panel's GitHub section.
function githubSection() {
  const s = gh.status;
  if (!s || !s.repo) return null;
  if (!s.signedIn)
    return h(
      'div',
      { class: 'gh-connect' },
      h('div', { class: 'small' }, `${s.repo.owner}/${s.repo.name} is on GitHub. Connect to see its pull requests and issues here.`),
      gh.error ? h('div', { class: 'muted small' }, gh.error) : null,
      h('button', { class: 'btn small', onclick: connectGithub }, 'Connect GitHub')
    );
  const head = (key, label, count) =>
    h(
      'div',
      { class: 'git-section git-history-head muted small', onclick: () => ((gh.open[key] = !gh.open[key]), renderGit()) },
      `${gh.open[key] ? '▾' : '▸'} ${label}${count != null ? ` (${count})` : ''}`,
      h('span', { class: 'spacer' }),
      key === 'prs' ? h('button', { class: 'icon-btn', title: 'Refresh from GitHub', onclick: (e) => (e.stopPropagation(), refreshGithub(true)) }, gh.loading ? '…' : '⟳') : null
    );
  const prRows = (gh.prs || []).map((p) =>
    h(
      'div',
      { class: 'gh-row', title: `#${p.number} ${p.title}\n${p.head} → ${p.base}`, onclick: () => openPr(p.number) },
      h('span', { class: `gh-check ${p.checks}`, title: p.checks === 'none' ? 'No checks' : `Checks ${p.checks}` }, CHECK_ICON[p.checks]),
      h('div', { class: 'what' }, h('div', { class: 'subject' }, `${p.title}`), h('div', { class: 'muted small' }, `#${p.number} · ${p.author}${p.draft ? ' · draft' : ''} · ${ago(new Date(p.updatedAt).getTime())}`))
    )
  );
  const issueRows = (gh.issues || []).map((i) =>
    h(
      'div',
      { class: 'gh-row', title: `#${i.number} ${i.title}`, onclick: () => openIssue(i.number) },
      h('span', { class: 'gh-check' }, '○'),
      h('div', { class: 'what' }, h('div', { class: 'subject' }, i.title), h('div', { class: 'muted small' }, `#${i.number} · ${i.author}${i.labels.length ? ' · ' + i.labels.join(', ') : ''}`))
    )
  );
  const empty = (list, text) => (list ? (list.length ? null : h('div', { class: 'muted small gh-empty' }, text)) : h('div', { class: 'muted small gh-empty' }, gh.loading ? 'Loading…' : gh.error || ''));
  return h(
    'div',
    { class: 'gh-section' },
    head('prs', 'Pull requests', gh.prs ? gh.prs.length : null),
    gh.open.prs ? h('div', { class: 'gh-list' }, ...prRows, empty(gh.prs, 'No open pull requests.')) : null,
    head('issues', 'Issues', gh.issues ? gh.issues.length : null),
    gh.open.issues ? h('div', { class: 'gh-list' }, ...issueRows, empty(gh.issues, 'No open issues.')) : null
  );
}

function connectGithub() {
  const token = h('input', { type: 'password', class: 'big', placeholder: 'GitHub token (ghp_… or github_pat_…)', spellcheck: 'false' });
  const save = h('button', { class: 'btn primary' }, 'Connect');
  const again = h('button', { class: 'btn' }, 'I signed in with gh');
  const msg = h('p', { class: 'muted small' });
  const close = modal([
    h(
      'div',
      { class: 'body' },
      h('h3', {}, 'Connect GitHub'),
      h('p', { class: 'small' }, 'If you use the GitHub CLI, run ', h('code', {}, 'gh auth login'), ' in the terminal, then press "I signed in with gh". Switchdesk uses the same sign-in.'),
      h('p', { class: 'small' }, 'Or paste a token. A fine-grained token for this repository needs read and write access to pull requests, issues and contents, plus read access to checks and actions. It is stored encrypted on this computer.'),
      token,
      msg
    ),
    h('div', { class: 'foot' }, again, save),
  ]);
  const done = async (s) => {
    gh.status = s;
    if (s && s.signedIn) {
      close();
      toast(`Connected to GitHub as ${s.login}.`);
      refreshGithub(true);
    } else msg.textContent = (s && s.error) || 'No GitHub sign-in found yet.';
  };
  save.addEventListener('click', async () => token.value.trim() && done(await desk.github.setToken(token.value.trim())));
  again.addEventListener('click', async () => done(await desk.github.setToken('')));
  token.focus();
}

// ------------------------------------------------------------------ the pull request tab

async function openPr(n) {
  let t = state.tabs.find((x) => x.kind === 'pr' && x.pr.number === n);
  if (!t) {
    t = { id: `pr:${n}`, kind: 'pr', rel: `PR #${n}`, pr: { number: n, data: null, error: '' } };
    state.tabs.push(t);
  }
  activateTab(t.id);
  await loadPr(t);
}

async function loadPr(t) {
  try {
    t.pr.data = await desk.github.pr(t.pr.number);
    t.pr.error = '';
    cachePr(t.pr.data);
    queueEditorComments();
    t.rel = `PR #${t.pr.number}: ${t.pr.data.title}`.slice(0, 60);
  } catch (e) {
    t.pr.error = cleanErr(e);
  }
  renderTabs();
  if (activeTab() === t) renderPr(t);
}

function refreshPrTab(n) {
  const t = state.tabs.find((x) => x.kind === 'pr' && x.pr.number === n);
  if (t) loadPr(t);
}

function showPr(t) {
  const on = !!(t && t.kind === 'pr');
  $('#pr-view').classList.toggle('hidden', !on);
  if (on) renderPr(t);
}

function renderPr(t) {
  const view = $('#pr-view');
  const p = t.pr.data;
  if (!p) return view.replaceChildren(h('div', { class: 'muted' }, t.pr.error || 'Loading the pull request…'));
  const md = (text) => {
    const el = h('div', { class: 'msg-text' });
    renderMarkdown(el, text || '');
    return el;
  };
  const failing = p.checks.filter((c) => c.state === 'failing');
  const chat = prChat(p.number);
  const checks = p.checks.length
    ? p.checks.map((c) =>
        h(
          'div',
          { class: `pr-check ${c.state}` },
          h('span', { class: 'gh-check ' + c.state }, CHECK_ICON[c.state]),
          h('span', { class: 'name' }, c.name),
          c.title ? h('span', { class: 'muted small' }, c.title) : null,
          h('span', { class: 'spacer' }),
          c.state === 'failing' ? h('button', { class: 'btn small', onclick: () => fixPr(p, [{ kind: 'check', check: c }]) }, 'Fix with the agent') : null,
          c.url ? h('a', { href: '#', class: 'small', onclick: (e) => (e.preventDefault(), desk.openExternal(c.url)) }, 'Details ↗') : null
        )
      )
    : [h('div', { class: 'muted small' }, 'No checks on the latest commit.')];
  const threads = p.threads.map((th) => {
    const replyBox = h('textarea', { rows: 2, class: 'hidden', placeholder: 'Reply on GitHub' });
    const send = h('button', { class: 'btn small hidden' }, 'Send reply');
    send.addEventListener('click', async () => {
      if (!replyBox.value.trim()) return;
      try {
        await desk.github.reply(p.number, th.id, replyBox.value.trim());
        loadPr(t);
      } catch (e) {
        toast(cleanErr(e));
      }
    });
    return h(
      'div',
      { class: `card pr-thread${th.outdated ? ' outdated' : ''}` },
      h('div', { class: 'pr-where' }, h('a', { href: '#', title: 'Open the file with its comments', onclick: (e) => (e.preventDefault(), openPrFileAt(p, th)) }, h('code', {}, `${th.path}${th.line ? ':' + th.line : ''}`)), th.outdated ? h('span', { class: 'muted small' }, ' · outdated') : null),
      th.hunk ? h('pre', { class: 'pr-hunk' }, diffLines(th.hunk.split('\n').slice(-4).join('\n'))) : null,
      ...th.replies.map((r) => h('div', { class: 'pr-comment' }, h('div', { class: 'muted small' }, `${r.author} · ${ago(new Date(r.at).getTime())}`), md(r.body))),
      replyBox,
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn small primary', onclick: () => fixPr(p, [{ kind: 'comment', thread: th }]) }, 'Fix with the agent'),
        h('button', { class: 'btn small', onclick: () => (replyBox.classList.remove('hidden'), send.classList.remove('hidden'), replyBox.focus()) }, 'Reply'),
        send
      )
    );
  });
  const talk = p.talk.map((c) => h('div', { class: 'pr-comment' }, h('div', { class: 'muted small' }, `${c.author}${c.review ? ` ${REVIEW_TEXT[c.review] || 'reviewed'}` : ''} · ${ago(new Date(c.at).getTime())}`), c.body ? md(c.body) : null));
  const files = p.files.map((f) => {
    const patch = h('pre', { class: 'pr-patch hidden' }, f.patch ? diffLines(f.patch) : 'No text diff (binary or too large).');
    const n = p.threads.filter((th) => th.path === f.path && !th.outdated).length;
    return h(
      'div',
      { class: 'pr-file' },
      h(
        'div',
        { class: 'git-file', title: 'Open the diff in the editor, with its comments', onclick: () => openPrFile(p, f) },
        h('span', { class: `git-st st-${f.status === 'added' ? 'A' : f.status === 'removed' ? 'D' : 'M'}` }, f.status === 'added' ? 'A' : f.status === 'removed' ? 'D' : f.status === 'renamed' ? 'R' : 'M'),
        h('span', { class: 'name' }, f.path),
        h('span', { class: 'spacer' }),
        h('span', { class: 'stat-add small' }, `+${f.add}`),
        h('span', { class: 'stat-del small' }, ` −${f.del}`),
        n ? h('span', { class: 'pr-file-comments small', title: `${n} review comment${n > 1 ? 's' : ''}` }, ` 💬 ${n}`) : null,
        h('button', { class: 'icon-btn', title: 'Show the patch here', onclick: (e) => (e.stopPropagation(), patch.classList.toggle('hidden')) }, '▾')
      ),
      patch
    );
  });
  view.replaceChildren(
    ...[
    h(
      'div',
      { class: 'pr-head' },
      h('h2', {}, p.title, h('span', { class: 'muted' }, ` #${p.number}`)),
      h('div', { class: 'muted small' }, h('span', { class: `pr-state ${p.state}${p.draft ? ' draft' : ''}` }, p.draft ? 'Draft' : p.state === 'merged' ? 'Merged' : p.state === 'closed' ? 'Closed' : 'Open'), ` ${p.author} wants to merge `, h('code', {}, p.head), ' into ', h('code', {}, p.base)),
      reviewLine(p),
      chat && chat.pr.watch ? h('div', { class: 'small pr-watch' }, h('span', { class: 'spinner' }), ` Watching its checks${chat.pr.watch.autoFix ? `; failures go back to ${agentLabel(chat)} to fix (${chat.pr.watch.tries} of ${MAX_FIXES} tries used)` : ''}.`, h('a', { href: '#', onclick: (e) => (e.preventDefault(), (chat.pr.watch = null), queueSaveWorkspace(), renderPr(t)) }, ' Stop')) : null,
      p.state === 'open'
        ? h(
            'div',
            { class: 'actions' },
            p.draft ? h('button', { class: 'btn small', onclick: () => readyPr(t) }, 'Ready for review') : null,
            h('button', { class: 'btn small', onclick: () => requestReview(t) }, 'Request review'),
            h('button', { class: 'btn small', onclick: () => approvePr(t) }, 'Approve'),
            h('button', { class: `btn small${p.mergeState === 'clean' ? ' primary' : ''}`, title: MERGE_WHY[p.mergeState] || '', onclick: () => mergePr(t) }, 'Merge…')
          )
        : null,
      h(
        'div',
        { class: 'actions' },
        failing.length ? h('button', { class: 'btn small primary', onclick: () => fixPr(p, failing.map((c) => ({ kind: 'check', check: c }))) }, `Fix ${failing.length > 1 ? `${failing.length} failing checks` : 'the failing check'}`) : null,
        p.threads.length ? h('button', { class: 'btn small', onclick: () => fixPr(p, p.threads.filter((x) => !x.outdated).map((th) => ({ kind: 'comment', thread: th }))) }, 'Fix all review comments') : null,
        h('button', { class: 'btn small', onclick: () => reviewPr(p) }, '👁 Review with an agent'),
        chat ? h('button', { class: 'btn small', onclick: () => switchChat(chat.id) }, 'Open its chat') : null,
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn small', onclick: () => desk.openExternal(p.url) }, 'Open on GitHub ↗'),
        h('button', { class: 'icon-btn', title: 'Refresh', onclick: () => loadPr(t) }, '⟳')
      )
    ),
    p.body.trim() ? md(p.body) : h('div', { class: 'muted small' }, 'No description.'),
    h('h3', {}, `Checks${p.checksState !== 'none' ? ` · ${p.checksState}` : ''}`),
    h('div', { class: 'pr-checks' }, ...checks),
    p.threads.length ? h('h3', {}, `Review comments (${p.threads.length})`) : null,
    ...threads,
    talk.length ? h('h3', {}, 'Conversation') : null,
    ...talk,
    h('h3', {}, `Files changed (${p.files.length})`),
    h('div', { class: 'pr-files' }, ...files),
    ].filter(Boolean)
  );
}

// Who approved, who asked for changes, and who hasn't reviewed yet.
function reviewLine(p) {
  const bits = [
    ...p.verdicts.map((v) => `${v.login} ${v.state === 'APPROVED' ? 'approved' : 'asked for changes'}`),
    ...(p.requested.length ? [`waiting on ${p.requested.join(', ')}`] : []),
  ];
  const state = { clean: 'Ready to merge', dirty: 'Has conflicts', blocked: 'Not mergeable yet', unstable: 'Checks failing', behind: 'Behind its base branch' }[p.mergeState];
  if (!bits.length && !state) return null;
  return h('div', { class: 'small pr-reviews' }, [state, ...bits].filter(Boolean).join(' · '));
}

const REVIEW_TEXT = { APPROVED: 'approved', CHANGES_REQUESTED: 'asked for changes', COMMENTED: 'reviewed' };

async function openPrFileAt(p, th) {
  const f = p.files.find((x) => x.path === th.path);
  if (!f) return toast(`${th.path} isn't in this pull request's changes any more.`);
  await openPrFile(p, f);
  if (th.line && !th.outdated) setTimeout(() => diffEditor.getModifiedEditor().revealLineInCenter(th.line), 200);
}

function diffLines(text) {
  const frag = document.createDocumentFragment();
  for (const line of text.split('\n')) frag.append(h('span', { class: line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : line.startsWith('@@') ? 'hunk' : '' }, line + '\n'));
  return frag;
}

// ------------------------------------------------------------------ fixing a pull request

const prChat = (n) => chats.find((c) => c.pr && c.pr.number === n && c.worktree && !c.worktree.removed);

// A chat in its own copy at the pull request's latest commit, made once per pull request.
async function chatForPr(p) {
  let chat = prChat(p.number);
  if (chat) return chat;
  chat = createChat({ title: `PR #${p.number}: ${p.title}`.slice(0, 60) });
  chat.pr = { number: p.number, title: p.title, head: p.head, base: p.base, sameRepo: p.sameRepo, canPush: p.canPush, headRepo: p.sameRepo ? null : p.headRepo, threads: [], pushedSha: p.headSha };
  chat.making = true;
  renderWorktreeBar();
  try {
    chat.worktree = await desk.worktree.forPr(p.number, `pr ${p.number}`);
    chat.wtCount = 0;
  } catch (e) {
    chat.making = false;
    renderWorktreeBar();
    appendChat(h('div', { class: 'turn-error' }, `Couldn't get the pull request's code: ${cleanErr(e)}`), chat);
    return null;
  }
  chat.making = false;
  renderChatTabs();
  renderWorktreeBar();
  queueSaveWorkspace();
  return chat;
}

async function fixPr(p, items) {
  if (!items.length) return;
  const chat = await chatForPr(p);
  if (!chat) return;
  switchChat(chat.id);
  await sendFixes(chat, p, items);
}

async function sendFixes(chat, p, items, note = '') {
  const parts = [];
  for (const it of items) {
    if (it.kind === 'check') {
      const log = await desk.github.checkLog(it.check).catch(() => '');
      parts.push(`### Failing check: ${it.check.name}\n\n${log ? '```\n' + log + '\n```' : `No log was available${it.check.url ? `; it's at ${it.check.url}` : ''}. Run the same check here to see the failure.`}`);
    } else if (it.kind === 'comment') {
      const th = it.thread;
      chat.pr.threads = [...new Set([...(chat.pr.threads || []), th.id])];
      parts.push(`### Review comment on \`${th.path}${th.line ? ':' + th.line : ''}\`\n\n${th.hunk ? '```diff\n' + th.hunk.split('\n').slice(-6).join('\n') + '\n```\n\n' : ''}${th.replies.map((r) => `${r.author}: ${r.body}`).join('\n\n')}`);
    } else if (it.kind === 'finding') {
      const f = it.finding;
      parts.push(`### ${f.severity} at \`${f.file}:${f.line}\`: ${f.title}\n\n${f.detail || ''}`);
    }
  }
  const what = items.length > 1 ? 'these' : 'this';
  const prompt = `You're working on pull request #${p.number} "${p.title}" (branch \`${p.head}\` into \`${p.base}\`), in your own copy of the repository checked out at its latest commit. ${note}Fix ${what}:\n\n${parts.join('\n\n')}\n\nCheck each one against the code first and fix what's real; if you think something is wrong, say why instead. Keep the changes small, run whatever checks the failure involves, then commit with a clear message. Don't push: Switchdesk pushes to the pull request when you're done.`;
  const shown = items.length > 1 ? `Fix ${items.length} things on PR #${p.number}` : items[0].kind === 'check' ? `Fix the failing check "${items[0].check.name}" on PR #${p.number}` : items[0].kind === 'comment' ? `Fix the review comment on ${items[0].thread.path} in PR #${p.number}` : `Fix "${items[0].finding.title}" on PR #${p.number}`;
  if (chat === activeChat()) setMode('agent');
  send(prompt, 'agent', shown, chat);
}

// Its own branch, or a fork's that lets maintainers push. (Chats saved before forks only had sameRepo.)
const canPushTo = (pr) => (pr.canPush != null ? pr.canPush : pr.sameRepo);

// Push from a pull request's copy to its branch, and optionally answer the comments it fixed.
async function pushToPr(chat) {
  if (chat.busy) return toast('Wait for the agent to finish first.');
  const pr = chat.pr;
  if (!canPushTo(pr)) return toast("This pull request comes from a fork that doesn't let maintainers push to it. Use Merge into my folder, or ask its author to allow edits from maintainers.");
  const message = h('input', { class: 'big', value: `Address review on #${pr.number}`, spellcheck: 'true' });
  const replyBox = h('input', { type: 'checkbox', checked: !!(pr.threads || []).length });
  const green = keepGreenBox();
  const go = h('button', { class: 'btn primary' }, 'Push');
  const close = modal([
    h(
      'div',
      { class: 'body' },
      h('h3', {}, `Push to PR #${pr.number}?`),
      h('p', { class: 'muted small' }, `The agent's commits go to the branch ${pr.head}${pr.headRepo ? ` on ${pr.headRepo.owner}'s fork` : ' on GitHub'}. Anything it left uncommitted is committed first with this message:`),
      message,
      (pr.threads || []).length ? h('label', { class: 'check' }, replyBox, ` Reply "Fixed in …" on the ${pr.threads.length} review comment${pr.threads.length > 1 ? 's' : ''} it was asked to fix`) : null,
      green.el
    ),
    h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: () => close() }, 'Cancel'), go),
  ]);
  go.focus();
  go.addEventListener('click', async () => {
    go.disabled = true;
    go.textContent = 'Pushing…';
    try {
      const r = await desk.worktree.push(chat.worktree, pr.head, message.value.trim(), pr.headRepo || null);
      close();
      const short = r.sha.slice(0, 7);
      if (replyBox.checked) for (const id of pr.threads || []) await desk.github.reply(pr.number, id, `Fixed in ${short}.`).catch(() => {});
      pr.threads = [];
      pr.pushedSha = r.sha;
      appendChat(h('div', { class: 'notice' }, `Pushed ${short} to PR #${pr.number}. ${green.watch() ? "Switchdesk is watching its checks and will tell you how they go." : 'Its checks run again on GitHub.'}`), chat);
      if (green.watch()) startWatch(chat, r.sha, green.fix());
      refreshWorktree(chat);
      refreshPrTab(pr.number);
      gh.at = 0;
      queueSaveWorkspace();
    } catch (e) {
      go.disabled = false;
      go.textContent = 'Push';
      toast(`Push failed: ${cleanErr(e)}`);
    }
  });
}

// ------------------------------------------------------------------ reviewing a pull request

async function pickAgentFor(title, hint) {
  const choices = await compareChoices();
  if (!choices.length) return toast('Sign in to an agent first (Settings → Agents).'), null;
  const own = agentOf(activeChat());
  const sorted = [...choices.filter((c) => c.id === own), ...choices.filter((c) => c.id !== own)];
  return new Promise((resolve) => {
    let picked = null;
    const close = modal(
      [h('div', { class: 'body' }, h('h3', {}, title), h('p', { class: 'muted small' }, hint), h('div', { class: 'results' }, ...sorted.map((c, i) => h('div', { class: `result${i === 0 ? ' active' : ''}`, onclick: () => ((picked = c), close()) }, h('b', {}, c.label)))))],
      { onClose: () => resolve(picked) }
    );
  });
}

async function reviewPr(p) {
  const choice = await pickAgentFor(`Who should review PR #${p.number}?`, 'It reads the pull request in its own copy of the folder and changes nothing. You choose whether its findings go to GitHub.');
  if (!choice) return;
  const chat = createChat({ title: `Review of PR #${p.number} by ${choice.label}`.slice(0, 60) });
  chat.agent = choice.id;
  if (choice.account && choice.account !== 'default') chat.agentAccount = choice.account;
  chat.making = true;
  renderWorktreeBar();
  try {
    chat.worktree = await desk.worktree.forPr(p.number, `review ${p.number}`);
  } catch (e) {
    chat.making = false;
    renderWorktreeBar();
    return appendChat(h('div', { class: 'turn-error' }, `Couldn't get the pull request's code: ${cleanErr(e)}`), chat);
  }
  chat.making = false;
  chat.opinion = { pr: { number: p.number, sha: p.headSha, files: p.files.map((f) => f.path), title: p.title, head: p.head, base: p.base, sameRepo: p.sameRepo } };
  renderChatTabs();
  renderWorktreeBar();
  let diff = '';
  for (const f of p.files) {
    const part = `--- ${f.path} (${f.status})\n${f.patch || '(no text diff)'}\n`;
    if (diff.length + part.length > 60000) {
      diff += `\n(${p.files.length - diff.split('\n--- ').length} more files; read them in the copy.)\n`;
      break;
    }
    diff += part;
  }
  const prompt = `Review pull request #${p.number} "${p.title}" by ${p.author} (\`${p.head}\` into \`${p.base}\`) as a careful senior reviewer. You're in a copy of the repository at the pull request's latest commit, so read whatever surrounding code you need. Don't change any files.\n\nWhat it says it does:\n\n${p.body.trim() || '(no description)'}\n\nIts changes:\n\n\`\`\`diff\n${diff}\`\`\`\n\nLook for bugs, missed edge cases, security problems, and anything that doesn't fit the rest of the code. Say in a sentence or two what you think overall. Then list what you found, most serious first, as a fenced block marked \`findings\` holding a JSON array, like this:\n\n\`\`\`findings\n[{"file": "src/app.js", "line": 42, "severity": "error", "title": "Off-by-one drops the last item", "detail": "The loop stops at length - 1, so ..."}]\n\`\`\`\n\n"file" is relative to the repository, "line" is the line in the file as it is in this pull request, and "severity" is "error" (a real bug), "warning" (likely a problem) or "info" (worth a look). Only raise things on lines this pull request changes or that it breaks. Use an empty array if you found nothing worth raising.`;
  send(prompt, 'ask', `Review PR #${p.number}`, chat);
}

// The reviewer's findings, as a review on GitHub with a comment on each line.
async function postPrReview(chat, found, summary, btn) {
  const pr = chat.opinion.pr;
  const fileOf = (f) => (pr.files.includes(f) ? f : pr.files.find((x) => x.endsWith('/' + f)) || f);
  btn.disabled = true;
  btn.textContent = 'Posting…';
  try {
    await desk.github.review(pr.number, {
      sha: pr.sha,
      body: `${agentLabel(chat)} reviewed this pull request in Switchdesk.${summary ? `\n\n${summary}` : ''}`,
      comments: found.map((f) => ({ path: fileOf(f.file), line: f.line, body: `**${f.title}** (${f.severity})${f.detail ? `\n\n${f.detail}` : ''}` })),
    });
    btn.textContent = 'Posted to GitHub ✓';
    refreshPrTab(pr.number);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Post to the pull request';
    toast(`Couldn't post the review: ${cleanErr(e)}`);
  }
}

// ------------------------------------------------------------------ starting from an issue

async function openIssue(n) {
  let i;
  try {
    i = await desk.github.issue(n);
  } catch (e) {
    return toast(cleanErr(e));
  }
  const body = h('div', { class: 'msg-text issue-body' });
  renderMarkdown(body, i.body || '_No description._');
  const comments = i.comments.slice(-5).map((c) => {
    const el = h('div', { class: 'msg-text' });
    renderMarkdown(el, c.body);
    return h('div', { class: 'pr-comment' }, h('div', { class: 'muted small' }, c.author), el);
  });
  const close = modal([
    h('div', { class: 'body issue-modal' }, h('h3', {}, `${i.title} `, h('span', { class: 'muted' }, `#${i.number}`)), h('div', { class: 'muted small' }, `Opened by ${i.author}${i.labels.length ? ' · ' + i.labels.join(', ') : ''}`), body, ...comments),
    h(
      'div',
      { class: 'foot' },
      h('button', { class: 'btn', onclick: () => desk.openExternal(i.url) }, 'Open on GitHub ↗'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', title: 'The agent plans it first, and you approve the plan', onclick: () => (close(), startIssue(i, 'plan')) }, 'Plan it first'),
      h('button', { class: 'btn primary', onclick: () => (close(), startIssue(i, 'agent')) }, 'Start working on it')
    ),
  ]);
}

// A GitHub issue (#12) or a Linear one (ENG-12).
const issueRef = (i) => (i.identifier ? i.identifier : `#${i.number}`);

// agent and account: who works on it, when not the agent new chats use (the board starts several).
async function startIssue(i, mode, { agent, account } = {}) {
  const ref = issueRef(i);
  const chat = createChat({ title: `${ref} ${i.title}`.slice(0, 60) });
  if (agent) chat.agent = agent;
  if (account && account !== 'default') chat.agentAccount = account;
  chat.issue = i.identifier ? { linear: true, id: i.id, identifier: i.identifier, title: i.title, url: i.url } : { number: i.number, title: i.title };
  chat.making = true;
  renderWorktreeBar();
  try {
    chat.worktree = await desk.worktree.create((i.identifier ? `${i.identifier} ${i.title}` : `issue ${i.number} ${i.title}`).slice(0, 40));
    chat.wtCount = 0;
  } catch (e) {
    chat.making = false;
    renderWorktreeBar();
    return appendChat(h('div', { class: 'turn-error' }, cleanErr(e)), chat);
  }
  chat.making = false;
  renderChatTabs();
  renderWorktreeBar();
  queueSaveWorkspace();
  const talk = i.comments.length ? `\n\nComments on it:\n\n${i.comments.slice(-10).map((c) => `${c.author}: ${c.body}`).join('\n\n')}` : '';
  const prompt = `Work on ${i.identifier ? 'Linear' : 'GitHub'} issue ${ref}: "${i.title}" (opened by ${i.author}).\n\n${i.body.trim() || '(no description)'}${talk}\n\nYou're in your own copy of the repository, on a new branch. Make the change, check it works, and commit with a clear message that mentions ${ref}. Don't push: Switchdesk opens the pull request when you're done.`;
  if (chat === activeChat()) setMode(mode);
  send(prompt, mode, `Work on issue ${ref}: ${i.title}`, chat);
}

// The issue's copy, pushed to its branch and opened as a pull request that closes the issue.
async function openPrFromCopy(chat) {
  if (chat.busy) return toast('Wait for the agent to finish first.');
  const issue = chat.issue;
  const last = [...chat.el.querySelectorAll('.msg-text')].pop();
  const title = h('input', { class: 'big', value: issue.title, spellcheck: 'true' });
  const body = h('textarea', { class: 'pr-body', rows: 10, spellcheck: 'true' });
  const ref = issueRef(issue);
  // "Closes #12" closes a GitHub issue when the pull request merges; "Fixes ENG-12" does the same in Linear.
  body.value = `${issue.linear ? 'Fixes' : 'Closes'} ${ref}.\n\n${last ? last.innerText.trim() : ''}`.trim();
  const draft = h('input', { type: 'checkbox' });
  const green = keepGreenBox();
  const go = h('button', { class: 'btn primary' }, 'Open pull request');
  const close = modal([
    h('div', { class: 'body' }, h('h3', {}, `Pull request for issue ${ref}`), h('p', { class: 'muted small' }, `Pushes the branch ${chat.worktree.branch} to GitHub (committing anything left uncommitted) and opens the pull request.`), title, body, h('label', { class: 'check' }, draft, ' Open it as a draft'), green.el),
    h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: () => close() }, 'Cancel'), go),
  ]);
  title.focus();
  go.addEventListener('click', async () => {
    go.disabled = true;
    go.textContent = 'Opening…';
    try {
      const pushed = await desk.worktree.push(chat.worktree, chat.worktree.branch, `${title.value.trim()} (${ref})`);
      const r = await desk.github.createPr({ head: chat.worktree.branch, title: title.value.trim(), body: body.value, draft: draft.checked });
      close();
      if (issue.linear) desk.linear.comment(issue.id, `Pull request: [#${r.number} ${title.value.trim()}](${r.url})`).catch(() => {});
      chat.pr = { number: r.number, title: title.value.trim(), head: chat.worktree.branch, base: null, sameRepo: true, threads: [], pushedSha: pushed.sha };
      if (green.watch()) startWatch(chat, pushed.sha, green.fix());
      appendChat(h('div', { class: 'notice' }, `Opened PR #${r.number}. Changes you make in this chat from now on can be pushed to it.`), chat);
      renderWorktreeBar();
      queueSaveWorkspace();
      gh.at = 0;
      openPr(r.number);
    } catch (e) {
      go.disabled = false;
      go.textContent = 'Open pull request';
      toast(cleanErr(e));
    }
  });
}

// ------------------------------------------------------------------ keeping a pull request green
//
// After a push, Switchdesk watches the pull request's checks. When they pass (or fail and need you)
// you get a notification. With auto-fix on, a failing check goes back to the agent with its log, and
// its fix is pushed again, up to MAX_FIXES times.

const WATCH_MS = 30e3;
const MAX_FIXES = 3;
const watchBusy = new Set(); // chat ids being checked right now
let watchTimer = null;

function keepGreenBox() {
  const watch = h('input', { type: 'checkbox', checked: true });
  const fix = h('input', { type: 'checkbox', checked: true });
  watch.addEventListener('change', () => (fix.disabled = !watch.checked));
  return {
    el: h('div', { class: 'keep-green' }, h('label', { class: 'check' }, watch, ' Watch its checks and tell me how they go'), h('label', { class: 'check' }, fix, ` If a check fails, have the agent fix it and push again (up to ${MAX_FIXES} tries)`)),
    watch: () => watch.checked,
    fix: () => watch.checked && fix.checked,
  };
}

function startWatch(chat, sha, autoFix) {
  chat.pr.watch = { sha, since: Date.now(), tries: 0, autoFix: !!autoFix, fixing: false };
  queueSaveWorkspace();
  renderWorktreeBar();
}

function wireGithub() {
  clearInterval(watchTimer);
  watchTimer = setInterval(checkWatches, WATCH_MS);
}

function checkWatches() {
  for (const chat of chats) if (chat.pr && chat.pr.watch && !chat.pr.watch.fixing && !chat.busy && !watchBusy.has(chat.id)) watchStep(chat);
}

async function watchStep(chat) {
  const pr = chat.pr;
  const w = pr.watch;
  watchBusy.add(chat.id);
  try {
    const c = await desk.github.checks(w.sha);
    if (pr.watch !== w) return;
    const failing = c.list.filter((x) => x.state === 'failing');
    const names = failing.map((x) => x.name).join(', ');
    if (c.state === 'passing') stopWatch(chat, `Checks pass on PR #${pr.number}.`, true);
    else if (c.state === 'failing' && !w.autoFix) stopWatch(chat, `A check failed on PR #${pr.number}: ${names}. Fix it from the pull request's tab.`);
    else if (c.state === 'failing' && w.tries >= MAX_FIXES) stopWatch(chat, `Checks still fail on PR #${pr.number} after ${MAX_FIXES} tries, so it needs you: ${names}.`);
    else if (c.state === 'failing') {
      w.tries++;
      w.fixing = true;
      queueSaveWorkspace();
      appendChat(h('div', { class: 'notice' }, `${names} failed on PR #${pr.number}. Asking ${agentLabel(chat)} to fix it (try ${w.tries} of ${MAX_FIXES}).`), chat);
      await sendFixes(chat, { number: pr.number, title: pr.title, head: pr.head, base: pr.base || 'the default branch' }, failing.map((check) => ({ kind: 'check', check })), `This is try ${w.tries} of ${MAX_FIXES} at getting its checks to pass, and Switchdesk pushes your commit for you. `);
    } else if (c.state === 'none' && Date.now() - w.since > 15 * 60e3) stopWatch(chat, `No checks ran on PR #${pr.number}, so Switchdesk stopped watching it.`);
    else if (Date.now() - w.since > 3 * 3600e3) stopWatch(chat, `PR #${pr.number}'s checks were still running after 3 hours, so Switchdesk stopped watching them.`);
  } catch {
    /* offline for now: try again next time */
  } finally {
    watchBusy.delete(chat.id);
  }
}

function stopWatch(chat, text, good) {
  chat.pr.watch = null;
  queueSaveWorkspace();
  renderWorktreeBar();
  appendChat(h('div', { class: `notice${good ? ' good' : ''}` }, `${good ? '✓ ' : ''}${text}`), chat);
  try {
    const n = new Notification('Switchdesk', { body: text });
    n.onclick = () => (window.focus(), chats.includes(chat) && switchChat(chat.id));
  } catch {
    /* notifications off */
  }
  desk.flashWindow();
  refreshPrTab(chat.pr.number);
  gh.at = 0;
}

// The agent's turn on a failing check ended (chat.js calls this): push its fix and keep watching.
async function prTurnEnded(chat, failed) {
  const pr = chat.pr;
  const w = pr && pr.watch;
  if (!w || !w.fixing) return;
  w.fixing = false;
  if (failed) return stopWatch(chat, `The agent stopped before fixing PR #${pr.number}'s checks, so it needs you.`);
  try {
    const head = await desk.worktree.head(chat.worktree);
    if (head.sha === w.sha && !head.dirty) return stopWatch(chat, `${agentLabel(chat)} didn't change anything for PR #${pr.number}'s failing checks, so it needs you.`);
    const r = await desk.worktree.push(chat.worktree, pr.head, `Fix failing checks on #${pr.number}`, pr.headRepo || null);
    pr.pushedSha = r.sha;
    w.sha = r.sha;
    w.since = Date.now();
    appendChat(h('div', { class: 'notice' }, `Pushed ${r.sha.slice(0, 7)} to PR #${pr.number}. Watching its checks again.`), chat);
    queueSaveWorkspace();
    refreshWorktree(chat);
    refreshPrTab(pr.number);
  } catch (e) {
    stopWatch(chat, `Couldn't push the fix to PR #${pr.number}: ${cleanErr(e)}`);
  }
}

// ------------------------------------------------------------------ reviewers, approving and merging

async function readyPr(t) {
  try {
    await desk.github.ready(t.pr.data.nodeId);
    toast(`PR #${t.pr.number} is ready for review.`);
  } catch (e) {
    toast(cleanErr(e));
  }
  loadPr(t);
}

async function requestReview(t) {
  const p = t.pr.data;
  const people = await desk.github.collaborators().catch(() => []);
  const list = h('datalist', { id: 'gh-people' }, ...people.filter((x) => x !== p.author).map((x) => h('option', { value: x })));
  const input = h('input', { class: 'big', list: 'gh-people', placeholder: 'GitHub usernames, separated by commas', spellcheck: 'false' });
  const go = h('button', { class: 'btn primary' }, 'Request review');
  const close = modal([h('div', { class: 'body' }, h('h3', {}, `Who should review PR #${p.number}?`), input, list), h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: () => close() }, 'Cancel'), go)]);
  input.focus();
  go.addEventListener('click', async () => {
    const logins = input.value.split(/[\s,]+/).map((x) => x.replace(/^@/, '')).filter(Boolean);
    if (!logins.length) return input.focus();
    try {
      await desk.github.requestReviewers(p.number, logins);
      close();
      toast(`Asked ${logins.join(', ')} to review.`);
      loadPr(t);
    } catch (e) {
      toast(cleanErr(e));
    }
  });
}

async function approvePr(t) {
  const p = t.pr.data;
  const note = h('textarea', { rows: 3, class: 'pr-body', placeholder: 'A comment with the approval (optional)' });
  const go = h('button', { class: 'btn primary' }, 'Approve');
  const close = modal([h('div', { class: 'body' }, h('h3', {}, `Approve PR #${p.number}?`), note), h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: () => close() }, 'Cancel'), go)]);
  go.addEventListener('click', async () => {
    try {
      await desk.github.approve(p.number, note.value.trim());
      close();
      toast(`Approved PR #${p.number}.`);
      loadPr(t);
    } catch (e) {
      toast(cleanErr(e));
    }
  });
}

const MERGE_WHY = {
  dirty: "It has conflicts with the branch it's going into. Fix those first (ask an agent in its chat), then merge.",
  blocked: 'GitHub says it still needs something first: an approving review or checks that are required to pass.',
  unstable: "Some checks aren't passing. You can still merge if the repository allows it.",
  behind: "It's behind the branch it's going into. GitHub may ask you to update it first.",
  draft: "It's a draft. Mark it ready for review first.",
};

async function mergePr(t) {
  const p = t.pr.data;
  const method = h('select', {}, h('option', { value: 'squash' }, 'Squash and merge'), h('option', { value: 'merge' }, 'Create a merge commit'), h('option', { value: 'rebase' }, 'Rebase and merge'));
  const title = h('input', { class: 'big', value: `${p.title} (#${p.number})`, spellcheck: 'true' });
  const del = h('input', { type: 'checkbox', checked: p.sameRepo });
  const go = h('button', { class: 'btn primary' }, 'Merge');
  method.addEventListener('change', () => title.classList.toggle('hidden', method.value === 'rebase'));
  const close = modal([
    h(
      'div',
      { class: 'body' },
      h('h3', {}, `Merge PR #${p.number} into ${p.base}?`),
      MERGE_WHY[p.mergeState] ? h('p', { class: 'small merge-why' }, MERGE_WHY[p.mergeState]) : null,
      method,
      title,
      p.sameRepo ? h('label', { class: 'check' }, del, ` Delete the branch ${p.head} afterwards`) : null,
      h('p', { class: 'muted small' }, `Any copy Switchdesk made for it is removed once everything in it is pushed. If your folder is on ${p.head}, it switches to ${p.base} and pulls.`)
    ),
    h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: () => close() }, 'Cancel'), go),
  ]);
  go.focus();
  go.addEventListener('click', async () => {
    go.disabled = true;
    go.textContent = 'Merging…';
    try {
      const r = await desk.github.merge(p.number, { method: method.value, title: method.value === 'rebase' ? undefined : title.value.trim(), sha: p.headSha, head: p.head, base: p.base, deleteBranch: del.checked && p.sameRepo });
      close();
      const removed = await removeMergedCopies(p.number);
      toast(`Merged PR #${p.number}.${r.branchDeleted ? ` Deleted ${p.head}.` : ''}${r.switched ? ` Your folder is on ${p.base} now.` : ''}${removed ? ` Removed ${removed} cop${removed > 1 ? 'ies' : 'y'} of the folder.` : ''}`);
      refreshGit();
      refreshGithub(true);
      loadPr(t);
    } catch (e) {
      go.disabled = false;
      go.textContent = 'Merge';
      toast(`Couldn't merge: ${cleanErr(e)}`);
    }
  });
}

// The copies a merged pull request's chats worked in, once nothing in them is left unpushed.
async function removeMergedCopies(n) {
  let removed = 0;
  for (const chat of chats.filter((c) => ((c.pr && c.pr.number === n) || (c.opinion && c.opinion.pr && c.opinion.pr.number === n)) && c.worktree && !c.worktree.removed && !c.busy)) {
    const head = await desk.worktree.head(chat.worktree).catch(() => null);
    const pushed = chat.opinion ? head && !head.dirty : head && !head.dirty && head.sha === chat.pr.pushedSha;
    if (!pushed) continue;
    if (chat.pr) chat.pr.watch = null;
    await discardWorktree(chat, { silent: true });
    appendChat(h('div', { class: 'notice' }, `PR #${n} was merged, so this chat's copy of the folder was removed.`), chat);
    removed++;
  }
  return removed;
}
