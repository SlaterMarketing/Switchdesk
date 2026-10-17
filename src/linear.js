// Linear: your open issues, to start work on one the way you can from a GitHub issue. Signs in with
// a personal API key from Linear's settings, stored encrypted. Talks to Linear's GraphQL API.
'use strict';

const { safeStorage } = require('electron');

const API = process.env.SWITCHDESK_LINEAR_API || 'https://api.linear.app/graphql';

function savedKey(settings) {
  const l = settings.linear || {};
  if (!l.key) return null;
  try {
    return l.enc ? (safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(l.key, 'base64')) : null) : l.key;
  } catch {
    return null;
  }
}

function sealKey(key) {
  if (safeStorage.isEncryptionAvailable()) return { key: safeStorage.encryptString(key).toString('base64'), enc: true };
  return { key, enc: false };
}

async function query(settings, q, variables) {
  const key = savedKey(settings);
  if (!key) throw new Error('Connect Linear first, from the Git panel.');
  const r = await fetch(API, { method: 'POST', headers: { Authorization: key, 'Content-Type': 'application/json', 'User-Agent': 'Switchdesk' }, body: JSON.stringify({ query: q, variables }) });
  let j = null;
  try {
    j = await r.json();
  } catch {
    /* not JSON */
  }
  if (r.status === 401 || (j && (j.errors || []).some((e) => /authenticat/i.test(e.message || '')))) throw new Error("Linear didn't accept the API key. Make a new one in Linear (Settings → Security & access) and connect again.");
  if (!r.ok || !j || (j.errors && j.errors.length)) throw new Error((j && j.errors && j.errors.map((e) => e.message).join('; ')) || `Linear said ${r.status}.`);
  return j.data;
}

async function status(settings) {
  if (!savedKey(settings)) return { signedIn: false };
  try {
    const d = await query(settings, 'query { viewer { name email } }');
    return { signedIn: true, name: d.viewer.name, email: d.viewer.email };
  } catch (e) {
    return { signedIn: false, error: e.message };
  }
}

// Issues assigned to you that aren't done or cancelled, most recently updated first.
async function issues(settings) {
  const d = await query(
    settings,
    `query { viewer { assignedIssues(first: 50, orderBy: updatedAt, filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
      nodes { id identifier title url priorityLabel updatedAt state { name } team { key } } } } }`
  );
  return d.viewer.assignedIssues.nodes.map((i) => ({ id: i.id, identifier: i.identifier, title: i.title, url: i.url, priority: i.priorityLabel, state: i.state && i.state.name, team: i.team && i.team.key, updatedAt: i.updatedAt }));
}

async function issue(settings, id) {
  const d = await query(
    settings,
    `query($id: String!) { issue(id: $id) { id identifier title description url branchName state { name } creator { name }
      comments(first: 20) { nodes { body user { name } } } } }`,
    { id }
  );
  const i = d.issue;
  return { id: i.id, identifier: i.identifier, title: i.title, body: i.description || '', url: i.url, branchName: i.branchName, state: i.state && i.state.name, author: (i.creator && i.creator.name) || 'someone', comments: (i.comments ? i.comments.nodes : []).map((c) => ({ author: (c.user && c.user.name) || 'someone', body: c.body || '' })) };
}

const comment = (settings, id, body) => query(settings, 'mutation($id: String!, $body: String!) { commentCreate(input: { issueId: $id, body: $body }) { success } }', { id, body }).then((d) => d.commentCreate.success);

module.exports = { sealKey, status, issues, issue, comment };
