// End-to-end tests: the real app, driven through its window, with fake agents standing in for
// Cursor and Copilot. Run with `npm test` (on Linux, under xvfb-run).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { launch, profile, project, autoAllow, prompts, chatWith, sendMessage, idle, sshServer, agentLog, fakeGithub, fakeLinear } = require('./helpers');

const until = (w, fn, arg, timeout = 30000) => w.waitForFunction(fn, arg, { timeout });

// Every test gets its own app, data folder and project, and closes the app even when it fails.
function appTest(name, fn, opts = {}) {
  test(name, { timeout: 120000 }, async () => {
    const p = profile();
    const dir = project(opts);
    const run = await launch(p, dir);
    try {
      await fn({ ...run, p, dir });
      assert.deepEqual(run.errors, [], 'no uncaught errors in the window');
    } finally {
      await run.app.close().catch(() => {});
    }
  });
}

appTest('opens a folder and a file', async ({ w }) => {
  const rows = await w.$$eval('.tree-row', (r) => r.map((x) => x.textContent.trim()));
  assert.ok(rows.some((r) => r.includes('cart.js')), `cart.js in the tree: ${rows}`);
  await w.evaluate(() => openFile('cart.js'));
  await until(w, () => activeTab() && activeTab().rel === 'cart.js');
  assert.match(await w.evaluate(() => editor.getValue()), /function total/);
});

appTest('without Claude Code, a signed-in agent is used instead of the setup screen', async ({ w }) => {
  await until(w, () => typeof cliState !== 'undefined' && cliState);
  // Where Claude Code is installed anyway (found through the login shell), there's nothing to check.
  if (await w.evaluate(() => cliState.found)) return;
  await until(w, () => state.settings.lastAgent && state.settings.lastAgent !== 'claude');
  assert.equal(await w.$('.setup-backdrop'), null);
  assert.notEqual(await w.evaluate(() => agentOf(activeChat())), 'claude');
});

