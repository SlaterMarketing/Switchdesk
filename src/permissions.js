// Switchdesk's own permission rules, applied the same way to every agent. Each CLI asks for
// permission in its own way; every request comes through the app, and these rules answer it
// before the user is asked:
//   deny     commands that are always refused (checked first, even when prompts are skipped)
//   skipAll  answer yes to everything else, without asking
//   commands run any command        edits  edit and read files in the open folders
//   web      fetch pages and search   allow  commands (and tools) that are always fine
'use strict';

const DEFAULTS = { skipAll: false, commands: false, edits: false, web: false, allow: [], deny: [] };
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

// Returns { behavior: 'allow' | 'deny', message?, rule? }, or null to ask the user.
// inWorkspace(path) says whether a file is in the window's open folders.
function decide(settings, { toolName, input }, { mode, inWorkspace }) {
  if (ALWAYS_ASK.has(toolName) || mode === 'ask' || mode === 'plan') return null;
  const pol = policyOf(settings);
  if (SHELL.has(toolName)) {
    const cmd = commandOf(input);
    const parts = splitCommand(cmd);
    for (const part of parts) {
      const rule = pol.deny.find((r) => matches(r, part));
      if (rule) return { behavior: 'deny', rule, message: `Blocked by the user's Switchdesk permission rules ("${rule}"). Don't run this command or work around the block; if it's needed, explain why and ask the user to run it.` };
    }
    if (pol.skipAll || pol.commands) return { behavior: 'allow' };
    if (parts.length && parts.every((part) => pol.allow.some((r) => matches(r, part)))) return { behavior: 'allow', rule: 'allow-list' };
    return null;
  }
  if (pol.deny.some((r) => r.trim() === `tool:${toolName}`)) return { behavior: 'deny', message: `The user's Switchdesk permission rules block the ${toolName} tool.` };
  if (pol.skipAll) return { behavior: 'allow' };
  if (EDITS.has(toolName) || READS.has(toolName)) {
    const files = String((input && (input.file_path || input.notebook_path || input.path)) || '')
      .split(', ')
      .filter(Boolean);
    if (pol.edits && (!files.length ? READS.has(toolName) : files.every((f) => inWorkspace(f)))) return { behavior: 'allow' };
    return null;
  }
  if (WEB.has(toolName)) return pol.web ? { behavior: 'allow' } : null;
  if (pol.allow.some((r) => r.trim() === `tool:${toolName}`)) return { behavior: 'allow' };
  return null;
}

module.exports = { SHELL_TOOLS: SHELL, DEFAULTS, policyOf, decide, splitCommand, matches };
