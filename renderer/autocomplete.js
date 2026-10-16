/* global $, h, state, desk, toast, monaco, openSettings, runInTerminal */
'use strict';

// ------------------------------------------------------------------ tab autocomplete
//
// Grey suggestions as you type in the editor. Tab takes one, Esc dismisses it. The engine is
// GitHub Copilot's language server, or DeepSeek or Qwen with your API key (Settings → Autocomplete).

const complete = { status: null };
const COMPLETE_MAX_CHARS = 1_000_000;

const ENGINE_LABELS = { copilot: 'Copilot', deepseek: 'DeepSeek', qwen: 'Qwen' };

async function refreshCompleteStatus() {
  try {
    complete.status = await desk.complete.status();
  } catch {
    complete.status = null;
  }
  renderCompleteStatus();
  return complete.status;
}

function renderCompleteStatus() {
  const el = $('#status-complete');
  if (!el) return;
  const st = complete.status;
  const active = st && st.active;
  el.textContent = active ? `✦ ${ENGINE_LABELS[active]}` : st && st.engine === 'off' ? '' : '✦ Autocomplete off';
  el.title = active ? `Tab autocomplete by ${ENGINE_LABELS[active]}. Click to change.` : 'Tab autocomplete is off. Click to set it up.';
  el.classList.toggle('dim', !active);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wireAutocomplete() {
  monaco.editor.registerCommand('switchdesk.completionAccepted', (_accessor, command) => desk.complete.accepted(command));
  monaco.languages.registerInlineCompletionsProvider('*', {
    async provideInlineCompletions(model, position, context, token) {
      if (!complete.status || !complete.status.active || model.uri.scheme !== 'file' || !state.folder) return { items: [] };
      if (model.getValueLength() > COMPLETE_MAX_CHARS) return { items: [] };
      const explicit = context.triggerKind === monaco.languages.InlineCompletionTriggerKind.Explicit;
      // Wait for a pause in typing before asking.
      if (!explicit) await sleep(complete.status.active === 'copilot' ? 150 : 350);
      if (token.isCancellationRequested) return { items: [] };
      const opts = model.getOptions();
      const r = await desk.complete
        .request({
          rel: model.uri.path.slice(1),
          languageId: model.getLanguageId(),
          text: model.getValue(),
          line: position.lineNumber - 1,
          character: position.column - 1,
          tabSize: opts.tabSize,
          insertSpaces: opts.insertSpaces,
          explicit,
        })
        .catch(() => ({ items: [] }));
      if (token.isCancellationRequested) return { items: [] };
      return {
        items: (r.items || [])
          .filter((it) => it.insertText)
          .map((it) => ({
            insertText: it.insertText,
            range: new monaco.Range(it.range.start.line + 1, it.range.start.character + 1, it.range.end.line + 1, it.range.end.character + 1),
            command: it.command ? { id: 'switchdesk.completionAccepted', title: 'Accepted', arguments: [it.command] } : undefined,
          })),
      };
    },
    freeInlineCompletions() {},
    disposeInlineCompletions() {},
  });
  monaco.editor.onWillDisposeModel((m) => m.uri.scheme === 'file' && desk.complete.close(m.uri.path.slice(1)).catch(() => {}));
  desk.complete.onStatus(() => refreshCompleteStatus());
  $('#status-complete').addEventListener('click', () => openSettings('autocomplete'));
  refreshCompleteStatus();
}

// ------------------------------------------------------------------ Settings → Autocomplete

async function settingsAutocomplete(body) {
  const rerender = () => settingsAutocomplete(body);
  const st = await refreshCompleteStatus();
  if (!st) return body.replaceChildren(h('div', { class: 'turn-error' }, "Couldn't check autocomplete."));
  const engine = h(
    'select',
    {},
    ...[
      ['auto', 'Automatic: Copilot, or an API key if Copilot isn’t set up'],
      ['copilot', 'GitHub Copilot'],
      ['deepseek', 'DeepSeek (API key)'],
      ['qwen', 'Qwen (API key)'],
      ['off', 'Off'],
    ].map(([v, label]) => h('option', { value: v, selected: st.engine === v }, label))
  );
  engine.addEventListener('change', async () => {
    state.settings = await desk.setSettings({ autocomplete: { ...(state.settings.autocomplete || {}), engine: engine.value } });
    rerender();
  });

  const cp = st.copilot || {};
  const cpBox = h(
    'div',
    { class: 'set-box' },
    h('div', { class: 'row' }, h('b', {}, 'GitHub Copilot'), h('span', { class: 'spacer' }), h('span', { class: `agent-dot ${cp.signedIn ? 'ok' : cp.installed ? 'warn' : 'bad'}` })),
    h('div', { class: 'muted small' }, 'Uses GitHub’s own Copilot language server with your GitHub account. Copilot Free includes 2,000 completions a month.'),
    h('div', { class: 'muted small' }, !cp.installed ? 'Not installed.' : cp.signedIn ? `Signed in${cp.user ? ' as ' + cp.user : ''}.` : cp.message || 'Not signed in.')
  );
  const row = h('div', { class: 'row' });
  if (!cp.installed) {
    row.append(
      h('button', { class: 'btn small primary', onclick: () => runInTerminal(st.install) }, 'Install'),
      h('button', { class: 'btn small', onclick: rerender }, 'Check again'),
      h('span', { class: 'muted small' }, `Runs ${st.install} in the terminal.`)
    );
  } else if (!cp.signedIn) {
    row.append(h('button', { class: 'btn small primary', onclick: () => copilotSignIn(cpBox).then(rerender) }, 'Sign in with GitHub'));
  } else {
    row.append(h('button', { class: 'btn small', onclick: async () => (await desk.complete.signOut(), rerender()) }, 'Sign out'));
  }
  cpBox.append(row);

  const keyLine = (id, label) =>
    h('div', { class: 'row' }, h('span', { class: `agent-dot ${st.keys[id] ? 'ok' : 'bad'}` }), h('span', {}, label), h('span', { class: 'muted small' }, st.keys[id] ? 'Key saved.' : 'No key yet.'));
  const keyBox = h(
    'div',
    { class: 'set-box' },
    h('b', {}, 'With an API key'),
    h('div', { class: 'muted small' }, 'DeepSeek and Qwen can fill in code too, billed to your key. They use the keys saved under Settings → Agents.'),
    keyLine('deepseek', 'DeepSeek'),
    keyLine('qwen', 'Qwen'),
    h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => openSettingsSection('agents') }, 'Add a key'))
  );

  body.replaceChildren(
    h('h3', {}, 'Autocomplete'),
    h('p', { class: 'muted small' }, 'Grey suggestions appear as you type in the editor. Tab accepts one and Esc dismisses it. Alt+] and Alt+[ cycle through others when there are several.'),
    h('div', { class: 'set-field' }, h('span', {}, 'Engine'), engine),
    h('div', { class: 'muted small' }, st.active ? `Suggestions now come from ${ENGINE_LABELS[st.active]}.` : 'No engine is ready, so there are no suggestions yet.'),
    cpBox,
    keyBox
  );
}

