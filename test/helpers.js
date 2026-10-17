// Starts Switchdesk under Playwright with a fresh data folder, a throwaway home folder and the fake
// agents on PATH, so the tests don't depend on (or change) anything on the machine.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { _electron } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const FAKES = path.join(__dirname, 'fake-agent');

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `switchdesk-${name}-`));
}

// A data folder, home folder and fake-agent folder shared by one test's launches.
function profile() {
  const base = tempDir('profile');
  const p = { userData: path.join(base, 'data'), home: path.join(base, 'home'), agentDir: path.join(base, 'agent') };
  for (const d of Object.values(p)) fs.mkdirSync(d, { recursive: true });
  return p;
}

// A small git project to work in.
function project({ git = true } = {}) {
  const dir = tempDir('project');
  fs.writeFileSync(path.join(dir, 'cart.js'), 'function total(items) {\n  return items.reduce((sum, i) => sum + i.price, 0);\n}\n\nmodule.exports = { total };\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# Cart\n\nAdds up the price of the items in the cart.\n');
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(dir, 'lib', 'price.js'), "const price = (n) => '£' + n.toFixed(2);\nmodule.exports = { price };\n");
  if (git) {
    const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore', env: gitEnv() });
    g('init', '-q', '-b', 'main');
    g('add', '-A');
    g('commit', '-q', '-m', 'Start');
  }
  return dir;
}

