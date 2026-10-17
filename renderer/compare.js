/* global $, h, state, desk, toast, modal, chats, activeChat, createChat, switchChat, renderChatTabs, appendChat, send, buildPrompt, renderChips, autoGrow,
   agentState, agentAccounts, agentStatus, agentInfo, agentLabel, agentOf, acct, multiAccount, accountStatus, cliState, mergeWorktree, discardWorktree, refreshWorktree */
'use strict';

// ------------------------------------------------------------------ same prompt, several agents
//
// One message goes to several agents at once. Each works in its own copy of the folder (a git
// worktree, like ⑂ chats), so they can't step on each other. A bar above each of their chats shows
// how all of them are doing; pick the result you like and merge it into your folder.

const compareGroups = new Map(); // group id -> { prompt }

// The agents (and accounts) that are installed and signed in, as choices for the dialog.
async function compareChoices() {
  const out = [];
  if (cliState && cliState.found) {
    const auth = multiAccount() ? await accountStatus(acct.folderAccount) : cliState.auth;
    if (!auth || auth.loggedIn) out.push({ id: 'claude', label: 'Claude' });
  }
  const checks = [];
  for (const a of agentState.list) {
    if (a.id === 'claude') continue;
    const several = agentAccounts(a.id).length > 1;
    for (const x of agentAccounts(a.id))
      checks.push(
        agentStatus(a.id, false, x.id).then(
          (s) =>
            s &&
            s.installed &&
            s.loggedIn && {
              id: a.id,
              account: x.id,
              label: several ? `${a.label} · ${x.name}` : a.label,
            }
        )
      );
  }
  for (const c of await Promise.all(checks)) if (c) out.push(c);
  return out;
}

