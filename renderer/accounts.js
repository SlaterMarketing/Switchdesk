/* global $, h, state, desk, toast, modal, chats, activeChat, appendChat, openSettings, checkCli, queueSaveWorkspace */
'use strict';

// ------------------------------------------------------------------ Claude accounts
//
// Several Claude logins side by side, say a personal one and one from work. Each folder has an
// account it uses by default, and the pill in the chat box switches a chat to another account at
// any time; the conversation carries on where it was.

const acct = { accounts: [], rules: {}, defaultAccount: 'default', folderAccount: 'default', status: new Map(), usage: new Map() };

const multiAccount = () => acct.accounts.length > 1;
const accountName = (id) => (acct.accounts.find((a) => a.id === id) || acct.accounts[0] || { name: 'Main account' }).name;
const chatAccount = (chat) => (chat && acct.accounts.some((a) => a.id === chat.account) ? chat.account : acct.folderAccount);

function setAccounts(info) {
  Object.assign(acct, { accounts: info.accounts, rules: info.rules, defaultAccount: info.defaultAccount, folderAccount: info.folderAccount });
  renderAccountPill();
}

async function loadAccounts() {
  setAccounts(await desk.accounts.list());
}

// `claude auth status` for an account, cached. Returns { loggedIn, email, orgName, ... } or null.
async function accountStatus(id, fresh) {
  if (!fresh && acct.status.has(id)) return acct.status.get(id);
  const s = await desk.cliStatus(id).catch(() => null);
  const auth = s && s.found ? s.auth || { loggedIn: true } : null;
  acct.status.set(id, auth);
  return auth;
}

function accountDetail(auth) {
  if (!auth) return 'Checking…';
  if (!auth.loggedIn) return 'Not signed in';
  const who = auth.email || auth.orgName || 'Signed in';
  const plan = auth.subscriptionType ? ` · ${auth.subscriptionType[0].toUpperCase()}${auth.subscriptionType.slice(1)}` : '';
  return who + plan;
}

// ---------- the pill in the chat box

function renderAccountPill() {
  const btn = $('#account-btn');
  if (!btn) return;
  const chat = activeChat();
  btn.classList.toggle('hidden', !multiAccount());
  if (!multiAccount()) return;
  const id = chatAccount(chat);
  btn.textContent = `${accountName(id)} ▾`;
  btn.title = `This chat runs on your ${accountName(id)} Claude account. Click to switch.`;
  const usage = acct.usage.get(id);
  $('#status-limit').textContent = usage ? `${accountName(id)} usage ${usage}` : '';
}

// Rate-limit use arrives on each chat's events; it belongs to that chat's account.
function noteAccountUsage(chat, text) {
  const id = chatAccount(chat);
  acct.usage.set(id, text);
  if (!multiAccount()) $('#status-limit').textContent = `Usage ${text}`;
  else if (chatAccount(activeChat()) === id) renderAccountPill();
}

function toggleAccountMenu() {
  const old = $('#account-menu');
  if (old) return old.remove();
  const chat = activeChat();
  const current = chatAccount(chat);
  const folder = state.folder;
  const ruled = folder && acct.rules[folder.root] === current;
  const menu = h(
    'div',
    { id: 'account-menu', class: 'popup' },
    h('div', { class: 'menu-head' }, 'Run this chat on'),
    ...acct.accounts.map((a) => {
      const row = h('button', { class: a.id === current ? 'active' : '', onclick: () => (menu.remove(), switchChatAccount(chat, a.id)) }, h('b', {}, a.name), h('span', { class: 'acct-detail' }, accountDetail(acct.status.get(a.id))));
      accountStatus(a.id).then((auth) => ($('.acct-detail', row).textContent = accountDetail(auth)));
      return row;
    }),
    h('div', { class: 'menu-sep' }),
    folder
      ? h(
          'button',
          {
            class: ruled ? 'checked' : '',
            title: ruled ? 'Stop tying this folder to an account' : `New chats in ${folder.name} use ${accountName(current)}`,
            onclick: async () => {
              menu.remove();
              setAccounts(await desk.accounts.setRule(folder.root, ruled ? null : current));
              toast(ruled ? `${folder.name} now uses your default account (${accountName(acct.folderAccount)}).` : `New chats in ${folder.name} will use ${accountName(current)}.`);
              checkCli();
            },
          },
          h('b', {}, `${ruled ? '✓ ' : ''}Always use ${accountName(current)} in ${folder.name}`)
        )
      : null,
    h('button', { onclick: () => (menu.remove(), openSettings('accounts')) }, h('b', {}, 'Manage accounts…'))
  );
  $('#account-wrap').append(menu);
  const away = (e) => {
    if (!menu.contains(e.target) && e.target !== $('#account-btn')) {
      menu.remove();
      removeEventListener('mousedown', away, true);
    }
  };
  addEventListener('mousedown', away, true);
}