function gitEnv() {
  return { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
}

// The real Claude Code is left off PATH, so the tests behave the same with or without it installed.
async function launch(p, folder, extraEnv = {}) {
  const exe = require('electron'); // the path to Electron's binary
  const app = await _electron.launch({
    executablePath: exe,
    args: [ROOT, '--no-sandbox'],
    cwd: ROOT,
    env: { ...gitEnv(), HOME: p.home, PATH: [FAKES, ...process.env.PATH.split(path.delimiter).filter((d) => !fs.existsSync(path.join(d, 'claude')))].join(path.delimiter), SWITCHDESK_USER_DATA: p.userData, FAKE_AGENT_DIR: p.agentDir, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ...extraEnv },
    timeout: 60000,
  });
  const w = await app.firstWindow();
  const errors = [];
  w.on('pageerror', (e) => e.message !== 'Canceled' && errors.push(process.env.TEST_STACKS ? e.stack : e.message));
  w.on('dialog', (d) => d.accept()); // confirm() boxes get Yes
  await w.waitForFunction(() => window.monaco && typeof state !== 'undefined' && state.settings && typeof setFolder === 'function', null, { timeout: 60000 });
  if (folder) await openFolder(w, folder);
  return { app, w, errors };
}

async function openFolder(w, folder) {
  const now = await w.evaluate(() => state.folder && state.folder.root);
  if (now !== folder) await w.evaluate((f) => desk.openFolder(f).then(setFolder), folder);
  await w.waitForSelector('.tree-row', { timeout: 30000, state: 'attached' });
}

// Answers Allow on every permission card, like a user clicking through.
function autoAllow(w) {
  return w.evaluate(() =>
    setInterval(() => {
      for (const b of document.querySelectorAll('.card.approval:not(.resolved) button')) if (/^Allow$/.test(b.textContent.trim())) b.click();
    }, 200)
  );
}

// What the fake agents were sent, as parsed lines.
function agentLog(p) {
  const f = path.join(p.agentDir, 'log.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

function prompts(p, agent) {
  return agentLog(p)
    .filter((m) => m.method === 'session/prompt' && (!agent || m.agent === agent))
    .map((m) => m.params.prompt.map((x) => x.text || '').join(''));
}

// Starts a new chat on a fake agent in the given mode.
async function chatWith(w, agent, mode = 'agent') {
  await w.evaluate(
    async ([a, m]) => {
      newChat();
      await chooseAgent(a);
      setMode(m);
    },
    [agent, mode]
  );
}

async function sendMessage(w, text) {
  await w.fill('#input', text);
  await w.press('#input', 'Enter');
}

const idle = (w) => w.waitForFunction(() => activeChat() && !activeChat().busy, null, { timeout: 30000 });

// A throwaway SSH server on this machine, for SSH folders: key sign-in only, the fake agents on its
// PATH. Returns the ssh config the app should use (SWITCHDESK_SSH_CONFIG) and the host name in it.
async function sshServer(p) {
  const sshd = ['/usr/sbin/sshd', '/usr/bin/sshd'].find((f) => fs.existsSync(f));
  if (!sshd) return null;
  const dir = tempDir('sshd');
  const keygen = (file) => execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', file], { stdio: 'ignore' });
  keygen(path.join(dir, 'host_key'));
  keygen(path.join(dir, 'client_key'));
  fs.copyFileSync(path.join(dir, 'client_key.pub'), path.join(dir, 'authorized_keys'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const user = os.userInfo().username;
  const remotePath = [FAKES, ...process.env.PATH.split(path.delimiter).filter((d) => process.env.TEST_REMOTE_CLAUDE || !fs.existsSync(path.join(d, 'claude')))].join(':');
  const lines = [`Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${dir}/host_key`, `AuthorizedKeysFile ${dir}/authorized_keys`, 'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'PubkeyAuthentication yes', 'PermitRootLogin yes', 'StrictModes no', 'UsePAM no', `PidFile ${dir}/sshd.pid`, `SetEnv PATH=${remotePath} FAKE_AGENT_DIR=${p.agentDir}`];
  fs.writeFileSync(path.join(dir, 'sshd_config'), lines.join('\n') + '\n');
  const child = require('child_process').spawn(sshd, ['-D', '-e', '-f', path.join(dir, 'sshd_config')], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', (c) => (err += c));
  const config = path.join(dir, 'ssh_config');
  const client = ['Host switchdesk-test', '  HostName 127.0.0.1', `  Port ${port}`, `  User ${user}`, `  IdentityFile ${dir}/client_key`, '  IdentitiesOnly yes', '  StrictHostKeyChecking no', '  UserKnownHostsFile /dev/null', '  LogLevel ERROR'];
  fs.writeFileSync(config, client.join('\n') + '\n');
  for (let i = 0; i < 50; i++) {
    try {
      execFileSync('ssh', ['-F', config, '-o', 'BatchMode=yes', 'switchdesk-test', 'true'], { stdio: 'ignore', timeout: 5000 });
      return { config, host: 'switchdesk-test', stop: () => child.kill() };
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  child.kill();
  throw new Error('The test SSH server did not start: ' + err);
}

// A stand-in for GitHub's API, serving one pull request (#7, from the branch fix-cart, with a
// failing check and a review comment) and one issue (#3), for the folder's origin remote (a bare
// repository on this machine). Everything posted to it is in .posted.
async function fakeGithub(dir) {
  const http = require('http');
  const g = (...a) => execFileSync('git', a, { cwd: dir, env: gitEnv() }).toString().trim();
  const bare = tempDir('origin');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  g('remote', 'add', 'origin', bare);
  g('push', '-q', 'origin', 'main');
  g('checkout', '-q', '-b', 'fix-cart');
  fs.writeFileSync(path.join(dir, 'cart.js'), fs.readFileSync(path.join(dir, 'cart.js'), 'utf8').replace('0)', '0) || 0'));
  g('commit', '-qam', 'Guard the total');
  g('push', '-q', 'origin', 'fix-cart');
  const sha = g('rev-parse', 'HEAD');
  execFileSync('git', ['update-ref', 'refs/pull/7/head', sha], { cwd: bare });
  g('checkout', '-q', 'main');
  const user = { login: 'sam' };
  const pr = { number: 7, title: 'Guard the cart total', body: 'Makes total() safe.', user, draft: false, state: 'open', html_url: 'https://github.com/o/r/pull/7', updated_at: new Date().toISOString(), head: { ref: 'fix-cart', sha, repo: { full_name: 'o/r' } }, base: { ref: 'main', repo: { full_name: 'o/r' } } };
  const issue = { number: 3, title: 'Prices need a currency', body: 'Show prices with £.', user, labels: [{ name: 'bug' }], comments: 0, html_url: 'https://github.com/o/r/issues/3', updated_at: new Date().toISOString() };
  const routes = {
    'GET /user': () => ({ login: 'tester' }),
    'GET /repos/o/r': () => ({ default_branch: 'main' }),
    'GET /repos/o/r/pulls': () => [pr],
    'GET /repos/o/r/pulls/7': () => pr,
    'GET /repos/o/r/pulls/7/files': () => [{ filename: 'cart.js', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1,3 +1,3 @@\n function total(items) {\n-  return items.reduce((sum, i) => sum + i.price, 0);\n+  return items.reduce((sum, i) => sum + i.price, 0) || 0;\n }' }],
    'GET /repos/o/r/pulls/7/comments': () => [{ id: 900, path: 'cart.js', line: 2, original_line: 2, body: 'What about a null cart?', user, created_at: new Date().toISOString(), diff_hunk: '@@ -1,3 +1,3 @@\n+  return items.reduce((sum, i) => sum + i.price, 0) || 0;' }],
    'GET /repos/o/r/pulls/7/reviews': () => [],
    'GET /repos/o/r/issues/7/comments': () => [],
    [`GET /repos/o/r/commits/${sha}/check-runs`]: () => ({ check_runs: [{ id: 55, name: 'test', status: 'completed', conclusion: 'failure', app: { slug: 'github-actions' }, html_url: 'https://github.com/o/r/actions/runs/1', output: { title: '1 test failed', summary: '' } }] }),
    [`GET /repos/o/r/commits/${sha}/status`]: () => ({ statuses: [] }),
    'GET /repos/o/r/actions/jobs/55/logs': () => '2026-10-17T00:00:00.0000000Z Running tests\n2026-10-17T00:00:01.0000000Z ##[error]total(null) threw TypeError\n',
    'GET /repos/o/r/issues': () => [issue, { ...pr, pull_request: {} }],
    'GET /repos/o/r/issues/3': () => issue,
    'GET /repos/o/r/issues/3/comments': () => [],
    'POST /repos/o/r/pulls/7/comments/900/replies': () => ({ id: 901 }),
    'POST /repos/o/r/pulls/7/reviews': () => ({ id: 1 }),
    'POST /repos/o/r/pulls': () => ({ number: 8, html_url: 'https://github.com/o/r/pull/8' }),
  };
  const posted = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const key = `${req.method} ${req.url.split('?')[0]}`;
      const route = routes[key];
      if (req.method === 'POST') posted.push({ key, body: JSON.parse(body || '{}') });
      if (!route) return res.writeHead(404).end(JSON.stringify({ message: `Not Found: ${key}` }));
      const out = route();
      res.writeHead(req.method === 'POST' ? 201 : 200, { 'Content-Type': typeof out === 'string' ? 'text/plain' : 'application/json' });
      res.end(typeof out === 'string' ? out : JSON.stringify(out));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { env: { SWITCHDESK_GITHUB_API: `http://127.0.0.1:${server.address().port}`, SWITCHDESK_GITHUB_REPO: 'o/r' }, posted, bare, sha, close: () => server.close() };
}

module.exports = { fakeGithub, sshServer, launch, profile, project, openFolder, autoAllow, agentLog, prompts, chatWith, sendMessage, idle, tempDir };
