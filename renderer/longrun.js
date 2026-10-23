/* global $, h, state, desk, toast, modal, chats, chatById, activeChat, createChat, switchChat, renderChatTabs, appendChat, send, compareChoices, agentOf, agentInfo, agentLabel,
   queueSaveWorkspace, folderId, openPlanDoc, renderMarkdown, LIMIT_RE, CARRY_ON, autoPick, refreshWorktree, renderWorktreeBar, reviewWorktree, mergeWorktree, git */
'use strict';

// ------------------------------------------------------------------ long runs
//
// A big job left to run on its own, overnight say. You agree a plan of milestones first; then each
// milestone runs in a fresh chat (so the work doesn't get worse as one conversation fills up), in
// one copy of the folder on a branch of its own. A second agent checks each milestone against its
// "done when" before Switchdesk commits it. Questions never stop it: the agent picks what it would
// recommend and notes the question for the morning. At the end you get a summary to review, and
// nothing reaches your folder until you merge.

const RUN_FIX_ROUNDS = 2; // times a milestone goes back for fixes after a failed check
const RUN_NUDGES = 2; // times an agent that stopped without its report is told to carry on
const RUN_MOVES = 3; // times one milestone moves to another agent when one runs out of usage
const RUN_WAIT = 15 * 60 * 1000; // with every agent out of usage: try again this often
const RUN_MAX_FAILURES = 3; // milestones that don't work out before the run stops

const runCards = new Map(); // run id -> its card in the run's own chat
const runTimers = new Map(); // run id -> a retry while every agent is out of usage
const runDocs = new Map(); // run id -> its plan document
const liveRuns = new Map(); // run id -> the run, as this window is driving it

const runById = (id) => {
  if (!liveRuns.has(id)) {
    const saved = (state.settings.longRuns || []).find((r) => r.id === id);
    if (saved) liveRuns.set(id, saved);
  }
  return liveRuns.get(id) || null;
};
const allRuns = () => (state.settings.longRuns || []).map((r) => runById(r.id));
const folderRuns = () => allRuns().filter((r) => state.folder && r.folder === folderId());
const live = (r) => r && ['planning', 'ready', 'running', 'paused'].includes(r.phase);

async function saveRun(run) {
  liveRuns.set(run.id, run);
  // Other windows save their own runs too, so this one starts from what's saved now.
  const saved = ((await desk.getSettings()) || {}).longRuns || [];
  const others = saved.filter((r) => r.id !== run.id);
  // Finished runs from long ago drop off.
  const keep = [...others.filter((r) => live(r) || r.finished > Date.now() - 30 * 864e5), run];
  state.settings = await desk.setSettings({ longRuns: keep });
  renderRunCard(run);
  syncAwake();
}

// The computer stays awake while any run in this window is working.
function syncAwake() {
  desk.keepAwake(folderRuns().some((r) => r.phase === 'running')).catch(() => {});
}

// ------------------------------------------------------------------ prompts

function plannerPrompt(goal) {
  return `You're planning a long run that will work on its own, overnight, with nobody watching. It works through your plan one milestone at a time, each in a fresh session that only sees the goal, the list of milestones and short notes from the earlier ones.

The goal: ${goal}

Read whatever code you need to understand the project, but don't change anything. Then break the goal into milestones:
- Each is a focused piece of work one session can finish well, roughly 15 to 45 minutes. Split anything bigger rather than cramming it.
- In order, each building on the ones before it.
- Each has a concrete "done when" a reviewer can check: a test that passes, a command's output, or a behaviour to look for.
- Leave out anything only a person can do (accounts, payments, deploys, decisions only they can make). Mention those in your summary instead.

Say in a few sentences how you'll approach it. Then give the milestones as a fenced block marked \`milestones\` holding a JSON array, like this:

\`\`\`milestones
[{"title": "Add the settings page", "what": "A short paragraph on what to do and where.", "done_when": "npm test passes and the page opens from the menu", "after": []}]
\`\`\`

"after" lists the numbers (counting from 1) of earlier milestones this one needs. Leave it empty when it needs none.`;
}

const RUN_MARK = { done: '✓', failed: '✗', blocked: '✗', skipped: '–' };

