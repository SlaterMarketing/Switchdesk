/* global $, h, state, desk, toast, modal, chats, activeChat, appendChat, openSettings, checkCli, queueSaveWorkspace, renderAgentButton, usageKey, usageLabel, resetText */
"use strict";

// ------------------------------------------------------------------ Claude accounts
//
// Several Claude logins side by side, say a personal one and one from work. Each folder has an
// account it uses by default, and the agent menu in the chat box switches a chat to another account at
// any time; the conversation carries on where it was.

const acct = {
  accounts: [],
  rules: {},
  defaultAccount: "default",
  folderAccount: "default",
  status: new Map(),
  usage: new Map(),
};

const multiAccount = () => acct.accounts.length > 1;
const accountName = (id) =>
  (
    acct.accounts.find((a) => a.id === id) ||
    acct.accounts[0] || { name: "Main account" }
  ).name;
const chatAccount = (chat) =>
  chat && acct.accounts.some((a) => a.id === chat.account)
    ? chat.account
    : acct.folderAccount;

function setAccounts(info) {
  Object.assign(acct, {
    accounts: info.accounts,
    rules: info.rules,
    defaultAccount: info.defaultAccount,
    folderAccount: info.folderAccount,
  });
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
  if (!auth) return "Checking…";
  if (!auth.loggedIn) return "Not signed in";
  const who = auth.email || auth.orgName || "Signed in";
  const plan = auth.subscriptionType
    ? ` · ${auth.subscriptionType[0].toUpperCase()}${auth.subscriptionType.slice(1)}`
    : "";
  return who + plan;
}

// ---------- usage in the status bar (the account itself is picked in the agent menu, agents.js)

// A small meter for the plan limits of the chat's agent and account: the 5-hour window and the week,
// as the agent last reported them. Hover for every account's; click for Settings → Usage.
function renderAccountPill() {
  const chat = activeChat();
  renderAgentButton();
  const el = $("#status-limit");
  const key = chat ? usageKey(chat) : `claude:${acct.folderAccount}`;
  const u = acct.usage.get(key);
  if (!u || !(u.short || u.long))
    return (el.replaceChildren(), (el.title = ""));
  const bar = (label, w) =>
    w &&
    h(
      "span",
      {
        class: `limit-meter${w.pct >= 95 ? " full" : w.pct >= 80 ? " high" : ""}`,
      },
      h("span", { class: "limit-label" }, label),
      h(
        "span",
        { class: "limit-track" },
        h("span", {
          class: "limit-fill",
          style: `width:${Math.min(100, Math.max(2, w.pct))}%`,
        }),
      ),
      h("span", { class: "limit-pct" }, `${w.pct}%`),
    );
  el.replaceChildren(
    h("span", { class: "limit-who" }, usageLabel(key)),
    bar("5h", u.short),
    bar("7d", u.long),
  );
  const when = (w) =>
    w && resetText(w.resetsAt) ? ` (${resetText(w.resetsAt)})` : "";
  const lines = [...acct.usage.entries()]
    .filter(([, x]) => x && (x.short || x.long))
    .map(
      ([k, x]) =>
        `${usageLabel(k)}: ${[x.short ? `5 hours ${x.short.pct}%${when(x.short)}` : "", x.long ? `week ${x.long.pct}%${when(x.long)}` : ""].filter(Boolean).join(", ")}`,
    );
  el.title = `Plan limits used, as last reported:\n${lines.join("\n")}\n\nClick for Settings → Usage.`;
}

// Rate-limit use arrives on each chat's events; it belongs to that chat's agent and account.
function noteAccountUsage(chat, windows) {
  acct.usage.set(usageKey(chat), windows);
  if (chat === activeChat()) renderAccountPill();
}

// What each account last reported, so the meter shows before the first message.
async function loadUsageLimits() {
  const s = await desk.usage.summary().catch(() => null);
  for (const [k, v] of Object.entries((s && s.limits) || {}))
    if (!acct.usage.has(k)) acct.usage.set(k, v);
  renderAccountPill();
}

async function switchChatAccount(chat, id) {
  if (!chat || chatAccount(chat) === id) return;
  const auth = await accountStatus(id, true);
  if (auth && !auth.loggedIn && !(await signInAccount(id))) return;
  chat.account = id;
  renderAccountPill();
  queueSaveWorkspace();
  if (chat.sessionId || chat.busy)
    appendChat(
      h(
        "div",
        { class: "notice" },
        `Switched to ${accountName(id)}. ${chat.busy ? "Your next message" : "The conversation carries on, and your next message"} runs on this account.`,
      ),
      chat,
    );
}

