// End-to-end tests: the real app, driven through its window, with fake agents standing in for
// Cursor and Copilot. Run with `npm test` (on Linux, under xvfb-run).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { launch, profile, project, autoAllow, prompts, chatWith, sendMessage, idle, sshServer, agentLog } = require('./helpers');

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
  await w.keyboard.type('print(x + 1)');
  await w.keyboard.press('Shift+Enter');
  await until(w, () => /43/.test(document.querySelectorAll('#nb-view .nb-outputs')[4]?.innerText || ''), null, 30000).catch(async () => {
    throw new Error('outputs: ' + (await w.$$eval('#nb-view .nb-outputs', (e) => e.map((x) => x.innerText).join(' | '))));
  });
});

test('an SSH folder: files, search, git, the terminal and an agent all on the host', { timeout: 180000 }, async (t) => {
  const p = profile();
  const server = await sshServer(p);
  if (!server) return t.skip('no sshd on this machine');
  const dir = project();
  const { app, w, errors } = await launch(p, null, { SWITCHDESK_SSH_CONFIG: server.config });
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
    // What only works locally says so instead of touching a local folder.
    const copy = await w.evaluate(() => desk.worktree.create('x').then(() => 'made', (e) => e.message));
    assert.match(copy, /isn't available in SSH folders/);
    assert.deepEqual(errors, []);
  } finally {
    await app.close().catch(() => {});
    server.stop();
  }
});