function workerPrompt(run, i) {
  const m = run.milestones[i];
  const list = run.milestones.map((x, j) => `${j + 1}. ${j === i ? '→' : RUN_MARK[x.status] || ' '} ${x.title}`).join('\n');
  const notes = run.milestones
    .map((x, j) => (x.notes && j < i ? `- ${j + 1}. ${x.title}: ${x.notes}` : null))
    .filter(Boolean)
    .join('\n');
  return `You're working through a long run on your own. Nobody is watching, and nobody can answer questions until morning.

The overall goal: ${run.goal}

The milestones (✓ done, ✗ didn't work out, → yours):
${list}
${notes ? `\nNotes from earlier milestones:\n${notes}\n` : ''}
Your milestone, ${i + 1} of ${run.milestones.length}: ${m.title}
${m.what ? `What to do: ${m.what}\n` : ''}Done when: ${m.done_when || 'it works and fits the rest of the code'}
${m.resumed ? '\nAn earlier attempt at this milestone was interrupted, so some of its changes may already be here (see `git status`). Check what is there and finish it.\n' : ''}
How to work:
- Do only this milestone, completely and well. Later milestones are handled separately, so don't start them.
- Don't ask questions. When something is unclear, choose what you'd recommend, carry on, and note the question with the assumption you made.
- Check the "done when" yourself before you finish: run the test or command if there is one.
- Don't commit, push or open pull requests. Switchdesk commits each milestone once a reviewer has checked it.
- If you truly can't do it (it needs something only a person can provide), stop and report it as blocked.

Finish with a fenced block marked \`milestone\` holding JSON, like this:

\`\`\`milestone
{"status": "done", "summary": "What you did, in two or three sentences.", "questions": [{"question": "Should the export include archived rows?", "assumption": "Left them out"}], "notes": "Anything later milestones should know."}
\`\`\`

"status" is "done" or "blocked".`;
}

function checkerPrompt(run, i) {
  const m = run.milestones[i];
  return `You're checking one milestone of a long run before it's committed. Don't change any files.

The overall goal: ${run.goal}
The milestone: ${m.title}
${m.what ? `What it was meant to do: ${m.what}\n` : ''}Done when: ${m.done_when || 'it works and fits the rest of the code'}
What the agent says it did: ${m.summary || '(it gave no summary)'}

Its changes are everything since commit ${run.sha.slice(0, 12)}: see \`git status\` and \`git diff ${run.sha.slice(0, 12)}\`, including new files. Check them against "done when": run the check if it's a test or a command, and read the code for bugs or anything left unfinished. Be strict about "done when", but don't fail it over style or small things.

Finish with a fenced block marked \`verdict\` holding JSON, like this:

\`\`\`verdict
{"pass": false, "problems": ["The new test fails: total() returns NaN for an empty cart."]}
\`\`\`

When it passes, "problems" is empty. When it doesn't, give each problem as a short sentence the agent can act on.`;
}

const RUN_NUDGE = 'Nobody is around to answer, so carry on: choose what you would recommend, note the question and your assumption, and finish the milestone. End with the `milestone` block.';

// ------------------------------------------------------------------ the plan as a document

function fenced(text, tag) {
  const m = new RegExp('```' + tag + '\\s*\\n([\\s\\S]*?)```').exec(text || '');
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function cleanMilestones(list) {
  if (!Array.isArray(list)) return null;
  const out = list
    .filter((m) => m && m.title)
    .map((m) => ({ title: String(m.title).slice(0, 120), what: String(m.what || '').trim(), done_when: String(m.done_when || m.doneWhen || '').trim(), after: (Array.isArray(m.after) ? m.after : []).map((n) => parseInt(n, 10)).filter((n) => n > 0) }));
  return out.length ? out : null;
}

function planMarkdown(goal, milestones) {
  return [
    `# Long run: ${goal.split('\n')[0].slice(0, 80)}`,
    '',
    'Each milestone runs in a fresh chat and is checked before it is committed. Edit anything here, then press Build it to start the run.',
    '',
    ...milestones.flatMap((m, i) => [`## ${i + 1}. ${m.title}`, '', m.what || '', '', `**Done when:** ${m.done_when || ''}`, '', ...(m.after.length ? [`**After:** ${m.after.join(', ')}`, ''] : [])]),
  ].join('\n');
}

// Reads the milestones back from the plan document, as you may have edited it.
function parseMilestones(md) {
  const parts = md.split(/^##\s+/m).slice(1);
  const numbers = new Map(); // the number a heading had -> its place now
  const out = [];
  for (const part of parts) {
    const [head, ...rest] = part.split('\n');
    const num = /^(\d+)[.)]\s*/.exec(head);
    const title = head.replace(/^\d+[.)]\s*/, '').trim();
    if (!title) continue;
    if (num) numbers.set(+num[1], out.length + 1);
    let body = rest.join('\n');
    const take = (label) => {
      const re = new RegExp(`^\\s*\\*\\*${label}:?\\*\\*:?\\s*(.*)$`, 'im');
      const m = re.exec(body);
      if (!m) return '';
      body = body.replace(re, '');
      return m[1].trim();
    };
    const done = take('Done when');
    const after = take('After');
    out.push({ title, what: body.trim(), done_when: done, afterRaw: after });
  }
  return out.map(({ afterRaw, ...m }) => ({ ...m, after: (afterRaw.match(/\d+/g) || []).map((n) => numbers.get(+n) || +n).filter((n) => n > 0 && n <= out.length) }));
}

