'use strict';
// Help → Report a problem: the issue it opens is filled in, without keys or your home folder.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const report = require('../src/report');

test('a problem report fills in the issue, without keys or personal paths', () => {
  const url = new URL(report.issueUrl({ version: '1.2.3', electron: '40.0.0', agents: [{ label: 'Claude Code', installed: true }, { label: 'Codex', installed: false }], agent: 'Codex', error: `Failed in ${path.join(os.homedir(), 'secret-project')} with sk-ant-abcdefghijklmnop` }));
  assert.equal(url.origin + url.pathname, 'https://github.com/SlaterMarketing/switchdesk/issues/new');
  assert.equal(url.searchParams.get('template'), 'bug_report.yml');
  assert.equal(url.searchParams.get('version'), '1.2.3');
  const extra = url.searchParams.get('extra');
  assert.match(extra, /Switchdesk 1\.2\.3 \(Electron 40\.0\.0\)/);
  assert.match(extra, /Agents installed: Claude Code\n/);
  assert.match(extra, /Agent in use: Codex/);
  assert.match(extra, /Failed in ~.secret-project with \[key removed\]/);
  assert.ok(!extra.includes(os.homedir()));
});
