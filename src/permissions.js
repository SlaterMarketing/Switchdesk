// Switchdesk's own permission rules, applied the same way to every agent. Each CLI asks for
// permission in its own way; every request comes through the app, and these rules answer it
// before the user is asked:
//   deny     commands that are always refused (checked first, even when prompts are skipped)
//   skipAll  answer yes to everything else, without asking
//   commands run any command        edits  edit and read files in the open folders
//   web      fetch pages and search   allow  commands (and tools) that are always fine
//   ask      commands that always ask you first, whatever else says yes: prompts skipped, any
//            command allowed, an allow rule, or the agent in Auto mode
'use strict';

// Commands that can't be taken back. renderer/settings.js shows the same list.
const ASK_DEFAULTS = ['rm -rf', 'rm -fr', 'git push --force', 'git push -f', 'git reset --hard', 'git clean -f', 'npm publish', 'terraform apply', 'terraform destroy', 'kubectl delete', 'drop database'];
const DEFAULTS = { skipAll: false, commands: false, edits: false, web: false, allow: [], deny: [], ask: ASK_DEFAULTS };
const SHELL = new Set(['Bash', 'PowerShell', 'Shell', 'BashOutput']);
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);
const WEB = new Set(['WebFetch', 'WebSearch']);
// Tools that are questions for the user, not permissions: always shown.
const ALWAYS_ASK = new Set(['AskUserQuestion', 'ExitPlanMode']);

const policyOf = (settings) => ({ ...DEFAULTS, ...((settings && settings.permissions) || {}) });

// A command line split into the commands it runs, so `ok && rm -rf /` can't ride on `ok`.
function splitCommand(cmd) {
  const parts = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"') cur += cmd[i++] || '';
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    const two = cmd.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      parts.push(cur);
      cur = '';
      i++;
    } else if (c === '&' && (cmd[i - 1] === '>' || cmd[i + 1] === '>')) {
      cur += c; // 2>&1, &>file
    } else if (c === ';' || c === '|' || c === '\n' || c === '&') {
      parts.push(cur);
      cur = '';
    } else if (two === '$(' || c === '`') {
      // A command inside a command: check it on its own too.
      parts.push(cur);
      cur = '';
      if (two === '$(') i++;
    } else cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.replace(/^[\s(]+|[\s)]+$/g, '').replace(/^(sudo|env|time|nohup)\s+/, '')).filter(Boolean);
}

// "npm test" matches "npm test" and "npm test -- --watch"; "git *" or "git" matches any git command;
// "*" anywhere is a wildcard.
function matches(pattern, command) {
  const p = pattern.trim().replace(/\s+\*$/, '');
  if (!p) return false;
  const re = new RegExp('^' + p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '(\\s|$)');
  return re.test(command.trim().replace(/\s+/g, ' '));
}

const commandOf = (input) => String((input && (input.command || input.cmd)) || '').trim();

// Commands that only look at things. In Ask and Plan mode these run without asking, so an agent
// can research the code (Cursor and Copilot ask about every `ls`, `Get-ChildItem` or `git log`).
const LOOKS = [
  'ls', 'dir', 'tree', 'pwd', 'cat', 'head', 'tail', 'wc', 'file', 'stat', 'du', 'which', 'where', 'whoami', 'echo', 'type',
  'grep', 'rg', 'ag', 'find', 'fd', 'sort', 'uniq', 'cut', 'diff', 'jq',
  'git status', 'git log', 'git diff', 'git show', 'git branch', 'git blame', 'git ls-files', 'git rev-parse', 'git remote -v', 'git grep',
  'node --version', 'npm --version', 'npm ls', 'npm view', 'python --version', 'python3 --version',
  'Get-ChildItem', 'gci', 'Get-Content', 'gc', 'Get-Item', 'Get-Location', 'Select-String', 'Select-Object', 'Where-Object', 'ForEach-Object', 'Sort-Object', 'Measure-Object', 'Format-List', 'Format-Table', 'Test-Path', 'Resolve-Path', 'Get-Command', 'Write-Output',
];
// Not when they write somewhere: `> file`, find -delete/-exec, sort -o, git branch -D and so on.
const WRITES = /(^|[^0-9&])>|\s-(delete|exec|execdir|ok|fprint\w*)\b|\bsort\b.*\s-o\b|\bgit branch\b.*\s-(d|D|m|M|c|C)\b|-(Force|Remove)\b|\bOut-File\b|\bSet-Content\b|\bRemove-Item\b/i;
const looksOnly = (part) => !WRITES.test(part) && LOOKS.some((r) => matches(r, part) || matches(r.toLowerCase(), part.toLowerCase()));

