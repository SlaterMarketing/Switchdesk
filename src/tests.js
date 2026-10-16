// Running one test (or a file's tests) from the editor: the right command for the project's test
// runner, run in the background so the result can go on the test's line.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const isWin = process.platform === 'win32';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The closest package.json at or above the file, up to the folder's root.
function packageFor(abs, root) {
  let dir = path.dirname(abs);
  for (;;) {
    const p = path.join(dir, 'package.json');
    if (fs.existsSync(p)) {
      try {
        return { dir, pkg: JSON.parse(fs.readFileSync(p, 'utf8')) };
      } catch {
        return { dir, pkg: {} };
      }
    }
    if (dir === root || path.dirname(dir) === dir || !dir.startsWith(root)) return null;
    dir = path.dirname(dir);
  }
}

function localBin(dir, name) {
  for (let d = dir; ; d = path.dirname(d)) {
    const p = path.join(d, 'node_modules', '.bin', isWin ? `${name}.cmd` : name);
    if (fs.existsSync(p)) return p;
    if (path.dirname(d) === d) return null;
  }
}

// { bin, args, cwd, label } for a JavaScript or TypeScript test file. name: the test's name, or
// null for the whole file.
function jsCommand(abs, root, name, findNode) {
  const found = packageFor(abs, root);
  const dir = found ? found.dir : root;
  const deps = found ? { ...(found.pkg.dependencies || {}), ...(found.pkg.devDependencies || {}) } : {};
  const src = fs.readFileSync(abs, 'utf8');
  const rel = path.relative(dir, abs);
  const pattern = name ? escapeRe(name) : null;
  const npx = (tool, args) => {
    const bin = localBin(dir, tool);
    return bin ? { bin, args } : { bin: isWin ? 'npx.cmd' : 'npx', args: [tool, ...args] };
  };
  if (deps.vitest || /from ['"]vitest['"]/.test(src)) return { ...npx('vitest', ['run', rel, ...(pattern ? ['-t', pattern] : [])]), cwd: dir, runner: 'Vitest' };
  if (deps.jest || deps['ts-jest'] || /@jest\/globals/.test(src)) return { ...npx('jest', [rel, ...(pattern ? ['-t', pattern] : [])]), cwd: dir, runner: 'Jest' };
  if (deps.mocha) return { ...npx('mocha', [rel, ...(pattern ? ['-g', pattern] : [])]), cwd: dir, runner: 'Mocha' };
  // Node's own test runner (node:test), which also runs plain files that use assert.
  return findNode().then((node) => ({ bin: node || 'node', args: [...(/\.[cm]?tsx?$/.test(abs) ? ['--experimental-strip-types'] : []), '--test', ...(pattern ? [`--test-name-pattern=^${pattern}$|${pattern}`] : []), rel], cwd: dir, runner: 'Node' }));
}

async function pyCommand(abs, root, name, cls, python) {
  const rel = path.relative(root, abs).split(path.sep).join('/');
  const target = name ? `${rel}::${cls ? `${cls}::` : ''}${name}` : rel;
  return { bin: python, args: ['-m', 'pytest', '-q', target], cwd: root, runner: 'pytest', fallback: { bin: python, args: ['-m', 'unittest', '-v', [rel.replace(/\.py$/, '').replace(/\//g, '.'), cls, name].filter(Boolean).join('.')], cwd: root, runner: 'unittest' } };
}

function run(cmd, env, onSpawn) {
  return new Promise((resolve) => {
    const started = Date.now();
    let out = '';
    const child = spawn(cmd.bin, cmd.args, { cwd: cmd.cwd, env: { ...env, FORCE_COLOR: '0', NO_COLOR: '1', CI: '1' }, shell: isWin && /\.(cmd|bat)$/i.test(cmd.bin), windowsHide: true });
    if (onSpawn) onSpawn(child);
    const add = (c) => (out = (out + c.toString('utf8')).slice(-200000));
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => child.kill(), 10 * 60 * 1000);
    child.on('error', (e) => (clearTimeout(timer), resolve({ code: -1, output: String(e.message || e), ms: Date.now() - started })));
    child.on('close', (code) => (clearTimeout(timer), resolve({ code: code == null ? -1 : code, output: out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''), ms: Date.now() - started })));
  });
}

async function runTest({ abs, root, name, cls, env, findNode, findPython, onSpawn }) {
  const py = /\.py$/.test(abs);
  let cmd = py ? await pyCommand(abs, root, name, cls, await findPython(root)) : await jsCommand(abs, root, name, findNode);
  let r = await run(cmd, env, onSpawn);
  if (py && /No module named pytest/.test(r.output) && cmd.fallback) {
    cmd = cmd.fallback;
    r = await run(cmd, env, onSpawn);
  }
  // A name that matched nothing counts as a failure to run, not a pass.
  const none = /no tests? (found|ran|matched)|\b0 tests?\b|Ran 0 tests|No test files found|# tests 0|collected 0 items/i.test(r.output);
  return { ...r, passed: r.code === 0 && !none, none, runner: cmd.runner, command: [path.basename(cmd.bin), ...cmd.args].join(' ') };
}

module.exports = { runTest };