async function sendToSeveral() {
  if (!state.folder) return toast('Open a folder first.');
  const choices = await compareChoices();
  if (choices.length < 2) return toast('Sign in to at least two agents first (Settings → Agents).');
  const input = $('#input');
  const text = h('textarea', {
    class: 'pr-body',
    rows: 4,
    placeholder: 'What should they all do?',
    spellcheck: 'false',
  });
  text.value = input.value.trim();
  const current = agentOf(activeChat());
  // Start with the chat's own agent and the next two, so a quick Enter compares three.
  const picked = new Set(
    choices
      .filter((c) => c.id === current)
      .slice(0, 1)
      .map((c) => c.label)
  );
  for (const c of choices) if (picked.size < 3 && !picked.has(c.label) && ![...picked].some((l) => l.startsWith(agentInfo(c.id).label))) picked.add(c.label);
  const boxes = choices.map((c) => {
    const cb = h('input', { type: 'checkbox', checked: picked.has(c.label) });
    cb.choice = c;
    return cb;
  });
  const go = h('button', { class: 'btn primary' }, 'Send to all');
  const cancel = h('button', { class: 'btn' }, 'Cancel');
  const close = modal([
    h(
      'div',
      { class: 'body compare-pick' },
      h('h3', {}, 'Send to several agents'),
      h(
        'p',
        { class: 'muted small' },
        'Each agent works on this in its own copy of your folder, at the same time, in Agent mode. Compare what they did, then merge the one you like. Your folder isn’t touched until you do.'
      ),
      text,
      h('div', { class: 'compare-agents' }, ...boxes.map((cb) => h('label', { class: 'check' }, cb, ' ', cb.choice.label)))
    ),
    h('div', { class: 'foot' }, cancel, go),
  ]);
  cancel.addEventListener('click', close);
  const start = () => {
    const chosen = boxes.filter((b) => b.checked).map((b) => b.choice);
    if (!text.value.trim()) return text.focus();
    if (chosen.length < 2) return toast('Pick at least two agents.');
    close();
    startComparison(text.value.trim(), chosen, text.value.trim() === input.value.trim());
  };
  go.addEventListener('click', start);
  text.addEventListener('keydown', (e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && start());
  (text.value ? go : text).focus();
}

async function startComparison(text, chosen, fromInput) {
  // Context attached in the chat box (files, selections, pages) goes to every agent.
  const prompt = fromInput ? buildPrompt(text) : text;
  if (fromInput) {
    $('#input').value = '';
    autoGrow();
    state.chips = [];
    renderChips();
  }
  const group = crypto.randomUUID();
  compareGroups.set(group, { prompt: text });
  const made = chosen.map((c) => {
    const chat = createChat({ title: `${c.label}: ${text}`.slice(0, 60) });
    chat.agent = c.id;
    if (c.account && c.account !== 'default') chat.agentAccount = c.account;
    chat.compare = group;
    chat.making = true;
    return chat;
  });
  switchChat(made[0].id);
  renderCompareBar();
  // One copy at a time: git doesn't like several worktrees being added at once.
  for (const [i, chat] of made.entries()) {
    try {
      chat.worktree = await desk.worktree.create(`${chosen[i].label} ${text}`.slice(0, 40));
      chat.wtCount = 0;
    } catch (err) {
      chat.making = false;
      appendChat(h('div', { class: 'turn-error' }, `Couldn't make a copy for ${chosen[i].label}: ${String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`), chat);
      continue;
    }
    chat.making = false;
    send(prompt, 'agent', text, chat);
  }
  renderChatTabs();
}

// The bar above a compared chat: every agent in the group, how it's doing, and what it changed.
function renderCompareBar() {
  const bar = $('#compare-bar');
  if (!bar) return;
  const chat = activeChat();
  const group = chat && chat.compare && chats.filter((c) => c.compare === chat.compare);
  if (!group || group.length < 2) return bar.classList.add('hidden');
  bar.classList.remove('hidden');
  const pill = (c) => {
    const n = (c.wtChanges || []).length;
    const gone = c.worktree && c.worktree.removed;
    const what = c.making ? 'copying…' : c.busy ? 'working…' : gone ? 'discarded' : c.merged ? 'merged' : n ? `${n} file${n > 1 ? 's' : ''}` : c.usage.turns || c.sessionId ? 'no changes' : 'waiting';
    return h(
      'button',
      {
        class: `compare-pill${c === chat ? ' active' : ''}${c.merged ? ' merged' : ''}${gone ? ' gone' : ''}`,
        title: c.title,
        onclick: () => switchChat(c.id),
      },
      c.busy || c.making ? h('span', { class: 'spinner' }) : h('span', { class: 'dot' }, c.merged ? '✓' : gone ? '–' : n ? '●' : '○'),
      h('b', {}, c.title.split(':')[0]),
      h('span', { class: 'muted small' }, what)
    );
  };
  bar.replaceChildren(
    ...[
      h(
        'span',
        {
          class: 'compare-label',
          title: (compareGroups.get(chat.compare) || {}).prompt || '',
        },
        `Same prompt, ${group.length} agents`
      ),
      ...group.map(pill),
    ].filter(Boolean)
  );
}

// Merge the picked agent's copy, then offer to delete the others' copies.
async function useComparison(chat) {
  const others = chats.filter((c) => c !== chat && c.compare === chat.compare && c.worktree && !c.worktree.removed);
  await mergeWorktree(chat, {
    after: async () => {
      chat.merged = true;
      renderCompareBar();
      if (!others.length) return;
      if (others.some((c) => c.busy)) return toast('Merged. The other agents are still working; their copies stay until you discard them.');
      if (!confirm(`Merged ${agentLabel(chat)}'s changes. Delete the other ${others.length} cop${others.length > 1 ? 'ies' : 'y'}? Their chats stay open to read.`)) return;
      for (const c of others) await discardWorktree(c, { silent: true });
      renderCompareBar();
    },
  });
}

function wireCompare() {
  const btn = $('#btn-compare');
  if (btn) btn.addEventListener('click', sendToSeveral);
}
