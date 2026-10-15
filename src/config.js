// Settings page helpers: CLAUDE.md files, saved permission rules and MCP servers.
// These are Claude Code's own config files, so changes apply in the terminal too.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cli = require('./claude-cli');

const userDir = () => path.join(os.homedir(), '.claude');

function memoryFiles(workspace) {
  const files = [{ id: 'user', label: 'All projects (~/.claude/CLAUDE.md)', path: path.join(userDir(), 'CLAUDE.md') }];
  if (workspace) files.unshift({ id: 'project', label: 'This project (CLAUDE.md)', path: path.join(workspace, 'CLAUDE.md') });
  return files.map((f) => ({ ...f, content: fs.existsSync(f.path) ? fs.readFileSync(f.path, 'utf8') : '' }));
}

function saveMemory(workspace, id, content) {
  const f = memoryFiles(workspace).find((x) => x.id === id);
  if (!f) throw new Error('Unknown file');
  fs.mkdirSync(path.dirname(f.path), { recursive: true });
  fs.writeFileSync(f.path, content, 'utf8');
}

function settingsFiles(workspace) {
  const files = [{ id: 'user', label: 'All projects', path: path.join(userDir(), 'settings.json') }];
  if (workspace) files.unshift({ id: 'local', label: 'This project (just you)', path: path.join(workspace, '.claude', 'settings.local.json') });
  return files;
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function permissions(workspace) {
  return settingsFiles(workspace).map((f) => {
    const j = readJson(f.path);
    return { id: f.id, label: f.label, allow: (j.permissions && j.permissions.allow) || [], deny: (j.permissions && j.permissions.deny) || [] };
  });
}

function editRule(workspace, scope, rule, add) {
  const f = settingsFiles(workspace).find((x) => x.id === scope);
  if (!f) throw new Error('Unknown scope');
  const j = readJson(f.path);
  j.permissions = j.permissions || {};
  const allow = new Set(j.permissions.allow || []);
  if (add) allow.add(rule);
  else allow.delete(rule);
  j.permissions.allow = [...allow];
  writeJson(f.path, j);
}

async function runClaude(bin, args, cwd) {
  const env = await cli.childEnv();
  return new Promise((resolve) => {
    execFile(bin, args, { cwd, env, timeout: 60000, windowsHide: true, shell: process.platform === 'win32' && bin.endsWith('.cmd') }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout || '') + String(stderr || '') })
    );
  });
}

async function mcpList(bin, cwd) {
  const r = await runClaude(bin, ['mcp', 'list'], cwd);
  const servers = [];
  for (const line of r.out.split('\n')) {
    const m = /^([\w.@-]+):\s+(.*)$/.exec(line.trim());
    if (m && !/^(Checking|Usage|Error)/.test(m[1])) servers.push({ name: m[1], detail: m[2] });
  }
  return { servers, raw: r.out.trim() };
}

async function mcpRemove(bin, cwd, name) {
  return runClaude(bin, ['mcp', 'remove', name], cwd);
}

async function mcpAdd(bin, cwd, { name, target, transport }) {
  const args = ['mcp', 'add'];
  if (transport && transport !== 'stdio') args.push('--transport', transport);
  args.push(name);
  if (transport && transport !== 'stdio') args.push(target);
  else args.push('--', ...target.split(/\s+/).filter(Boolean));
  return runClaude(bin, args, cwd);
}

module.exports = { memoryFiles, saveMemory, permissions, editRule, mcpList, mcpRemove, mcpAdd };
