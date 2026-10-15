// The coding agents Switchdesk can run. Each is the vendor's own CLI on this computer, signed in
// by the user with that CLI's own login (or, for API-key models, the user's own key passed in
// the environment). Switchdesk never handles subscription logins or tokens.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { safeStorage } = require('electron');
const cli = require('./claude-cli');

const isWin = process.platform === 'win32';
const npmInstall = (pkg) => `npm install -g ${pkg}`;

// kind: how the app talks to it. key: which saved API key it needs, if any.
const AGENTS = {
  claude: { label: 'Claude', vendor: 'Anthropic', kind: 'claude', bins: ['claude'] },
  codex: {
    label: 'Codex',
    vendor: 'OpenAI',
    kind: 'codex',
    bins: ['codex'],
    install: () => npmInstall('@openai/codex'),
    login: ['login'],
    help: 'Signs in with your ChatGPT plan (Plus, Pro, Business) or an OpenAI API key.',
  },
  kimi: {
    label: 'Kimi',
    vendor: 'Moonshot',
    kind: 'acp',
    bins: ['kimi'],
    args: ['acp'],
    install: () => (isWin ? 'irm https://code.kimi.com/kimi-code/install.ps1 | iex' : 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash'),
    login: ['login'],
    help: 'Signs in with your Kimi Code membership.',
  },
  cursor: {
    label: 'Cursor',
    vendor: 'Anysphere',
    kind: 'acp',
    // The CLI is called `agent`, with `cursor-agent` kept as an alias. Look for the specific name
    // first, and only trust a bare `agent` in Cursor's own install folder.
    bins: ['cursor-agent'],
    extraPaths: () => (isWin ? [path.join(os.homedir(), '.local', 'bin', 'agent.exe'), path.join(process.env.LOCALAPPDATA || '', 'cursor-agent', 'agent.cmd'), path.join(process.env.LOCALAPPDATA || '', 'cursor-agent', 'cursor-agent.cmd')] : [path.join(os.homedir(), '.local', 'bin', 'agent')]),
    args: ['acp'],
    authMethod: 'cursor_login',
    statusArgs: ['status'], // checking over ACP could start a browser sign-in, so ask the CLI
    install: () => (isWin ? "irm 'https://cursor.com/install?win32=true' | iex" : 'curl https://cursor.com/install -fsS | bash'),
    login: ['login'],
    help: 'Runs Cursor\'s own command-line agent with your Cursor plan, through the connection Cursor provides for other editors.',
  },
  gemini: {
    label: 'Gemini',
    vendor: 'Google',
    kind: 'acp',
    bins: ['gemini'],
    args: ['--acp'],
    install: () => npmInstall('@google/gemini-cli'),
    key: { name: 'Gemini API key', url: 'https://aistudio.google.com/apikey' },
    env: (k, o) => ({ GEMINI_API_KEY: k, ...(o.model ? { GEMINI_MODEL: o.model } : {}) }),
    help: 'Runs Gemini CLI with your own Gemini API key (pay as you go). Google doesn\'t allow apps like this to use a Google-account sign-in.',
  },
  qwen: {
    label: 'Qwen',
    vendor: 'Alibaba',
    kind: 'acp',
    bins: ['qwen'],
    args: ['--acp', '--auth-type', 'openai'],
    install: () => npmInstall('@qwen-code/qwen-code'),
    key: { name: 'Alibaba Cloud Model Studio API key', url: 'https://modelstudio.console.alibabacloud.com/' },
    defaults: { baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', model: 'qwen3-coder-plus' },
    env: (k, o) => ({ OPENAI_API_KEY: k, OPENAI_BASE_URL: o.baseUrl, OPENAI_MODEL: o.model }),
    help: 'Runs Qwen Code with your own Alibaba Cloud API key.',
  },
  deepseek: {
    label: 'DeepSeek',
    vendor: 'DeepSeek',
    kind: 'acp',
    bins: ['qwen'],
    args: ['--acp', '--auth-type', 'openai'],
    install: () => npmInstall('@qwen-code/qwen-code'),
    key: { name: 'DeepSeek API key', url: 'https://platform.deepseek.com/api_keys' },
    defaults: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    env: (k, o) => ({ OPENAI_API_KEY: k, OPENAI_BASE_URL: o.baseUrl, OPENAI_MODEL: o.model }),
    help: 'Runs DeepSeek models in Qwen Code (open source) with your own DeepSeek API key.',
  },
};

// ---------- finding the CLIs

function candidates(name) {
  const home = os.homedir();
  if (isWin) {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      path.join(home, '.local', 'bin', `${name}.exe`),
      path.join(appData, 'npm', `${name}.cmd`),
      path.join(local, 'Programs', name, `${name}.exe`),
      path.join(home, `.${name}`, 'bin', `${name}.exe`),
      path.join(home, '.kimi-code', 'bin', `${name}.exe`),
    ];
  }
  return [path.join(home, '.local', 'bin', name), path.join(home, '.npm-global', 'bin', name), path.join(home, `.${name}`, 'bin', name), path.join(home, '.kimi-code', 'bin', name), '/opt/homebrew/bin/' + name, '/usr/local/bin/' + name, '/usr/bin/' + name];
}

async function findBin(id, settings) {
  const a = AGENTS[id];
  if (!a) return null;
  if (id === 'claude') return cli.findClaude(settings.claudePath);
  const override = (settings.agentPaths || {})[id];
  if (override && fs.existsSync(override)) return override;
  for (const p of a.extraPaths ? a.extraPaths() : []) if (p && fs.existsSync(p)) return p;
  for (const name of a.bins) {
    for (const p of candidates(name)) if (fs.existsSync(p)) return p;
    const env = await cli.childEnv();
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    for (const dir of (env[pathKey] || '').split(path.delimiter)) {
      for (const n of isWin ? [`${name}.exe`, `${name}.cmd`] : [name]) {
        const p = path.join(dir, n);
        if (dir && fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

// ---------- API keys, kept encrypted with the operating system's keychain

function readKey(settings, id) {
  const saved = (settings.apiKeys || {})[id];
  if (!saved || !saved.key) return '';
  try {
    return saved.enc && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(saved.key, 'base64')) : saved.enc ? '' : saved.key;
  } catch {
    return '';
  }
}

function sealKey(key) {
  if (!key) return null;
  if (safeStorage.isEncryptionAvailable()) return { key: safeStorage.encryptString(key).toString('base64'), enc: true };
  return { key, enc: false };
}

function options(settings, id) {
  const a = AGENTS[id];
  const saved = (settings.apiKeys || {})[id] || {};
  return { ...(a.defaults || {}), ...(saved.baseUrl ? { baseUrl: saved.baseUrl } : {}), ...(saved.model ? { model: saved.model } : {}) };
}

// Environment for one run of an agent. model overrides the saved default where the CLI reads it.
function envFor(settings, id, model) {
  const a = AGENTS[id];
  if (!a || !a.env) return {};
  const o = options(settings, id);
  if (model) o.model = model;
  return a.env(readKey(settings, id), o);
}

function commandLine(bin, args) {
  const q = (s) => (/[\s"']/.test(s) ? (isWin ? `& "${s}"` : `'${s}'`) : s);
  return [q(bin), ...args].join(' ');
}

// `<cli> status`: signed in unless it says otherwise.
function cliStatus(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 20000, windowsHide: true, shell: isWin && /\.(cmd|bat)$/i.test(bin) }, (err, out, errOut) => {
      const text = (String(out || '') + String(errOut || '')).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim();
      const loggedIn = !err && !/not (logged|signed) in|log ?in required|unauthenticated/i.test(text);
      resolve({ loggedIn, detail: text.split('\n').find((l) => /@|logged|signed/i.test(l)) || '' });
    });
  });
}

function version(bin) {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 15000, windowsHide: true, shell: isWin && /\.(cmd|bat)$/i.test(bin) }, (err, out) => resolve(err ? '' : String(out).trim().split('\n')[0]));
  });
}

module.exports = { AGENTS, findBin, readKey, sealKey, options, envFor, commandLine, version, cliStatus };