async function switchChatAccount(chat, id) {
  if (!chat || chatAccount(chat) === id) return;
  const auth = await accountStatus(id, true);
  if (auth && !auth.loggedIn && !(await signInAccount(id))) return;
  chat.account = id;
  renderAccountPill();
  queueSaveWorkspace();
  if (chat.sessionId || chat.busy)
    appendChat(h('div', { class: 'notice' }, `Switched to ${accountName(id)}. ${chat.busy ? 'Your next message' : 'The conversation carries on, and your next message'} runs on this account.`), chat);
}

// ---------- signing in

// Signs an account in with Claude Code's own browser sign-in. Resolves true once it's signed in.
function signInAccount(id) {
  return new Promise((resolve) => {
    let url = null;
    let done = false;
    const status = h('div', { class: 'muted small' }, 'Starting…');
    const openBtn = h('button', { class: 'btn small', disabled: true, onclick: () => url && desk.openExternal(url) }, 'Open the sign-in page');
    const copyBtn = h('button', { class: 'btn small', disabled: true, onclick: () => url && (navigator.clipboard.writeText(url), toast('Link copied. Paste it into the browser window signed in to the right account.')) }, 'Copy link');
    const code = h('input', { type: 'text', placeholder: 'Paste the code here', spellcheck: 'false' });
    const submit = h('button', { class: 'btn small primary' }, 'Submit code');
    const sendCode = () => code.value.trim() && (desk.sendLoginCode(code.value), (submit.textContent = 'Checking…'));
    submit.addEventListener('click', sendCode);
    code.addEventListener('keydown', (e) => e.key === 'Enter' && sendCode());
    const offUrl = desk.onLoginUrl((u) => {
      url = u;
      openBtn.disabled = copyBtn.disabled = false;
      status.textContent = 'Your browser should open. Sign in there and click Authorize.';
    });
    const offExit = desk.onLoginExit(async (r) => {
      if (r.account && r.account !== id) return;
      const auth = await accountStatus(id, true);
      if (auth && auth.loggedIn) {
        done = true;
        close();
        toast(`${accountName(id)} is signed in${auth.email ? ` as ${auth.email}` : ''}.`);
        checkCli();
      } else status.textContent = "That didn't finish. Try again, or paste the code if the page showed one.";
    });
    const close = modal(
      [
        h(
          'div',
          { class: 'body acct-signin' },
          h('h3', {}, `Sign in to ${accountName(id)}`),
          h('p', { class: 'muted small' }, 'Your browser signs in with whichever Claude account it is using. If that is the other account, sign out on claude.ai first, or copy the link into a private window or another browser profile.'),
          status,
          h('div', { class: 'row' }, openBtn, copyBtn),
          h('div', { class: 'muted small' }, 'If the page shows you a code instead, paste it here:'),
          h('div', { class: 'row' }, code, submit)
        ),
        h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: () => close() }, 'Cancel')),
      ],
      {
        onClose: () => {
          offUrl();
          offExit();
          if (!done) desk.cancelLogin();
          resolve(done);
        },
      }
    );
    code.focus(); // so Escape closes it
    desk.startLogin(id).catch((e) => (status.textContent = String(e.message || e)));
  });
}

// ---------- Settings → Accounts

