// GitHub: the open folder's pull requests and issues, for the PR tab and "start from an issue".
// Signs in with the GitHub CLI's own sign-in (`gh auth login`) when it's there, or a token pasted in
// the Git panel, stored encrypted. Talks to GitHub's REST API directly.
'use strict';

const { safeStorage } = require('electron');
const { execFile } = require('child_process');
const agents = require('./agents');
const cli = require('./claude-cli');
const { git } = require('./snapshots');

const API = (process.env.SWITCHDESK_GITHUB_API || 'https://api.github.com').replace(/\/$/, '');
let cliCache = { at: 0, token: null };

// "git@github.com:owner/name.git" or "https://github.com/owner/name" -> { owner, name }
function parseRepo(url) {
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(String(url || '').trim());
  return m ? { owner: m[1], name: m[2] } : null;
}

async function repoOf(cwd) {
  if (process.env.SWITCHDESK_GITHUB_REPO) {
    const [owner, name] = process.env.SWITCHDESK_GITHUB_REPO.split('/'); // the app's tests
    return { owner, name };
  }
  try {
    return parseRepo(await git(cwd, ['remote', 'get-url', 'origin']));
  } catch {
    return null;
  }
}

// The GitHub CLI's token, if you've signed in with it.
async function cliToken() {
  if (Date.now() - cliCache.at < 5 * 60e3) return cliCache.token;
  const bin = await agents.findCommand(['gh']);
  let token = null;
  if (bin) {
    const env = await cli.childEnv();
    token = await new Promise((resolve) => execFile(bin, ['auth', 'token', '--hostname', 'github.com'], { env, timeout: 10000, windowsHide: true }, (err, out) => resolve(err ? null : String(out).trim() || null)));
  }
  cliCache = { at: Date.now(), token };
  return token;
}

function savedToken(settings) {
  const g = settings.github || {};
  if (!g.token) return null;
  try {
    return g.enc ? (safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(g.token, 'base64')) : null) : g.token;
  } catch {
    return null;
  }
}

async function auth(settings) {
  const saved = savedToken(settings);
  if (saved) return { token: saved, via: 'token' };
  const t = await cliToken();
  return t ? { token: t, via: 'gh' } : { token: null, via: null };
}

function sealToken(token) {
  if (safeStorage.isEncryptionAvailable()) return { token: safeStorage.encryptString(token).toString('base64'), enc: true };
  return { token, enc: false };
}

async function request(settings, method, path, body, { accept, text } = {}) {
  const { token } = await auth(settings);
  if (!token) throw new Error('Connect GitHub first: sign in with the GitHub CLI (`gh auth login`), or connect with a token from the Git panel.');
  const r = await fetch(path.startsWith('http') ? path : API + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: accept || 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Switchdesk', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    let msg = '';
    try {
      const j = await r.json();
      msg = [j.message, ...(j.errors || []).map((e) => e.message || e.code || '')].filter(Boolean).join(': ');
    } catch {
      /* not JSON */
    }
    if (r.status === 401) msg = "GitHub didn't accept the sign-in. Sign in again (`gh auth login`) or connect again from the Git panel.";
    else if (r.status === 404) msg = `GitHub couldn't find that, or your sign-in can't see it${msg ? ` (${msg})` : ''}.`;
    throw Object.assign(new Error(msg || `GitHub said ${r.status}.`), { status: r.status });
  }
  if (text) return r.text();
  return r.status === 204 ? null : r.json();
}

