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