// ---------- signing in

// Signs an account in with Claude Code's own browser sign-in. Resolves true once it's signed in.
function signInAccount(id) {
  return new Promise((resolve) => {
    let url = null;
    let done = false;
    const status = h("div", { class: "muted small" }, "Starting…");
    const openBtn = h(
      "button",
      {
        class: "btn small",
        disabled: true,
        onclick: () => url && desk.openExternal(url),
      },
      "Open the sign-in page",
    );
    const copyBtn = h(
      "button",
      {
        class: "btn small",
        disabled: true,
        onclick: () =>
          url &&
          (navigator.clipboard.writeText(url),
          toast(
            "Link copied. Paste it into the browser window signed in to the right account.",
          )),
      },
      "Copy link",
    );
    const code = h("input", {
      type: "text",
      placeholder: "Paste the code here",
      spellcheck: "false",
    });
    const submit = h("button", { class: "btn small primary" }, "Submit code");
    const sendCode = () =>
      code.value.trim() &&
      (desk.sendLoginCode(code.value), (submit.textContent = "Checking…"));
    submit.addEventListener("click", sendCode);
    code.addEventListener("keydown", (e) => e.key === "Enter" && sendCode());
    const offUrl = desk.onLoginUrl((u) => {
      url = u;
      openBtn.disabled = copyBtn.disabled = false;
      status.textContent =
        "Your browser should open. Sign in there and click Authorize.";
    });
    const offExit = desk.onLoginExit(async (r) => {
      if (r.account && r.account !== id) return;
      const auth = await accountStatus(id, true);
      if (auth && auth.loggedIn) {
        done = true;
        close();
        toast(
          `${accountName(id)} is signed in${auth.email ? ` as ${auth.email}` : ""}.`,
        );
        checkCli();
      } else
        status.textContent =
          "That didn't finish. Try again, or paste the code if the page showed one.";
    });
    const close = modal(
      [
        h(
          "div",
          { class: "body acct-signin" },
          h("h3", {}, `Sign in to ${accountName(id)}`),
          h(
            "p",
            { class: "muted small" },
            "Your browser signs in with whichever Claude account it is using. If that is the other account, sign out on claude.ai first, or copy the link into a private window or another browser profile.",
          ),
          status,
          h("div", { class: "row" }, openBtn, copyBtn),
          h(
            "div",
            { class: "muted small" },
            "If the page shows you a code instead, paste it here:",
          ),
          h("div", { class: "row" }, code, submit),
        ),
        h(
          "div",
          { class: "foot" },
          h("button", { class: "btn", onclick: () => close() }, "Cancel"),
        ),
      ],
      {
        onClose: () => {
          offUrl();
          offExit();
          if (!done) desk.cancelLogin();
          resolve(done);
        },
      },
    );
    code.focus(); // so Escape closes it
    desk
      .startLogin(id)
      .catch((e) => (status.textContent = String(e.message || e)));
  });
}

// ---------- Claude's accounts, in Settings → Agents

// Claude's accounts work like the other agents' (each with its own sign-in), plus a default and
// per-folder rules, since the terminal and commit messages use the folder's account too.
function claudeAccountsBox(rerender) {
  const box = h(
    "div",
    { class: "agent-accounts claude-accounts" },
    h("div", { class: "muted small" }, "Loading accounts…"),
  );
  fillClaudeAccounts(box, rerender).catch((e) =>
    box.replaceChildren(
      h("div", { class: "turn-error" }, String(e.message || e)),
    ),
  );
  return box;
}

