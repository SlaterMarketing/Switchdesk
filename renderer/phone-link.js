// Your phone's view of this window's chats (the page itself is in src/phone.js): what each chat is
// doing, what it's waiting on you for, its latest messages, and sending it a message.
'use strict';

const phoneCards = new WeakMap(); // card element -> its id for the phone
let phoneCardIds = 0;
const cardId = (el) => (phoneCards.has(el) ? phoneCards.get(el) : (phoneCards.set(el, `c${++phoneCardIds}`), phoneCards.get(el)));

function phoneChat(chat) {
  const waitingCards = [...chat.el.querySelectorAll('.card.approval:not(.resolved), .card.plan:not(.resolved)')];
  const messages = [...chat.el.querySelectorAll('.msg-user, .msg-text')]
    .filter((el) => el.classList.contains('msg-user') || !el.closest('.msg-user'))
    .slice(-30)
    .map((el) => ({ role: el.classList.contains('msg-user') ? 'user' : 'agent', text: (el.classList.contains('msg-user') ? [...el.childNodes].filter((n) => !(n.classList && n.classList.contains('rewind-btn'))).map((n) => n.textContent).join('') : el.innerText).trim().slice(0, 4000) }))
    .filter((m) => m.text);
  const last = messages[messages.length - 1];
  return {
    id: chat.id,
    title: chat.title,
    agent: agentLabel(chat),
    folder: state.folder ? state.folder.name : '',
    busy: !!chat.busy,
    waiting: waitingCards.length > 0,
    last: last ? last.text.slice(0, 200) : '',
    messages,
    asks: waitingCards.map((el) => ({
      id: cardId(el),
      title: (el.phone && el.phone.title) || ($('h4', el) || {}).textContent || 'Waiting for you',
      detail: el.phone ? el.phone.detail : '',
      choices: el.phone ? el.phone.choices : [],
    })),
  };
}

async function phoneRequest({ what, args }) {
  if (what === 'state') return { folder: state.folder ? state.folder.name : '', chats: chats.filter((c) => !isPristine(c) || c.busy).map(phoneChat) };
  if (what === 'new') {
    const chat = createChat();
    send(args.text, null, null, chat);
    return { chat: chat.id };
  }
  if (what === 'start') return startHandedOver(args);
  const chat = chats.find((c) => c.id === args.chat);
  if (!chat) return { error: 'That chat was closed.' };
  // Another app checking on a chat it handed over (or any chat): all of it, and whether it's done.
  if (what === 'read') {
    const c = phoneChat(chat);
    return { title: c.title, agent: c.agent, working: !!(chat.busy || chat.making || chat.queue.length), waiting_for_user: c.waiting, waiting_on: c.asks.map((a) => a.title), copy: chat.worktree && !chat.worktree.removed ? chat.worktree.path : undefined, messages: c.messages };
  }
  if (what === 'stop') {
    chat.queue.length = 0;
    if (chat.busy) {
      if (chat.turn) chat.turn.interrupted = true;
      desk.chatInterrupt(chat.id);
    }
    return { ok: true, stopped: !!chat.busy };
  }
  if (what === 'send') {
    if (!args.text.trim()) return { error: 'Type a message first.' };
    // The chat box's model and effort are the active chat's, so it's the one that sends.
    if (chat !== activeChat()) switchChat(chat.id);
    send(args.text, null, null, chat);
    return { ok: true };
  }
  if (what === 'answer') {
    const el = [...chat.el.querySelectorAll('.card.approval:not(.resolved)')].find((x) => cardId(x) === args.card);
    if (!el || !el.phone) return { error: 'That was already answered.' };
    el.phone.pick(args.choice);
    return { ok: true };
  }
  return { error: 'Not something Switchdesk knows.' };
}

// Work another app (Claude Desktop, say) handed over: a chat of its own, with the agent and mode it
// asked for, in its own copy if it asked for one. It's an ordinary chat from then on.
async function startHandedOver({ task, agent, mode, own_copy: ownCopy, title, from }) {
  task = String(task || '').trim();
  if (!task) return { error: 'Say what to do: task is empty.' };
  if (!state.folder) return { error: 'This window has no folder open.' };
  let who = null;
  if (agent) {
    const choices = await compareChoices();
    const want = String(agent).trim().toLowerCase();
    who = choices.find((c) => c.id === want || c.label.toLowerCase() === want) || choices.find((c) => c.label.toLowerCase().startsWith(want) || c.id.startsWith(want));
    if (!who) return { error: `${agent} isn't set up in Switchdesk. Signed in: ${choices.map((c) => c.label).join(', ') || 'none'}.` };
  }
  const name = String(title || task.split('\n')[0]).slice(0, 60);
  const chat = createChat({ title: name });
  if (who) {
    chat.agent = who.id;
    chat.agentAccount = who.account && who.account !== 'default' ? who.account : undefined;
  }
  if (ownCopy) {
    chat.making = true;
    renderWorktreeBar();
    try {
      chat.worktree = await desk.worktree.create(name);
      chat.wtCount = 0;
    } catch (err) {
      chat.making = false;
      renderWorktreeBar();
      return { error: `Couldn't make a copy of the folder: ${String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}` };
    }
    chat.making = false;
  }
  renderChatTabs();
  renderWorktreeBar();
  switchChat(chat.id);
  send(task, MODES.includes(mode) ? mode : 'agent', `From ${from || 'another app'}: ${task.length > 300 ? `${task.slice(0, 300)}…` : task}`, chat);
  return { chat: chat.id, agent: agentLabel(chat), copy: chat.worktree ? chat.worktree.path : undefined };
}

function wirePhone() {
  desk.phone.onRequest((req) =>
    Promise.resolve()
      .then(() => phoneRequest(req))
      .catch((e) => ({ error: String(e.message || e) }))
      .then((r) => desk.phone.answer(req.id, r))
  );
}