// ------------------------------------------------------------------ starting one

async function openLongRuns() {
  if (!state.folder) return toast('Open a folder first.');
  if (git.status && git.status.repo === false) return toast('Long runs work in a copy of the folder, so it needs to be a git repository. Use the Git panel to set one up.');
  const choices = await compareChoices();
  if (!choices.length) return toast('Sign in to an agent first (Settings → Agents).');
  const body = h('div', { class: 'body long-run-form' });
  const close = modal([body]);
  const goal = h('textarea', { rows: 5, placeholder: 'What should it get done? The more you say about the end result, the better the plan.', spellcheck: 'false' });
  goal.value = $('#input').value.trim();
  const own = agentOf(activeChat());
  const pickList = (sel) => h('select', {}, ...choices.map((c, i) => h('option', { value: String(i), selected: i === sel }, c.label)));
  const mine = Math.max(0, choices.findIndex((c) => c.id === own));
  const other = choices.findIndex((c, i) => i !== mine && c.id !== choices[mine].id);
  const worker = pickList(mine);
  const checker = pickList(other >= 0 ? other : mine);
  const allow = h('input', { type: 'checkbox', checked: true });
  const go = h('button', { class: 'btn primary' }, 'Plan it');
  const unfinished = folderRuns().filter(live);
  body.replaceChildren(
    h('h3', {}, 'Long run'),
    h('p', { class: 'muted small' }, 'For a big job left to run on its own. First the agent plans it as milestones for you to check. Then each milestone runs in a fresh chat, in its own copy of the folder, and a second agent checks it before it is committed. Questions never stop it: it notes them and its assumption for the morning.'),
    ...unfinished.map((r) => h('div', { class: 'schedule-row' }, h('div', { class: 'what' }, h('b', {}, r.title), h('div', { class: 'muted small' }, runState(r))), h('button', { class: 'btn small', onclick: () => (close(), showRun(r)) }, 'Open'))),
    goal,
    h('label', { class: 'inline' }, 'Does the work ', worker),
    h('label', { class: 'inline' }, 'Checks each milestone ', checker),
    h('label', { class: 'inline' }, allow, " Let it run commands and edit files without asking. Risky ones on your always-ask list are refused, so it never waits on you."),
    h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: close }, 'Cancel'), go)
  );
  goal.focus();
  go.addEventListener('click', () => {
    if (!goal.value.trim()) return goal.focus();
    close();
    const w = choices[+worker.value] || choices[0];
    const c = choices[+checker.value] || w;
    planRun(goal.value.trim(), w, c, allow.checked);
  });
}

