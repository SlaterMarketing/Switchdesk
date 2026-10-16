/* global $, h, state, desk, toast, modal, chats, activeChat, createChat, switchChat, renderChatTabs, appendChat, send, compareChoices, agentOf, agentInfo, agentLabel, queueSaveWorkspace, git */
'use strict';

// ------------------------------------------------------------------ scheduled tasks
//
// A prompt that runs on its own on a schedule (every morning, weekdays, every few hours) in this
// folder, while Switchdesk is open. Each run is a new chat, in its own copy of the folder when it's a
// git repo, so it never changes your files until you merge. A run missed while the app was closed
// happens once when the folder next opens.

const SCHEDULE_TICK = 30 * 1000;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
let scheduleTimer = null;
const scheduleStarting = new Set(); // schedule ids whose run is being set up
const isRunning = (id) => scheduleStarting.has(id) || chats.some((c) => c.scheduled === id && (c.busy || c.making));

const schedules = () => (state.settings.schedules || []).filter((s) => state.folder && s.folder === state.folder.root);

// When a schedule is next due, after the run at (or the creation time) `from`.
function nextRun(s, from = s.lastRun || s.created) {
  if (s.every === 'hours') return from + Math.max(1, s.hours || 1) * 3600e3;
  const [hh, mm] = String(s.time || '09:00').split(':').map((x) => parseInt(x, 10) || 0);
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setHours(hh, mm);
  if (d.getTime() <= from) d.setDate(d.getDate() + 1);
  while (s.every === 'weekdays' && (d.getDay() === 0 || d.getDay() === 6)) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function describeSchedule(s) {
  if (s.every === 'hours') return s.hours > 1 ? `Every ${s.hours} hours` : 'Every hour';
  return `${s.every === 'weekdays' ? 'Weekdays' : 'Every day'} at ${s.time}`;
}

function whenText(t) {
  const d = new Date(t);
  const today = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `today ${time}`;
  const tomorrow = new Date(today.getTime() + 864e5);
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow ${time}`;
  return `${DAYS[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1} ${time}`;
}

async function saveSchedules(list) {
  const others = (state.settings.schedules || []).filter((s) => !state.folder || s.folder !== state.folder.root);
  state.settings = await desk.setSettings({ schedules: [...others, ...list] });
}

async function updateSchedule(id, patch) {
  const list = schedules().map((s) => (s.id === id ? { ...s, ...patch } : s));
  await saveSchedules(list);
}

// Every half minute: start whatever is due in this folder.
function checkSchedules() {
  if (!state.folder) return;
  const now = Date.now();
  for (const s of schedules()) if (s.enabled !== false && !isRunning(s.id) && nextRun(s) <= now) runSchedule(s);
}

function wireSchedules() {
  clearInterval(scheduleTimer);
  scheduleTimer = setInterval(checkSchedules, SCHEDULE_TICK);
  const btn = $('#btn-schedule');
  if (btn) btn.addEventListener('click', () => openSchedules());
}

// A folder just opened: give restored chats a moment, then catch up on anything missed.
function schedulesFolderOpened() {
  setTimeout(checkSchedules, 5000);
}

async function runSchedule(s) {
  if (isRunning(s.id)) return;
  scheduleStarting.add(s.id);
  // Marked as run up front, so a slow start or a crash doesn't run it twice.
  await updateSchedule(s.id, { lastRun: Date.now() });
  const was = activeChat();
  const chat = createChat({ title: `⏲ ${s.title}`.slice(0, 60) });
  chat.agent = s.agent || 'claude';
  if (s.agentAccount && s.agentAccount !== 'default') chat.agentAccount = s.agentAccount;
  chat.scheduled = s.id;
  // It runs in the background: you stay in the chat you were in.
  if (was && was !== chat) switchChat(was.id);
  if (s.copy) {
    chat.making = true;
    try {
      chat.worktree = await desk.worktree.create(`scheduled ${s.title}`.slice(0, 40));
      chat.wtCount = 0;
    } catch {
      chat.worktree = null; // not a git repo after all: it works in the folder
    }
    chat.making = false;
  }
  renderChatTabs();
  const intro = `This is a scheduled task (${describeSchedule(s).toLowerCase()}), running on its own with nobody watching. Do it, then finish with a short summary of what you did and anything that needs a person.\n\n`;
  scheduleStarting.delete(s.id);
  send(intro + s.prompt, s.mode || 'agent', `Scheduled: ${s.title}`, chat);
}

// The chat's turn ended (chat.js calls this for every result).
function scheduleDone(chat, failed) {
  if (!chat.scheduled) return;
  const id = chat.scheduled;
  updateSchedule(id, { lastChat: chat.sessionId || null, lastResult: failed ? 'error' : 'done' });
  try {
    const n = new Notification('Switchdesk', { body: `Scheduled task ${failed ? 'stopped' : 'finished'}: ${chat.title.replace(/^⏲ /, '')}` });
    n.onclick = () => (window.focus(), chats.includes(chat) && switchChat(chat.id));
  } catch {
    /* notifications off */
  }
  queueSaveWorkspace();
}

// The list of this folder's schedules, with a form to add or edit one.
async function openSchedules(editing) {
  if (!state.folder) return toast('Open a folder first.');
  const choices = await compareChoices();
  const body = h('div', { class: 'body schedules' });
  const close = modal([body]);
  const list = () => {
    const rows = schedules().map((s) => {
      const last = s.lastChat && chats.find((c) => c.sessionId === s.lastChat);
      return h(
        'div',
        { class: `schedule-row${s.enabled === false ? ' off' : ''}` },
        h(
          'div',
          { class: 'what' },
          h('b', {}, s.title),
          h('div', { class: 'muted small' }, `${describeSchedule(s)} · ${agentInfo(s.agent || 'claude').label}${s.copy ? ' · in its own copy' : ''}`),
          h('div', { class: 'muted small' }, s.enabled === false ? 'Paused' : isRunning(s.id) ? 'Running now' : `Next: ${whenText(nextRun(s))}`, s.lastRun && s.lastRun !== s.created ? ` · last ran ${whenText(s.lastRun)}` : '', last ? ' · ' : '', last ? h('a', { href: '#', onclick: (e) => (e.preventDefault(), close(), switchChat(last.id)) }, 'open its chat') : null)
        ),
        h('button', { class: 'btn small', title: 'Run it now', disabled: isRunning(s.id), onclick: () => (close(), runSchedule(s)) }, 'Run now'),
        h('button', { class: 'btn small', onclick: async () => (await updateSchedule(s.id, { enabled: s.enabled === false })) || list() }, s.enabled === false ? 'Resume' : 'Pause'),
        h('button', { class: 'btn small', onclick: () => form(s) }, 'Edit'),
        h('button', { class: 'icon-btn', title: 'Delete', onclick: async () => confirm(`Delete "${s.title}"?`) && (await saveSchedules(schedules().filter((x) => x.id !== s.id)), list()) }, '✕')
      );
    });
    body.replaceChildren(
      h('h3', {}, 'Scheduled tasks'),
      h('p', { class: 'muted small' }, `Prompts that run on their own in ${state.folder.name} while Switchdesk is open. Each run is a new chat; one missed while the app was closed runs when you next open the folder.`),
      ...(rows.length ? rows : [h('div', { class: 'muted' }, 'None yet.')]),
      h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: close }, 'Close'), h('button', { class: 'btn primary', onclick: () => form() }, '＋ New scheduled task'))
    );
  };
  const form = (s) => {
    const own = agentOf(activeChat());
    const title = h('input', { type: 'text', placeholder: 'Name, e.g. "Morning dependency check"', value: s ? s.title : '' });
    const prompt = h('textarea', { rows: 5, placeholder: 'What should the agent do each time?', spellcheck: 'false' });
    prompt.value = s ? s.prompt : $('#input').value.trim();
    const every = h('select', {}, h('option', { value: 'day' }, 'Every day'), h('option', { value: 'weekdays' }, 'Weekdays'), h('option', { value: 'hours' }, 'Every few hours'));
    every.value = s ? s.every : 'day';
    const time = h('input', { type: 'time', value: s ? s.time || '09:00' : '09:00' });
    const hours = h('input', { type: 'number', min: 1, max: 168, value: s ? s.hours || 4 : 4, style: 'width:5em' });
    const hoursRow = h('label', { class: 'inline' }, 'every ', hours, ' hours');
    const sync = () => {
      time.classList.toggle('hidden', every.value === 'hours');
      hoursRow.classList.toggle('hidden', every.value !== 'hours');
    };
    every.addEventListener('change', sync);
    sync();
    const agent = h('select', {}, ...choices.map((c, i) => h('option', { value: String(i) }, c.label)));
    const pick = s ? choices.findIndex((c) => c.id === s.agent && (c.account || 'default') === (s.agentAccount || 'default')) : choices.findIndex((c) => c.id === own);
    agent.value = String(Math.max(0, pick));
    const mode = h('select', {}, h('option', { value: 'agent' }, 'Agent (can change files)'), h('option', { value: 'ask' }, 'Ask (read only)'));
    mode.value = s ? s.mode || 'agent' : 'agent';
    const copy = h('input', { type: 'checkbox', checked: s ? !!s.copy : !!(git.status && git.status.repo !== false) });
    const save = h('button', { class: 'btn primary' }, s ? 'Save' : 'Schedule it');
    save.addEventListener('click', async () => {
      if (!prompt.value.trim()) return prompt.focus();
      const c = choices[parseInt(agent.value, 10)] || { id: 'claude' };
      const next = {
        id: s ? s.id : crypto.randomUUID(),
        folder: state.folder.root,
        title: title.value.trim() || prompt.value.trim().split('\n')[0].slice(0, 50),
        prompt: prompt.value.trim(),
        every: every.value,
        time: time.value || '09:00',
        hours: Math.max(1, parseInt(hours.value, 10) || 1),
        agent: c.id,
        agentAccount: c.account && c.account !== 'default' ? c.account : undefined,
        mode: mode.value,
        copy: copy.checked,
        enabled: s ? s.enabled : true,
        created: s ? s.created : Date.now(),
        lastRun: s ? s.lastRun : undefined,
        lastChat: s ? s.lastChat : undefined,
      };
      // A changed schedule counts from now, so editing it doesn't set it off.
      if (s && (s.every !== next.every || s.time !== next.time || s.hours !== next.hours)) next.lastRun = Date.now();
      await saveSchedules(s ? schedules().map((x) => (x.id === s.id ? next : x)) : [...schedules(), next]);
      toast(`Scheduled. Next run ${whenText(nextRun(next))}.`);
      list();
    });
    body.replaceChildren(
      h('h3', {}, s ? 'Edit scheduled task' : 'New scheduled task'),
      title,
      prompt,
      h('div', { class: 'schedule-when' }, every, time, hoursRow),
      h('div', { class: 'schedule-when' }, h('span', { class: 'muted small' }, 'Agent'), agent, mode),
      h('label', { class: 'check' }, copy, ' Work in its own copy of the folder (merge what you like afterwards)'),
      h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: list }, 'Back'), save)
    );
    (s ? prompt : title).focus();
  };
  if (editing === 'new') form();
  else list();
}
