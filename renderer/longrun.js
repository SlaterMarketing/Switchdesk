/* global $, h, state, desk, toast, modal, chats, chatById, activeChat, createChat, switchChat, renderChatTabs, appendChat, send, compareChoices, agentOf, agentInfo, agentLabel,
   queueSaveWorkspace, folderId, openPlanDoc, activeTab, activateTab, openSession, renderMarkdown, LIMIT_RE, CARRY_ON, CARRY_ON_RESET, RESET_SLACK, atText, limitResetAt, autoPick, cancelCarryOn, refreshWorktree, renderWorktreeBar, reviewWorktree, mergeWorktree, git */
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
const RUN_MAX_FAILURES = 3; // milestones that don't work out before the run stops

const runCards = new Map(); // run id -> its card in the run's own chat
const runTimers = new Map(); // run id -> { at, chat }: waiting for a limit to reset
const runDocs = new Map(); // run id -> its plan document
const liveRuns = new Map(); // run id -> the run, as this window is driving it
const runChecks = new Set(); // run ids running a milestone's check command right now
const runWaitCards = new Map(); // `run id:milestone id` -> the card asking you to do it

const runById = (id) => {
  if (!liveRuns.has(id)) {
    const saved = (state.settings.longRuns || []).find((r) => r.id === id);
    if (saved) liveRuns.set(id, withIds(saved, saved.milestones));
  }
  return liveRuns.get(id) || null;
};
const allRuns = () => (state.settings.longRuns || []).map((r) => runById(r.id));
const folderRuns = () => allRuns().filter((r) => state.folder && r.folder === folderId());
const live = (r) => r && ['planning', 'ready', 'running', 'paused', 'waiting'].includes(r.phase);

// Milestones have ids (m1, m2…) so re-planning can add, drop and reorder them. Plans number them
// from 1, so numbers in "after" become ids here.
function withIds(run, list) {
  run.nextId = Math.max(run.nextId || 0, ...list.map((m) => +(/^m(\d+)$/.exec(m.id || '') || [])[1] || 0));
  for (const m of list) if (!m.id) m.id = `m${++run.nextId}`;
  for (const m of list) m.after = (m.after || []).map((a) => (typeof a === 'number' ? list[a - 1] && list[a - 1].id : a)).filter((a) => a && a !== m.id);
  run.milestones = list;
  return run;
}
const msById = (run, id) => run.milestones.find((m) => m.id === id);
const msNum = (run, m) => run.milestones.indexOf(m) + 1;

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
- Where a single command can prove it (the tests, a build, a script), give it as "check". Switchdesk runs it itself before committing, and the milestone only counts when it exits successfully. It runs in the project folder; leave it out when no command can tell.
- When the work needs a person partway through (to try it out, play-test it, or make a call only they can), add a milestone for that with "needs_you" saying what they should do. The run waits for them there and carries on meanwhile with anything that doesn't depend on it.
- Leave out what can't happen without a person at all (accounts, payments, deploys), and mention it in your summary instead.

Say in a few sentences how you'll approach it. Then give the milestones as a fenced block marked \`milestones\` holding a JSON array, like this:

\`\`\`milestones
[{"title": "Add the settings page", "what": "A short paragraph on what to do and where.", "done_when": "the tests pass and the page opens from the menu", "check": "npm test", "after": []},
 {"title": "Try the settings page", "needs_you": "Open Settings and say whether the layout works", "after": [1]}]
\`\`\`

"after" lists the numbers (counting from 1) of earlier milestones this one needs. Leave it empty when it needs none.`;
}

const RUN_MARK = { done: '✓', failed: '✗', blocked: '✗', skipped: '–', waiting: '…' };

function workerPrompt(run, i) {
  const m = run.milestones[i];
  const list = run.milestones.map((x, j) => `${j + 1}. ${j === i ? '→' : RUN_MARK[x.status] || ' '} ${x.title}`).join('\n');
  const notes = run.milestones
    .map((x, j) => (x.feedback ? `- ${j + 1}. ${x.title} (from the person running this): ${x.feedback}` : x.notes && x.status === 'done' ? `- ${j + 1}. ${x.title}: ${x.notes}` : null))
    .filter(Boolean)
    .join('\n');
  return `You're working through a long run on your own. Nobody is watching, and nobody can answer questions until morning.

The overall goal: ${run.goal}

The milestones (✓ done, ✗ didn't work out, … waiting for the person, → yours):
${list}
${notes ? `\nNotes from earlier milestones:\n${notes}\n` : ''}
Your milestone, ${i + 1} of ${run.milestones.length}: ${m.title}
${m.what ? `What to do: ${m.what}\n` : ''}Done when: ${m.done_when || 'it works and fits the rest of the code'}
${m.check ? `Switchdesk checks it by running \`${m.check}\` in the project folder: it only counts when that succeeds, so make sure it does.\n` : ''}${m.resumed ? '\nAn earlier attempt at this milestone was interrupted, so some of its changes may already be here (see `git status`). Check what is there and finish it.\n' : ''}
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
${m.checkRun && m.checkRun.ok ? `Switchdesk ran \`${m.check}\` and it passed, so you don't need to run that again.\n` : ''}
Its changes are everything since commit ${run.sha.slice(0, 12)}: see \`git status\` and \`git diff ${run.sha.slice(0, 12)}\`, including new files. Check them against "done when": run the check if it's a test or a command, and read the code for bugs or anything left unfinished. Be strict about "done when", but don't fail it over style or small things.

Finish with a fenced block marked \`verdict\` holding JSON, like this:

\`\`\`verdict
{"pass": false, "problems": ["The new test fails: total() returns NaN for an empty cart."]}
\`\`\`

When it passes, "problems" is empty. When it doesn't, give each problem as a short sentence the agent can act on.`;
}