function openSettingsSection(id) {
  const btn = document.querySelector(`.settings-nav [data-section="${id}"]`);
  if (btn) btn.click();
}

// GitHub's device sign-in: show the code, open github.com/login/device, wait for it to finish.
async function copilotSignIn(box) {
  let r;
  try {
    r = await desk.complete.signIn();
  } catch (e) {
    return toast(`Couldn't start the GitHub sign-in: ${String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`);
  }
  if (r.done) return;
  navigator.clipboard.writeText(r.userCode).catch(() => {});
  box.append(
    h(
      'div',
      { class: 'set-box warn-box' },
      h('div', {}, 'Enter this code on the GitHub page that just opened:'),
      h('div', { class: 'device-code' }, r.userCode),
      h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => navigator.clipboard.writeText(r.userCode).then(() => toast('Copied.')) }, 'Copy code'), h('a', { href: r.verificationUri, target: '_blank', class: 'small' }, r.verificationUri)),
      h('div', { class: 'muted small' }, 'The code is already on your clipboard. This page updates once you’ve signed in.')
    )
  );
  try {
    const st = await desk.complete.signInFinish(r.command);
    toast(st.signedIn ? `Copilot autocomplete is on${st.user ? ' for ' + st.user : ''}.` : st.message || 'Sign-in didn’t finish.');
  } catch (e) {
    toast(`GitHub sign-in didn't finish: ${String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`);
  }
}
