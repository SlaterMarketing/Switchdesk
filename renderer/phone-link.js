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
  const chat = chats.find((c) => c.id === args.chat);
  if (!chat) return { error: 'That chat was closed.' };
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

function wirePhone() {
  desk.phone.onRequest((req) =>
    Promise.resolve()
      .then(() => phoneRequest(req))
      .catch((e) => ({ error: String(e.message || e) }))
      .then((r) => desk.phone.answer(req.id, r))
  );
}