const RUN_NUDGE = 'Nobody is around to answer, so carry on: choose what you would recommend, note the question and your assumption, and finish the milestone. End with the `milestone` block.';

// ------------------------------------------------------------------ the plan as a document

// The last block marked `tag` in an agent's reply, as JSON. Agents often write Windows paths with
// single backslashes (C:\Users\…), which isn't valid JSON, so those are read as written.
function fenced(text, tag) {
  const all = [...String(text || '').matchAll(new RegExp('```' + tag + '[ \\t]*\\r?\\n([\\s\\S]*?)```', 'g'))];
  if (!all.length) return null;
  const body = all[all.length - 1][1].trim();
  for (const src of [body, body.replace(/\\(?!["\\/bfnrtu])/g, '\\\\'), body.replace(/\\/g, '\\\\')]) {
    try {
      return JSON.parse(src);
    } catch {
      /* try the next way */
    }
  }
  // Still not JSON: a report is a report. Take what can be read from it.
  const field = (k) => (new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(body) || [])[1];
  const pass = /"pass"\s*:\s*(true|false)/.exec(body);
  return { status: field('status') || 'done', summary: field('summary') || '', notes: field('notes') || '', pass: pass ? pass[1] === 'true' : undefined, problems: [], unreadable: true };
}

function cleanMilestones(list) {
  if (!Array.isArray(list)) return null;
  const out = list
    .filter((m) => m && m.title)
    .map((m) => ({
      id: m.id ? String(m.id) : undefined,
      title: String(m.title).slice(0, 120),
      what: String(m.what || '').trim(),
      done_when: String(m.done_when || m.doneWhen || '').trim(),
      check: String(m.check || '').trim().replace(/^`+|`+$/g, ''),
      needs_you: String(m.needs_you || m.needsYou || '').trim(),
      after: (Array.isArray(m.after) ? m.after : []).map((n) => (/^m\d+$/.test(String(n)) ? String(n) : parseInt(n, 10))).filter((n) => typeof n === 'string' || n > 0),
    }));
  return out.length ? out : null;
}

function planMarkdown(goal, milestones) {
  return [
    `# Long run: ${goal.split('\n')[0].slice(0, 80)}`,
    '',
    'Each milestone runs in a fresh chat and is checked before it is committed. Edit anything here, then press Build it to start the run.',
    '',
    ...milestones.flatMap((m, i) => [
      `## ${i + 1}. ${m.title}`,
      '',
      m.what || '',
      '',
      ...(m.needs_you ? [`**Needs you:** ${m.needs_you}`, ''] : [`**Done when:** ${m.done_when || ''}`, '']),
      ...(m.check ? [`**Check:** \`${m.check}\``, ''] : []),
      ...(m.after.length ? [`**After:** ${m.after.map((a) => (typeof a === 'number' ? a : milestones.findIndex((x) => x.id === a) + 1)).filter((n) => n > 0).join(', ')}`, ''] : []),
    ]),
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
    const check = take('Check').replace(/^`+|`+$/g, '');
    const needs = take('Needs you');
    const after = take('After');
    out.push({ title, what: body.trim(), done_when: done, check, needs_you: needs, afterRaw: after });
  }
  return out.map(({ afterRaw, ...m }) => ({ ...m, after: (afterRaw.match(/\d+/g) || []).map((n) => numbers.get(+n) || +n).filter((n) => n > 0 && n <= out.length) }));
}

// ------------------------------------------------------------------ starting one

// The 🌙 button: the folder's run that's going, or a new one.
function longRunButton() {
  const run = folderRuns().find((r) => ['running', 'paused', 'waiting', 'ready'].includes(r.phase));
  return run ? openRunPage(run) : openLongRuns();
}

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
  const replan = h('input', { type: 'checkbox', checked: true });
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
    h('label', { class: 'inline' }, replan, ' After each milestone, look again at what’s left and adjust the plan'),
    h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: close }, 'Cancel'), go)
  );
  goal.focus();
  go.addEventListener('click', () => {
    if (!goal.value.trim()) return goal.focus();
    close();
    const w = choices[+worker.value] || choices[0];
    const c = choices[+checker.value] || w;
    planRun(goal.value.trim(), w, c, allow.checked, replan.checked);
  });
}