const repoPath = (repo) => `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
const who = (u) => (u && u.login) || 'someone';

// "passing", "failing", "running" or "none", from check runs and commit statuses.
function checksState(runs, statuses) {
  const all = [...runs.map((r) => (r.status !== 'completed' ? 'running' : /^(success|neutral|skipped)$/.test(r.conclusion) ? 'ok' : 'fail')), ...statuses.map((s) => (s.state === 'pending' ? 'running' : s.state === 'success' ? 'ok' : 'fail'))];
  if (!all.length) return 'none';
  if (all.includes('fail')) return 'failing';
  if (all.includes('running')) return 'running';
  return 'passing';
}

async function checks(settings, repo, sha) {
  const [runs, status] = await Promise.all([
    request(settings, 'GET', `${repoPath(repo)}/commits/${sha}/check-runs?per_page=100`).catch(() => ({ check_runs: [] })),
    request(settings, 'GET', `${repoPath(repo)}/commits/${sha}/status`).catch(() => ({ statuses: [] })),
  ]);
  const list = [
    ...(runs.check_runs || []).map((r) => ({
      kind: 'run',
      id: r.id,
      name: r.name,
      state: r.status !== 'completed' ? 'running' : /^(success|neutral|skipped)$/.test(r.conclusion) ? 'passing' : 'failing',
      conclusion: r.conclusion,
      url: r.html_url || r.details_url,
      app: r.app && r.app.slug,
      title: r.output && r.output.title,
      summary: r.output && r.output.summary,
    })),
    ...(status.statuses || []).map((s) => ({ kind: 'status', id: s.id, name: s.context, state: s.state === 'pending' ? 'running' : s.state === 'success' ? 'passing' : 'failing', url: s.target_url, summary: s.description })),
  ];
  return { list, state: checksState(runs.check_runs || [], status.statuses || []) };
}

async function status(settings, cwd) {
  const repo = await repoOf(cwd);
  const { token, via } = await auth(settings);
  let login = null;
  let error = null;
  if (token)
    try {
      login = (await request(settings, 'GET', '/user')).login;
    } catch (e) {
      error = e.message;
    }
  return { repo, signedIn: !!login, via, login, error };
}

async function listPrs(settings, repo) {
  const prs = await request(settings, 'GET', `${repoPath(repo)}/pulls?state=open&sort=updated&direction=desc&per_page=30`);
  const states = await Promise.all(prs.map((p, i) => (i < 15 ? checks(settings, repo, p.head.sha).then((c) => c.state, () => 'none') : 'none')));
  return prs.map((p, i) => ({ number: p.number, title: p.title, author: who(p.user), draft: !!p.draft, head: p.head.ref, base: p.base.ref, updatedAt: p.updated_at, url: p.html_url, checks: states[i] }));
}

async function getPr(settings, repo, n) {
  const base = `${repoPath(repo)}/pulls/${n}`;
  const p = await request(settings, 'GET', base);
  const [files, comments, talk, reviews, ch] = await Promise.all([
    request(settings, 'GET', `${base}/files?per_page=100`),
    request(settings, 'GET', `${base}/comments?per_page=100`),
    request(settings, 'GET', `${repoPath(repo)}/issues/${n}/comments?per_page=100`),
    request(settings, 'GET', `${base}/reviews?per_page=100`),
    checks(settings, repo, p.head.sha),
  ]);
  return {
    number: p.number,
    title: p.title,
    body: p.body || '',
    author: who(p.user),
    draft: !!p.draft,
    state: p.merged_at ? 'merged' : p.state,
    url: p.html_url,
    head: p.head.ref,
    headSha: p.head.sha,
    // A pull request from a fork can only be pushed to there, if at all.
    sameRepo: !!(p.head.repo && p.base.repo && p.head.repo.full_name === p.base.repo.full_name),
    base: p.base.ref,
    files: files.map((f) => ({ path: f.filename, from: f.previous_filename, status: f.status, add: f.additions, del: f.deletions, patch: f.patch || '' })),
    // Review comments, grouped into threads by the comment they reply to.
    threads: threadsOf(comments),
    talk: [
      ...talk.map((c) => ({ id: c.id, author: who(c.user), body: c.body || '', at: c.created_at })),
      ...reviews.filter((r) => (r.body || '').trim() || r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED').map((r) => ({ id: r.id, author: who(r.user), body: r.body || '', at: r.submitted_at, review: r.state })),
    ].sort((a, b) => String(a.at).localeCompare(String(b.at))),
    checks: ch.list,
    checksState: ch.state,
  };
}

function threadsOf(comments) {
  const byId = new Map();
  const threads = [];
  for (const c of comments.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))) {
    const item = { id: c.id, author: who(c.user), body: c.body || '', at: c.created_at };
    const parent = c.in_reply_to_id && byId.get(c.in_reply_to_id);
    if (parent) {
      parent.replies.push(item);
      byId.set(c.id, parent);
    } else {
      const t = { id: c.id, path: c.path, line: c.line || c.original_line || null, outdated: c.line == null, hunk: c.diff_hunk || '', replies: [item] };
      threads.push(t);
      byId.set(c.id, t);
    }
  }
  return threads;
}

// What a failed check printed: the end of its log (for GitHub Actions jobs), or its summary.
async function checkLog(settings, repo, check) {
  let log = '';
  if (check.kind === 'run' && check.app === 'github-actions') {
    try {
      const raw = await request(settings, 'GET', `${repoPath(repo)}/actions/jobs/${check.id}/logs`, null, { text: true });
      const lines = raw.split('\n').map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '').replace(/\x1b\[[0-9;]*m/g, ''));
      const firstError = lines.findIndex((l) => /##\[error\]/.test(l));
      const from = firstError >= 0 ? Math.max(0, firstError - 120) : Math.max(0, lines.length - 200);
      log = lines.slice(from, from + 250).join('\n');
    } catch {
      /* no log access */
    }
  }
  return [check.title, check.summary, log].filter(Boolean).join('\n\n').slice(0, 40000);
}

async function listIssues(settings, repo) {
  const list = await request(settings, 'GET', `${repoPath(repo)}/issues?state=open&sort=updated&direction=desc&per_page=50`);
  return list.filter((i) => !i.pull_request).map((i) => ({ number: i.number, title: i.title, author: who(i.user), labels: (i.labels || []).map((l) => (typeof l === 'string' ? l : l.name)), comments: i.comments, updatedAt: i.updated_at, url: i.html_url }));
}

async function getIssue(settings, repo, n) {
  const [i, comments] = await Promise.all([request(settings, 'GET', `${repoPath(repo)}/issues/${n}`), request(settings, 'GET', `${repoPath(repo)}/issues/${n}/comments?per_page=100`)]);
  return { number: i.number, title: i.title, body: i.body || '', author: who(i.user), url: i.html_url, labels: (i.labels || []).map((l) => (typeof l === 'string' ? l : l.name)), comments: comments.map((c) => ({ author: who(c.user), body: c.body || '' })) };
}

// A review with comments on lines. GitHub refuses the whole review if one comment is on a line
// outside the diff; then those go in the review's text instead.
async function postReview(settings, repo, n, { sha, body, comments }) {
  const url = `${repoPath(repo)}/pulls/${n}/reviews`;
  try {
    return await request(settings, 'POST', url, { commit_id: sha, body, event: 'COMMENT', comments: comments.map((c) => ({ path: c.path, line: c.line, side: 'RIGHT', body: c.body })) });
  } catch (e) {
    if (e.status !== 422 || !comments.length) throw e;
    const extra = comments.map((c) => `**${c.path}:${c.line}**\n\n${c.body}`).join('\n\n---\n\n');
    return request(settings, 'POST', url, { commit_id: sha, body: `${body}\n\n${extra}`, event: 'COMMENT' });
  }
}

const createPr = (settings, repo, { head, base, title, body, draft }) => request(settings, 'POST', `${repoPath(repo)}/pulls`, { head, base, title, body, draft: !!draft }).then((p) => ({ number: p.number, url: p.html_url }));
const reply = (settings, repo, n, commentId, body) => request(settings, 'POST', `${repoPath(repo)}/pulls/${n}/comments/${commentId}/replies`, { body });
const defaultBranch = (settings, repo) => request(settings, 'GET', repoPath(repo)).then((r) => r.default_branch);

// A push address that carries the token, for when git itself isn't signed in to GitHub.
async function pushUrl(settings, repo) {
  if (process.env.SWITCHDESK_GITHUB_REPO) return null;
  const { token } = await auth(settings);
  return token ? `https://x-access-token:${token}@github.com/${repo.owner}/${repo.name}.git` : null;
}

module.exports = { parseRepo, repoOf, status, sealToken, listPrs, getPr, checkLog, listIssues, getIssue, postReview, createPr, reply, defaultBranch, pushUrl, forgetCli: () => (cliCache = { at: 0, token: null }) };
