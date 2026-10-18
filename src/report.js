// Help → Report a problem: a new GitHub issue on Switchdesk's repository, filled in with the
// version, the system and which agents are installed. Nothing is sent until you submit it there.
'use strict';

const os = require('os');

const REPO = 'https://github.com/SlaterMarketing/switchdesk';

function osName() {
  const r = os.release();
  if (process.platform === 'win32') return `Windows ${Number(r.split('.')[2]) >= 22000 ? '11' : '10'} (${r})`;
  if (process.platform === 'darwin') return `macOS (Darwin ${r})`;
  return `Linux ${r}`;
}

// Personal paths and anything that looks like a key, out of an error before it goes in an issue.
function scrub(text) {
  const home = os.homedir();
  let s = String(text || '');
  if (home && home.length > 2) s = s.split(home).join('~');
  return s.replace(/\b(sk|lin_api|ghp|gho|github_pat|xox[a-z])[-_][A-Za-z0-9_-]{8,}/g, '[key removed]').slice(0, 3000);
}

// { version, electron, agents: [{ label, installed }], agent?, error? } -> the new issue's URL.
function issueUrl({ version, electron, agents = [], agent, error }) {
  const lines = [
    `- Switchdesk ${version} (Electron ${electron})`,
    `- ${osName()}, ${process.arch}`,
    `- Agents installed: ${agents.filter((a) => a.installed).map((a) => a.label).join(', ') || 'none'}`,
  ];
  if (agent) lines.push(`- Agent in use: ${agent}`);
  const extra = [lines.join('\n'), error ? `What it said:\n\n\`\`\`\n${scrub(error)}\n\`\`\`` : ''].filter(Boolean).join('\n\n');
  const q = new URLSearchParams({ template: 'bug_report.yml', version, extra, labels: 'bug' });
  return `${REPO}/issues/new?${q}`;
}

module.exports = { REPO, issueUrl, scrub, osName };