async function planRun(goalText, worker, checker, allowAll, replan = true) {
  const run = {
    id: crypto.randomUUID(),
    folder: folderId(),
    title: goalText.split('\n')[0].slice(0, 60),
    goal: goalText,
    worker: { id: worker.id, account: worker.account },
    checker: { id: checker.id, account: checker.account },
    allowAll,
    replan,
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
  run.nextId = 0;
  withIds(run, list.map(({ id, ...m }) => ({ ...m, status: 'pending' })));
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
    run.nextId = 0;
    withIds(run, list.map((m) => ({ ...m, status: 'pending' })));
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
  openRunPage(run);
  nextMilestone(run);
}

// A milestone you skipped (a play-test, say) doesn't hold up what comes after it.
const depOk = (d) => d.status === 'done' || (d.status === 'skipped' && d.needs_you);
const depDead = (d) => ['failed', 'blocked', 'skipped'].includes(d.status) && !depOk(d);

// The next milestone whose earlier ones are done. One that needs you waits for you, and the run
// carries on meanwhile with anything that doesn't depend on it.
async function nextMilestone(run) {
  if (!['running', 'waiting'].includes(run.phase) || run.replanning) return;
  if (run.failures >= RUN_MAX_FAILURES) return finishRun(run);
  // A milestone that was under way when its chat went (a restart) starts again.
  const going = run.milestones.find((m) => m.status === 'working' || m.status === 'checking');
  if (going) return runChecks.has(run.id) || chatById(going.status === 'checking' && going.checkChat ? going.checkChat : going.chat) ? undefined : startMilestone(run, run.milestones.indexOf(going));
  for (const m of run.milestones) {
    if (m.status !== 'pending') continue;
    const deps = (m.after || []).map((a) => msById(run, a)).filter(Boolean);
    const dead = deps.filter(depDead);
    if (dead.length) {
      m.status = 'skipped';
      m.summary = `Skipped: it needs milestone ${dead.map((d) => msNum(run, d)).join(' and ')}, which didn't work out.`;
      await saveRun(run);
      return nextMilestone(run);
    }
    if (!deps.every(depOk)) continue;
    if (m.needs_you) {
      await askYou(run, m);
      continue;
    }
    return startMilestone(run, run.milestones.indexOf(m));
  }
  if (run.milestones.some((m) => m.status === 'waiting')) {
    // Nothing else can go on without you.
    run.phase = 'waiting';
    run.why = '';
    return saveRun(run);
  }
  finishRun(run);
}

async function startMilestone(run, i) {
  const m = run.milestones[i];
  run.phase = 'running';
  m.resumed = m.status !== 'pending';
  m.status = 'working';
  m.startedAt = m.startedAt || Date.now();
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

// ------------------------------------------------------------------ milestones that need you

async function askYou(run, m) {
  m.status = 'waiting';
  m.startedAt = Date.now();
  await saveRun(run);
  showWaitCard(run, m);
  try {
    const n = new Notification('Switchdesk', { body: `Long run: your turn. ${m.title}` });
    n.onclick = () => (window.focus(), openRunPage(run));
  } catch {
    /* notifications off */
  }
  desk.flashWindow && desk.flashWindow();
}

// The card in the run's chat (and on your phone) for a milestone that needs you.
function showWaitCard(run, m) {
  const chat = chatById(run.chat);
  const key = `${run.id}:${m.id}`;
  if (!chat || runWaitCards.has(key)) return;
  const say = h('textarea', { rows: 2, placeholder: 'How did it go? Anything the run should know (optional)', spellcheck: 'false' });
  const card = h(
    'div',
    { class: 'card approval long-run-wait' },
    h('h4', {}, `🌙 Your turn: ${m.title}`),
    h('div', {}, m.needs_you),
    m.what ? h('div', { class: 'muted small' }, m.what) : null,
    say,
    h('div', { class: 'actions' }, h('button', { class: 'btn small primary', onclick: () => answerWait(run, m.id, 'done', say.value) }, 'Done'), h('button', { class: 'btn small', onclick: () => answerWait(run, m.id, 'skipped', say.value) }, 'Skip it'))
  );
  card.phone = {
    title: `Long run: ${m.title}`,
    detail: m.needs_you,
    choices: [
      { id: 'done', label: 'Done' },
      { id: 'skipped', label: 'Skip it' },
    ],
    pick: (choice) => answerWait(run, m.id, choice === 'done' ? 'done' : 'skipped', ''),
  };
  runWaitCards.set(key, card);
  appendChat(card, chat);
}

function closeWaitCard(run, m, said) {
  const key = `${run.id}:${m.id}`;
  const card = runWaitCards.get(key);
  runWaitCards.delete(key);
  if (!card) return;
  card.classList.add('resolved');
  card.phone = null;
  card.replaceChildren(h('h4', {}, `🌙 ${m.title}`), h('div', { class: 'muted small' }, said));
}

async function answerWait(run, id, how, feedback) {
  const m = msById(run, id);
  if (!m || m.status !== 'waiting') return;
  m.status = how;
  m.feedback = String(feedback || '').trim().slice(0, 2000);
  m.summary = how === 'done' ? (m.feedback ? `You said: ${m.feedback}` : 'You did it.') : `You skipped it.${m.feedback ? ` You said: ${m.feedback}` : ''}`;
  m.endedAt = Date.now();
  closeWaitCard(run, m, how === 'done' ? 'Done. The run carries on.' : 'Skipped. The run carries on.');
  if (run.phase === 'waiting') run.phase = 'running';
  await saveRun(run);
  if (run.phase === 'running') nextMilestone(run);
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
    if (run.replanning) return replanDone(run, ev.is_error || !turn || turn.interrupted ? '' : text);
    return;
  }
  const i = chat.longRun.i;
  const m = run.milestones[i];
  if (!m || run.phase === 'done' || run.phase === 'stopped') return;
  // Only the turn the run is waiting on moves it on: not a later turn of a chat it has finished with.
  if (role === 'work' ? m.status !== 'working' || (m.chat && m.chat !== chat.id) : m.status !== 'checking' || (m.checkChat && m.checkChat !== chat.id)) return;
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
    // Every agent is out: wait for this one's limit to reset (watchRuns carries it on then).
    const at = limitResetAt(chat) + RESET_SLACK;
    run.why = `Every agent is out of usage. It carries on by itself ${atText(at)}, when the limit resets.`;
    runTimers.set(run.id, { at, chat: chat.id });
    await saveRun(run);
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
  if (m.check) {
    // Switchdesk runs the milestone's check itself, so "it passes" doesn't rest on the agent's word.
    runChecks.add(run.id);
    m.checkRun = { running: true };
    renderRunPage();
    try {
      const r = await desk.worktree.run(run.worktree, m.check);
      m.checkRun = { ok: r.ok, code: r.code, timedOut: r.timedOut, ms: r.ms, output: String(r.output || '').slice(-1500) };
    } catch (err) {
      m.checkRun = { error: String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '').slice(0, 300) };
    }
    runChecks.delete(run.id);
    if (run.phase === 'done' || run.phase === 'stopped') return;
    if (run.phase !== 'running') {
      // Paused meanwhile: resuming takes its report again and runs the check again.
      m.status = 'working';
      return saveRun(run);
    }
    const r = m.checkRun;
    if (r.error === undefined && !r.ok) {
      const how = r.timedOut ? 'timed out' : `failed (exit code ${r.code})`;
      return sendBack(run, i, [`\`${m.check}\` ${how}.`], `Switchdesk ran \`${m.check}\` and it ${how}. Its output ends:\n\n\`\`\`\n${r.output.slice(-1200)}\n\`\`\``);
    }
    await saveRun(run);
  }
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
  sendBack(run, i, problems, `${agentLabel(chat)} checked it against "done when" and found:\n\n${problems.map((p) => `- ${p}`).join('\n')}`);
}

