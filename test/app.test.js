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
    assert.equal(review.commit_id, hub.sha);
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
