/* global $, h, desk, chats, chatById, appendChat, send, notifyAttention, scrollChat */
'use strict';

// ------------------------------------------------------------------ Debug mode
//
// Like Cursor's: instead of guessing, the agent lists what might be wrong, adds temporary logging
// that tells those apart, and asks you to reproduce the bug. The logging posts to a collector in
// Switchdesk; one click sends what it captured back to the agent, which fixes the cause and, once
// you've checked the fix, takes the logging out again.

const DEBUG_MARK = 'switchdesk-debug';

function debugPrefix(url) {
  return (
    `[Debug mode: find the cause of the bug below from what the code actually does at run time, not by guessing.\n` +
    `1. List a few hypotheses for what could be going wrong.\n` +
    `2. Add temporary logging that tells them apart: the values, branches and timings that would confirm or rule out each one. Send every log line as an HTTP POST with a JSON body to ${url}\n` +
    `   JavaScript/TypeScript (Node or browser): fetch('${url}', { method: 'POST', body: JSON.stringify({ hypothesis: 'A', where: 'file:line', ...values }) }).catch(() => {});\n` +
    `   Python: import json, urllib.request; urllib.request.urlopen(urllib.request.Request('${url}', data=json.dumps({...}).encode(), method='POST'), timeout=1)  (wrapped in try/except)\n` +
    `   Other languages: any HTTP POST to that address. The logging must never throw or change what the code does.\n` +
    `   Put every addition between comments that contain "${DEBUG_MARK}" (for example "// #region ${DEBUG_MARK}" and "// #endregion ${DEBUG_MARK}") so it can all be removed later.\n` +
    `3. Then stop and ask me to reproduce the bug, saying exactly what to do. Don't fix anything yet: Switchdesk collects the logs and sends them to you.]\n\n`
  );
}

// The first message of a debugging session gets the instructions; later ones carry on.
async function debugModePrompt(chat, prompt) {
  if (chat.debugging) return prompt;
  chat.debugUrl = await desk.debugLog.open(chat.id);
  chat.debugging = true;
  return debugPrefix(chat.debugUrl) + prompt;
}

const cleanupMessage = `The bug is fixed. Remove every piece of logging you added for debugging (everything marked ${DEBUG_MARK}), and nothing else. Then check nothing else still refers to it.`;

// After each Debug mode turn: reproduce, then send the logs, or clean up once it's fixed.
function debugModeCard(chat, turn) {
  if (turn.debugCleanup) {
    chat.debugging = false;
    chat.debugCard = null;
    return appendChat(h('div', { class: 'notice' }, 'Debug logging removed. The next Debug mode message starts a new investigation.'), chat);
  }
  const count = h('b', {}, '0');
  const sendBtn = h('button', { class: 'btn small primary', onclick: () => sendLogs(chat) }, "I've reproduced it: send the logs");
  const card = h(
    'div',
    { class: 'card debug-mode' },
    h('h4', {}, 'Debug mode'),
    h('div', { class: 'small' }, 'Reproduce the bug now: run your app (in the terminal, the preview or anywhere) and do what goes wrong. Logs captured so far: ', count),
    h(
      'div',
      { class: 'actions' },
      sendBtn,
      h('button', { class: 'btn small', title: 'The fix works: remove the logging the agent added', onclick: () => cleanUp(chat) }, "It's fixed: remove the logging")
    )
  );
  if (chat.debugCard) chat.debugCard.classList.add('resolved');
  chat.debugCard = card;
  chat.debugCount = count;
  appendChat(card, chat);
  notifyAttention(chat);
}

async function sendLogs(chat) {
  const lines = await desk.debugLog.take(chat.id);
  if (chat.debugCard) chat.debugCard.classList.add('resolved');
  let text = lines.join('\n');
  if (text.length > 40000) text = `[…${lines.length} lines, the earliest left out…]\n${text.slice(-40000)}`;
  const body = lines.length
    ? `I reproduced the bug. Here's what the logging captured (${lines.length} line${lines.length > 1 ? 's' : ''}):\n\n\`\`\`\n${text}\n\`\`\`\n\nCompare it with your hypotheses. If the cause is clear, fix it, keep the logging so we can check the fix, and ask me to reproduce again. If it isn't clear yet, add more logging and ask me to reproduce again.`
    : `I reproduced the bug, but none of the logging reached Switchdesk. Check that the logging runs on the path that fails (and that the app was restarted if it needed to be), fix that, and ask me to reproduce again.`;
  send(body, 'debug', lines.length ? `Sent ${lines.length} log line${lines.length > 1 ? 's' : ''} from the reproduction` : 'Reproduced it, but no logs came in', chat);
}

function cleanUp(chat) {
  if (chat.debugCard) chat.debugCard.classList.add('resolved');
  chat.cleanupNext = true;
  send(cleanupMessage, 'debug', 'Fixed: remove the debug logging', chat);
}

function wireDebugMode() {
  desk.debugLog.onCount(({ chatId, count }) => {
    const chat = chatById(chatId);
    if (chat && chat.debugCount) chat.debugCount.textContent = String(count);
  });
}