// The plan files agents keep while planning (Gemini's plans folder, Cursor's .plan.md).
const isPlanFile = (f) => /[\\/]plans?[\\/][^\\/]+\.md$/i.test(f) || /\.plan\.md$/i.test(f);

// Returns { behavior: 'allow' | 'deny', message?, rule? }, or null to ask the user, or
// { behavior: 'ask', rule } to ask because of an always-ask rule.
// inWorkspace(path) says whether a file is in the window's open folders. autoApprove: the agent is
// in Auto mode but asks Switchdesk anyway (because of the always-ask rules), so everything else is yes.
// Ask and Plan mode follow the same rules, except that file edits always ask (agents are meant to
// only look while planning), and read-only commands never do.
function decide(settings, { toolName, input }, { mode, inWorkspace, autoApprove }) {
  if (ALWAYS_ASK.has(toolName)) return null;
  // Switchdesk's own Preview tools only look at and click around the page in the Preview.
  if (/switchdesk[-_]preview|^preview_(open|screenshot|page|click|type|console|eval)$/.test(toolName || '')) return { behavior: 'allow' };
  const pol = policyOf(settings);
  const looking = mode === 'ask' || mode === 'plan';
  if (SHELL.has(toolName)) {
    const cmd = commandOf(input);
    const parts = splitCommand(cmd);
    for (const part of parts) {
      const rule = pol.deny.find((r) => matches(r, part));
      if (rule) return { behavior: 'deny', rule, message: `Blocked by the user's Switchdesk permission rules ("${rule}"). Don't run this command or work around the block; if it's needed, explain why and ask the user to run it.` };
    }
    for (const part of parts) {
      const rule = (pol.ask || []).find((r) => matches(r, part) || matches(r.toLowerCase(), part.toLowerCase()));
      if (rule) return { behavior: 'ask', rule };
    }
    if (pol.skipAll || pol.commands || autoApprove) return { behavior: 'allow' };
    if (parts.length && parts.every((part) => pol.allow.some((r) => matches(r, part)) || (looking && looksOnly(part)))) return { behavior: 'allow', rule: 'allow-list' };
    return null;
  }
  if (pol.deny.some((r) => r.trim() === `tool:${toolName}`)) return { behavior: 'deny', message: `The user's Switchdesk permission rules block the ${toolName} tool.` };
  const files = String((input && (input.file_path || input.notebook_path || input.path)) || '')
    .split(', ')
    .filter(Boolean);
  if (EDITS.has(toolName) && looking) return mode === 'plan' && files.length && files.every(isPlanFile) ? { behavior: 'allow' } : null;
  if (pol.skipAll || autoApprove) return { behavior: 'allow' };
  if (looking && READS.has(toolName)) return { behavior: 'allow' };
  if (EDITS.has(toolName) || READS.has(toolName)) {
    if (pol.edits && (!files.length ? READS.has(toolName) : files.every((f) => inWorkspace(f)))) return { behavior: 'allow' };
    return null;
  }
  if (WEB.has(toolName)) return pol.web ? { behavior: 'allow' } : null;
  if (pol.allow.some((r) => r.trim() === `tool:${toolName}`)) return { behavior: 'allow' };
  return null;
}

// The always-ask rules as Claude Code permission rules, so Claude asks for them in its own Auto
// mode too ("git push --force" -> "Bash(git push --force:*)").
const claudeAskRules = (settings) =>
  (policyOf(settings).ask || [])
    .map((r) => r.trim().replace(/\s*\*$/, ''))
    .filter((r) => r && !r.includes('*') && !/[()]/.test(r))
    .map((r) => `Bash(${r}:*)`);

module.exports = { SHELL_TOOLS: SHELL, DEFAULTS, ASK_DEFAULTS, policyOf, decide, splitCommand, matches, looksOnly, claudeAskRules };