appTest('an error in a chat can be reported as a GitHub issue, filled in', async ({ app, w }) => {
  await app.evaluate(({ shell }) => {
    global.opened = [];
    shell.openExternal = async (url) => global.opened.push(url);
  });
  await w.evaluate(() => appendChat(turnError('Cursor stopped: something broke', activeChat())));
  await w.click('.turn-error .err-report');
  const url = await (async () => {
    for (let i = 0; i < 50; i++) {
      const u = await app.evaluate(() => global.opened[0]);
      if (u) return new URL(u);
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
  assert.equal(url.pathname, '/SlaterMarketing/switchdesk/issues/new');
  assert.match(url.searchParams.get('extra'), /Switchdesk \d+\.\d+\.\d+[\s\S]*What it said:[\s\S]*something broke/);
});

appTest('replaces across files and undoes', async ({ w, dir }) => {
  await w.evaluate(() => openReplace());
  await w.fill('#search-query', 'price');
  await w.fill('#replace-with', 'cost');
  await until(w, () => /\d/.test($('#search-summary').textContent));
  await w.click('#replace-all');
  await w.waitForFunction(() => /Replaced/.test(document.body.innerText), null, { timeout: 15000 });
  assert.match(fs.readFileSync(path.join(dir, 'cart.js'), 'utf8'), /i\.cost/);
  assert.match(fs.readFileSync(path.join(dir, 'lib', 'price.js'), 'utf8'), /const cost/);
  await w.click('#replace-undo');
  await w.waitForFunction(() => /Undid the replace/.test(document.body.innerText), null, { timeout: 15000 });
  assert.match(fs.readFileSync(path.join(dir, 'cart.js'), 'utf8'), /i\.price/);
  assert.match(fs.readFileSync(path.join(dir, 'lib', 'price.js'), 'utf8'), /const price/);
});

appTest('Claude carries on after its background subagents, and a subagent opens to show its work', async ({ w, p }) => {
  // The stand-in Claude Code, found fresh (the app looked for Claude when it started).
  await w.evaluate(async (bin) => {
    state.settings = await desk.setSettings({ claudePath: bin });
    await agentStatus('claude', true);
    await checkCli();
  }, path.join(__dirname, 'fake-claude', 'claude'));
  await chatWith(w, 'claude', 'plan');
  await sendMessage(w, 'plan the empty cart fix');
  // Claude's first turn ends while its subagent runs in the background.
  await w.waitForSelector('.notice.waiting', { timeout: 30000 });
  assert.match(await w.$eval('.tool', (e) => e.innerText), /Find the cart code/);
  // When it finishes, Claude carries on by itself, and its plan reaches the chat.
  await w.waitForSelector('.card.plan .plan-summary', { timeout: 30000 });
  assert.match(await w.$eval('.card.plan', (e) => e.innerText), /Guard the empty cart/);
  assert.equal(await w.$$eval('.notice.waiting', (e) => e.length), 0);
  // The subagent's row opens its task, thinking, tools and report.
  await w.click('.tool .head:has-text("Find the cart code")');
  await w.waitForSelector('.sub-view .sub-status.completed', { timeout: 10000 });
  const view = await w.$eval('.sub-view', (e) => e.innerText);
  assert.match(view, /Find where the cart total is worked out/);
  assert.match(view, /Read cart\.js/);
  assert.match(view, /Finished · 1 step/);
  assert.match(view, /in total\(\)/);
  await w.click('.sub-view button:has-text("Back to chat")');
  assert.equal(await w.$$eval('.sub-view', (e) => e.length), 0);
  await w.click('.card.plan button:has-text("Build it")');
  await idle(w);
  await sendMessage(w, 'go');
  await idle(w);
  const answers = fs.readFileSync(path.join(p.agentDir, 'claude.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(answers[0].answer.behavior, 'allow', 'the plan was approved, not turned away');
});

appTest('a plan opens as a document with its to-dos, and Build it builds it', async ({ w, p }) => {
  await autoAllow(w);
  await chatWith(w, 'cursor', 'plan');
  await sendMessage(w, 'plan the empty cart fix');
  await w.waitForSelector('.card.plan .plan-summary', { timeout: 30000 });
  // The chat card is a short summary; the plan itself is in its tab.
  const card = await w.$eval('.card.plan', (e) => e.innerText);
  assert.match(card, /Tidy the cart/);
  assert.doesNotMatch(card, /Keep the rest as it is/);
  await until(w, () => activeTab() && activeTab().kind === 'plan');
  await w.waitForSelector('#plan-preview .plan-todo', { timeout: 10000 });
  const todos = await w.$$eval('#plan-preview .plan-todo', (e) => e.map((x) => x.innerText));
  assert.ok(todos.some((t) => /Guard the empty cart/.test(t)), `to-dos: ${todos}`);
  // cart.js in the plan opens the file.
  await w.click('#plan-preview .file-ref');
  await until(w, () => activeTab() && activeTab().rel === 'cart.js');
  await w.evaluate(() => activateTab(state.tabs.find((t) => t.kind === 'plan').id));
  await w.click('#plan-bar button:has-text("Build it")');
  await until(w, () => state.tabs.find((t) => t.kind === 'plan').plan.status !== '');
  await idle(w);
  assert.ok(prompts(p, 'cursor').some((t) => /Build this plan now/.test(t)), 'the build was asked for');
  assert.equal(await w.evaluate(() => activeChat().mode || state.mode), 'agent');
});

appTest('plan tabs and comparisons come back after a restart', async ({ app, w, p, dir }) => {
  await autoAllow(w);
  await chatWith(w, 'cursor', 'plan');
  await sendMessage(w, 'plan it');
  await w.waitForSelector('.card.plan', { timeout: 30000 });
  await w.evaluate(() => startComparison('compare-test', [{ id: 'cursor', label: 'Cursor' }, { id: 'copilot', label: 'Copilot' }], false));
  await until(w, () => chats.filter((c) => c.compare && c.sessionId && !c.busy && !c.making).length === 2, null, 60000);
  await w.evaluate(() => saveWorkspace());
  await app.close();

  const again = await launch(p, dir);
  try {
    const w2 = again.w;
    await until(w2, () => state.tabs.some((t) => t.kind === 'plan'));
    await until(w2, () => chats.filter((c) => c.compare).length === 2);
    await w2.evaluate(() => switchChat(chats.find((c) => c.compare).id));
    await until(w2, () => /2 agents/.test($('#compare-bar').innerText) && /1 file/.test($('#compare-bar').innerText));
    // Build it still works: it asks the plan's chat for a build as a new message.
    await w2.evaluate(() => activateTab(state.tabs.find((t) => t.kind === 'plan').id));
    await w2.click('#plan-bar button:has-text("Build it")');
    await until(w2, () => !chats.some((c) => c.busy) && state.tabs.find((t) => t.kind === 'plan').plan.status !== '');
    assert.ok(prompts(p, 'cursor').some((t) => /Build this plan now/.test(t)));
    assert.deepEqual(again.errors, []);
  } finally {
    await again.app.close().catch(() => {});
  }
});

appTest('switching agent carries on in the same tab', async ({ w, p }) => {
  await chatWith(w, 'cursor');
  await sendMessage(w, 'remember the word pineapple');
  await idle(w);
  const tabs = await w.evaluate(() => chats.length);
  await w.evaluate(() => pickAgent('copilot'));
  assert.equal(await w.evaluate(() => chats.length), tabs, 'no new tab');
  assert.match(await w.evaluate(() => activeChat().el.innerText), /Switched from Cursor to Copilot/);
  await sendMessage(w, 'what was the word?');
  await idle(w);
  const sent = prompts(p, 'copilot').pop();
  assert.match(sent, /pineapple/, 'Copilot gets the conversation so far');
  assert.match(sent, /what was the word/);
});

appTest('the same prompt to two agents, then merge one', async ({ w, dir }) => {
  await w.evaluate(() => startComparison('compare-test', [{ id: 'cursor', label: 'Cursor' }, { id: 'copilot', label: 'Copilot' }], false));
  await until(w, () => chats.filter((c) => c.compare && (c.wtChanges || []).length && !c.busy).length === 2, null, 60000);
  // Each worked in its own copy; the folder itself is untouched.
  assert.equal(fs.existsSync(path.join(dir, 'fake.txt')), false);
  const copies = await w.evaluate(() => chats.filter((c) => c.compare).map((c) => c.worktree.path));
  assert.equal(new Set(copies).size, 2);
  await w.evaluate(() => switchChat(chats.find((c) => c.compare && c.agent === 'copilot').id));
  await w.evaluate(() => useComparison(activeChat()));
  await w.click('.modal button:has-text("Merge")');
  await until(w, () => chats.some((c) => c.merged));
  assert.equal(fs.readFileSync(path.join(dir, 'fake.txt'), 'utf8'), 'from copilot\n');
  // The other copy is deleted once you say so (the test answers yes).
  await until(w, () => chats.filter((c) => c.compare && c.worktree.removed).length === 1);
});

appTest('✨ writes commit messages and pull requests with the agent of the chat', async ({ w, dir }) => {
  const g = (...a) => require('child_process').execFileSync('git', a, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' } }).toString();
  fs.appendFileSync(path.join(dir, 'cart.js'), '// more\n');
  const message = await w.evaluate(() => desk.git.suggest('cursor'));
  assert.match(message, /^\[cursor\] \[ask\] got: Write a git commit message/);
  g('checkout', '-q', '-b', 'more');
  g('commit', '-qam', 'More');
  const pr = await w.evaluate(() => desk.git.pr('copilot'));
  assert.match(pr.title, /^\[copilot\] \[ask\] got: Write a pull request for this branch \(more, going into main\)/);
  assert.equal(pr.branch, 'more');
});

appTest('a second opinion marks its findings in the editor', async ({ w }) => {
  await w.evaluate(() => startOpinion({ id: 'copilot', label: 'Copilot' }, ['cart.js'], activeChat()));
  await w.waitForSelector('.card.findings', { timeout: 30000 });
  assert.match(await w.$eval('.card.findings', (e) => e.innerText), /Empty cart not handled/);
  await w.evaluate(() => openFile('cart.js'));
  await until(w, () => monaco.editor.getModelMarkers({ owner: 'second-opinion' }).length === 1);
});

appTest('agents can drive the Preview', async ({ w }) => {
  const http = require('http');
  const page = '<title>Counter</title><button id="add" onclick="n.textContent = +n.textContent + 1">Add one</button> <span id="n">0</span><script>console.log("ready")</script>';
  const server = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(page));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${server.address().port}/`;
    const tool = (name, args = {}) => w.evaluate(([n, a]) => runPreviewTool(n, a), [name, args]);
    assert.match((await tool('preview_open', { url })).text, /Counter/);
    assert.match((await tool('preview_page')).text, /Add one/);
    await tool('preview_click', { text: 'Add one' });
    assert.equal((await tool('preview_eval', { expression: 'n.textContent' })).text, '"1"');
    assert.match((await tool('preview_console')).text, /ready/);
    assert.ok((await tool('preview_screenshot')).image, 'a screenshot');
  } finally {
    server.close();
  }
});

appTest('a scheduled task runs on its own in a copy of the folder', async ({ w, p, dir }) => {
  // When it's next due.
  const due = await w.evaluate(() => {
    const at = new Date(2026, 9, 16, 10, 0).getTime(); // a Friday, 10:00
    return {
      day: new Date(nextRun({ every: 'day', time: '09:00' }, at)).toString(),
      weekdays: new Date(nextRun({ every: 'weekdays', time: '09:00' }, at)).getDay(),
      hours: nextRun({ every: 'hours', hours: 3 }, at) - at,
    };
  });
  assert.match(due.day, /Sat Oct 17 2026 09:00/);
  assert.equal(due.weekdays, 1, 'weekdays skip to Monday');
  assert.equal(due.hours, 3 * 3600e3);
  // Make one in the dialog.
  await w.evaluate(() => chooseAgent('cursor'));
  await w.evaluate(() => openSchedules('new'));
  await w.fill('.schedules input[type="text"]', 'Nightly check');
  await w.fill('.schedules textarea', 'compare-test nightly');
  await w.click('.schedules button:has-text("Schedule it")');
  await until(w, () => schedules().length === 1 && $('.schedule-row'));
  assert.match(await w.$eval('.schedule-row', (e) => e.innerText), /Every day at 09:00 · Cursor · in its own copy/);
  await w.click('.modal button:has-text("Close")');
  // Pretend it last ran two days ago: it runs now, in the background.
  const before = await w.evaluate(() => activeChat().id);
  await w.evaluate(() => updateSchedule(schedules()[0].id, { lastRun: Date.now() - 2 * 864e5 }).then(checkSchedules));
  await until(w, () => chats.some((c) => c.scheduled && !c.busy && !c.making && c.sessionId), null, 30000);
  assert.equal(await w.evaluate(() => activeChat().id), before, 'you stay where you were');
  assert.ok(prompts(p, 'cursor').some((t) => /scheduled task/.test(t) && /compare-test nightly/.test(t)));
  assert.equal(fs.existsSync(path.join(dir, 'fake.txt')), false, 'your folder is untouched');
  await until(w, () => schedules()[0].lastResult === 'done' && Date.now() - schedules()[0].lastRun < 60000);
  // Not again until it's next due.
  await w.evaluate(() => checkSchedules());
  assert.equal(await w.evaluate(() => chats.filter((c) => c.scheduled).length), 1);
});

appTest('a notebook opens as cells and runs them in a Jupyter kernel', async ({ w, dir }) => {
  const cell = (cell_type, source, extra = {}) => ({ cell_type, id: Math.random().toString(16).slice(2, 10), metadata: {}, source, ...extra });
  const nbFile = {
    cells: [
      cell('markdown', ['# Sales\n', 'Some **notes**.']),
      cell('code', ['x = 6 * 7\n', 'print("hello")\n', 'x'], { outputs: [], execution_count: null }),
      cell('code', ['from IPython.display import HTML\n', 'HTML("<table><tr><td>cell</td></tr></table>")'], { outputs: [], execution_count: null }),
      cell('code', ['1 / 0'], { outputs: [], execution_count: null }),
      cell('code', ['print("never")'], { outputs: [], execution_count: null }),
    ],
    metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' }, language_info: { name: 'python' } },
    nbformat: 4,
    nbformat_minor: 5,
  };
  fs.writeFileSync(path.join(dir, 'sales.ipynb'), JSON.stringify(nbFile, null, 1));
  await w.evaluate(() => refreshFiles());
  await w.evaluate(() => openFile('sales.ipynb'));
  await w.waitForSelector('#nb-view .nb-cell.code .monaco-editor', { timeout: 15000 });
  assert.equal(await w.$$eval('#nb-view .nb-cell', (e) => e.length), 5);
  assert.match(await w.$eval('#nb-view .nb-md', (e) => e.innerHTML), /<h1[^>]*>Sales<\/h1>/);
  await w.click('#nb-bar button:has-text("Run all")');
  await w.waitForSelector('#nb-view .nb-out.error', { timeout: 90000 }).catch(async (err) => {
    throw new Error(`${err.message}\n${await w.$eval('#nb-view', (e) => e.innerText.slice(0, 600))}`);
  });
  const outs = await w.$$eval('#nb-view .nb-outputs', (e) => e.map((x) => x.innerText));
  assert.match(outs[0], /hello[\s\S]*42/);
  assert.match(outs[1], /cell/);
  assert.match(outs[2], /ZeroDivisionError/);
  assert.equal(outs[3], '', 'running stops at the error');
  assert.match(await w.$eval('#nb-bar', (e) => e.innerText), /Python 3.*Idle/);
  // The outputs are in the file once saved.
  await w.evaluate(() => saveActive());
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'sales.ipynb'), 'utf8'));
  assert.equal(saved.cells[1].execution_count, 1);
  assert.deepEqual(saved.cells[1].outputs[0], { output_type: 'stream', name: 'stdout', text: ['hello\n'] });
  assert.equal(saved.cells[1].outputs[1].data['text/plain'], '42');
  // A new cell, typed and run with Shift+Enter; the kernel remembers x.
  await w.click('#nb-view .nb-adder button:has-text("Code")');
  // Type once the new cell's editor has the focus, so no key goes elsewhere.
  await until(w, () => { const codes = document.querySelectorAll('#nb-view .nb-code'); return codes.length === 5 && codes[4].contains(document.activeElement); });
  await w.keyboard.type('print(x + 1)');
  await w.keyboard.press('Shift+Enter');
  await until(w, () => /43/.test(document.querySelectorAll('#nb-view .nb-outputs')[4]?.innerText || ''), null, 30000).catch(async () => {
    throw new Error('outputs: ' + (await w.$$eval('#nb-view .nb-outputs', (e) => e.map((x) => x.innerText).join(' | '))));
  });
});

appTest('switching chat tabs opens each chat at its latest messages', async ({ w }) => {
  const fill = (n) => w.evaluate((n) => { for (let i = 0; i < n; i++) appendChat(h('div', { class: 'msg' }, `line ${i}`.repeat(40))); }, n);
  await chatWith(w, 'cursor');
  await fill(60);
  const first = await w.evaluate(() => activeChat().id);
  await w.evaluate(() => createChat());
  await fill(60);
  const second = await w.evaluate(() => activeChat().id);
  const atBottom = () => w.evaluate(() => { const el = $('#messages-host'); return el.scrollHeight - el.scrollTop - el.clientHeight < 4; });
  await w.evaluate(() => ($('#messages-host').scrollTop = 0));
  await w.evaluate((id) => switchChat(id), first);
  await until(w, () => { const el = $('#messages-host'); return el.scrollHeight - el.scrollTop - el.clientHeight < 4; });
  await w.evaluate(() => ($('#messages-host').scrollTop = 200));
  await w.evaluate((id) => switchChat(id), second);
  await w.waitForTimeout(100);
  assert.ok(await atBottom(), 'the second chat opens at its latest messages');
});

test('with no folder open, a chat still works, in a folder of its own', { timeout: 60000 }, async () => {
  const p = profile();
  const { app, w, errors } = await launch(p, null);
  try {
    assert.match(await w.$eval('#chat', (e) => e.innerText), /plain chat/);
    await chatWith(w, 'cursor');
    await sendMessage(w, 'what is a monad');
    await idle(w);
    assert.match(await w.$eval('#chat', (e) => e.innerText), /got: what is a monad/);
    const cwd = agentLog(p).filter((m) => m.method === 'session/new').pop().params.cwd;
    assert.equal(cwd, path.join(p.home, '.switchdesk', 'chats'));
    assert.deepEqual(errors, []);
  } finally {
    await app.close().catch(() => {});
  }
});

test('the Desk view: just the chat with your chats down the left, files beside it when opened, and back to Code', { timeout: 90000 }, async () => {
  const p = profile();
  const dir = project();
  const demo = path.join(p.agentDir, 'demo.json');
  require('fs').writeFileSync(demo, JSON.stringify([{ match: 'write the notes', steps: [{ write: { path: 'notes/plan.md', content: '# The plan\n\nShip it on Tuesday.\n' } }, { say: 'Done.' }] }]));
  let { app, w, errors } = await launch(p, dir, { FAKE_AGENT_DEMO: demo });
  const shown = (sel) => w.$eval(sel, (e) => getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0);
  try {
    await w.click('#view-switch [data-view=desk]');
    await w.waitForFunction(() => document.body.classList.contains('desk'));
    assert.equal(await shown('#editor-area'), false);
    assert.equal(await shown('#history-list'), true);
    assert.equal(await shown('.side-tabs'), false);
    assert.match(await w.$eval('#desk-folder', (e) => e.innerText), new RegExp(path.basename(dir)));
    await chatWith(w, 'cursor');
    assert.equal(await shown('.desk-starters'), true);
    await sendMessage(w, 'hello from desk');
    await idle(w);
    assert.match(await w.$eval('#chat', (e) => e.innerText), /got: hello from desk/);
    // What the agent writes is listed beside the chat, with a preview.
    await sendMessage(w, 'write the notes');
    await idle(w);
    await w.waitForSelector('#desk-outputs .out-row:has-text("plan.md")');
    await w.waitForSelector('#desk-outputs .out-doc h1:has-text("The plan")');
    assert.equal(await shown('#editor-area'), false);
    // A file opened from the chat shows beside it, and goes away when closed.
    await w.evaluate(() => openFile('cart.js'));
    await w.waitForFunction(() => document.querySelector('#workbench').classList.contains('peek'));
    assert.equal(await shown('#editor-area'), true);
    await w.evaluate(() => closeTab(state.activeTab));
    assert.equal(await shown('#editor-area'), false);
    // The view is remembered.
    await app.close();
    ({ app, w, errors } = await launch(p, dir));
    await w.waitForFunction(() => document.body.classList.contains('desk'));
    await w.click('#view-switch [data-view=code]');
    assert.equal(await shown('#editor-area'), true);
    assert.equal(await shown('.side-tabs'), true);
    assert.equal(await w.evaluate(() => state.settings.view), 'code');
    assert.deepEqual(errors, []);
  } finally {
    await app.close().catch(() => {});
  }
});

test('pull requests: fix a check and a comment, push, review with an agent, and an issue to a PR', { timeout: 180000 }, async () => {
  const p = profile();
  const dir = project();
  const hub = await fakeGithub(dir);
  const { app, w, errors } = await launch(p, dir, hub.env);
  const gitIn = (cwd, ...a) => require('child_process').execFileSync('git', a, { cwd }).toString().trim();
  try {
    // New chats use a stand-in agent.
    await w.evaluate(async () => (state.settings = await desk.setSettings({ lastAgent: 'cursor' })));
    await w.evaluate(() => desk.github.setToken('test-token').then(() => refreshGithub(true)));
    await w.evaluate(() => showSidePanel('git'));
    await w.waitForSelector('.gh-row:has-text("Guard the cart total")', { timeout: 30000 });
    assert.match(await w.$eval('.gh-row', (e) => e.innerText), /#7 · sam/);
    // The pull request opens in a tab with its check, comment and files.
    await w.click('.gh-row:has-text("Guard the cart total")');
    await w.waitForSelector('#pr-view .pr-thread', { timeout: 15000 });
    const view = await w.$eval('#pr-view', (e) => e.innerText);
    for (const want of [/fix-cart/, /1 test failed/, /What about a null cart\?/, /Files changed \(1\)/i]) assert.match(view, want);
    // Its file opens as a diff in the editor, with the review comment under its line.
    await w.click('#pr-view .pr-file .git-file');
    await w.waitForSelector('#diff-editor .pr-zone .pr-inline-thread:has-text("What about a null cart?")', { timeout: 15000 });
    assert.match(await w.evaluate(() => diffEditor.getModifiedEditor().getValue()), /0\) \|\| 0/);
    assert.doesNotMatch(await w.evaluate(() => diffEditor.getOriginalEditor().getValue()), /\|\| 0/);
    // Comment on another line from there.
    await w.evaluate(() => diffEditor.getModifiedEditor().setPosition({ lineNumber: 3, column: 1 }));
    await w.click('#diff-comment');
    await w.fill('#diff-editor .pr-inline-thread.draft textarea', 'Should this be exported?');
    await w.click('#diff-editor .pr-inline-thread.draft button:has-text("Comment")');
    await w.waitForSelector('#diff-editor .pr-inline-thread:has-text("Should this be exported?"):not(.draft)', { timeout: 15000 });
    assert.deepEqual(hub.posted.find((x) => x.key === 'POST /repos/o/r/pulls/7/comments').body, { commit_id: hub.sha, path: 'cart.js', line: 3, side: 'RIGHT', body: 'Should this be exported?' });
    // On the pull request's branch, your own copy of the file shows its comments too.
    gitIn(dir, 'checkout', '-q', 'fix-cart');
    await w.evaluate(() => refreshGit().then(() => openFile('cart.js')));
    await w.waitForSelector('#editor .pr-zone .pr-inline-thread:has-text("What about a null cart?")', { timeout: 15000 });
    await w.evaluate(() => (editor.setPosition({ lineNumber: 1, column: 1 }), editor.getAction('switchdesk.prComment').run()));
    await w.waitForSelector('#editor .pr-inline-thread.draft', { timeout: 5000 });
    await w.click('#editor .pr-inline-thread.draft button:has-text("Cancel")');
    gitIn(dir, 'checkout', '-q', 'main');
    await w.evaluate(() => refreshGit().then(() => activateTab('pr:7')));
    // A failing check goes to an agent in a copy at the pull request's commit, with its log.
    await w.click('#pr-view .pr-check button:has-text("Fix with the agent")');
    await until(w, () => activeChat() && activeChat().pr && activeChat().worktree && !activeChat().busy && (activeChat().wtChanges || []).length > 0, null, 60000);
    const asked = prompts(p).pop();
    assert.match(asked, /pull request #7/);
    assert.match(asked, /total\(null\) threw TypeError/, 'the check log is in the prompt');
    const copy = await w.evaluate(() => activeChat().worktree.root);
    assert.equal(gitIn(copy, 'rev-parse', 'HEAD~1'), hub.sha, 'the copy started at the pull request\'s commit');
    // The review comment goes to the same chat.
    await w.click('#pr-view .pr-thread button:has-text("Fix with the agent")');
    await until(w, () => !activeChat().busy && activeChat().pr.threads.length === 1, null, 30000);
    assert.match(prompts(p).pop(), /What about a null cart\?/);
    assert.equal(await w.evaluate(() => chats.filter((c) => c.pr).length), 1, 'one chat per pull request');
    // Push sends the commits to the pull request's branch and answers the comment.
    await w.click('#worktree-bar button:has-text("Push to PR #7")');
    await w.click('.modal button:has-text("Push")');
    await w.waitForFunction(() => /Pushed [0-9a-f]{7} to PR #7/.test(activeChat().el.innerText), null, { timeout: 30000 });
    assert.equal(gitIn(hub.bare, 'rev-parse', 'fix-cart'), gitIn(copy, 'rev-parse', 'HEAD'));
    assert.ok(hub.posted.some((x) => x.key.endsWith('/comments/900/replies') && /^Fixed in [0-9a-f]{7}/.test(x.body.body)));
    // Switchdesk watches the checks: they fail again, so the agent fixes it and the fix is pushed.
    const chatText = () => w.evaluate(() => chats.find((c) => c.pr && c.pr.number === 7).el.innerText);
    await w.evaluate(() => checkWatches());
    await until(w, () => /Watching its checks again/.test(chats.find((c) => c.pr && c.pr.number === 7).el.innerText), null, 30000);
    assert.match(await chatText(), /test failed on PR #7\. Asking Cursor to fix it \(try 1 of 3\)/);
    assert.match(prompts(p).pop(), /try 1 of 3/);
    assert.equal(gitIn(hub.bare, 'rev-parse', 'fix-cart'), gitIn(copy, 'rev-parse', 'HEAD'), 'the fix was pushed by itself');
    // Then they pass, and it says so.
    await w.evaluate(() => checkWatches());
    await until(w, () => /Checks pass on PR #7/.test(chats.find((c) => c.pr && c.pr.number === 7).el.innerText));
    assert.equal(await w.evaluate(() => chats.find((c) => c.pr && c.pr.number === 7).pr.watch), null);
    // Review with an agent: its findings go to GitHub as a review with a line comment.
    await w.evaluate(() => activateTab('pr:7'));
    await w.click('#pr-view button:has-text("Review with an agent")');
    await w.click('.modal .result');
    await w.waitForSelector('.card.findings button:has-text("Post to the pull request")', { timeout: 60000 });
    await w.click('.card.findings button:has-text("Post to the pull request")');
    await w.waitForSelector('.card.findings button:has-text("Posted to GitHub")', { timeout: 15000 });
    const review = hub.posted.find((x) => x.key.endsWith('/pulls/7/reviews')).body;
    assert.equal(review.commit_id, gitIn(hub.bare, 'rev-parse', 'fix-cart'), 'the review is on its latest commit');
    assert.deepEqual(review.comments.map((c) => [c.path, c.line]), [['cart.js', 2]]);
    assert.match(review.comments[0].body, /Null cart throws/);
    // Ask for a review, approve, and merge, all from the pull request's tab.
    await w.evaluate(() => activateTab('pr:7'));
    await w.click('#pr-view button:has-text("Request review")');
    await w.fill('.modal input', 'alex');
    await w.click('.modal button:has-text("Request review")');
    await until(w, () => !document.querySelector('.modal'));
    assert.deepEqual(hub.posted.find((x) => x.key.endsWith('/requested_reviewers')).body, { reviewers: ['alex'] });
    await w.click('#pr-view button:has-text("Approve")');
    await w.click('.modal button:has-text("Approve")');
    await until(w, () => !document.querySelector('.modal'));
    assert.ok(hub.posted.some((x) => x.key.endsWith('/pulls/7/reviews') && x.body.event === 'APPROVE'));
    await w.click('#pr-view button:has-text("Merge…")');
    await w.click('.modal button:has-text("Merge")');
    await until(w, () => !document.querySelector('.modal'));
    const merged = hub.posted.find((x) => x.key === 'PUT /repos/o/r/pulls/7/merge').body;
    assert.equal(merged.merge_method, 'squash');
    assert.equal(merged.commit_title, 'Guard the cart total (#7)');
    assert.ok(hub.posted.some((x) => x.key === 'DELETE /repos/o/r/git/refs/heads/fix-cart'), 'its branch was deleted');
    await until(w, () => chats.filter((c) => c.pr && c.pr.number === 7).every((c) => c.worktree.removed), null, 15000);
    // An issue starts a chat in its own copy, which ends in a pull request that closes it.
    await w.evaluate(() => ((gh.open.issues = true), renderGit()));
    await w.click('.gh-row:has-text("Prices need a currency")');
    await w.click('.modal button:has-text("Start working on it")');
    await until(w, () => activeChat().issue && !activeChat().busy && (activeChat().wtChanges || []).length > 0, null, 60000);
    assert.match(prompts(p).pop(), /issue #3: "Prices need a currency"/);
    await w.click('#worktree-bar button:has-text("Open pull request")');
    await w.click('.modal button:has-text("Open pull request")');
    await until(w, () => activeChat().pr && activeChat().pr.number === 8, null, 30000);
    const opened = hub.posted.find((x) => x.key === 'POST /repos/o/r/pulls').body;
    assert.equal(opened.title, 'Prices need a currency');
    assert.match(opened.body, /^Closes #3\./);
    assert.equal(opened.base, 'main');
    assert.equal(gitIn(hub.bare, 'rev-parse', opened.head), gitIn(await w.evaluate(() => activeChat().worktree.root), 'rev-parse', 'HEAD'), 'its branch was pushed');
    assert.deepEqual(errors, []);
  } finally {
    hub.close();
    await app.close().catch(() => {});
  }
});

test("a pull request from a fork: the fix is pushed to the fork's branch", { timeout: 120000 }, async () => {
  const p = profile();
  const dir = project();
  const hub = await fakeGithub(dir);
  // The pull request's branch is on alex's fork, which lets maintainers push to it.
  const forks = require('./helpers').tempDir('forks');
  const fork = path.join(forks, 'alex-r.git');
  require('child_process').execFileSync('git', ['clone', '-q', '--bare', hub.bare, fork]);
  Object.assign(hub.pr.head, { repo: { full_name: 'alex/r', name: 'r', owner: { login: 'alex' } } });
  hub.pr.maintainer_can_modify = true;
  const { app, w, errors } = await launch(p, dir, { ...hub.env, SWITCHDESK_GITHUB_FORKS: forks });
  const gitIn = (cwd, ...a) => require('child_process').execFileSync('git', a, { cwd }).toString().trim();
  try {
    await w.evaluate(async () => (state.settings = await desk.setSettings({ lastAgent: 'cursor' })));
    await w.evaluate(() => desk.github.setToken('test-token').then(() => refreshGithub(true)));
    await w.evaluate(() => openPr(7));
    await w.click('#pr-view .pr-check button:has-text("Fix with the agent")');
    await until(w, () => activeChat() && activeChat().pr && !activeChat().busy && (activeChat().wtChanges || []).length > 0, null, 60000);
    await w.click('#worktree-bar button:has-text("Push to PR #7")');
    assert.match(await w.$eval('.modal', (e) => e.innerText), /on alex's fork/);
    await w.click('.modal button:has-text("Push")');
    await w.waitForFunction(() => /Pushed [0-9a-f]{7} to PR #7/.test(activeChat().el.innerText), null, { timeout: 30000 });
    const copy = await w.evaluate(() => activeChat().worktree.root);
    assert.equal(gitIn(fork, 'rev-parse', 'fix-cart'), gitIn(copy, 'rev-parse', 'HEAD'), "the fork's branch has the fix");
    assert.equal(gitIn(hub.bare, 'rev-parse', 'fix-cart'), hub.sha, 'the main repository is untouched');
    assert.deepEqual(errors, []);
  } finally {
    hub.close();
    await app.close().catch(() => {});
  }
});

test('a Linear issue: start work on it, and its pull request says it fixes it', { timeout: 120000 }, async () => {
  const p = profile();
  const dir = project();
  const hub = await fakeGithub(dir);
  const linear = await fakeLinear();
  const { app, w, errors } = await launch(p, dir, { ...hub.env, ...linear.env });
  try {
    await w.evaluate(async () => (state.settings = await desk.setSettings({ lastAgent: 'cursor' })));
    await w.evaluate(() => desk.github.setToken('test-token').then(() => refreshGithub(true)));
    await w.evaluate(() => showSidePanel('git'));
    await w.click('.git-section:has-text("Linear")');
    await w.click('button:has-text("Connect Linear")');
    await w.fill('.modal input', 'lin_api_wrong');
    await w.click('.modal button:has-text("Connect")');
    await w.waitForFunction(() => /didn't accept/.test(document.querySelector('.modal').innerText));
    await w.fill('.modal input', 'lin_api_test');
    await w.click('.modal button:has-text("Connect")');
    await w.waitForSelector('.gh-row:has-text("Totals need tax")', { timeout: 15000 });
    assert.match(await w.$eval('.gh-row:has-text("Totals need tax")', (e) => e.innerText), /ENG-12 · Todo · High/);
    await w.click('.gh-row:has-text("Totals need tax")');
    await w.click('.modal button:has-text("Start working on it")');
    await until(w, () => activeChat().issue && !activeChat().busy && (activeChat().wtChanges || []).length > 0, null, 60000);
    assert.match(prompts(p).pop(), /Linear issue ENG-12: "Totals need tax"[\s\S]*Add 20% tax/);
    assert.match(await w.$eval('#worktree-bar', (e) => e.innerText), /Issue ENG-12/);
    await w.click('#worktree-bar button:has-text("Open pull request")');
    await w.click('.modal button:has-text("Open pull request")');
    await until(w, () => activeChat().pr && activeChat().pr.number === 8, null, 30000);
    const opened = hub.posted.find((x) => x.key === 'POST /repos/o/r/pulls').body;
    assert.match(opened.body, /^Fixes ENG-12\./);
    const commented = () => linear.requests.find((r) => /commentCreate/.test(r.query));
    for (let i = 0; i < 50 && !commented(); i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(commented().variables, { id: 'iss-12', body: 'Pull request: [#8 Totals need tax](https://github.com/o/r/pull/8)' });
    assert.deepEqual(errors, []);
  } finally {
    linear.close();
    hub.close();
    await app.close().catch(() => {});
  }
});

test('the board: start several at once, and see what each one needs', { timeout: 120000 }, async () => {
  const p = profile();
  const dir = project();
  const hub = await fakeGithub(dir);
  const { app, w, errors } = await launch(p, dir, hub.env);
  const col = (key) => w.$$eval(`#board-view .board-col.${key} .board-title`, (els) => els.map((e) => e.textContent.trim()));
  try {
    await w.evaluate(async () => (state.settings = await desk.setSettings({ lastAgent: 'cursor' })));
    await w.evaluate(() => desk.github.setToken('test-token').then(() => refreshGithub(true)));
    await w.click('#btn-board');
    await w.waitForSelector('#board-view .board-empty');
    // An issue and two typed tasks, each in its own copy.
    await w.click('#board-view button:has-text("Start several")');
    await w.check('.modal .board-pick:has-text("Prices need a currency") input');
    await w.fill('.modal textarea', 'compare-test the board\nsay hello');
    await w.click('.modal button:has-text("Start")');
    await until(w, () => chats.filter((c) => c.worktree).length === 3 && chats.every((c) => !c.busy && !c.making), null, 60000);
    await until(w, () => document.querySelectorAll('#board-view .board-col.review .board-card').length === 2, null, 15000);
    assert.deepEqual((await col('review')).sort(), ['#3 Prices need a currency', 'compare-test the board']);
    assert.deepEqual(await col('idle'), ['say hello']);
    assert.equal(new Set(await w.evaluate(() => chats.filter((c) => c.worktree).map((c) => c.worktree.root))).size, 3, 'three copies');
    assert.match(await w.$eval('#board-view .board-card:has-text("Prices need a currency")', (e) => e.innerText), /Open pull request/i);
    // One that plans first asks to run a command: it shows under Needs you, with Answer.
    await w.click('#board-view button:has-text("Start several")');
    await w.fill('.modal textarea', 'plan the cart');
    await w.selectOption('.modal select >> nth=1', 'plan');
    await w.click('.modal button:has-text("Start")');
    // (Its plan opens in a tab of its own, so go back to the board.)
    await until(w, () => chats.some((c) => c.title === 'plan the cart' && c.el.querySelector('.card.plan')), null, 30000);
    await w.click('#btn-board');
    await until(w, () => document.querySelectorAll('#board-view .board-col.needs .board-card').length === 1, null, 30000);
    assert.deepEqual(await col('needs'), ['plan the cart']);
    await w.click('#board-view .board-col.needs button:has-text("Answer")');
    assert.equal(await w.evaluate(() => activeChat().title), 'plan the cart');
    assert.deepEqual(errors, []);
  } finally {
    hub.close();
    await app.close().catch(() => {});
  }
});

test('an SSH folder: files, search, git, the terminal, an agent and a pull request all on the host', { timeout: 180000 }, async (t) => {
  const p = profile();
  const server = await sshServer(p);
  if (!server) return t.skip('no sshd on this machine');
  const dir = project();
  const hub = await fakeGithub(dir);
  const { app, w, errors } = await launch(p, null, { SWITCHDESK_SSH_CONFIG: server.config, ...hub.env });
  try {
    await w.evaluate((url) => desk.openFolder(url).then(setFolder), `ssh://${server.host}${dir}`);
    await w.waitForSelector('.tree-row', { timeout: 30000, state: 'attached' });
    assert.equal(await w.evaluate(() => state.folder.remote), server.host);
    assert.ok((await w.$$eval('.tree-row', (r) => r.map((x) => x.textContent))).some((x) => x.includes('cart.js')));
    // Open, edit and save a file.
    await w.evaluate(() => openFile('cart.js'));
    await until(w, () => activeTab() && activeTab().rel === 'cart.js');
    await w.evaluate(() => (editor.getModel().setValue('// edited over ssh\n' + editor.getValue()), saveActive()));
    await until(w, () => !activeTab().dirty);
    assert.match(fs.readFileSync(path.join(dir, 'cart.js'), 'utf8'), /^\/\/ edited over ssh/);
    // Search runs on the host.
    const found = await w.evaluate(() => desk.searchFiles('price', {}));
    assert.deepEqual(found.results.map((r) => r.rel).sort(), ['README.md', 'cart.js', 'lib/price.js']);
    // Git on the host sees the edit.
    const git = await w.evaluate(() => desk.git.status());
    assert.equal(git.repo, true);
    assert.deepEqual(git.files.map((f) => `${f.status} ${f.rel}`), ['M cart.js']);
    // Code intelligence runs the language server on the host.
    fs.writeFileSync(path.join(dir, 'main.go'), 'package main\n\nfunc main() {}\n');
    await w.evaluate(() => openFile('main.go'));
    await until(w, () => monaco.editor.getModelMarkers({}).some((m) => m.message === 'fake problem over ssh'), null, 30000);
    // A test runs on the host.
    fs.writeFileSync(path.join(dir, 'sum.test.js'), "const test = require('node:test');\nconst assert = require('assert');\ntest('adds', () => assert.equal(1 + 1, 2));\n");
    const ran = await w.evaluate(() => desk.tests.run({ rel: 'sum.test.js', name: 'adds', key: 'x' }));
    assert.ok(ran.passed, ran.output);
    assert.equal(ran.runner, 'Node');
    // A notebook's cells run in a kernel on the host.
    const nb = { cells: [{ cell_type: 'code', id: 'a1', metadata: {}, source: ['import os\n', 'print("on", os.environ.get("SSH_CONNECTION") is not None)'], outputs: [], execution_count: null }], metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } }, nbformat: 4, nbformat_minor: 5 };
    fs.writeFileSync(path.join(dir, 'host.ipynb'), JSON.stringify(nb));
    await w.evaluate(() => openFile('host.ipynb'));
    await w.waitForSelector('#nb-view .nb-cell.code .monaco-editor', { timeout: 15000 });
    await w.click('#nb-bar button:has-text("Run all")');
    await until(w, () => /on True/.test(document.querySelector('#nb-view .nb-outputs')?.innerText || ''), null, 90000).catch(async (err) => {
      throw new Error(`${err.message}\n${await w.$eval('#nb-view', (e) => e.innerText.slice(0, 600))}`);
    });
    // The debugger runs the program on the host and stops at a breakpoint, for Node and for Python.
    fs.writeFileSync(path.join(dir, 'calc.js'), "const a = 40;\nconst b = a + 2;\nconsole.log('answer', b);\n");
    fs.writeFileSync(path.join(dir, 'calc.py'), "a = 40\nb = a + 2\nprint('answer', b)\n");
    await w.evaluate(() => ((window.dbg = []), desk.debug.onEvent((e) => window.dbg.push(e))));
    for (const rel of ['calc.js', 'calc.py']) {
      await w.evaluate(() => (window.dbg.length = 0));
      const started = await w.evaluate((r) => desk.debug.start({ rel: r, breakpoints: { [r]: [3] } }), rel);
      assert.ok(!started.missing, `${rel}: ${JSON.stringify(started)}`);
      await until(w, (r) => window.dbg.some((e) => e.type === 'stopped' && e.frames[0] && e.frames[0].rel === r && e.frames[0].line === 3), rel, 30000);
      const ev = await w.evaluate(() => desk.debug.evaluate('b', window.dbg.find((e) => e.type === 'stopped').frames[0].id));
      assert.equal(ev.value, '42', `${rel}: ${JSON.stringify(ev)}`);
      await w.evaluate(() => desk.debug.cmd('continue'));
      await until(w, () => window.dbg.some((e) => e.type === 'terminated'), null, 30000);
      assert.match(await w.evaluate(() => window.dbg.filter((e) => e.type === 'output').map((e) => e.text).join('')), /answer 42/);
    }
    // The terminal is a shell on the host, in the folder.
    await w.evaluate(async () => {
      toggleTerminal(true);
      const term = await newTerminal();
      desk.term.write(term.id, 'echo "in-$(basename "$PWD")-$((40+2))"\r');
    });
    const want = `in-${path.basename(dir)}-42`;
    await until(w, (s) => terms.some((x) => { const b = x.xterm.buffer.active; for (let i = 0; i < b.length; i++) if ((b.getLine(i)?.translateToString() || '').includes(s)) return true; return false; }), want, 30000);
    // An agent runs on the host, in the folder, and its changes show as for a local folder.
    await chatWith(w, 'cursor');
    await sendMessage(w, 'compare-test over ssh');
    await idle(w);
    assert.equal(fs.readFileSync(path.join(dir, 'fake.txt'), 'utf8'), 'from cursor\n');
    const sent = agentLog(p).filter((m) => m.method === 'session/prompt');
    assert.ok(sent.length && sent.every((m) => m.overSsh), 'the agent ran over ssh');
    await until(w, () => /fake\.txt/.test(activeChat().el.innerText));
    // Two agents compare in copies on the host, and one is merged back into the folder.
    await w.evaluate(() => startComparison('compare-test', [{ id: 'cursor', label: 'Cursor' }, { id: 'copilot', label: 'Copilot' }], false));
    // (Cursor already wrote the same fake.txt in the folder, so only Copilot's copy differs.)
    await until(w, () => chats.filter((c) => c.compare && c.sessionId && !c.busy && !c.making).length === 2 && chats.some((c) => c.compare && c.agent === 'copilot' && (c.wtChanges || []).length), null, 60000);
    await w.evaluate(() => switchChat(chats.find((c) => c.compare && c.agent === 'copilot').id));
    await w.evaluate(() => useComparison(activeChat()));
    await w.click('.modal button:has-text("Merge")');
    await until(w, () => chats.some((c) => c.merged), null, 30000);
    assert.equal(fs.readFileSync(path.join(dir, 'fake.txt'), 'utf8'), 'from copilot\n');
    // A pull request's failing check is fixed by an agent in a copy of the folder on the host, and pushed.
    await w.evaluate(async () => (state.settings = await desk.setSettings({ lastAgent: 'cursor' })));
    await w.evaluate(() => desk.github.setToken('test-token').then(() => refreshGithub(true)));
    await w.evaluate(() => showSidePanel('git'));
    await w.click('.gh-row:has-text("Guard the cart total")');
    await w.click('#pr-view .pr-check button:has-text("Fix with the agent")');
    await until(w, () => activeChat() && activeChat().pr && activeChat().worktree && !activeChat().busy && (activeChat().wtChanges || []).length > 0, null, 60000);
    const copy = await w.evaluate(() => activeChat().worktree.root);
    assert.ok(copy.startsWith(path.join(p.home, '.switchdesk', 'worktrees')), `the copy is on the host: ${copy}`);
    assert.equal(fs.readFileSync(path.join(copy, 'fixed.txt'), 'utf8'), 'fixed by cursor\n');
    assert.ok(agentLog(p).some((m) => m.method === 'session/new' && m.params.cwd === copy && m.overSsh), 'the agent ran over ssh, in the copy');
    await w.click('#worktree-bar button:has-text("Push to PR #7")');
    await w.click('.modal button:has-text("Push")');
    await w.waitForFunction(() => /Pushed [0-9a-f]{7} to PR #7/.test(activeChat().el.innerText), null, { timeout: 30000 });
    const gitIn = (cwd, ...a) => require('child_process').execFileSync('git', a, { cwd }).toString().trim();
    assert.equal(gitIn(hub.bare, 'rev-parse', 'fix-cart'), gitIn(copy, 'rev-parse', 'HEAD'));
    // Its diff opens from the copy on the host too.
    const d = await w.evaluate(() => desk.worktree.diff(activeChat().worktree, 'fixed.txt'));
    assert.deepEqual(d, { before: '', after: 'fixed by cursor\n' });
    await w.evaluate(() => discardWorktree(activeChat(), { silent: true }));
    assert.ok(!fs.existsSync(copy), 'the copy was removed from the host');
    assert.deepEqual(errors, []);
  } finally {
    hub.close();
    await app.close().catch(() => {});
    server.stop();
  }
});

appTest('MCP servers sign in from Settings, and /mcp opens them', async ({ app, w, p }) => {
  fs.mkdirSync(p.agentDir, { recursive: true });
  fs.writeFileSync(path.join(p.agentDir, 'mcp.json'), JSON.stringify([{ name: 'claude.ai Atlassian Rovo', url: 'https://mcp.atlassian.com/v1/mcp', status: 'needs-auth' }]));
  // The "browser" opens the sign-in page, which signs in. On claude.ai's connector page, the user
  // adds Google Sheets.
  await app.evaluate(({ shell }, file) => {
    const fs = process.mainModule.require('fs');
    const sheets = { name: 'claude.ai Google Sheets', url: 'https://sheets.example.com/mcp', status: 'connected', hidden: true };
    shell.openExternal = async (url) => {
      if (url !== 'https://claude.ai/customize/connectors') return void fetch(url);
      fs.writeFileSync(file, JSON.stringify([...JSON.parse(fs.readFileSync(file, 'utf8')), sheets]));
    };
  }, path.join(p.agentDir, 'mcp.json'));
  await w.evaluate(async (bin) => {
    state.settings = await desk.setSettings({ claudePath: bin });
    await checkCli();
  }, path.join(__dirname, 'fake-claude', 'claude'));
  await chatWith(w, 'claude');
  await w.fill('#input', '/mcp');
  await w.press('#input', 'Enter'); // picks it from the menu
  await w.press('#input', 'Enter');
  await w.waitForSelector('.rule:has-text("claude.ai Atlassian Rovo") >> text=Needs authentication');
  await w.click('.rule:has-text("claude.ai Atlassian Rovo") button:has-text("Sign in")');
  await w.waitForSelector('.rule:has-text("claude.ai Atlassian Rovo") >> text=Connected');
  assert.equal(await w.$('.rule button:has-text("Sign in")'), null);
  // Adding a server that needs signing in signs in to it straight away.
  await w.fill('input[placeholder^="Name"]', 'tracker');
  await w.fill('input[placeholder^="https"]', 'https://tracker.example.com/mcp');
  await w.click('.set-box button:has-text("Add")');
  await w.waitForSelector('.rule:has-text("tracker") >> text=Connected');
  // The agent's tool, as Claude calls it from a chat: adds the server, then signs in.
  await w.click('.settings-top button[title="Close"]');
  await sendMessage(w, 'connect me to the wiki');
  const cfg = path.join(p.agentDir, 'mcp-config.json');
  for (let i = 0; i < 100 && !fs.existsSync(cfg); i++) await w.waitForTimeout(100);
  const { env } = JSON.parse(fs.readFileSync(cfg, 'utf8')).mcpServers['switchdesk-preview'];
  assert.equal(env.SWITCHDESK_AGENT, 'claude');
  const call = (args) => fetch(env.SWITCHDESK_PREVIEW_URL, { method: 'POST', body: JSON.stringify({ name: 'connect_mcp_server', args }) }).then((r) => r.json());
  assert.match((await call({ name: 'wiki', url: 'https://wiki.example.com/mcp' })).text, /^Connected to wiki\. Its tools: list_tickets\./);
  assert.match((await call({ name: 'wiki' })).text, /wiki was already connected/);
  // A connector `claude mcp list` shows but Claude Code doesn't load: signed in through a terminal.
  const listed = JSON.parse(fs.readFileSync(path.join(p.agentDir, 'mcp.json'), 'utf8'));
  fs.writeFileSync(path.join(p.agentDir, 'mcp.json'), JSON.stringify([...listed, { name: 'claude.ai Notion', url: 'https://mcp.notion.com/mcp', status: 'needs-auth', hidden: true }]));
  assert.match((await call({ name: 'notion' })).text, /^Connected to claude\.ai Notion\./);
  // Not set up at all: claude.ai's connector page opens, the user adds it there, and the chat
  // reloads to get it.
  assert.match((await call({ name: 'Google Sheets' })).text, /^Connected to claude\.ai Google Sheets\. This chat loads its tools when the user sends their next message/);
  assert.ok(env.SWITCHDESK_AGENT && fs.readFileSync(cfg, 'utf8'));
  fs.rmSync(cfg);
  await w.click('.card.plan button:has-text("Build it")');
  await idle(w);
  await w.evaluate(() => send('go'));
  for (let i = 0; i < 100 && !fs.existsSync(cfg); i++) await w.waitForTimeout(100);
  assert.ok(fs.existsSync(cfg), 'the chat restarted to load the new connector');
});

appTest('the other agents connect services through Switchdesk, and get their tools', async ({ app, w, p }) => {
  const { spawn } = require('child_process');
  const fake = spawn(process.execPath, [path.join(__dirname, 'fake-oauth-mcp.js'), '0']);
  const port = await new Promise((r) => fake.stdout.once('data', (d) => r(String(d).trim())));
  try {
    // The "browser" approves the sign-in straight away.
    await app.evaluate(({ shell }) => (shell.openExternal = async (url) => void fetch(url)));
    await chatWith(w, 'cursor');
    await sendMessage(w, 'hello');
    await idle(w);
    const starts = () => agentLog(p).filter((m) => m.agent === 'cursor' && (m.method === 'session/new' || m.method === 'session/load') && m.params.mcpServers.length);
    const spec = starts().pop().params.mcpServers[0];
    const env = Object.fromEntries(spec.env.map((e) => [e.name, e.value]));
    assert.equal(env.SWITCHDESK_AGENT, 'cursor');
    const call = (name, args) => fetch(env.SWITCHDESK_PREVIEW_URL, { method: 'POST', body: JSON.stringify({ name, args, agent: 'cursor' }) }).then((r) => r.json());
    assert.match((await call('connect_mcp_server', { name: 'Google Sheets' })).error, /claude\.ai connector[\s\S]*switch this chat to Claude/);
    assert.match((await call('connect_mcp_server', { name: 'tracker', url: `http://127.0.0.1:${port}/mcp` })).text, /^Connected to tracker\. Its tools: list_tickets\. They load when the user sends their next message/);
    assert.deepEqual((await call('gateway_tools', {})).tools.map((t) => t.name), ['tracker__list_tickets']);
    assert.equal((await call('gateway_call', { tool: 'tracker__list_tickets', arguments: {} })).mcp.content[0].text, 'TICKET-1: Fix the login page');
    // The chat picks the tools up with the next message.
    const before = starts().length;
    await sendMessage(w, 'list my tickets');
    await idle(w);
    assert.equal(starts().length, before + 1, 'the agent restarted on the same conversation');
    // And Settings lists it for the other agents.
    await w.evaluate(() => openSettings('mcp'));
    await w.waitForSelector('.gateway-mcp .rule:has-text("tracker") >> text=Connected');
  } finally {
    fake.kill();
  }
});

appTest('when an agent hits its limit, the chat carries on in another one', async ({ w, p }) => {
  await chatWith(w, 'cursor');
  await sendMessage(w, 'remember the word pineapple');
  await idle(w);
  await w.evaluate(() => appendChat(turnError("You've hit your usage limit. It resets at 3pm.", activeChat())));
  await w.click('.limit-options button:has-text("Copilot")');
  await until(w, () => agentOf(activeChat()) === 'copilot');
  await idle(w);
  const sent = prompts(p, 'copilot').pop();
  assert.match(sent, /pineapple/, 'Copilot gets the conversation so far');
  assert.match(sent, /hit its usage limit/);
});

appTest('with no other agent to move to, a chat that hits its limit carries on when the limit resets', async ({ w, p }) => {
  await chatWith(w, 'cursor');
  await sendMessage(w, 'remember the word mango');
  await idle(w);
  // No other agent is ready, and the limit resets in an hour.
  await w.evaluate(() => (window.agentStatus = async () => ({ installed: false })));
  const at = Math.floor(Date.now() / 1000) + 3600;
  await w.evaluate((at) => appendChat(turnError(limitText(`Usage limit reached|${at}`), activeChat(), `Usage limit reached|${at}`)), at);
  await w.waitForSelector('.reset-wait');
  const when = new Date((at + 120) * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  assert.match(await w.$eval('.reset-wait', (e) => e.innerText), new RegExp(`carries on by itself (\\w+ )?at ${when.replace(/\s/g, '\\s')}, when the limit resets`));
  // The time comes (after the computer slept, say): it carries on by itself.
  await w.evaluate(() => {
    for (const x of resetWaits.values()) x.at = Date.now() - 1;
    checkResetWaits();
  });
  await idle(w);
  assert.match(prompts(p, 'cursor').pop(), /it has reset now/);
  assert.match(await w.$eval('.reset-wait', (e) => e.innerText), /The limit has reset, so it carried on/);
  // Sending something yourself cancels a wait; and it can be switched off.
  await w.evaluate(() => appendChat(turnError('Usage limit reached', activeChat())));
  await w.waitForSelector('.reset-wait:has-text("Cancel")');
  await sendMessage(w, 'never mind');
  await idle(w);
  assert.equal(await w.evaluate(() => resetWaits.size), 0);
  await w.evaluate(async () => (state.settings = await desk.setSettings({ carryOnAtReset: false })));
  await w.evaluate(() => appendChat(turnError('Usage limit reached', activeChat())));
  await w.waitForSelector('.limit-options button:has-text("wait and carry on")');
  assert.equal(await w.evaluate(() => resetWaits.size), 0);
});

test('the mic button starts the computer’s dictation in the chat box', { timeout: 120000 }, async () => {
  const p = profile();
  const log = path.join(p.userData, 'dictate.log');
  const { app, w, errors } = await launch(p, project(), { SWITCHDESK_DICTATE_LOG: log });
  try {
    // Linux has no dictation, so the button is hidden there. Show it to click it.
    await w.evaluate(() => document.querySelector('#mic-btn').classList.remove('hidden'));
    await w.click('#mic-btn');
    await until(w, () => document.activeElement && document.activeElement.id === 'input');
    for (let i = 0; i < 50 && !fs.existsSync(log); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(fs.readFileSync(log, 'utf8'), 'start\n');
    assert.deepEqual(errors, []);
  } finally {
    await app.close().catch(() => {});
  }
});

test('babysitting a pull request: checks, then new review comments, until it is merged', { timeout: 180000 }, async () => {
  const p = profile();
  const dir = project();
  const hub = await fakeGithub(dir);
  hub.passFrom = 1; // the first fix makes the checks pass
  const { app, w, errors } = await launch(p, dir, hub.env);
  const chatText = () => w.evaluate(() => chats.find((c) => c.pr && c.pr.number === 7).el.innerText);
  const step = () => w.evaluate(() => checkWatches());
  try {
    await w.evaluate(async () => (state.settings = await desk.setSettings({ lastAgent: 'cursor' })));
    await w.evaluate(() => desk.github.setToken('test-token').then(() => refreshGithub(true)));
    await w.evaluate(() => openPr(7));
    await w.click('#pr-view button:has-text("Babysit it")');
    // The failing check goes to the agent and its fix is pushed.
    await until(w, () => /Pushed [0-9a-f]{7} to PR #7\. Still babysitting it/.test(chats.find((c) => c.pr && c.pr.number === 7).el.innerText), null, 60000);
    assert.match(prompts(p).pop(), /total\(null\) threw TypeError/);
    assert.doesNotMatch(await chatText(), /new review comments/, "the author's own comment from before isn't counted");
    // Checks pass: it says so and keeps babysitting.
    await step();
    await until(w, () => /Checks pass on PR #7\. Still babysitting/.test(chats.find((c) => c.pr && c.pr.number === 7).el.innerText));
    assert.ok(await w.evaluate(() => chats.find((c) => c.pr && c.pr.number === 7).pr.watch.babysit));
    // A reviewer leaves comments: they go to the agent, the fix is pushed and the comment answered.
    const now = new Date().toISOString();
    hub.comments.push({ id: 990, path: 'cart.js', line: 2, original_line: 2, body: 'Please add a test for this.', user: { login: 'alex' }, created_at: now, diff_hunk: '' });
    hub.talk.push({ id: 77, body: 'Also mention it in the README.', user: { login: 'alex' }, created_at: now });
    await step();
    await until(w, () => (chats.find((c) => c.pr && c.pr.number === 7).el.innerText.match(/Still babysitting it\./g) || []).length >= 2, null, 60000);
    const asked = prompts(p).pop();
    assert.match(asked, /Please add a test for this\./);
    assert.match(asked, /Also mention it in the README\./);
    assert.ok(hub.posted.some((x) => x.key.endsWith('/comments/990/replies') && /^Fixed in [0-9a-f]{7}/.test(x.body.body)));
    // Nothing new: nothing is sent.
    const before = prompts(p).length;
    await step();
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(prompts(p).length, before);
    // Merged: it stops.
    hub.pr.merged_at = new Date().toISOString();
    await step();
    await until(w, () => /PR #7 was merged, so Switchdesk stopped babysitting it/.test(chats.find((c) => c.pr && c.pr.number === 7).el.innerText));
    assert.equal(await w.evaluate(() => chats.find((c) => c.pr && c.pr.number === 7).pr.watch), null);
    assert.deepEqual(errors, []);
  } finally {
    await app.close().catch(() => {});
    hub.close();
  }
});

appTest('Auto picks the agent with the most room, and moves on when one runs out', async ({ w, p }) => {
  await w.evaluate(() => loadAgents());
  await w.click('#agent-btn');
  await w.click('#agent-menu button:has-text("Auto")');
  assert.match(await w.$eval('#agent-btn', (e) => e.textContent), /^Auto · /);
  // Claude is nearly out, Copilot has the most room.
  await w.evaluate(() => {
    for (const a of acct.accounts) acct.usage.set(`claude:${a.id}`, { short: { pct: 95 }, long: { pct: 40 } });
    acct.usage.set('copilot', { short: { pct: 5 } });
  });
  await sendMessage(w, 'remember the word pineapple');
  await until(w, () => agentOf(activeChat()) === 'copilot');
  await idle(w);
  assert.match(prompts(p, 'copilot').pop(), /pineapple/);
  // Copilot runs out mid-task: the chat carries on by itself in the next agent with room.
  await w.evaluate(() => appendChat(turnError("You've hit your usage limit.", activeChat()), activeChat()));
  await until(w, () => agentOf(activeChat()) !== 'copilot' && !activeChat().busy && /carries on in/.test(activeChat().el.innerText), null, 30000);
  const now = await w.evaluate(() => agentOf(activeChat()));
  assert.equal(now, 'cursor');
  assert.match(await w.evaluate(() => activeChat().el.innerText), /Auto: Copilot is out of usage, so this chat carries on in Cursor/);
  const sent = prompts(p, 'cursor').pop();
  assert.match(sent, /pineapple/, 'Cursor gets the conversation so far');
  assert.match(sent, /hit its usage limit/);
  // Picking an agent yourself turns Auto off.
  await w.click('#agent-btn');
  await w.click('#agent-menu button:has-text("Copilot")');
  assert.doesNotMatch(await w.$eval('#agent-btn', (e) => e.textContent), /Auto/);
});

test('your phone signs in with the QR code, answers what an agent waits on, and sends messages', { timeout: 120000 }, async () => {
  const p = profile();
  const dir = project();
  const { app, w, errors } = await launch(p, dir, { SWITCHDESK_PHONE_HOST: '127.0.0.1' });
  try {
    await w.evaluate(() => openSettings('phone'));
    await w.click('.settings-body label:has-text("Let my phone check in") input');
    await w.waitForSelector('.phone-link img', { timeout: 15000 });
    const { urls } = await w.evaluate(() => desk.phone.status());
    const base = new URL(urls[0].url).origin;
    // Without the code, nothing.
    assert.equal((await fetch(base + '/')).status, 403);
    assert.equal((await fetch(base + '/api/state')).status, 403);
    assert.equal((await fetch(base + '/?t=wrong', { redirect: 'manual' })).status, 403);
    // It goes on the home screen with Switchdesk's name and icon.
    const manifest = await (await fetch(base + '/manifest.webmanifest')).json();
    assert.equal(manifest.name, 'Switchdesk');
    assert.equal(manifest.display, 'standalone');
    for (const icon of [...manifest.icons.map((i) => i.src), '/icon-180.png']) assert.equal((await fetch(base + icon)).headers.get('content-type'), 'image/png');
    assert.match(await (await fetch(base + '/')).text(), /apple-touch-icon/);
    // Or type the code Settings shows: a wrong one fails, the right one signs in once.
    await w.waitForSelector('.phone-code', { timeout: 10000 });
    const code = (await w.$eval('.phone-code', (e) => e.textContent)).replace(/\D/g, '');
    const pair = (c) => fetch(base + '/pair', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `code=${c}` });
    assert.match(await (await fetch(base + '/')).text(), /Type the code/);
    assert.equal((await pair(code === '000000' ? '111111' : '000000')).status, 403);
    const typed = await pair(code.slice(0, 3) + '+' + code.slice(3));
    assert.equal(typed.status, 302);
    assert.equal((await fetch(base + '/api/state', { headers: { cookie: typed.headers.get('set-cookie').split(';')[0] } })).status, 200);
    assert.equal((await pair(code)).status, 403, 'a code works once');
    // The QR code's link signs the phone in with a cookie.
    const signIn = await fetch(urls[0].url, { redirect: 'manual' });
    assert.equal(signIn.status, 302);
    const cookie = signIn.headers.get('set-cookie').split(';')[0];
    assert.match(await (await fetch(base + '/', { headers: { cookie } })).text(), /Switchdesk/);
    const get = () => fetch(base + '/api/state', { headers: { cookie } }).then((r) => r.json());
    const post = (path, body, extra = { 'x-switchdesk': '1' }) => fetch(base + path, { method: 'POST', headers: { cookie, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) }).then((r) => r.json());
    await w.click('.settings-top button[title="Close"]');
    // An agent asks to run a command: the phone sees it and allows it.
    await w.evaluate(async () => (state.settings = await desk.setSettings({ permissions: { ask: ['ls'] } })));
    await chatWith(w, 'cursor', 'plan');
    await sendMessage(w, 'plan it');
    await w.waitForSelector('.card.approval:not(.resolved)', { timeout: 30000 });
    const s = await get();
    const chat = s.chats.find((c) => c.waiting);
    assert.ok(chat, 'the chat shows as waiting on you');
    assert.equal(chat.agent, 'Cursor');
    assert.match(chat.asks[0].detail, /ls plans/);
    assert.deepEqual(chat.asks[0].choices.map((c) => c.id), ['allow', 'deny']);
    assert.ok((await post('/api/answer', { chat: chat.id, card: chat.asks[0].id, choice: 'allow' }, {})).error, "another site can't answer for you");
    assert.ok((await post('/api/answer', { chat: chat.id, card: chat.asks[0].id, choice: 'allow' })).ok);
    await w.waitForSelector('.card.approval.resolved:has-text("Allowed from your phone")', { timeout: 10000 });
    await w.waitForSelector('.card.plan', { timeout: 30000 });
    await idle(w);
    await w.evaluate(async () => (state.settings = await desk.setSettings({ permissions: { ask: [] } })));
    // A message from the phone goes to the chat.
    assert.ok((await post('/api/send', { chat: chat.id, text: 'hello from my phone' })).ok);
    await until(w, () => /hello from my phone/.test(activeChat().el.innerText));
    await idle(w);
    assert.match(prompts(p, 'cursor').pop(), /hello from my phone/);
    const after = (await get()).chats.find((c) => c.id === chat.id);
    assert.ok(after.messages.some((m) => m.role === 'user' && /hello from my phone/.test(m.text)));
    // And a new chat can start from the phone.
    const n = await post('/api/new', { text: 'a new one from the bus' });
    assert.ok(n.chat);
    await until(w, () => chats.length === 2 && /a new one from the bus/.test(activeChat().el.innerText));
    // Every window is there, chats or not, and a chat can start in any of them.
    const other = project();
    const [w2] = await Promise.all([app.waitForEvent('window'), w.evaluate((d) => desk.newWindow(d), other)]);
    await w2.waitForFunction(() => typeof chats !== 'undefined' && chats.length && state.folder, null, { timeout: 30000 });
    const spaces = (await get()).workspaces;
    assert.deepEqual(spaces.map((x) => x.name).sort(), [path.basename(dir), path.basename(other)].sort());
    const there = spaces.find((x) => x.name === path.basename(other));
    const started = await post('/api/new', { text: 'over in the other folder', workspace: there.id });
    assert.ok(started.chat.startsWith(there.id + ':'));
    await until(w2, () => /over in the other folder/.test(activeChat().el.innerText));
    assert.ok((await get()).chats.some((c) => c.workspace === there.id && /over in the other folder/.test(c.title)));
    // Turning it off closes the page.
    await w.evaluate(() => desk.phone.set(false));
    await assert.rejects(fetch(base + '/api/state', { headers: { cookie } }));
    assert.deepEqual(errors, []);
  } finally {
    await app.close().catch(() => {});
  }
});

test('opening Switchdesk again opens a window in the one that is running', { timeout: 120000 }, async () => {
  const p = profile();
  const { app, w, errors } = await launch(p, project());
  try {
    const exe = require('electron');
    const root = path.join(__dirname, '..');
    const again = require('child_process').spawn(exe, [root, '--no-sandbox'], { env: { ...process.env, HOME: p.home, SWITCHDESK_USER_DATA: p.userData } });
    const [win, code] = await Promise.all([app.waitForEvent('window', { timeout: 30000 }), new Promise((r) => again.on('exit', r))]);
    assert.equal(code, 0, 'the second copy hands over and closes');
    await win.waitForFunction(() => typeof chats !== 'undefined' && chats.length, null, { timeout: 30000 });
    assert.equal(app.windows().length, 2);
    assert.deepEqual(errors, []);
  } finally {
    await app.close().catch(() => {});
  }
});

test('a chat started with no folder carries on when you open one', { timeout: 120000 }, async () => {
  const p = profile();
  const { app, w, errors } = await launch(p, null);
  try {
    await chatWith(w, 'cursor');
    await sendMessage(w, 'remember the word pineapple');
    await idle(w);
    const dir = project();
    await w.evaluate((f) => desk.openFolder(f).then(setFolder), dir);
    await w.waitForSelector('.tree-row', { timeout: 30000, state: 'attached' });
    assert.equal(await w.evaluate(() => chats.length), 1);
    const text = await w.evaluate(() => activeChat().el.innerText);
    assert.match(text, /remember the word pineapple/, 'the conversation is still there');
    assert.match(text, /Carrying on in /);
    await sendMessage(w, 'what was the word?');
    await idle(w);
    const sent = prompts(p, 'cursor').pop();
    assert.match(sent, /pineapple/, 'the agent gets the conversation so far');
    assert.match(sent, new RegExp(path.basename(dir)));
    assert.deepEqual(errors, []);
  } finally {
    await app.close().catch(() => {});
  }
});

appTest('an always-ask prompt can stop asking about its rule', async ({ w }) => {
  await w.evaluate(async () => (state.settings = await desk.setSettings({ permissions: { skipAll: true, ask: ['ls', 'rm -rf'] } })));
  await chatWith(w, 'cursor', 'plan');
  await sendMessage(w, 'plan it');
  await w.waitForSelector('.card.approval:not(.resolved)', { timeout: 30000 });
  const buttons = await w.$$eval('.card.approval:not(.resolved) button', (b) => b.map((x) => x.textContent));
  assert.deepEqual(buttons, ['Allow', 'Allow, and stop asking about "ls"', 'Deny']);
  await w.click('.card.approval button:has-text("stop asking")');
  await w.waitForSelector('.card.plan', { timeout: 30000 });
  assert.deepEqual(await w.evaluate(() => state.settings.permissions.ask), ['rm -rf']);
  assert.deepEqual(await w.evaluate(() => state.settings.permissions.allow || []), [], 'no allow rules were added');
});

appTest('scrolling up to read stays put while new messages arrive', async ({ w }) => {
  await chatWith(w, 'cursor');
  const host = () => w.evaluate(() => { const el = $('#messages-host'); return { top: el.scrollTop, gap: el.scrollHeight - el.scrollTop - el.clientHeight, jump: !$('#jump-latest').classList.contains('hidden') }; });
  await w.evaluate(() => { for (let i = 0; i < 80; i++) appendChat(h('div', { class: 'notice' }, `line ${i}`)); });
  assert.ok((await host()).gap < 5, 'following along at the end');
  const box = await (await w.$('#messages-host')).boundingBox();
  await w.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await w.mouse.wheel(0, -1500);
  await w.waitForTimeout(300);
  const reading = await host();
  assert.ok(reading.gap > 200, 'scrolled up');
  await w.evaluate(() => appendChat(h('div', { class: 'notice' }, 'something new')));
  const after = await host();
  assert.equal(after.top, reading.top, "a new message doesn't pull you down");
  assert.ok(after.jump, 'a button offers the latest');
  await w.click('#jump-latest');
  assert.ok((await host()).gap < 5);
  // Sending your own message always goes to the end.
  await w.mouse.wheel(0, -1500);
  await w.waitForTimeout(300);
  await sendMessage(w, 'hello');
  await idle(w);
  assert.ok((await host()).gap < 5);
});

appTest("Claude's questions show what each option means, and take several when asked", async ({ w }) => {
  await w.evaluate(() => {
    window.__answer = null;
    questionCard(activeChat(), {
      questions: [
        { header: 'Refund', question: 'How do you want to handle this?', options: [{ label: 'Both (Recommended)', description: 'Pay Jennifer now and rework the payout flow.' }, { label: 'Just pay Jennifer', description: 'Only the A$50 refund.' }] },
        { question: 'Which shops?', multiSelect: true, options: [{ label: 'Comics Lounge' }, { label: 'Kintana' }] },
      ],
    }, (m) => (window.__answer = m));
  });
  const card = await w.$eval('.card.question', (e) => e.innerText);
  assert.match(card, /Pay Jennifer now and rework the payout flow\./, 'the explanation is on the card, not only on hover');
  assert.match(card, /REFUND|Refund/);
  await w.click('.q-option:has-text("Both")');
  await w.click('.q-option:has-text("Comics Lounge")');
  await w.click('.q-option:has-text("Kintana")');
  await w.click('.card.question button:has-text("Answer")');
  const a = await w.evaluate(() => window.__answer);
  assert.match(a, /"How do you want to handle this\?" → Both \(Recommended\)/);
  assert.match(a, /"Which shops\?" → Comics Lounge, Kintana/);
  assert.match(await w.$eval('.card.question .resolution', (e) => e.textContent), /Answered: Both \(Recommended\) · Comics Lounge, Kintana/);
});

appTest("a plan's to-dos tick off one by one as the agent finishes them, not all at once", async ({ w }) => {
  const md = '# Camp\n\nBuild it in stages.\n\n## To-dos\n\n- [ ] Stage 1: placeholder bow with sway\n- [ ] Stage 2: guard with sword and patrol route\n- [ ] Stage 3: sword combat and takedown\n';
  await w.evaluate((md) => {
    window.__doc = openPlanDoc(md, { onBuild() {}, onKeep() {} });
    __doc.resolve('Building', 'building');
    __doc.todos([
      { content: 'Stage 1: placeholder bow with sway', status: 'completed' },
      { content: 'Stage 2: guard with sword and patrol route', status: 'in_progress' },
      { content: 'Write DownwindGuard.h', status: 'completed' }, // a small step doesn't tick a big to-do
    ]);
  }, md);
  const states = () => w.$$eval('#plan-preview .plan-todo', (e) => e.map((x) => x.className.replace('plan-todo ', '')));
  assert.deepEqual(await states(), ['completed', 'in_progress', 'pending']);
  // The turn ends partway: only what's done is ticked, and the bar says how far it got.
  await w.evaluate(() => __doc.resolve('Built. The changes are in the chat.', 'built'));
  assert.deepEqual(await states(), ['completed', 'pending', 'pending']);
  assert.match(await w.$eval('#plan-bar', (e) => e.innerText), /1 of 3 done/);
  // A later turn's list only has the next stage: what was ticked stays ticked.
  await w.evaluate(() => __doc.todos([{ content: 'Stage 2: guard with sword, patrol route', status: 'completed' }]));
  assert.deepEqual(await states(), ['completed', 'completed', 'pending']);
});

appTest('Auto mode is part of Agent now', async ({ w }) => {
  const modes = await w.$$eval('#mode-menu button', (b) => b.map((x) => x.dataset.mode));
  assert.deepEqual(modes, ['ask', 'plan', 'agent', 'debug']);
  await w.evaluate(() => setMode('auto')); // saved from before
  assert.equal(await w.evaluate(() => state.mode), 'agent');
  assert.match(await w.$eval('#mode-btn', (e) => e.textContent), /^Agent/);
});

appTest('the composer menus stay inside a narrow chat panel', async ({ w }) => {
  await w.evaluate(() => document.documentElement.style.setProperty('--chat-w', '330px'));
  const inside = (sel) => w.evaluate((s) => {
    const m = document.querySelector(s).getBoundingClientRect(), c = document.querySelector('#composer').getBoundingClientRect();
    return m.left >= c.left - 1 && m.right <= Math.min(innerWidth, c.right) + 1 ? 'inside' : `${m.left}-${m.right} vs ${c.left}-${c.right}`;
  }, sel);
  await w.click('#mode-btn');
  assert.equal(await inside('#mode-menu'), 'inside');
  await w.click('#mode-btn');
  await w.click('#agent-btn');
  assert.equal(await inside('#agent-menu'), 'inside');
});

test('a long run plans milestones, works through each in a fresh chat, checks it and commits it', { timeout: 150000 }, async () => {
  const p = profile();
  const dir = project();
  const fs = require('fs');
  const { execFileSync } = require('child_process');
  const demo = path.join(p.agentDir, 'demo.json');
  const block = (tag, o) => '```' + tag + '\n' + JSON.stringify(o) + '\n```';
  fs.writeFileSync(
    demo,
    JSON.stringify([
      { match: "You're planning a long run", steps: [{ say: 'Two steps.\n\n' + block('milestones', [{ title: 'Write the notes', what: 'Add notes.md.', done_when: 'notes.md exists', after: [] }, { title: 'Write the todo', what: 'Add todo.md.', done_when: 'todo.md lists two items', after: [1] }]) }] },
      { match: 'Your milestone, 1 of 2', steps: [{ write: { path: 'notes.md', content: '# Notes\n' } }, { say: 'Done.\n\n' + block('milestone', { status: 'done', summary: 'Added notes.md.', questions: [{ question: 'Markdown or text?', assumption: 'Markdown' }], notes: 'Notes live in notes.md.' }) }] },
      { match: 'The milestone: Write the notes', steps: [{ say: block('verdict', { pass: true, problems: [] }) }] },
      { match: 'Your milestone, 2 of 2', steps: [{ write: { path: 'todo.md', content: '- one\n' } }, { say: block('milestone', { status: 'done', summary: 'Added todo.md.' }) }] },
      { match: 'The milestone: Write the todo', steps: [{ say: block('verdict', { pass: false, problems: ['todo.md has one item, not two.'] }) }] },
      { match: 'Fix these', steps: [{ write: { path: 'todo.md', content: '- one\n- two\n' } }, { say: block('milestone', { status: 'done', summary: 'todo.md has two items now.' }) }] },
      { match: 'Check it again', steps: [{ say: block('verdict', { pass: true, problems: [] }) }] },
    ])
  );
  const { app, w, errors } = await launch(p, dir, { FAKE_AGENT_DEMO: demo });
  try {
    await w.click('#btn-long-run');
    await w.fill('.long-run-form textarea', 'Write the notes and the todo list');
    // Cursor does the work and checks it here.
    for (const sel of await w.$$('.long-run-form select')) await sel.selectOption({ label: 'Cursor' });
    await w.click('.long-run-form button:has-text("Plan it")');
    // The plan opens as a document to edit; Build it starts the run.
    await w.waitForSelector('#plan-bar button:has-text("Build it")', { timeout: 30000 });
    assert.match(await w.$eval('#plan-preview', (e) => e.innerText), /Write the notes[\s\S]*Done when: notes.md exists[\s\S]*Write the todo/);
    await w.click('#plan-bar button:has-text("Build it")');
    await w.waitForSelector('.card.long-run.summary', { timeout: 60000 }).catch(async (e) => {
      console.log(JSON.stringify(await w.evaluate(() => ({ runs: state.settings.longRuns, chats: chats.map((c) => [c.title, c.busy, c.longRun, c.el.innerText.slice(-600)]), active: activeChat() && activeChat().title })), null, 1), errors);
      throw e;
    });
    assert.match(await w.$eval('.card.long-run.summary', (e) => e.innerText), /2 of 2 milestones done\. 1 question it answered for itself: worth a look/);
    // Each milestone is its own commit on the run's branch, and your folder is untouched.
    const run = await w.evaluate(() => state.settings.longRuns[0]);
    assert.equal(run.phase, 'done');
    assert.equal(run.milestones[1].rounds, 1);
    const log = execFileSync('git', ['log', '--format=%s', '-3'], { cwd: run.worktree.root, encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(log.slice(0, 2), ['Write the todo', 'Write the notes']);
    assert.equal(fs.readFileSync(path.join(run.worktree.root, 'todo.md'), 'utf8'), '- one\n- two\n');
    assert.equal(fs.existsSync(path.join(dir, 'notes.md')), false);
    // A report with a Windows path in it (not valid JSON as written) still counts.
    const report = await w.evaluate(() => fenced('Done.\n\n```milestone\n{"status": "done", "summary": "Set C:\\Users\\Willi\\Game up"}\n```', 'milestone'));
    assert.equal(report.status, 'done');
    assert.match(report.summary, /Willi/);
    // Nothing a run's agent asks waits for an answer: questions and risky commands get one at once.
    const answers = await w.evaluate((id) => {
      const got = [];
      const chat = { longRun: { run: id, role: 'work', i: 0 } };
      const ask = (req) => longRunApproval(chat, req, () => got.push('allow'), (m) => got.push(m));
      ask({ toolName: 'AskUserQuestion', input: {} });
      ask({ toolName: 'Bash', input: { command: 'git push --force' }, askRule: 'git push --force' });
      ask({ toolName: 'Bash', input: { command: 'npm test' } });
      return got;
    }, run.id);
    assert.match(answers[0], /Nobody is around to answer/);
    assert.match(answers[1], /"git push --force" isn't allowed/);
    assert.equal(answers[2], 'allow');
    // Each milestone's chats closed once it was settled; the run's page shows how it went.
    assert.deepEqual(await w.evaluate(() => chats.filter((c) => c.longRun).map((c) => c.longRun.role)), ['plan']);
    await w.waitForSelector('#run-view:not(.hidden) .run-ms');
    const page = await w.$eval('#run-view', (e) => e.innerText);
    assert.match(page, /Finished: 2 of 2 done/);
    assert.match(page, /Worth a look[\s\S]*Markdown or text\?[\s\S]*It went with: Markdown/);
    assert.match(page, /Write the todo[\s\S]*fixed 1×/);
    assert.match(await w.$eval('#run-view', (e) => e.textContent), /What it did: todo\.md has two items now/);
    assert.equal(await w.$$eval('#run-view .run-progress .seg.done', (s) => s.length), 2);
    // A closed milestone's chat opens again from the page.
    await w.click('#run-view .run-ms:nth-child(2) summary');
    await w.click('#run-view .run-ms:nth-child(2) button:has-text("Open its chat")');
    await w.waitForFunction(() => /Write the todo/.test(activeChat().title));
    assert.deepEqual(errors, []);
  } finally {
    await app.close();
  }
});

test('a long run runs each milestone’s check, waits for you where it needs you, re-plans, and stops at once', { timeout: 150000 }, async () => {
  const p = profile();
  const dir = project();
  const fs = require('fs');
  const demo = path.join(p.agentDir, 'demo.json');
  const block = (tag, o) => '```' + tag + '\n' + JSON.stringify(o) + '\n```';
  const done = (summary) => block('milestone', { status: 'done', summary });
  fs.writeFileSync(
    demo,
    JSON.stringify([
      { match: "You're planning a long run", steps: [{ say: block('milestones', [{ title: 'Write the notes', what: 'Add notes.md.', done_when: 'notes.md exists', check: 'test -f notes.md', after: [] }, { title: 'Try the notes', needs_you: 'Read notes.md and say if it reads well', after: [1] }, { title: 'Write the todo', what: 'Add todo.md.', done_when: 'todo.md exists', after: [] }]) }] },
      // It says it's done without writing the file: Switchdesk's own check catches that.
      { match: 'Your milestone, 1 of 3', steps: [{ say: done('Added notes.md.') }] },
      { match: 'Switchdesk ran `test -f notes.md` and it failed', steps: [{ write: { path: 'notes.md', content: '# Notes\n' } }, { say: done('Really added notes.md.') }] },
      { match: 'The milestone: Write the notes', steps: [{ say: block('verdict', { pass: true, problems: [] }) }] },
      { match: 'Milestone m1, "Write the notes", is done', steps: [{ say: block('replan', { changes: 'Added a readme once you have read the notes.', milestones: [{ id: 'm2', title: 'Try the notes', needs_you: 'Read notes.md and say if it reads well', after: ['m1'] }, { id: 'm3', title: 'Write the todo', what: 'Add todo.md.', done_when: 'todo.md exists', after: [] }, { title: 'Write the readme', what: 'Add README.md.', done_when: 'README.md exists', after: ['m2'] }] }) }] },
      { match: 'Your milestone, 3 of 4', steps: [{ write: { path: 'todo.md', content: '- one\n' } }, { say: done('Added todo.md.') }] },
      { match: 'The milestone: Write the todo', steps: [{ say: block('verdict', { pass: true, problems: [] }) }] },
      { match: 'Your milestone, 4 of 4', steps: [{ say: 'Starting on the readme.' }, { wait: 60000 }, { say: done('Added README.md.') }] },
    ])
  );
  const { app, w, errors } = await launch(p, dir, { FAKE_AGENT_DEMO: demo });
  try {
    await w.click('#btn-long-run');
    await w.fill('.long-run-form textarea', 'Notes, a look from me, then the todo');
    for (const sel of await w.$$('.long-run-form select')) await sel.selectOption({ label: 'Cursor' });
    await w.click('.long-run-form button:has-text("Plan it")');
    await w.waitForSelector('#plan-bar button:has-text("Build it")', { timeout: 30000 });
    assert.match(await w.$eval('#plan-preview', (e) => e.innerText), /Check: test -f notes\.md[\s\S]*Needs you: Read notes\.md[\s\S]*After: 1/);
    await w.click('#plan-bar button:has-text("Build it")');
    // The todo goes ahead while the notes wait for you; then nothing else can go on without you.
    const state = () => w.evaluate(() => state.settings.longRuns[0]);
    await w.waitForFunction(() => (state.settings.longRuns[0] || {}).phase === 'waiting', null, { timeout: 60000 }).catch(async (e) => {
      console.log(JSON.stringify(await state(), null, 1), errors);
      throw e;
    });
    let run = await state();
    assert.deepEqual(run.milestones.map((m) => [m.title, m.status]), [['Write the notes', 'done'], ['Try the notes', 'waiting'], ['Write the todo', 'done'], ['Write the readme', 'pending']]);
    assert.equal(run.milestones[0].rounds, 1);
    assert.equal(run.milestones[0].checkRun.ok, true);
    assert.match(run.changes[0].text, /Added a readme/);
    assert.equal(await w.$$eval('.card.long-run-wait:not(.resolved)', (c) => c.length), 1);
    await w.waitForSelector('#run-view:not(.hidden) .run-yours');
    assert.match(await w.$eval('#run-view', (e) => e.innerText), /Waiting on you: Try the notes[\s\S]*Plan changes \(1\)/);
    await w.fill('#run-view .run-yours textarea', 'Reads well, keep it short');
    await w.click('#run-view .run-yours button:has-text("Done")');
    // What you said reaches the next milestone.
    await w.waitForFunction(() => chats.some((c) => c.longRun && c.longRun.role === 'work' && c.busy && /4\/4/.test(c.title)), null, { timeout: 30000 });
    assert.match(await w.evaluate(() => workerPrompt(runById(state.settings.longRuns[0].id), 3)), /Try the notes \(from the person running this\): Reads well, keep it short/);
    assert.equal(await w.$$eval('.card.long-run-wait:not(.resolved)', (c) => c.length), 0);
    // Stop halts the agent mid-step.
    await w.evaluate(() => (window.confirm = () => true));
    await w.waitForFunction(() => /Starting on the readme/.test(chats.find((c) => /4\/4/.test(c.title)).el.innerText));
    await w.click('#run-view .run-head button:has-text("Stop")');
    await w.waitForFunction(() => state.settings.longRuns[0].phase === 'stopped' && !chats.some((c) => c.longRun && c.busy), null, { timeout: 15000 }).catch(async (e) => {
      console.log(JSON.stringify(await w.evaluate(() => [state.settings.longRuns[0].phase, chats.map((c) => [c.title, c.busy])])));
      console.log(fs.readFileSync(path.join(p.agentDir, 'log.jsonl'), 'utf8').split('\n').filter((l) => /cancel|prompt|"result"/.test(l)).slice(-8).map((l) => l.slice(0, 200)).join('\n'));
      throw e;
    });
    run = await state();
    assert.equal(run.milestones[3].status, 'pending');
    assert.match(run.milestones[3].why, /stopped partway/);
    assert.deepEqual(errors, []);
  } finally {
    await app.close();
  }
});

test('other apps hand work to Switchdesk through its MCP server, and read the result', { timeout: 120000 }, async () => {
  const p = profile();
  const dir = project();
  const other = project();
  const fs = require('fs');
  const { spawn } = require('child_process');
  const demo = path.join(p.agentDir, 'demo.json');
  fs.writeFileSync(demo, JSON.stringify([{ match: 'Add a changelog', steps: [{ write: { path: 'CHANGELOG.md', content: '# Changes\n' } }, { say: 'Added CHANGELOG.md.' }] }]));
  const { app, w, errors } = await launch(p, dir, { FAKE_AGENT_DEMO: demo });
  try {
    // Settings → Other apps adds Switchdesk to Claude Desktop's MCP settings, keeping what's there.
    const cfgFile = path.join(p.home, '.config', 'Claude', 'claude_desktop_config.json');
    fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
    fs.writeFileSync(cfgFile, JSON.stringify({ mcpServers: { other: { command: 'x' } }, theme: 'dark' }));
    await w.evaluate(() => openSettings('apps'));
    await w.click('button:has-text("Add to Claude Desktop")');
    await w.waitForSelector('button:has-text("Added to Claude Desktop")');
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    assert.equal(cfg.theme, 'dark');
    assert.ok(cfg.mcpServers.other);
    const spec = cfg.mcpServers.switchdesk;
    await w.keyboard.press('Escape');
    // Claude Desktop starts it the way the entry says.
    const mcp = spawn(spec.command, spec.args, { env: { ...process.env, ...spec.env } });
    let buf = '';
    const waiting = new Map();
    mcp.stdout.on('data', (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (waiting.has(m.id)) waiting.get(m.id)(m);
      }
    });
    let n = 0;
    const rpc = (method, params) => new Promise((r) => (waiting.set(++n, r), mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n')));
    const tool = async (name, args) => {
      const r = (await rpc('tools/call', { name, arguments: args })).result;
      return { ...JSON.parse(r.isError ? '{}' : r.content[0].text), isError: r.isError, text: r.content[0].text };
    };
    try {
      await rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-ai', version: '1' }, capabilities: {} });
      assert.deepEqual((await rpc('tools/list')).result.tools.map((t) => t.name), ['switchdesk_folders', 'switchdesk_start', 'switchdesk_chats', 'switchdesk_read', 'switchdesk_send', 'switchdesk_stop']);
      assert.deepEqual((await tool('switchdesk_folders', {})).open, [dir]);
      // It hands over a task: a chat starts in the folder, with the agent it asked for.
      const started = await tool('switchdesk_start', { folder: dir, task: 'Add a changelog file', agent: 'cursor' });
      assert.equal(started.agent, 'Cursor');
      const read = await tool('switchdesk_read', { chat: started.chat, wait_seconds: 30 });
      assert.equal(read.working, false);
      assert.match(read.messages.map((m) => m.text).join('\n'), /From Claude Desktop: Add a changelog file[\s\S]*Added CHANGELOG\.md/);
      assert.equal(fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8'), '# Changes\n');
      assert.match(await w.evaluate(() => activeChat().title), /Add a changelog file/);
      assert.equal((await tool('switchdesk_chats', { folder: dir })).chats.length, 1);
      // A folder that isn't open gets a window of its own.
      const there = await tool('switchdesk_start', { folder: other, task: 'Add a changelog here too', agent: 'Cursor', own_copy: true });
      assert.ok(there.chat && there.copy, there.text);
      assert.equal((await tool('switchdesk_read', { chat: there.chat, wait_seconds: 30 })).working, false);
      assert.equal(fs.existsSync(path.join(there.copy, 'CHANGELOG.md')), true);
      assert.equal(fs.existsSync(path.join(other, 'CHANGELOG.md')), false);
      assert.equal(app.windows().length, 2);
      const bad = await tool('switchdesk_start', { folder: path.join(dir, 'nope'), task: 'x' });
      assert.ok(bad.isError);
      assert.match(bad.text, /There's no folder at/);
    } finally {
      mcp.kill();
    }
    assert.deepEqual(errors, []);
  } finally {
    await app.close();
  }
});

test('a chat left alone stops its agent, and the next message picks the conversation up again', { timeout: 90000 }, async () => {
  const p = profile();
  const dir = project();
  const fs = require('fs');
  const runs = () => (fs.existsSync(path.join(p.agentDir, 'claude-runs.jsonl')) ? fs.readFileSync(path.join(p.agentDir, 'claude-runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const { app, w, errors } = await launch(p, dir, { SWITCHDESK_SLEEP_AFTER: '2000' });
  try {
    await w.evaluate(async (bin) => {
      state.settings = await desk.setSettings({ claudePath: bin });
      await agentStatus('claude', true);
      await checkCli();
    }, path.join(__dirname, 'fake-claude', 'claude'));
    await chatWith(w, 'claude', 'ask');
    await sendMessage(w, 'hello there');
    await w.waitForFunction(() => activeChat().busy || activeChat().sessionId);
    await idle(w);
    const first = runs().find((r) => r.pid && !r.args.includes('--version') && r.args.includes('--input-format'));
    assert.ok(first, JSON.stringify(runs()) + (await w.evaluate(() => activeChat().el.innerText)));
    // Left alone, its process ends.
    await w.waitForTimeout(500);
    const deadline = Date.now() + 15000;
    while (!runs().some((r) => r.exit === first.pid) && Date.now() < deadline) await w.waitForTimeout(300);
    assert.ok(runs().some((r) => r.exit === first.pid), 'the idle agent stopped');
    assert.doesNotMatch(await w.evaluate(() => activeChat().el.innerText), /stopped|exited|error/i);
    // The next message starts it again on the same conversation.
    await sendMessage(w, 'and again');
    await idle(w);
    const again = runs().filter((r) => r.pid && r.args.includes('--input-format')).pop();
    assert.notEqual(again.pid, first.pid);
    assert.equal(again.args[again.args.indexOf('--resume') + 1], `fake-claude-${first.pid}`);
    assert.equal(await w.$$eval('.msg-user', (m) => m.length), 2);
    assert.deepEqual(errors, []);
  } finally {
    await app.close();
  }
});

test('the status bar shows the same plan limits in every window', { timeout: 120000 }, async () => {
  const p = profile();
  const { app, w, errors } = await launch(p, project());
  try {
    const key = await w.evaluate(() => usageKey(activeChat()));
    await w.evaluate((k) => (acct.usage.set(k, { short: { pct: 46 }, long: { pct: 59 }, at: Date.now() - 86400e3 }), renderAccountPill()), key);
    const [w2] = await Promise.all([app.waitForEvent('window'), w.evaluate((d) => desk.newWindow(d), project())]);
    await w2.waitForFunction(() => typeof desk !== 'undefined' && typeof acct !== 'undefined', null, { timeout: 30000 });
    // A chat in the other window hears newer limits.
    await w2.evaluate((k) => desk.usage.limits(k, { short: { pct: 97 }, long: { pct: 41 }, at: Date.now() }), key);
    await until(w, () => /5h.*97%.*7d.*41%/s.test($('#status-limit').innerText));
    // A window that has reset since shows as empty again.
    await w.evaluate((k) => (acct.usage.set(k, { short: { pct: 80, resetsAt: Date.now() - 1000 }, long: { pct: 41 }, at: Date.now() }), renderAccountPill()), key);
    assert.match(await w.$eval('#status-limit', (e) => e.innerText), /5h.*0%/s);
    assert.deepEqual(errors, []);
  } finally {
    await app.close().catch(() => {});
  }
});