// A milestone goes back to its agent to fix what its check found, a couple of times at most.
async function sendBack(run, i, problems, found) {
  const m = run.milestones[i];
  m.problems = problems;
  if (m.rounds >= RUN_FIX_ROUNDS) return giveUp(run, i, 'failed', `It still didn't pass its check after ${RUN_FIX_ROUNDS} rounds of fixes: ${problems.join(' ')}`);
  m.rounds++;
  m.status = 'working';
  m.nudges = 0;
  await saveRun(run);
  const w = chatById(m.chat);
  if (!w) return giveUp(run, i, 'failed', 'Its chat was closed.');
  send(`${found}\n\nFix these, check "done when" again, and finish with the \`milestone\` block.`, 'agent', `Fix what the check found (round ${m.rounds})`, w);
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
  m.endedAt = Date.now();
  closeCheck(m);
  await saveRun(run);
  afterSettled(run, i);
}

// A milestone that didn't work out: its changes go to a branch of their own, and the run moves on.
async function giveUp(run, i, status, why) {
  const m = run.milestones[i];
  m.status = status;
  m.why = why;
  m.endedAt = Date.now();
  try {
    m.setAside = await desk.worktree.setAside(run.worktree, `milestone ${i + 1}`, run.sha);
  } catch {
    /* nothing to keep */
  }
  run.failures = (run.failures || 0) + 1;
  closeCheck(m);
  await saveRun(run);
  afterSettled(run, i);
}

// ------------------------------------------------------------------ re-planning as it goes
//
// After each milestone the planner looks at what's left in light of what was learned: a milestone
// that's no longer needed goes, a missing one is added. It reads, but changes nothing.

function afterSettled(run, i) {
  const plan = chatById(run.chat);
  if (run.replan && run.phase === 'running' && plan && !plan.busy && run.milestones.some((m) => m.status === 'pending')) {
    run.replanning = true;
    saveRun(run);
    return send(replanPrompt(run, i), 'ask', `Look at what's left after milestone ${i + 1}`, plan);
  }
  nextMilestone(run);
}

