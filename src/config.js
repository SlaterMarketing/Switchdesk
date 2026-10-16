// Settings page helpers: CLAUDE.md files, saved permission rules and MCP servers.
// These are Claude Code's own config files, so changes apply in the terminal too. "acct" is the
// account the open folder uses ({ dir, env, main }): each account has its own personal files.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cli = require('./claude-cli');

const mainAcct = () => ({ dir: path.join(os.homedir(), '.claude'), env: {}, main: true });

function memoryFiles(workspace, acct = mainAcct()) {
  const label = acct.main ? 'All projects (~/.claude/CLAUDE.md)' : `All projects, ${acct.name} account`;
  const files = [{ id: 'user', label, path: path.join(acct.dir, 'CLAUDE.md') }];
  if (workspace)
    files.unshift(
      { id: 'agents', label: 'This project, every agent (AGENTS.md)', path: path.join(workspace, 'AGENTS.md') },
      { id: 'project', label: 'This project, Claude only (CLAUDE.md)', path: path.join(workspace, 'CLAUDE.md') }
    );
  return files.map((f) => ({ ...f, content: fs.existsSync(f.path) ? fs.readFileSync(f.path, 'utf8') : '' }));
}

// Claude reads CLAUDE.md, and the other agents AGENTS.md. A line "@AGENTS.md" in CLAUDE.md makes
// Claude read AGENTS.md too (Claude Code's import syntax), so one file holds the rules for all.
const IMPORT_RE = /^@AGENTS\.md\s*$/m;
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');

function rulesShared(workspace) {
  return !!workspace && IMPORT_RE.test(read(path.join(workspace, 'CLAUDE.md')));
}

// Moves CLAUDE.md's rules into AGENTS.md (when AGENTS.md is empty) and points CLAUDE.md at it.
function shareRules(workspace) {
  const claudeMd = path.join(workspace, 'CLAUDE.md');
  const agentsMd = path.join(workspace, 'AGENTS.md');
  const claude = read(claudeMd);
  if (IMPORT_RE.test(claude)) return { moved: false };
  const moved = !read(agentsMd).trim() && !!claude.trim();
  if (moved) {
    fs.writeFileSync(agentsMd, claude, 'utf8');
    fs.writeFileSync(claudeMd, '@AGENTS.md\n', 'utf8');
  } else fs.writeFileSync(claudeMd, '@AGENTS.md\n' + (claude ? '\n' + claude : ''), 'utf8');
  return { moved };
}


function saveMemory(workspace, id, content, acct) {
  const f = memoryFiles(workspace, acct).find((x) => x.id === id);
  if (!f) throw new Error('Unknown file');
  fs.mkdirSync(path.dirname(f.path), { recursive: true });
  fs.writeFileSync(f.path, content, 'utf8');
}

function settingsFiles(workspace, acct = mainAcct()) {
  const files = [{ id: 'user', label: acct.main ? 'All projects' : `All projects, ${acct.name} account`, path: path.join(acct.dir, 'settings.json') }];
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

function permissions(workspace, acct) {
  return settingsFiles(workspace, acct).map((f) => {
    const j = readJson(f.path);
    return { id: f.id, label: f.label, allow: (j.permissions && j.permissions.allow) || [], deny: (j.permissions && j.permissions.deny) || [] };
  });
}

function editRule(workspace, scope, rule, add, acct) {
  const f = settingsFiles(workspace, acct).find((x) => x.id === scope);
  if (!f) throw new Error('Unknown scope');
  const j = readJson(f.path);
  j.permissions = j.permissions || {};
  const allow = new Set(j.permissions.allow || []);
  if (add) allow.add(rule);
  else allow.delete(rule);
  j.permissions.allow = [...allow];
  writeJson(f.path, j);
}

async function runClaude(bin, args, cwd, acct = mainAcct()) {
  const env = await cli.childEnv(acct.env);
  return new Promise((resolve) => {
    execFile(bin, args, { cwd, env, timeout: 60000, windowsHide: true, shell: process.platform === 'win32' && bin.endsWith('.cmd') }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout || '') + String(stderr || '') })
    );
  });
}

async function mcpList(bin, cwd, acct) {
  const r = await runClaude(bin, ['mcp', 'list'], cwd, acct);
  const servers = [];
  for (const line of r.out.split('\n')) {
    const m = /^([\w.@-]+):\s+(.*)$/.exec(line.trim());
    if (m && !/^(Checking|Usage|Error)/.test(m[1])) servers.push({ name: m[1], detail: m[2] });
  }
  return { servers, raw: r.out.trim() };
}

async function mcpRemove(bin, cwd, name, acct) {
  return runClaude(bin, ['mcp', 'remove', name], cwd, acct);
}

async function mcpAdd(bin, cwd, { name, target, transport }, acct) {
  const args = ['mcp', 'add'];
  if (transport && transport !== 'stdio') args.push('--transport', transport);
  args.push(name);
  if (transport && transport !== 'stdio') args.push(target);
  else args.push('--', ...target.split(/\s+/).filter(Boolean));
  return runClaude(bin, args, cwd, acct);
}

module.exports = { rulesShared, shareRules, memoryFiles, saveMemory, permissions, editRule, mcpList, mcpRemove, mcpAdd };
