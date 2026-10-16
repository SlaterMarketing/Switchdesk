/* global $, h, state, toast, modal, monaco, chats, activeChat, createChat, switchChat, appendChat, send, openFile, modelUri, agentInfo, agentLabel, agentOf, compareChoices */
'use strict';

// ------------------------------------------------------------------ second opinion
//
// A different agent reviews your uncommitted changes (or one turn's files) without touching them.
// What it finds shows in the editor like any other problem, with a squiggle, the lightbulb's
// "Fix with the agent", and a card in its chat with Open and Fix for each finding.

const OPINION_OWNER = 'second-opinion';
const opinionFindings = new Map(); // rel -> [finding]

function opinionPrompt(files) {
  const scope = files && files.length ? `these files, as changed since the last commit: ${files.map((f) => `\`${f}\``).join(', ')} (see \`git diff\` for them)` : 'the uncommitted changes in this project (look at `git status` and `git diff`, including new untracked files)';
  return `Another agent made changes, and you're giving a second opinion. Review ${scope} as a careful senior reviewer. Look for bugs, missed edge cases, security problems, and anything that doesn't fit the rest of the code. Read the surrounding code where you need to. Don't change any files.

Say in a sentence or two what you think overall. Then list what you found, most serious first, as a fenced block marked \`findings\` holding a JSON array, like this:

\`\`\`findings
[{"file": "src/app.js", "line": 42, "severity": "error", "title": "Off-by-one drops the last item", "detail": "The loop stops at length - 1, so ..."}]
\`\`\`

"file" is relative to the project folder, "line" is the line in the file as it is now, and "severity" is "error" (a real bug), "warning" (likely a problem) or "info" (worth a look). Use an empty array if you found nothing worth raising.`;
}

// Pick the reviewer: any ready agent, starting with one that isn't the chat's own.
async function secondOpinion(files) {
  if (!state.folder) return toast('Open a folder first.');
  const choices = await compareChoices();
  if (!choices.length) return toast('Sign in to an agent first (Settings → Agents).');
  const origin = activeChat();
  const own = agentOf(origin);
  const sorted = [...choices.filter((c) => c.id !== own), ...choices.filter((c) => c.id === own)];
  const list = h(
    'div',
    { class: 'results' },
    ...sorted.map((c, i) =>
      h(
        'div',
        { class: `result${i === 0 ? ' active' : ''}`, onclick: () => (close(), startOpinion(c, files, origin)) },
        h('b', {}, c.label),
        h('span', { class: 'muted small' }, c.id === own ? ' (the same agent as this chat)' : '')
      )
    )
  );
  const close = modal([h('div', { class: 'body' }, h('h3', {}, 'Who should review it?'), h('p', { class: 'muted small' }, files && files.length ? `Reviews ${files.length} file${files.length > 1 ? 's' : ''} from this turn. It reads the code and doesn't change anything.` : 'Reviews your uncommitted changes. It reads the code and doesn’t change anything.'), list)]);
  list.firstChild && list.firstChild.focus && list.firstChild.focus();
}

function startOpinion(choice, files, origin) {
  const chat = createChat({ title: `Review by ${choice.label}` });
  chat.agent = choice.id;
  if (choice.account && choice.account !== 'default') chat.agentAccount = choice.account;
  chat.opinion = { origin: origin && origin.id, files };
  send(opinionPrompt(files), 'ask', files && files.length ? `Second opinion on ${files.length} file${files.length > 1 ? 's' : ''}` : 'Second opinion on my uncommitted changes', chat);
}