function replanPrompt(run, i) {
  const m = run.milestones[i];
  const list = run.milestones.map((x) => `${x.id}. ${RUN_MARK[x.status] || ' '} ${x.title} (${RUN_STATUS_TEXT[x.status].toLowerCase()})`).join('\n');
  const left = run.milestones.filter((x) => x.status === 'pending').map(({ id, title, what, done_when, check, needs_you, after }) => ({ id, title, what, done_when, check: check || undefined, needs_you: needs_you || undefined, after }));
  return `The long run you planned is under way. Milestone ${m.id}, "${m.title}", ${m.status === 'done' ? 'is done' : `didn't work out (${RUN_STATUS_TEXT[m.status].toLowerCase()})`}.
What it did: ${m.summary || '(no summary)'}
${m.notes ? `Its notes: ${m.notes}\n` : ''}${m.why ? `What went wrong: ${m.why}\n` : ''}
Where the run is up to (✓ done, ✗ didn't work out, … waiting for the person):
${list}

Look at what's left in light of that, reading the code if it helps, but don't change anything. Only change the plan when it's worth it: a milestone that's no longer needed, one that's now missing, or one that should change because of what was learned. Usually nothing needs to change.

The milestones still to do:

\`\`\`json
${JSON.stringify(left, null, 1)}
\`\`\`

Finish with a fenced block marked \`replan\` holding JSON: {"changes": "A sentence on what you changed and why, or empty when nothing changed.", "milestones": [the milestones still to do, in order, in the same form]}. Keep the "id" of each milestone you keep, and leave it off new ones. "after" lists the ids of the milestones each one needs.`;
}

async function replanDone(run, text) {
  run.replanning = false;
  const r = fenced(text, 'replan');
  const list = cleanMilestones(Array.isArray(r) ? r : r && r.milestones);
  const before = run.milestones.filter((m) => m.status === 'pending');
  if (list) {
    const known = new Map(run.milestones.map((m) => [m.id, m]));
    const fresh = list
      .filter((x) => !x.id || !known.has(x.id) || known.get(x.id).status === 'pending')
      .map((x) => {
        const was = known.get(x.id);
        return { ...(was || {}), ...x, id: was ? was.id : `m${++run.nextId}`, status: 'pending', after: x.after.map((a) => (typeof a === 'number' ? `m${a}` : a)) };
      });
    const ids = new Set([...run.milestones.filter((m) => m.status !== 'pending'), ...fresh].map((m) => m.id));
    for (const m of fresh) m.after = m.after.filter((a) => ids.has(a) && a !== m.id);
    const shape = (l) => JSON.stringify(l.map(({ id, title, what, done_when, check, needs_you, after }) => [id, title, what, done_when, check, needs_you, after]));
    if (shape(fresh) !== shape(before)) {
      const added = fresh.filter((m) => !known.has(m.id)).length;
      const dropped = before.filter((m) => !fresh.some((x) => x.id === m.id)).length;
      const said = r && !Array.isArray(r) && String(r.changes || '').trim();
      run.milestones = [...run.milestones.filter((m) => m.status !== 'pending'), ...fresh];
      run.changes = [...(run.changes || []), { at: Date.now(), text: (said || 'It adjusted what was left.').slice(0, 600), added, dropped }];
    }
  }
  await saveRun(run);
  nextMilestone(run);
}

// ------------------------------------------------------------------ stopping

// Stop means now: the agents stop mid-step, and nothing more is sent.
function stopRun(run, { ask = true } = {}) {
  if (!run || !live(run)) return;
  if (ask && !confirm('Stop the run now? The agent stops mid-step. Finished milestones stay committed on its branch, and unfinished work stays in its copy.')) return;
  for (const c of chats) {
    if (!c.longRun || c.longRun.run !== run.id) continue;
    c.queue.length = 0;
    cancelCarryOn(c, 'The run was stopped.');
    if (c.busy) {
      if (c.turn) c.turn.interrupted = true;
      desk.chatInterrupt(c.id);
    }
  }
  // A step that was only just starting can miss the first stop, so it gets a second one.
  setTimeout(() => {
    for (const c of chats) if (c.longRun && c.longRun.run === run.id && c.busy) desk.chatInterrupt(c.id);
  }, 3000);
  runTimers.delete(run.id);
  run.replanning = false;
  for (const m of run.milestones) {
    if (m.status === 'waiting') closeWaitCard(run, m, 'The run was stopped.');
    if (['working', 'checking', 'waiting'].includes(m.status)) {
      if (m.status !== 'waiting') m.why = "The run was stopped partway through this. What it changed so far is in the run's copy, not committed.";
      m.status = 'pending';
    }
  }
  finishRun(run, true);
}

// A settled milestone's chats close, so a night's run doesn't leave a tab per step. They stay in
// your past chats, and the run's page opens them again.
function closeCheck(m) {
  closeRunChat(m.checkChat);
  m.checkChat = null;
  if (settled(m)) {
    const w = chatById(m.chat);
    if (w && w.sessionId) m.session = w.sessionId;
    if (closeRunChat(m.chat)) m.chat = null;
  }
}

function closeRunChat(id) {
  const c = id && chatById(id);
  if (!c || c.busy) return false;
  desk.chatClose(c.id);
  c.el.remove();
  chats.splice(chats.indexOf(c), 1);
  if (activeChat() === null && chats.length) {
    const run = c.longRun && runById(c.longRun.run);
    const home = run && chatById(run.chat);
    switchChat((home || chats[chats.length - 1]).id);
  }
  renderChatTabs();
  return true;
}

async function finishRun(run, stopped) {
  runTimers.delete(run.id);
  run.phase = stopped ? 'stopped' : 'done';
  run.finished = Date.now();
  await saveRun(run);
  if (runDocs.has(run.id)) runDocs.get(run.id).resolve(`${doneCount(run)} of ${run.milestones.length} milestones done. The run's page has the summary.`, 'built');
  const chat = chatById(run.chat);
  if (chat) {
    refreshWorktree(chat);
    appendChat(summaryCard(run), chat);
    // If you were following the run, the summary is what you come back to.
    if (!activeChat() || activeChat().longRun) switchChat(chat.id);
  }
  const t = activeTab();
  if (!t || t.kind === 'run' || t.kind === 'plan') openRunPage(run);
  try {
    const n = new Notification('Switchdesk', { body: `Long run ${stopped ? 'stopped' : 'finished'}: ${doneCount(run)} of ${run.milestones.length} milestones done. ${run.title}` });
    n.onclick = () => (window.focus(), chat && switchChat(chat.id));
  } catch {
    /* notifications off */
  }
  desk.flashWindow && desk.flashWindow();
}

// ------------------------------------------------------------------ the run's page
//
// Each run has a page of its own (a tab beside your files): where it's up to, what's happening now,
// every milestone with what it did and what its check found, and in the morning the summary. The
// run's chat keeps a small card that opens it.

const RUN_STATUS_TEXT = { pending: 'To do', working: 'Working', checking: 'Being checked', waiting: 'Needs you', done: 'Done', failed: "Didn't work out", blocked: 'Blocked', skipped: 'Skipped' };
const RUN_STATUS_ICON = { pending: '', working: '', checking: '', waiting: '…', done: '✓', failed: '✗', blocked: '!', skipped: '–' };
const doneCount = (run) => run.milestones.filter((m) => m.status === 'done').length;
const settled = (m) => ['done', 'failed', 'blocked', 'skipped'].includes(m.status);

function runState(run) {
  const n = run.milestones.length;
  const at = run.milestones.findIndex((m) => m.status === 'working' || m.status === 'checking');
  if (run.phase === 'planning') return 'Planning the milestones';
  if (run.phase === 'ready') return `${n} milestones planned. Waiting for you to start it`;
  if (run.phase === 'paused') return `Paused at ${doneCount(run)} of ${n} done${run.why ? `. ${run.why}` : ''}`;
  const yours = run.milestones.filter((m) => m.status === 'waiting').map((m) => m.title);
  if (run.phase === 'waiting') return `Waiting on you: ${yours.join(', ')}`;
  if (run.phase === 'running') return run.why || [at >= 0 ? `On milestone ${at + 1} of ${n}` : run.replanning ? `Looking at what's left` : `${doneCount(run)} of ${n} done`, yours.length ? `. Also waiting on you: ${yours.join(', ')}` : ''].join('');
  return `${run.phase === 'stopped' ? 'Stopped' : 'Finished'}: ${doneCount(run)} of ${n} done`;
}

function duration(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 1) return 'under a minute';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60 ? `${min % 60} min` : ''}`.trim();
}

// One segment per milestone, coloured by how it went.
function runProgress(run) {
  return h('div', { class: 'run-progress', title: `${doneCount(run)} of ${run.milestones.length} done` }, ...run.milestones.map((m, i) => h('span', { class: `seg ${m.status}`, title: `${i + 1}. ${m.title}: ${RUN_STATUS_TEXT[m.status]}` })));
}

function runButtons(run, { small } = {}) {
  const btn = (label, fn, cls = '') => h('button', { class: `btn${small ? ' small' : ''} ${cls}`, onclick: fn }, label);
  const n = run.milestones.length;
  const chat = chatById(run.chat);
  const finished = run.phase === 'done' || run.phase === 'stopped';
  return [
    run.phase === 'ready' && n ? btn('Start the run', () => beginRun(run), 'primary') : null,
    run.phase === 'running' || run.phase === 'waiting' ? btn('Pause after this step', () => ((run.phase = 'paused'), (run.why = 'You paused it.'), saveRun(run))) : null,
    run.phase === 'paused' ? btn('Resume', () => resumeRun(run), 'primary') : null,
    finished && chat ? btn('Review the changes', () => reviewWorktree(chat)) : null,
    finished && chat ? btn('Merge into my folder', () => mergeWorktree(chat), 'primary') : null,
    run.phase === 'ready' ? btn('Cancel', () => finishRun(run, true)) : null,
    ['running', 'paused', 'waiting'].includes(run.phase) ? btn('Stop', () => stopRun(run), 'danger') : null,
  ].filter(Boolean);
}

// The small card in the run's chat.
function showRunCard(run, chat) {
  const card = h('div', { class: 'card long-run' });
  runCards.set(run.id, card);
  appendChat(card, chat);
  renderRunCard(run);
}

function renderRunCard(run) {
  renderRunPage();
  updateRunButton();
  const card = runCards.get(run.id);
  if (!card) return;
  const go = ['ready', 'paused'].includes(run.phase) ? runButtons(run, { small: true }).slice(0, 1) : [];
  card.replaceChildren(
    h('h4', {}, `🌙 ${run.title}`),
    h('div', { class: 'muted small' }, runState(run)),
    run.milestones.length ? runProgress(run) : null,
    h('div', { class: 'actions' }, ...go, h('button', { class: `btn small${go.length ? '' : ' primary'}`, onclick: () => openRunPage(run) }, 'Open the run'))
  );
}

function openRunPage(run) {
  const id = `run:${run.id}`;
  let t = state.tabs.find((x) => x.id === id);
  if (!t) {
    t = { id, kind: 'run', rel: `Long run: ${run.title}`, runId: run.id };
    state.tabs.push(t);
  }
  activateTab(t.id);
}

let runPageTimer = null;
// Called by activateTab for every tab (and with null to hide the page).
function showRunPage(t) {
  const on = !!(t && t.kind === 'run');
  $('#run-view').classList.toggle('hidden', !on);
  clearInterval(runPageTimer);
  runPageTimer = null;
  if (!on) return;
  renderRunPage();
  // The live line and the clock move on their own while the page shows.
  runPageTimer = setInterval(renderRunPage, 2000);
}

// What the agent on the current milestone is doing right now: its latest step, in words.
function liveLine(run, m) {
  if (m.checkRun && m.checkRun.running) return `Switchdesk is running \`${m.check}\``;
  const c = chatById(m.status === 'checking' ? m.checkChat : m.chat);
  if (!c) return '';
  const rows = c.el.querySelectorAll('.tool .label');
  const last = rows.length ? rows[rows.length - 1].textContent.trim() : '';
  const who = agentLabel(c);
  if (!c.busy) return `${who} is between steps`;
  return last ? `${who}: ${last}` : `${who} is reading the code`;
}

