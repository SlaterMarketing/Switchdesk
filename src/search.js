// Project-wide text search (Ctrl+Shift+F). Plain Node, so it works on any machine without ripgrep.

const fs = require('fs/promises');
const path = require('path');

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_MATCHES = 2000;
const MAX_LINE = 300;

const current = new Map(); // group -> id: a newer search from the same window cancels the one running

function buildRegex(query, { regex, caseSensitive, wholeWord }) {
  let src = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (wholeWord) src = `\\b(?:${src})\\b`;
  return new RegExp(src, caseSensitive ? 'g' : 'gi');
}

function matchesInclude(rel, include) {
  if (!include) return true;
  return include
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((pat) => {
      if (pat.startsWith('*.')) return rel.toLowerCase().endsWith(pat.slice(1));
      return rel.toLowerCase().includes(pat.replace(/\*/g, ''));
    });
}

// files: workspace-relative paths (already filtered by .gitignore). root is the folder they're in, or a
// function from a path to its absolute path. Returns [{ rel, matches: [{ line, col, len, text }] }].
async function search(root, files, query, opts = {}) {
  const group = opts.group || '';
  const id = (current.get(group) || 0) + 1;
  current.set(group, id);
  const absOf = typeof root === 'function' ? root : (rel) => path.join(root, rel);
  const io = opts.io || fs; // an SSH folder reads through its connection instead
  if (!query) return { results: [], truncated: false };
  let re;
  try {
    re = buildRegex(query, opts);
  } catch (e) {
    return { error: `Invalid regular expression: ${e.message}` };
  }
  const results = [];
  let count = 0;
  let truncated = false;
  for (let i = 0; i < files.length; i++) {
    if (id !== current.get(group)) return { cancelled: true };
    const rel = files[i];
    if (!matchesInclude(rel, opts.include)) continue;
    let buf;
    try {
      const abs = absOf(rel);
      const st = await io.stat(abs);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      buf = await io.readFile(abs);
    } catch {
      continue;
    }
    if (buf.subarray(0, 8000).includes(0)) continue; // binary
    const lines = buf.toString('utf8').split(/\r?\n/);
    const matches = [];
    for (let n = 0; n < lines.length; n++) {
      const line = lines[n];
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line))) {
        if (m[0].length === 0) {
          re.lastIndex++;
          continue;
        }
        // Trim long lines around the match so the panel stays readable.
        const start = Math.max(0, m.index - 60);
        const text = (start > 0 ? '…' : '') + line.slice(start, start + MAX_LINE);
        matches.push({ line: n + 1, col: m.index + 1, len: m[0].length, text, offset: m.index - start + (start > 0 ? 1 : 0) });
        if (++count >= MAX_MATCHES) break;
      }
      if (count >= MAX_MATCHES) break;
    }
    if (matches.length) results.push({ rel, matches });
    if (count >= MAX_MATCHES) {
      truncated = true;
      break;
    }
    if (i % 200 === 199) await new Promise((r) => setImmediate(r)); // stay responsive on big repos
  }
  return { results, truncated, count };
}

// Replace across files: every match in each listed file except the ones in skip ("rel:line:col").
// With a regular expression, $1 and the rest work as in String.replace. Returns each file's text
// before and after, so the change can be undone.
async function replace(root, rels, query, replacement, opts = {}) {
  const absOf = typeof root === 'function' ? root : (rel) => path.join(root, rel);
  const io = opts.io || fs;
  let re;
  try {
    re = buildRegex(query, opts);
  } catch (e) {
    return { error: `Invalid regular expression: ${e.message}` };
  }
  const skip = new Set(opts.skip || []);
  const files = [];
  for (const rel of rels) {
    const abs = absOf(rel);
    let before;
    try {
      before = await io.readFile(abs, 'utf8');
    } catch {
      continue;
    }
    let count = 0;
    // Line by line, so a skipped match is found by the same line and column the panel showed.
    const parts = before.split(/(\r?\n)/);
    for (let i = 0, line = 1; i < parts.length; i += 2, line++) {
      parts[i] = parts[i].replace(re, (...m) => {
        const offset = m.find((x) => typeof x === 'number'); // after the groups (and before named groups)
        if (typeof offset !== 'number' || m[0].length === 0 || skip.has(`${rel}:${line}:${offset + 1}`)) return m[0];
        count++;
        return opts.regex ? m[0].replace(new RegExp(re.source, re.flags.replace('g', '')), replacement) : replacement;
      });
    }
    if (!count) continue;
    const after = parts.join('');
    await io.writeFile(abs, after, 'utf8');
    files.push({ rel, count, before, after });
  }
  return { files };
}

module.exports = { search, replace, buildRegex };