function parseFindings(text) {
  const m = /```findings\s*\n([\s\S]*?)```/.exec(text) || /```json\s*\n(\s*\[[\s\S]*?\])\s*```/.exec(text);
  if (!m) return null;
  try {
    const list = JSON.parse(m[1]);
    return Array.isArray(list) ? list.filter((f) => f && f.file && f.title).map((f) => ({ ...f, file: String(f.file).replace(/^\.\//, '').replace(/\\/g, '/'), line: Math.max(1, parseInt(f.line, 10) || 1), severity: ['error', 'warning', 'info'].includes(f.severity) ? f.severity : 'warning' })) : null;
  } catch {
    return null;
  }
}

// The reviewer's turn ended: show its findings in the editor and as a card.
function opinionDone(chat, turn) {
  const text = (turn.replyTexts || []).map((b) => b.text).join('\n\n') || [...chat.el.querySelectorAll('.msg-text')].map((e) => e.innerText).join('\n\n');
  const found = parseFindings(text);
  if (!found) return;
  const who = agentLabel(chat);
  // Paths the reviewer gave relative to a subfolder still match the project's own.
  const rels = [...(state.fileSet || [])];
  for (const f of found) if (!state.fileSet.has(f.file)) f.file = rels.find((r) => r.endsWith('/' + f.file)) || f.file;
  for (const k of [...opinionFindings.keys()]) opinionFindings.delete(k);
  for (const f of found) opinionFindings.set(f.file, [...(opinionFindings.get(f.file) || []), { ...f, who }]);
  for (const m of monaco.editor.getModels()) applyOpinionMarkers(m);
  // The card shows the findings, so the raw block in the reply isn't needed.
  for (const code of chat.el.querySelectorAll('pre code.language-findings')) code.closest('pre').remove();
  appendChat(findingsCard(chat, found, who), chat);
}

function applyOpinionMarkers(model) {
  const rel = [...opinionFindings.keys()].find((r) => model.uri.toString() === modelUri(r).toString());
  const list = rel ? opinionFindings.get(rel) : [];
  const sev = { error: monaco.MarkerSeverity.Error, warning: monaco.MarkerSeverity.Warning, info: monaco.MarkerSeverity.Info };
  monaco.editor.setModelMarkers(
    model,
    OPINION_OWNER,
    list.map((f) => {
      const line = Math.min(f.line, model.getLineCount());
      return { severity: sev[f.severity], message: `${f.title}${f.detail ? `\n${f.detail}` : ''}`, source: `${f.who} review`, startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: model.getLineMaxColumn(line) };
    })
  );
}

function findingsCard(chat, found, who) {
  const origin = () => chats.find((c) => c.id === (chat.opinion || {}).origin) || null;
  const fixPrompt = (list) =>
    `${who} reviewed the changes and found ${list.length > 1 ? 'these problems' : 'this problem'}:\n\n${list.map((f) => `- ${f.severity.toUpperCase()} @${f.file}:${f.line}: ${f.title}${f.detail ? `. ${f.detail}` : ''}`).join('\n')}\n\nCheck ${list.length > 1 ? 'each one' : 'it'} against the code. Fix what's real, keep the changes small, and say briefly if you think any finding is wrong and why.`;
  const fix = (list) => {
    // The fix goes to the chat that made the changes, in Agent mode.
    const to = origin();
    if (to) switchChat(to.id);
    send(fixPrompt(list), 'agent', `Fix ${list.length > 1 ? `${list.length} findings` : `"${list[0].title}"`} from ${who}'s review`, to || undefined);
  };
  const rows = found.map((f) =>
    h(
      'div',
      { class: `finding ${f.severity}` },
      h('span', { class: 'sev' }, f.severity === 'error' ? '●' : f.severity === 'warning' ? '▲' : 'ℹ'),
      h('div', { class: 'what' }, h('b', {}, f.title), h('a', { href: '#', class: 'where', onclick: (e) => (e.preventDefault(), openFile(f.file, f.line)) }, `${f.file}:${f.line}`), f.detail ? h('div', { class: 'muted small' }, f.detail) : null),
      h('button', { class: 'btn small', onclick: () => fix([f]) }, 'Fix')
    )
  );
  return h(
    'div',
    { class: 'card findings' },
    h('div', { class: 'row' }, h('h4', {}, found.length ? `${who} found ${found.length} thing${found.length > 1 ? 's' : ''}` : `${who} found nothing to raise`), h('span', { class: 'spacer' }), found.length > 1 ? h('button', { class: 'btn small primary', onclick: () => fix(found) }, 'Fix all') : null),
    ...rows,
    found.length ? h('div', { class: 'muted small' }, 'They’re marked in the editor too; the lightbulb there offers a fix.') : null
  );
}

function wireOpinion() {
  monaco.editor.onDidCreateModel((m) => opinionFindings.size && setTimeout(() => applyOpinionMarkers(m), 0));
}