function runPage(run) {
  const n = run.milestones.length;
  const finished = run.phase === 'done' || run.phase === 'stopped';
  const elapsed = run.started ? duration((run.finished || Date.now()) - run.started) : '';
  const qs = run.milestones.flatMap((m, i) => (m.questions || []).map((q) => ({ ...q, i })));
  const trouble = run.milestones.map((m, i) => ({ m, i })).filter(({ m }) => ['failed', 'blocked'].includes(m.status));
  const head = h(
    'div',
    { class: 'run-head' },
    h('div', { class: 'run-eyebrow' }, '🌙 Long run'),
    h('h2', {}, run.title),
    run.goal !== run.title ? h('div', { class: 'run-goal muted' }, run.goal) : null,
    h('div', { class: `run-state ${run.phase}` }, h('span', { class: 'dot' }), runState(run)),
    n ? runProgress(run) : null,
    h(
      'div',
      { class: 'run-meta muted small' },
      [`${doneCount(run)} of ${n} done`, elapsed && (finished ? `took ${elapsed}` : `running for ${elapsed}`), `${agentInfo(run.worker.id).label} works, ${agentInfo(run.checker.id).label} checks`, run.worktree && `branch ${run.worktree.branch}`].filter(Boolean).join(' · ')
    ),
    h('div', { class: 'actions' }, ...runButtons(run))
  );
  // A milestone that needs you, answered here or on its card.
  const yours = run.milestones.filter((m) => m.status === 'waiting');
  const waiting = yours.length
    ? h(
        'div',
        { class: 'run-yours' },
        ...yours.map((m) => {
          const say = h('textarea', { rows: 2, placeholder: 'How did it go? Anything the run should know (optional)', spellcheck: 'false' });
          return h('div', { class: 'run-flag' }, h('h3', {}, `Your turn: ${m.title}`), h('div', {}, m.needs_you), say, h('div', { class: 'actions' }, h('button', { class: 'btn small primary', onclick: () => answerWait(run, m.id, 'done', say.value) }, 'Done'), h('button', { class: 'btn small', onclick: () => answerWait(run, m.id, 'skipped', say.value) }, 'Skip it')));
        })
      )
    : null;
  const changes = (run.changes || []).length
    ? h('details', { class: 'run-changes' }, h('summary', {}, `Plan changes (${run.changes.length})`), h('ul', {}, ...run.changes.map((c) => h('li', {}, c.text, h('span', { class: 'muted small' }, [c.added && ` ${c.added} added`, c.dropped && ` ${c.dropped} dropped`].filter(Boolean).join(','))))))
    : null;
  // In the morning: what needs you first.
  const morning = finished
    ? h(
        'div',
        { class: 'run-morning' },
        h('h3', {}, trouble.length || qs.length ? 'Worth a look' : 'All done, nothing needs you'),
        ...trouble.map(({ m, i }) => h('div', { class: 'run-flag bad' }, h('b', {}, `${i + 1}. ${m.title}: ${RUN_STATUS_TEXT[m.status].toLowerCase()}. `), m.why || '', m.setAside ? h('span', { class: 'muted' }, ` Its work is kept on ${m.setAside}.`) : null)),
        ...qs.map((q) => h('div', { class: 'run-flag' }, h('b', {}, q.question), h('span', { class: 'muted' }, ` It went with: ${q.assumption || 'not said'} (milestone ${q.i + 1})`))),
        h('div', { class: 'muted small' }, "Nothing is in your folder until you merge. Review shows every file it changed.")
      )
    : null;
  const steps = h(
    'div',
    { class: 'run-steps' },
    ...run.milestones.map((m, i) => {
      const now = m.status === 'working' || m.status === 'checking';
      const took = m.startedAt && (m.endedAt || now) ? duration((m.endedAt || Date.now()) - m.startedAt) : '';
      const open = m.chat && chatById(m.chat) ? () => switchChat(m.chat) : m.session ? () => openSession({ id: m.session, agent: run.worker.id, agentAccount: run.worker.account, title: `🌙 ${i + 1}. ${m.title}` }, run.worktree) : null;
      const detail = [
        m.what ? h('p', {}, m.what) : null,
        m.needs_you ? h('p', {}, h('b', {}, 'For you: '), m.needs_you) : h('p', {}, h('b', {}, 'Done when: '), m.done_when || 'not said'),
        m.check ? h('p', {}, h('b', {}, 'Check: '), h('code', {}, m.check), m.checkRun ? h('span', { class: m.checkRun.ok ? 'muted' : 'bad' }, m.checkRun.running ? ' running now' : m.checkRun.error !== undefined ? ` couldn't run: ${m.checkRun.error}` : m.checkRun.ok ? ` passed (${duration(m.checkRun.ms)})` : m.checkRun.timedOut ? ' timed out' : ` failed (exit code ${m.checkRun.code})`) : null) : null,
        m.checkRun && !m.checkRun.ok && m.checkRun.output ? h('pre', { class: 'run-output' }, m.checkRun.output.slice(-600)) : null,
        m.summary && (m.status !== 'skipped' || m.needs_you) ? h('p', {}, h('b', {}, m.needs_you ? 'How it went: ' : 'What it did: '), m.summary) : null,
        m.problems && m.problems.length ? h('div', {}, h('b', {}, m.status === 'done' ? `Its check found, and it fixed:` : 'Its check found:'), h('ul', {}, ...m.problems.map((p) => h('li', {}, p)))) : null,
        (m.questions || []).length ? h('div', {}, h('b', {}, 'Questions it answered for itself:'), h('ul', {}, ...m.questions.map((q) => h('li', {}, `${q.question} `, h('span', { class: 'muted' }, `It went with: ${q.assumption || 'not said'}`))))) : null,
        m.why && m.status !== 'done' ? h('p', { class: 'bad' }, m.why) : null,
        m.checkNote ? h('p', { class: 'muted' }, m.checkNote) : null,
      ].filter(Boolean);
      const el = h(
        'details',
        { class: `run-ms ${m.status}`, open: (m.ui ? m.ui === 'open' : now) || undefined },
        h(
          'summary',
          // What you opened or closed stays that way while the page re-renders.
          { onclick: (e) => (m.ui = e.currentTarget.parentElement.open ? 'shut' : 'open') },
          h('span', { class: `run-num ${m.status}` }, RUN_STATUS_ICON[m.status] || String(i + 1)),
          h('span', { class: 'run-ms-title' }, m.title),
          h('span', { class: 'spacer' }),
          m.rounds ? h('span', { class: 'run-tag' }, `fixed ${m.rounds}×`) : null,
          m.commit ? h('code', { class: 'run-sha', title: m.commit }, m.commit.slice(0, 7)) : null,
          took ? h('span', { class: 'muted small' }, took) : null,
          h('span', { class: `run-pill ${m.status}` }, RUN_STATUS_TEXT[m.status])
        ),
        now ? h('div', { class: 'run-live' }, h('span', { class: 'spinner' }), liveLine(run, m)) : null,
        h('div', { class: 'run-ms-body' }, ...detail, open ? h('button', { class: 'btn small', onclick: open }, m.status === 'checking' ? 'Open the work chat' : 'Open its chat') : null)
      );
      return el;
    })
  );
  return [head, waiting, morning, changes, n ? h('h3', { class: 'run-steps-head' }, 'Milestones') : h('div', { class: 'muted' }, 'The agent is planning the milestones in the run’s chat.'), steps].filter(Boolean);
}

