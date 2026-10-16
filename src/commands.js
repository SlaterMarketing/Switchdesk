// Custom slash commands kept as Markdown files, so the ones you wrote for one agent work in all of
// them. Claude Code reads its own; for every other agent Switchdesk expands the file into the prompt.
//   .claude/commands/**/*.md  (project and ~/.claude)   .codex/prompts/*.md  (project and ~/.codex)
//   .cursor/commands/*.md      .github/prompts/*.prompt.md
'use strict';

const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const SOURCES = [
  { dir: '.claude/commands', label: 'Claude command', deep: true },
  { dir: '.codex/prompts', label: 'Codex prompt' },
  { dir: '.cursor/commands', label: 'Cursor command' },
  { dir: '.github/prompts', label: 'Copilot prompt', ext: '.prompt.md' },
];

async function walk(dir, deep, prefix = '') {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && deep) out.push(...(await walk(full, deep, prefix + e.name + ':')));
    else if (e.isFile() && e.name.endsWith('.md')) out.push({ full, name: prefix + e.name });
  }
  return out;
}

// "---\ndescription: x\n---\nbody" -> { meta, body }
function parse(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return { meta, body: text.slice(m[0].length) };
}

async function listCommands(folders) {
  const roots = [...(folders || []).map((f) => ({ root: f, scope: 'project' })), { root: os.homedir(), scope: 'user' }];
  const seen = new Map();
  for (const { root, scope } of roots)
    for (const src of SOURCES) {
      for (const f of await walk(path.join(root, src.dir), src.deep)) {
        const ext = src.ext && f.name.endsWith(src.ext) ? src.ext : '.md';
        const name = f.name.slice(0, -ext.length);
        if (!/^[\w:.-]+$/.test(name) || seen.has(name)) continue; // the project's own wins over yours
        let text;
        try {
          text = await fs.readFile(f.full, 'utf8');
        } catch {
          continue;
        }
        const { meta, body } = parse(text);
        const first = body.split('\n').find((l) => l.trim()) || '';
        seen.set(name, {
          name,
          desc: (meta.description || first.replace(/^#+\s*/, '')).slice(0, 90),
          hint: meta['argument-hint'] || '',
          body: body.trim(),
          from: `${src.label}${scope === 'user' ? ' (yours)' : ''}`,
        });
      }
    }
  return [...seen.values()];
}

module.exports = { listCommands, parse };
