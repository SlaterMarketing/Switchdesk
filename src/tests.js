// Running one test (or a file's tests) from the editor: the right command for the project's test
// runner, run in the background so the result can go on the test's line.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const isWin = process.platform === 'win32';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Files on this computer, or (for an SSH folder) on its host, which runs the tests too.
const localIo = {
  P: path,
  win: isWin,
  exists: async (p) => fs.existsSync(p),
  read: async (p) => fs.readFileSync(p, 'utf8'),
  run: (cmd, env, onSpawn) => run(cmd, env, onSpawn),
};

function hostIo(remote) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  return {
    P: path.posix,
    win: false,
    exists: (p) => remote.exec(['test', '-e', p], remote.home).then((r) => r.code === 0, () => false),
    read: async (p) => {
      const r = await remote.call('read', { path: p });
      if (r.content == null) throw new Error('not text');
      return r.content;
    },
    run: async (cmd) => {
      const started = Date.now();
      const r = await remote.exec(['sh', '-lc', [cmd.bin, ...cmd.args].map(q).join(' ') + ' 2>&1'], cmd.cwd, { env: { FORCE_COLOR: '0', NO_COLOR: '1', CI: '1' }, timeout: 10 * 60 * 1000 }).catch((e) => ({ code: -1, stdout: Buffer.from(String(e.message || e)) }));
      return { code: r.code, output: r.stdout.toString('utf8').slice(-200000).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''), ms: Date.now() - started };
    },
  };
}

// The closest package.json at or above the file, up to the folder's root.
async function packageFor(io, abs, root) {
  const P = io.P;
  let dir = P.dirname(abs);
  for (;;) {
    const p = P.join(dir, 'package.json');
    if (await io.exists(p)) {
      try {
        return { dir, pkg: JSON.parse(await io.read(p)) };
      } catch {
        return { dir, pkg: {} };
      }
    }
    if (dir === root || P.dirname(dir) === dir || !dir.startsWith(root)) return null;
    dir = P.dirname(dir);
  }
}

async function localBin(io, dir, name) {
  const P = io.P;
  for (let d = dir; ; d = P.dirname(d)) {
    const p = P.join(d, 'node_modules', '.bin', io.win ? `${name}.cmd` : name);
    if (await io.exists(p)) return p;
    if (P.dirname(d) === d) return null;
  }
}

// { bin, args, cwd, label } for a JavaScript or TypeScript test file. name: the test's name, or
// null for the whole file.
async function jsCommand(io, abs, root, name, findNode) {
  const found = await packageFor(io, abs, root);
  const dir = found ? found.dir : root;
  const deps = found ? { ...(found.pkg.dependencies || {}), ...(found.pkg.devDependencies || {}) } : {};
  const src = await io.read(abs);
  const rel = io.P.relative(dir, abs);
  const pattern = name ? escapeRe(name) : null;
  const npx = async (tool, args) => {
    const bin = await localBin(io, dir, tool);
    return bin ? { bin, args } : { bin: io.win ? 'npx.cmd' : 'npx', args: [tool, ...args] };
  };
  if (deps.vitest || /from ['"]vitest['"]/.test(src)) return { ...(await npx('vitest', ['run', rel, ...(pattern ? ['-t', pattern] : [])])), cwd: dir, runner: 'Vitest' };
  if (deps.jest || deps['ts-jest'] || /@jest\/globals/.test(src)) return { ...(await npx('jest', [rel, ...(pattern ? ['-t', pattern] : [])])), cwd: dir, runner: 'Jest' };
  if (deps.mocha) return { ...(await npx('mocha', [rel, ...(pattern ? ['-g', pattern] : [])])), cwd: dir, runner: 'Mocha' };
  // Node's own test runner (node:test), which also runs plain files that use assert.
  return findNode().then((node) => ({ bin: node || 'node', args: [...(/\.[cm]?tsx?$/.test(abs) ? ['--experimental-strip-types'] : []), '--test', ...(pattern ? [`--test-name-pattern=^${pattern}$|${pattern}`] : []), rel], cwd: dir, runner: 'Node' }));
}

async function pyCommand(io, abs, root, name, cls, python) {
  const rel = io.P.relative(root, abs).split(io.P.sep).join('/');
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

// remote: an SSH folder's connection, to find and run the tests on its host.
async function runTest({ abs, root, name, cls, env, findNode, findPython, onSpawn, remote }) {
  const io = remote ? hostIo(remote) : localIo;
  const py = /\.py$/.test(abs);
  let cmd = py ? await pyCommand(io, abs, root, name, cls, (await findPython(root)) || 'python3') : await jsCommand(io, abs, root, name, findNode);
  let r = await io.run(cmd, env, onSpawn);
  if (py && /No module named pytest/.test(r.output) && cmd.fallback) {
    cmd = cmd.fallback;
    r = await io.run(cmd, env, onSpawn);
  }
  // A name that matched nothing counts as a failure to run, not a pass.
  const none = /no tests? (found|ran|matched)|\b0 tests?\b|Ran 0 tests|No test files found|# tests 0|collected 0 items/i.test(r.output);
  return { ...r, passed: r.code === 0 && !none, none, runner: cmd.runner, command: [io.P.basename(cmd.bin), ...cmd.args].join(' ') };
}

module.exports = { runTest };
