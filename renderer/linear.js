/* global h, desk, toast, modal, gh, renderGit, renderMarkdown, cleanErr, ago, startIssue */
'use strict';

// ------------------------------------------------------------------ Linear issues
//
// The Git panel lists the Linear issues assigned to you, under the GitHub ones. One starts a chat in
// its own copy of the folder, on a new branch, which ends in a pull request that says "Fixes ENG-12"
// (so Linear links it, and closes the issue when it merges) and is linked from the issue.

const lin = { status: null, issues: null, loading: false, error: '', open: false, at: 0 };

async function refreshLinear(force) {
  if (lin.loading || (!force && Date.now() - lin.at < 60e3)) return;
  lin.loading = true;
  renderGit();
  try {
    lin.status = await desk.linear.status();
    lin.error = lin.status.error || '';
    lin.issues = lin.status.signedIn ? await desk.linear.issues() : null;
  } catch (e) {
    lin.error = cleanErr(e);
  }
  lin.at = Date.now();
  lin.loading = false;
  renderGit();
}

// The Git panel's Linear section, shown for folders on GitHub (where its pull requests go).
function linearSection() {
  if (!gh.status || !gh.status.repo || !gh.status.signedIn) return null;
  const s = lin.status;
  const count = s && s.signedIn && lin.issues ? ` (${lin.issues.length})` : '';
  const head = h(
    'div',
    {
      class: 'git-section git-history-head muted small',
      onclick: () => {
        lin.open = !lin.open;
        renderGit();
        if (lin.open) refreshLinear();
      },
    },
    `${lin.open ? '▾' : '▸'} Linear${count}`,
    h('span', { class: 'spacer' }),
    lin.open && s && s.signedIn ? h('button', { class: 'icon-btn', title: 'Refresh from Linear', onclick: (e) => (e.stopPropagation(), refreshLinear(true)) }, lin.loading ? '…' : '⟳') : null
  );
  if (!lin.open) return head;
  let body;
  if (!s) body = h('div', { class: 'muted small gh-empty' }, 'Loading…');
  else if (!s.signedIn)
    body = h('div', { class: 'gh-connect' }, h('div', { class: 'small' }, 'Connect Linear to start work from the issues assigned to you.'), lin.error ? h('div', { class: 'muted small' }, lin.error) : null, h('button', { class: 'btn small', onclick: connectLinear }, 'Connect Linear'));
  else
    body = h(
      'div',
      { class: 'gh-list' },
      ...(lin.issues || []).map((i) =>
        h(
          'div',
          { class: 'gh-row', title: `${i.identifier} ${i.title}`, onclick: () => openLinearIssue(i.id) },
          h('span', { class: 'gh-check' }, '◇'),
          h('div', { class: 'what' }, h('div', { class: 'subject' }, i.title), h('div', { class: 'muted small' }, [i.identifier, i.state, i.priority && i.priority !== 'No priority' ? i.priority : null, i.updatedAt ? ago(new Date(i.updatedAt).getTime()) : null].filter(Boolean).join(' · ')))
        )
      ),
      lin.issues && !lin.issues.length ? h('div', { class: 'muted small gh-empty' }, 'Nothing assigned to you is open.') : null,
      lin.error ? h('div', { class: 'muted small gh-empty' }, lin.error) : null
    );
  return h('div', { class: 'gh-section' }, head, body);
}

function connectLinear() {
  const key = h('input', { type: 'password', class: 'big', placeholder: 'Linear API key (lin_api_…)', spellcheck: 'false' });
  const save = h('button', { class: 'btn primary' }, 'Connect');
  const msg = h('p', { class: 'muted small' });
  const close = modal([
    h('div', { class: 'body' }, h('h3', {}, 'Connect Linear'), h('p', { class: 'small' }, 'Make a personal API key in Linear (Settings → Security & access → Personal API keys) and paste it here. It is stored encrypted on this computer.'), key, msg),
    h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: () => close() }, 'Cancel'), save),
  ]);
  save.addEventListener('click', async () => {
    if (!key.value.trim()) return key.focus();
    save.disabled = true;
    const s = await desk.linear.setKey(key.value.trim()).catch((e) => ({ signedIn: false, error: cleanErr(e) }));
    save.disabled = false;
    if (!s.signedIn) return (msg.textContent = s.error || "Linear didn't accept that key.");
    close();
    toast(`Connected to Linear as ${s.name}.`);
    lin.status = s;
    refreshLinear(true);
  });
  key.focus();
}

async function openLinearIssue(id) {
  let i;
  try {
    i = await desk.linear.issue(id);
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
    h('div', { class: 'body issue-modal' }, h('h3', {}, `${i.title} `, h('span', { class: 'muted' }, i.identifier)), h('div', { class: 'muted small' }, `Opened by ${i.author}${i.state ? ' · ' + i.state : ''}`), body, ...comments),
    h(
      'div',
      { class: 'foot' },
      h('button', { class: 'btn', onclick: () => desk.openExternal(i.url) }, 'Open in Linear ↗'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', title: 'The agent plans it first, and you approve the plan', onclick: () => (close(), startIssue(i, 'plan')) }, 'Plan it first'),
      h('button', { class: 'btn primary', onclick: () => (close(), startIssue(i, 'agent')) }, 'Start working on it')
    ),
  ]);
}