async function planRun(goalText, worker, checker, allowAll) {
  const run = {
    id: crypto.randomUUID(),
    folder: folderId(),
    title: goalText.split('\n')[0].slice(0, 60),
    goal: goalText,
    worker: { id: worker.id, account: worker.account },
    checker: { id: checker.id, account: checker.account },
    allowAll,
    phase: 'planning',
    milestones: [],
    created: Date.now(),
  };
  const chat = runChat(run, `🌙 ${run.title}`, worker, { role: 'plan' });
  chat.making = true;
  renderWorktreeBar();
  try {
    chat.worktree = await desk.worktree.create(`long run ${run.title}`.slice(0, 40));
    chat.wtCount = 0;
    run.worktree = chat.worktree;
    run.sha = (await desk.worktree.head(chat.worktree)).sha;
  } catch (err) {
    chat.making = false;
    renderWorktreeBar();
    return toast(String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  }
  chat.making = false;
  run.chat = chat.id;
  renderChatTabs();
  renderWorktreeBar();
  await saveRun(run);
  showRunCard(run, chat);
  send(plannerPrompt(run.goal), 'ask', `Plan a long run: ${run.title}`, chat);
}

// A chat that belongs to a run. It shares the run's copy, which closing it doesn't delete.
function runChat(run, title, who, longRun) {
  const chat = createChat({ title: title.slice(0, 60) });
  chat.agent = who.id;
  chat.agentAccount = who.account && who.account !== 'default' ? who.account : undefined;
  chat.longRun = { run: run.id, ...longRun };
  if (run.worktree) chat.worktree = run.worktree;
  renderChatTabs();
  return chat;
}

// The planner's turn ended: show its milestones as a plan to edit, with Start the run.
function plannerDone(run, chat, text) {
  const list = cleanMilestones(fenced(text, 'milestones'));
  if (!list) return appendChat(h('div', { class: 'notice' }, 'No milestones came back yet. Reply in this chat to keep planning, and ask for the `milestones` block.'), chat);
  run.milestones = list.map((m) => ({ ...m, status: 'pending' }));
  run.phase = 'ready';
  saveRun(run);
  openRunPlan(run, chat);
}

// Build it on the plan, or Start the run on its card: the plan as it is in the document now.
function beginRun(run) {
  if (run.phase !== 'ready') return toast(run.phase === 'planning' ? 'Still planning. One moment.' : 'This run has already started.');
  const doc = runDocs.get(run.id);
  if (doc) {
    const list = parseMilestones(doc.text());
    if (!list.length) return toast('The plan needs at least one milestone, as a "## " heading.');
    run.milestones = list.map((m) => ({ ...m, status: 'pending' }));
    doc.resolve('Running. Each milestone is checked before it is committed.', 'building');
  }
  startRun(run);
}

function openRunPlan(run, chat) {
  const doc = openPlanDoc(planMarkdown(run.goal, run.milestones), {
    chat,
    onBuild: () => beginRun(run),
    onKeep: (feedback) => {
      send(`Keep planning.${feedback ? ` My feedback: ${feedback}` : ''} Here is the plan as it stands:\n\n${doc.text()}\n\nRevise it and give the whole list again as the \`milestones\` block.`, 'ask', feedback ? `Keep planning: ${feedback}` : 'Keep planning', chat);
      doc.resolve('Sent back for revision.', 'sent');
    },
  });
  runDocs.set(run.id, doc);
  appendChat(h('div', { class: 'notice' }, `The plan has ${run.milestones.length} milestone${run.milestones.length > 1 ? 's' : ''}. It's open as a document: edit it, then press Build it to start the run.`), chat);
}

// ------------------------------------------------------------------ running

async function startRun(run) {
  run.phase = 'running';
  run.started = run.started || Date.now();
  run.failures = run.failures || 0;
  await saveRun(run);
  nextMilestone(run);
}

function depsMet(run, m) {
  return (m.after || []).every((n) => !run.milestones[n - 1] || run.milestones[n - 1].status === 'done');
}

async function nextMilestone(run) {
  if (run.phase !== 'running') return;
  const i = run.milestones.findIndex((m) => !['done', 'failed', 'blocked', 'skipped'].includes(m.status));
  if (i < 0 || run.failures >= RUN_MAX_FAILURES) return finishRun(run);
  const m = run.milestones[i];
  if (!depsMet(run, m)) {
    m.status = 'skipped';
    m.summary = `Skipped: it needs milestone ${m.after.filter((n) => run.milestones[n - 1].status !== 'done').join(' and ')}, which didn't work out.`;
    await saveRun(run);
    return nextMilestone(run);
  }
  m.resumed = m.status !== 'pending';
  m.status = 'working';
  m.rounds = m.rounds || 0;
  m.nudges = 0;
  m.moves = 0;
  await saveRun(run);
  const was = activeChat();
  const w = runChat(run, `🌙 ${i + 1}/${run.milestones.length} ${m.title}`, run.worker, { role: 'work', i });
  m.chat = w.id;
  followAlong(was, w);
  send(workerPrompt(run, i), 'agent', `Milestone ${i + 1} of ${run.milestones.length}: ${m.title}`, w);
}

// A run's new chat comes to the front only if you were already watching the run.
function followAlong(was, chat) {
  if (was && was !== chat && !was.longRun) switchChat(was.id);
}

// Every turn in a run's chat ends here (chat.js).
async function longRunTurnEnded(chat, turn, ev) {
  const run = runById(chat.longRun.run);
  if (!run) return;
  const text = turn ? (turn.replyTexts || []).map((b) => b.text).join('\n\n') : '';
  const role = chat.longRun.role;
  // The run's card shows what these blocks say, so the raw JSON isn't needed in the chat.
  const hide = () => {
    for (const code of chat.el.querySelectorAll('pre code.language-milestones, pre code.language-milestone, pre code.language-verdict')) code.closest('pre').remove();
  };
  hide();
  setTimeout(hide, 100); // after the reply's last render
  if (role === 'plan') {
    if (run.phase === 'planning' || run.phase === 'ready') return !ev.is_error && turn && !turn.interrupted && plannerDone(run, chat, text);
    return;
  }
  const i = chat.longRun.i;
  const m = run.milestones[i];
  if (!m || run.phase === 'done' || run.phase === 'stopped') return;
  if (turn && turn.interrupted && turn.forQueued) return; // your message goes next; its turn carries the run on
  if (!turn || turn.interrupted) {
    // You pressed Stop: the run waits for you.
    run.phase = 'paused';
    run.why = 'You stopped it.';
    return saveRun(run);
  }
  if (ev.is_error) return turnFailed(run, chat, m, String(ev.result || (ev.errors || []).join('\n')));
  m.moves = 0;
  if (run.phase !== 'running') return; // paused: picks up from here when you resume
  if (role === 'work') return workDone(run, chat, i, text);
  if (role === 'check') return checkDone(run, chat, i, text);
}

async function turnFailed(run, chat, m, error) {
  if (LIMIT_RE.test(error)) {
    // Out of usage: carry on in another agent with room, or wait for one to reset.
    if (m.moves < RUN_MOVES) {
      m.moves++;
      const pick = await autoPick(chat).catch(() => null);
      if (pick) return send(CARRY_ON, null, null, chat);
    }
    run.why = `Every agent is out of usage. Trying again every ${RUN_WAIT / 60000} minutes.`;
    await saveRun(run);
    clearTimeout(runTimers.get(run.id));
    runTimers.set(
      run.id,
      setTimeout(() => {
        runTimers.delete(run.id);
        if (run.phase !== 'running' || !chats.includes(chat)) return;
        run.why = '';
        m.moves = 0;
        send(CARRY_ON, null, null, chat);
      }, RUN_WAIT)
    );
    return;
  }
  // Any other error: try again a couple of times, then let the milestone go.
  m.errors = (m.errors || 0) + 1;
  if (m.errors <= 2 && run.phase === 'running') return send(`The last turn stopped with an error: ${error.slice(0, 500)}\n\nCarry on with the milestone.`, 'agent', 'Carry on after the error', chat);
  return giveUp(run, chat.longRun.i, 'failed', `It kept stopping with an error: ${error.slice(0, 300)}`);
}

async function workDone(run, chat, i, text) {
  const m = run.milestones[i];
  const report = fenced(text, 'milestone');
  if (!report) {
    // It stopped to ask something, or forgot its report.
    if (m.nudges < RUN_NUDGES) {
      m.nudges++;
      return send(RUN_NUDGE, 'agent', 'Carry on (nobody is around to answer)', chat);
    }
    m.summary = text.trim().slice(0, 600);
  } else {
    m.summary = String(report.summary || '').slice(0, 1200);
    m.notes = String(report.notes || '').slice(0, 800);
    m.questions = [...(m.questions || []), ...(Array.isArray(report.questions) ? report.questions : []).filter((q) => q && q.question).map((q) => ({ question: String(q.question), assumption: String(q.assumption || '') }))];
  }
  if (report && report.status === 'blocked') return giveUp(run, i, 'blocked', m.summary || 'It needs something only a person can provide.');
  m.status = 'checking';
  await saveRun(run);
  const was = activeChat();
  let c = m.checkChat && chatById(m.checkChat);
  if (c) return send('The agent changed it to fix those problems. Check it again the same way, and finish with the `verdict` block.', 'agent', 'Check it again', c);
  c = runChat(run, `🌙 Check ${i + 1}/${run.milestones.length}`, run.checker, { role: 'check', i });
  m.checkChat = c.id;
  followAlong(was, c);
  send(checkerPrompt(run, i), 'agent', `Check milestone ${i + 1}: ${m.title}`, c);
}

async function checkDone(run, chat, i, text) {
  const m = run.milestones[i];
  const v = fenced(text, 'verdict');
  if (!v && !m.verdictNudged) {
    m.verdictNudged = true;
    return send('Finish with the `verdict` block, please.', 'agent', 'Give the verdict', chat);
  }
  m.verdictNudged = false;
  const problems = v && Array.isArray(v.problems) ? v.problems.map(String).filter(Boolean) : [];
  if (!v || v.pass || !problems.length) {
    if (!v) m.checkNote = 'The checker gave no verdict, so it was committed unchecked.';
    return commitMilestone(run, i);
  }
  m.problems = problems;
  if (m.rounds >= RUN_FIX_ROUNDS) return giveUp(run, i, 'failed', `It still didn't pass its check after ${RUN_FIX_ROUNDS} rounds of fixes: ${problems.join(' ')}`);
  m.rounds++;
  m.status = 'working';
  m.nudges = 0;
  await saveRun(run);
  const w = chatById(m.chat);
  if (!w) return giveUp(run, i, 'failed', 'Its chat was closed.');
  send(`${agentLabel(chat)} checked it against "done when" and found:\n\n${problems.map((p) => `- ${p}`).join('\n')}\n\nFix these, check "done when" again, and finish with the \`milestone\` block.`, 'agent', `Fix what the check found (round ${m.rounds})`, w);
}

async function commitMilestone(run, i) {
  const m = run.milestones[i];
  try {
    const r = await desk.worktree.commit(run.worktree, `${m.title}\n\nLong run milestone ${i + 1} of ${run.milestones.length}: ${run.title}`);
    m.commit = r.committed ? r.sha : null;
    run.sha = r.sha;
  } catch (err) {
    return giveUp(run, i, 'failed', `Committing it failed: ${String(err.message || err).slice(0, 300)}`);
  }
  m.status = 'done';
  closeCheck(m);
  await saveRun(run);
  nextMilestone(run);
}

// A milestone that didn't work out: its changes go to a branch of their own, and the run moves on.
async function giveUp(run, i, status, why) {
  const m = run.milestones[i];
  m.status = status;
  m.why = why;
  try {
    m.setAside = await desk.worktree.setAside(run.worktree, `milestone ${i + 1}`, run.sha);
  } catch {
    /* nothing to keep */
  }
  run.failures = (run.failures || 0) + 1;
  closeCheck(m);
  await saveRun(run);
  nextMilestone(run);
}

function closeCheck(m) {
  const c = m.checkChat && chatById(m.checkChat);
  m.checkChat = null;
  if (!c || c.busy) return;
  desk.chatClose(c.id);
  c.el.remove();
  chats.splice(chats.indexOf(c), 1);
  if (activeChat() === null && chats.length) switchChat(chats[chats.length - 1].id);
  renderChatTabs();
}

async function finishRun(run, stopped) {
  clearTimeout(runTimers.get(run.id));
  run.phase = stopped ? 'stopped' : 'done';
  run.finished = Date.now();
  await saveRun(run);
  if (runDocs.has(run.id)) runDocs.get(run.id).resolve(`${doneCount(run)} of ${run.milestones.length} milestones done. See the summary in the run's chat.`, 'built');
  const chat = chatById(run.chat);
  if (chat) {
    refreshWorktree(chat);
    appendChat(summaryCard(run), chat);
    // If you were following the run, the summary is what you come back to.
    if (!activeChat() || activeChat().longRun) switchChat(chat.id);
  }
  try {
    const n = new Notification('Switchdesk', { body: `Long run ${stopped ? 'stopped' : 'finished'}: ${doneCount(run)} of ${run.milestones.length} milestones done. ${run.title}` });
    n.onclick = () => (window.focus(), chat && switchChat(chat.id));
  } catch {
    /* notifications off */
  }
  desk.flashWindow && desk.flashWindow();
}

const doneCount = (run) => run.milestones.filter((m) => m.status === 'done').length;

// ------------------------------------------------------------------ the run's card

const RUN_STATUS_TEXT = { pending: 'Waiting', working: 'Working', checking: 'Being checked', done: 'Done', failed: "Didn't work out", blocked: 'Blocked', skipped: 'Skipped' };
const RUN_STATUS_ICON = { pending: '○', working: '◐', checking: '◑', done: '✓', failed: '✗', blocked: '✗', skipped: '–' };

function runState(run) {
  const n = run.milestones.length;
  if (run.phase === 'planning') return 'Planning';
  if (run.phase === 'ready') return `Planned: ${n} milestones, waiting for you to start it`;
  if (run.phase === 'paused') return `Paused at ${doneCount(run)} of ${n} done${run.why ? `. ${run.why}` : ''}`;
  if (run.phase === 'running') return `${doneCount(run)} of ${n} done${run.why ? `. ${run.why}` : ''}`;
  return `${run.phase === 'stopped' ? 'Stopped' : 'Finished'}: ${doneCount(run)} of ${n} done`;
}

function showRunCard(run, chat) {
  const card = h('div', { class: 'card long-run' });
  runCards.set(run.id, card);
  appendChat(card, chat);
  renderRunCard(run);
}

function renderRunCard(run) {
  const card = runCards.get(run.id);
  if (!card) return;
  const n = run.milestones.length;
  const elapsed = run.started ? Math.round(((run.finished || Date.now()) - run.started) / 60000) : 0;
  const btn = (label, fn, cls = '') => h('button', { class: `btn small ${cls}`, onclick: fn }, label);
  card.replaceChildren(
    h('div', { class: 'row' }, h('h4', {}, `🌙 ${run.title}`), h('span', { class: 'spacer' }), h('span', { class: 'muted small' }, runState(run), elapsed ? ` · ${elapsed < 120 ? `${elapsed} min` : `${Math.round(elapsed / 6) / 10} h`}` : '')),
    h('div', { class: 'muted small' }, `${agentInfo(run.worker.id).label} does the work, ${agentInfo(run.checker.id).label} checks it. On branch ${run.worktree ? run.worktree.branch : '…'}.`),
    ...run.milestones.map((m, i) =>
      h(
        'div',
        { class: `run-step ${m.status}` },
        h('span', { class: 'todo-icon' }, RUN_STATUS_ICON[m.status] || '○'),
        h('span', {}, `${i + 1}. ${m.title}`),
        h('span', { class: 'muted small' }, ` · ${RUN_STATUS_TEXT[m.status] || ''}${m.rounds ? ` (fixed ${m.rounds}×)` : ''}`),
        m.chat && chatById(m.chat) ? h('a', { href: '#', class: 'small', onclick: (e) => (e.preventDefault(), switchChat(m.chat)) }, ' open') : null
      )
    ),
    h(
      'div',
      { class: 'actions' },
      run.phase === 'ready' && n ? btn('Start the run', () => beginRun(run), 'primary') : null,
      run.phase === 'running' ? btn('Pause after this step', () => ((run.phase = 'paused'), (run.why = 'You paused it.'), saveRun(run))) : null,
      run.phase === 'paused' ? btn('Resume', () => resumeRun(run), 'primary') : null,
      run.phase === 'ready' ? btn('Cancel', () => finishRun(run, true)) : null,
      run.phase === 'running' || run.phase === 'paused' ? btn('Stop and summarise', () => confirm('Stop the run? Finished milestones stay committed on its branch.') && finishRun(run, true), 'danger') : null
    )
  );
}

function summaryCard(run) {
  const qs = run.milestones.flatMap((m, i) => (m.questions || []).map((q) => ({ ...q, i })));
  const lines = [
    `### ${run.phase === 'stopped' ? 'Stopped' : 'Done'}: ${doneCount(run)} of ${run.milestones.length} milestones`,
    '',
    ...run.milestones.map((m, i) => `- ${RUN_STATUS_ICON[m.status] || '○'} **${i + 1}. ${m.title}**${m.commit ? ` (\`${m.commit.slice(0, 7)}\`)` : ''}: ${m.status === 'done' ? m.summary || 'Done.' : m.why || RUN_STATUS_TEXT[m.status]}${m.checkNote ? ` ${m.checkNote}` : ''}${m.setAside ? ` Its changes are kept on \`${m.setAside}\`.` : ''}`),
    '',
    ...(qs.length ? ['**Questions it answered for itself**', '', ...qs.map((q) => `- ${q.i + 1}. ${q.question} *Assumed: ${q.assumption || 'not said'}*`), ''] : []),
    `Everything is on branch \`${run.worktree.branch}\`. Nothing is in your folder until you merge.`,
  ];
  const body = h('div', { class: 'msg-text' });
  renderMarkdown(body, lines.join('\n'));
  const chat = chatById(run.chat);
  return h(
    'div',
    { class: 'card long-run summary' },
    h('h4', {}, `🌙 Morning summary: ${run.title}`),
    body,
    chat ? h('div', { class: 'actions' }, h('button', { class: 'btn small', onclick: () => reviewWorktree(chat) }, 'Review the changes'), h('button', { class: 'btn small primary', onclick: () => mergeWorktree(chat) }, 'Merge into my folder')) : null
  );
}

function showRun(run) {
  const chat = chatById(run.chat) || chats.find((c) => c.longRun && c.longRun.run === run.id && c.longRun.role === 'plan');
  if (!chat) return toast("The run's chat isn't open any more.");
  switchChat(chat.id);
}

async function resumeRun(run) {
  run.phase = 'running';
  run.why = '';
  await saveRun(run);
  // A milestone whose chat is still open and waiting carries on there; otherwise it starts afresh.
  const m = run.milestones.find((x) => x.status === 'working' || x.status === 'checking');
  const c = m && chatById(m.status === 'checking' ? m.checkChat : m.chat);
  if (c && !c.busy) return send(m.status === 'checking' ? 'Carry on checking, and finish with the `verdict` block.' : 'Carry on with the milestone, and finish with the `milestone` block.', 'agent', 'Carry on', c);
  if (c && c.busy) return; // its turn ending carries the run on
  nextMilestone(run);
}

// ------------------------------------------------------------------ approvals and restarts

// Nobody is watching a run, so nothing it asks may wait for an answer.
function longRunApproval(chat, req, allow, deny) {
  const run = runById(chat.longRun.run);
  if (req.toolName === 'AskUserQuestion') return deny('Nobody is around to answer during this long run. Choose the option you would recommend, carry on, and note the question and your assumption in your report.'), true;
  if (chat.longRun.role === 'plan' || !run) return false; // planning happens with you there
  if (req.toolName === 'ExitPlanMode') return allow(), true;
  if (req.askRule) return deny(`This long run runs unattended, so "${req.askRule}" isn't allowed. Find another way, or leave it and note it in your report.`), true;
  if (run.allowAll) return allow(), true;
  return deny('This long run runs unattended and was started without permission to run that. Find another way, or note it in your report.'), true;
}

// The run's chat is open again after a restart: show its card, and a run that was working waits.
function longRunRestored(chat) {
  const run = chat.longRun && runById(chat.longRun.run);
  if (!run || chat.longRun.role !== 'plan') return;
  run.chat = chat.id;
  if (run.phase === 'running') {
    run.phase = 'paused';
    run.why = 'Switchdesk closed while it was working. Resume to carry on.';
    for (const m of run.milestones) if (m.status === 'working' || m.status === 'checking') (m.chat = null), (m.checkChat = null);
  }
  if (run.phase === 'planning') run.phase = 'ready';
  saveRun(run);
  showRunCard(run, chat);
  if (run.phase === 'done' || run.phase === 'stopped') appendChat(summaryCard(run), chat);
}

// Whether the run this chat belongs to is still going (its copy can't be discarded then).
function longRunBusy(chat) {
  const run = chat.longRun && runById(chat.longRun.run);
  return !!run && ['running', 'paused'].includes(run.phase);
}

function wireLongRuns() {
  const btn = $('#btn-long-run');
  if (btn) btn.addEventListener('click', () => openLongRuns());
}