async function fillClaudeAccounts(box, rerender) {
  await loadAccounts();
  const nameInput = h("input", {
    type: "text",
    placeholder: "Name, e.g. Work",
    spellcheck: "false",
  });
  const add = async () => {
    const name = nameInput.value.trim();
    if (!name) return nameInput.focus();
    const info = await desk.accounts.add(name);
    setAccounts(info);
    checkCli();
    await rerender();
    signInAccount(info.added).then(rerender);
  };
  nameInput.addEventListener("keydown", (e) => e.key === "Enter" && add());

  const rows = acct.accounts.map((a) => {
    const detail = h(
      "span",
      { class: "muted small" },
      accountDetail(acct.status.get(a.id)),
    );
    const signBtn = h(
      "button",
      { class: "btn small", onclick: () => signInAccount(a.id).then(rerender) },
      "Sign in",
    );
    accountStatus(a.id, true).then((auth) => {
      detail.textContent = accountDetail(auth);
      signBtn.textContent = auth && auth.loggedIn ? "Sign in again" : "Sign in";
      signBtn.classList.toggle("primary", !(auth && auth.loggedIn));
    });
    const name = h(
      "b",
      {
        class: "acct-name",
        title: "Click to rename",
        contenteditable: "plaintext-only",
        spellcheck: "false",
      },
      a.name,
    );
    name.addEventListener(
      "keydown",
      (e) => e.key === "Enter" && (e.preventDefault(), name.blur()),
    );
    name.addEventListener("blur", async () => {
      if (name.textContent.trim() && name.textContent.trim() !== a.name)
        setAccounts(await desk.accounts.rename(a.id, name.textContent));
      else name.textContent = a.name;
    });
    const isDefault = acct.defaultAccount === a.id;
    return h(
      "div",
      { class: "acct-row" },
      h(
        "div",
        { class: "acct-who" },
        name,
        isDefault ? h("span", { class: "acct-tag" }, "Default") : null,
        h("br"),
        detail,
      ),
      h("span", { class: "spacer" }),
      isDefault
        ? null
        : h(
            "button",
            {
              class: "btn small",
              title: "Folders without their own account use this one",
              onclick: async () => (
                setAccounts(await desk.accounts.setDefault(a.id)),
                rerender(),
                checkCli()
              ),
            },
            "Make default",
          ),
      signBtn,
      a.id === "default"
        ? null
        : h(
            "button",
            {
              class: "btn small danger",
              onclick: async () => {
                if (chats.some((c) => c.busy && chatAccount(c) === a.id))
                  return toast(
                    `A chat is still running on ${a.name}. Stop it first.`,
                  );
                if (
                  !confirm(
                    `Remove ${a.name}? Switchdesk signs it out and deletes its chat history and settings on this computer. Your account itself isn't affected.`,
                  )
                )
                  return;
                setAccounts(await desk.accounts.remove(a.id));
                for (const c of chats) if (c.account === a.id) c.account = null;
                renderAccountPill();
                rerender();
                checkCli();
              },
            },
            "Remove",
          ),
    );
  });

  const ruleRows = Object.entries(acct.rules).map(([folder, id]) =>
    h(
      "div",
      { class: "rule" },
      h("code", { title: folder }, folder),
      h("span", { class: "muted small" }, `→ ${accountName(id)}`),
      h("span", { class: "spacer" }),
      h(
        "button",
        {
          class: "icon-btn",
          title: "Remove",
          onclick: async () => (
            setAccounts(await desk.accounts.setRule(folder, null)),
            rerender(),
            checkCli()
          ),
        },
        "✕",
      ),
    ),
  );
  const folder = state.folder;
  const folderSel =
    folder &&
    h(
      "select",
      {
        onchange: async (e) => {
          setAccounts(
            await desk.accounts.setRule(folder.root, e.target.value || null),
          );
          rerender();
          checkCli();
        },
      },
      h(
        "option",
        { value: "", selected: !acct.rules[folder.root] },
        `Default (${accountName(acct.defaultAccount)})`,
      ),
      ...acct.accounts.map((a) =>
        h(
          "option",
          { value: a.id, selected: acct.rules[folder.root] === a.id },
          a.name,
        ),
      ),
    );

  const multi = acct.accounts.length > 1;
  box.replaceChildren(
    ...[
      ...rows,
      h(
        "div",
        { class: "row" },
        nameInput,
        h("button", { class: "btn small", onclick: add }, "Add account"),
      ),
      folder && multi
        ? field(
            `${folder.name} uses`,
            folderSel,
            "New chats in this folder (and folders inside it) start on this account. The terminal and commit messages use it too.",
          )
        : null,
      ruleRows.length
        ? h(
            "div",
            { class: "rules" },
            h("div", { class: "muted small" }, "Folders tied to an account"),
            ...ruleRows,
          )
        : null,
      h(
        "div",
        { class: "muted small" },
        "Each account has its own Claude sign-in, chat history and personal settings (a new one starts with a copy of your instructions and settings). Pick it for a chat from the agent menu in the chat box.",
      ),
    ].filter(Boolean),
  );
}
