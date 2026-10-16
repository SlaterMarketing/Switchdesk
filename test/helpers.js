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

module.exports = { sshServer, launch, profile, project, openFolder, autoAllow, agentLog, prompts, chatWith, sendMessage, idle, tempDir };