function renderRunPage() {
  const t = activeTab();
  if (!t || t.kind !== 'run') return;
  const run = runById(t.runId);
  const view = $('#run-view');
  if (view.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA') return; // you're typing
  // Only when something changed, so text you're selecting stays put.
  const now = run && run.milestones.find((m) => m.status === 'working' || m.status === 'checking');
  const key = run ? JSON.stringify([run, now && liveLine(run, now), Math.floor(Date.now() / 60000), state.tabs.length]) : '';
  if (view.dataset.key === key && view.childElementCount) return;
  view.dataset.key = key;
  const scroll = view.scrollTop;
  view.replaceChildren(...(run ? runPage(run) : [h('div', { class: 'muted' }, 'This run is gone.')]));
  view.scrollTop = scroll;
}

// The 🌙 button shows how far the folder's run has got.
function updateRunButton() {
  const btn = $('#btn-long-run');
  if (!btn) return;
  const run = folderRuns().find((r) => ['running', 'paused', 'waiting'].includes(r.phase));
  btn.textContent = run ? `🌙 ${doneCount(run)}/${run.milestones.length}` : '🌙';
  btn.classList.toggle('run-on', !!run);
}

// What the run's chat says when it ends: the headline, and the page has the rest.
function summaryCard(run) {
  const qs = run.milestones.reduce((n, m) => n + (m.questions || []).length, 0);
  const bad = run.milestones.filter((m) => ['failed', 'blocked'].includes(m.status)).length;
  const notes = [bad && `${bad} didn't work out`, qs && `${qs} question${qs > 1 ? 's' : ''} it answered for itself`].filter(Boolean);
  return h(
    'div',
    { class: 'card long-run summary' },
    h('h4', {}, `🌙 ${run.phase === 'stopped' ? 'Stopped' : 'Finished'}: ${run.title}`),
    h('div', {}, `${doneCount(run)} of ${run.milestones.length} milestones done${notes.length ? `. ${notes.join(', ')}: worth a look` : ''}.`),
    h('div', { class: 'actions' }, h('button', { class: 'btn small primary', onclick: () => openRunPage(run) }, 'Open the summary'), chatById(run.chat) ? h('button', { class: 'btn small', onclick: () => mergeWorktree(chatById(run.chat)) }, 'Merge into my folder') : null)
  );
}

function showRun(run) {
  openRunPage(run);
}

async function resumeRun(run) {
  runTimers.delete(run.id);
  if (runChecks.has(run.id)) return; // the check's result carries it on
  run.phase = 'running';
  run.why = '';
  await saveRun(run);
  // A milestone whose chat is still open and waiting carries on there; otherwise it starts afresh.
  const m = run.milestones.find((x) => x.status === 'working' || x.status === 'checking');
  const c = m && chatById(m.status === 'checking' ? m.checkChat : m.chat);
  // It already said it's done (and the run missed it): take that rather than asking again.
  if (c && !c.busy && m.status === 'working' && fenced(c.lastTurnText, 'milestone')) return workDone(run, c, c.longRun.i, c.lastTurnText);
  if (c && !c.busy && m.status === 'checking' && fenced(c.lastTurnText, 'verdict')) return checkDone(run, c, c.longRun.i, c.lastTurnText);
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
  run.replanning = false;
  saveRun(run);
  showRunCard(run, chat);
  for (const m of run.milestones) if (m.status === 'waiting') showWaitCard(run, m);
  if (run.phase === 'done' || run.phase === 'stopped') appendChat(summaryCard(run), chat);
}

// Whether the run this chat belongs to is still going (its copy can't be discarded then).
function longRunBusy(chat) {
  const run = chat.longRun && runById(chat.longRun.run);
  return !!run && ['running', 'paused', 'waiting'].includes(run.phase);
}

// A run that's meant to be working but has nothing running (a step that went missing) is nudged
// on after two quiet minutes, so a night isn't lost to a hiccup.
const runQuiet = new Map(); // run id -> half-minute checks with nothing running
function watchRuns() {
  // A limit that has reset: carry on where it stopped.
  for (const [id, w] of [...runTimers]) {
    const run = runById(id);
    const chat = chatById(w.chat);
    if (!run || run.phase !== 'running' || !chat) {
      if (!run || run.phase !== 'paused') runTimers.delete(id);
      continue;
    }
    if (w.at > Date.now() || chat.busy) continue;
    runTimers.delete(id);
    run.why = '';
    const m = run.milestones[chat.longRun.i];
    if (m) m.moves = 0;
    saveRun(run);
    send(CARRY_ON_RESET, 'agent', 'Carry on (the limit reset)', chat);
  }
  for (const run of folderRuns()) {
    const working = run.phase === 'running' && (runTimers.has(run.id) || runChecks.has(run.id) || chats.some((c) => c.longRun && c.longRun.run === run.id && (c.busy || c.making || c.queue.length)));
    const quiet = run.phase === 'running' && !working ? (runQuiet.get(run.id) || 0) + 1 : 0;
    runQuiet.set(run.id, quiet);
    if (quiet >= 4) {
      runQuiet.set(run.id, 0);
      resumeRun(run);
    }
  }
}

function wireLongRuns() {
  const btn = $('#btn-long-run');
  if (btn) btn.addEventListener('click', () => longRunButton());
  setInterval(watchRuns, 30 * 1000);
}