async function settingsAccounts(body) {
  await loadAccounts();
  const rerender = () => settingsAccounts(body);
  const nameInput = h('input', { type: 'text', placeholder: 'Name, e.g. Work', spellcheck: 'false' });
  const add = async () => {
    const name = nameInput.value.trim();
    if (!name) return nameInput.focus();
    const info = await desk.accounts.add(name);
    setAccounts(info);
    checkCli();
    await rerender();
    signInAccount(info.added).then(rerender);
  };
  nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && add());

  const rows = acct.accounts.map((a) => {
    const detail = h('span', { class: 'muted small' }, accountDetail(acct.status.get(a.id)));
    const signBtn = h('button', { class: 'btn small', onclick: () => signInAccount(a.id).then(rerender) }, 'Sign in');
    accountStatus(a.id, true).then((auth) => {
      detail.textContent = accountDetail(auth);
      signBtn.textContent = auth && auth.loggedIn ? 'Sign in again' : 'Sign in';
      signBtn.classList.toggle('primary', !(auth && auth.loggedIn));
    });
    const name = h('b', { class: 'acct-name', title: 'Click to rename', contenteditable: 'plaintext-only', spellcheck: 'false' }, a.name);
    name.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), name.blur()));
    name.addEventListener('blur', async () => {
      if (name.textContent.trim() && name.textContent.trim() !== a.name) setAccounts(await desk.accounts.rename(a.id, name.textContent));
      else name.textContent = a.name;
    });
    const isDefault = acct.defaultAccount === a.id;
    return h(
      'div',
      { class: 'acct-row' },
      h('div', { class: 'acct-who' }, name, isDefault ? h('span', { class: 'acct-tag' }, 'Default') : null, h('br'), detail),
      h('span', { class: 'spacer' }),
      isDefault ? null : h('button', { class: 'btn small', title: 'Folders without their own account use this one', onclick: async () => (setAccounts(await desk.accounts.setDefault(a.id)), rerender(), checkCli()) }, 'Make default'),
      signBtn,
      a.id === 'default'
        ? null
        : h(
            'button',
            {
              class: 'btn small danger',
              onclick: async () => {
                if (chats.some((c) => c.busy && chatAccount(c) === a.id)) return toast(`A chat is still running on ${a.name}. Stop it first.`);
                if (!confirm(`Remove ${a.name}? Claude Desk signs it out and deletes its chat history and settings on this computer. Your account itself isn't affected.`)) return;
                setAccounts(await desk.accounts.remove(a.id));
                for (const c of chats) if (c.account === a.id) c.account = null;
                renderAccountPill();
                rerender();
                checkCli();
              },
            },
            'Remove'
          )
    );
  });

  const ruleRows = Object.entries(acct.rules).map(([folder, id]) =>
    h(
      'div',
      { class: 'rule' },
      h('code', { title: folder }, folder),
      h('span', { class: 'muted small' }, `→ ${accountName(id)}`),
      h('span', { class: 'spacer' }),
      h('button', { class: 'icon-btn', title: 'Remove', onclick: async () => (setAccounts(await desk.accounts.setRule(folder, null)), rerender(), checkCli()) }, '✕')
    )
  );
  const folder = state.folder;
  const folderSel =
    folder &&
    h(
      'select',
      {
        onchange: async (e) => {
          setAccounts(await desk.accounts.setRule(folder.root, e.target.value || null));
          rerender();
          checkCli();
        },
      },
      h('option', { value: '', selected: !acct.rules[folder.root] }, `Default (${accountName(acct.defaultAccount)})`),
      ...acct.accounts.map((a) => h('option', { value: a.id, selected: acct.rules[folder.root] === a.id }, a.name))
    );

  body.replaceChildren(
    h('h3', {}, 'Accounts'),
    h('p', { class: 'muted small' }, 'Stay signed in to several Claude accounts, say a personal one and one from work. Each folder uses its default account, and the account button in the chat box switches any chat at any time.'),
    h('div', { class: 'set-box' }, ...rows, h('div', { class: 'row' }, nameInput, h('button', { class: 'btn small primary', onclick: add }, 'Add account'))),
    folder ? field(`${folder.name} uses`, folderSel, 'New chats in this folder (and folders inside it) start on this account. The terminal and commit messages use it too.') : null,
    h('div', { class: 'set-box' }, h('b', {}, 'Folder rules'), ruleRows.length ? h('div', { class: 'rules' }, ...ruleRows) : h('div', { class: 'muted small' }, 'No folders tied to an account yet.')),
    h('p', { class: 'muted small' }, 'Each extra account keeps its own sign-in, chat history and personal settings. A new account starts with a copy of your personal instructions and settings.')
  );
}

function wireAccounts() {
  $('#account-btn').addEventListener('click', toggleAccountMenu);
}
