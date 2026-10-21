'use strict';
// The always-ask rules, straight against src/permissions.js.
const test = require('node:test');
const assert = require('node:assert');
const permissions = require('../src/permissions');

const bash = (command) => ({ toolName: 'Bash', input: { command } });
const opts = { mode: 'agent', inWorkspace: () => true };

test('always-ask rules ask first, whatever else says yes', () => {
  const skip = { permissions: { skipAll: true } };
  assert.deepStrictEqual(permissions.decide(skip, bash('ls && git push --force origin main'), opts), { behavior: 'ask', rule: 'git push --force' });
  assert.deepStrictEqual(permissions.decide(skip, bash('ls'), opts), { behavior: 'allow' });
  assert.strictEqual(permissions.decide({ permissions: { commands: true } }, bash('DROP DATABASE prod'), opts).behavior, 'ask');
  // Auto mode for an agent that asks anyway: everything else is yes, the rules still ask.
  assert.deepStrictEqual(permissions.decide({}, bash('npm test'), { ...opts, autoApprove: true }), { behavior: 'allow' });
  assert.strictEqual(permissions.decide({}, bash('rm -rf build'), { ...opts, autoApprove: true }).behavior, 'ask');
  // Blocked still beats ask, and an emptied list asks for nothing.
  assert.strictEqual(permissions.decide({ permissions: { deny: ['rm -rf'] } }, bash('rm -rf /'), opts).behavior, 'deny');
  assert.deepStrictEqual(permissions.decide({ permissions: { skipAll: true, ask: [] } }, bash('rm -rf build'), opts), { behavior: 'allow' });
  assert.ok(permissions.claudeAskRules({}).includes('Bash(git push --force:*)'));
  assert.deepStrictEqual(permissions.claudeAskRules({ permissions: { ask: ['./deploy.sh *', 'a*b'] } }), ['Bash(./deploy.sh:*)']);
});

test('here-documents are text, not commands, and Always allow never allows rm', () => {
  const cmd = `cd app && npx tsx x.ts 2>&1 | grep -E "^(a|b)|Error" ; rm -rf tmp; cat > ./v.mts <<'EOF'\nimport "dotenv/config";\nconst p = 1;\nconsole.log("a:", p);\nEOF\nnpx tsx ./v.mts | tail -4; rm -f ./v.mts`;
  assert.deepStrictEqual(permissions.splitCommand(cmd), ['cd app', 'npx tsx x.ts 2>&1', 'grep -E "^(a|b)|Error"', 'rm -rf tmp', 'cat > ./v.mts', 'npx tsx ./v.mts', 'tail -4', 'rm -f ./v.mts']);
  assert.deepStrictEqual(permissions.allowRulesFor(cmd), ['cd app', 'npx tsx', 'grep', 'cat', 'tail']);
  // A here-document a shell runs is still checked, command by command.
  assert.deepStrictEqual(permissions.splitCommand('bash <<EOF\nrm -rf /\nEOF\necho hi'), ['bash', 'rm -rf /', 'echo hi']);
  assert.strictEqual(permissions.decide({ permissions: { skipAll: true } }, bash('bash <<EOF\nrm -rf /\nEOF'), opts).behavior, 'ask');
  // Old junk rules are cleaned up; real ones stay.
  for (const r of ['applied)"', 'import', 'const p', 'console.log("x', 'EOF', 'rm', '^export async', 'function', 'off-schedule:']) assert.ok(permissions.junkRule(r), r);
  for (const r of ['npx tsx', 'git status', 'grep', 'npm test *']) assert.ok(!permissions.junkRule(r), r);
});

test('skipping prompts can skip the always-ask rules too, when you say so', () => {
  assert.strictEqual(permissions.decide({ permissions: { skipAll: true } }, bash('rm -rf build'), opts).behavior, 'ask');
  assert.strictEqual(permissions.decide({ permissions: { skipAll: true, skipAsk: true } }, bash('rm -rf build'), opts).behavior, 'allow');
  assert.strictEqual(permissions.decide({ permissions: { skipAll: true, skipAsk: true, deny: ['rm -rf /'] } }, bash('rm -rf /'), opts).behavior, 'deny');
  assert.strictEqual(permissions.decide({ permissions: { skipAsk: true } }, bash('rm -rf build'), opts).behavior, 'ask', 'only with prompts skipped');
});
