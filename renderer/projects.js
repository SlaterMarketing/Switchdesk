/* global $, h, desk, state, toast, modal, setFolder, loadHistory, openSession, switchChat, chats, agentRows, agentInfo, chatTitleFor */
'use strict';

// Projects in the Desk view, like Claude's app: each project is a folder with its own chats, its own
// instructions and its own files, and you swap between them from the top of the chat list. Switching
// brings back that project's open chats where you left them. A new project gets a folder of its own
// (Documents/Switchdesk Projects/<name>), so nobody has to think about folders to use one.

const projectName = (f) => {
  const m = /^ssh:\/\/[^/]+(.*)$/.exec(f);
  const p = (m ? m[1] : f).replace(/[\\/]+$/, '');
  return p.split(/[\\/]/).pop() || f;
};

// Projects you've made or used in Desk first, then other recent folders.
function projectList() {
  const mine = (state.settings && state.settings.projects) || [];
  const recent = (state.settings && state.settings.recentFolders) || [];
  return [...new Set([...mine, ...recent])].filter((f) => !((state.settings && state.settings.hiddenProjects) || []).includes(f));
}

async function rememberProject(root) {
  if (!root) return;
  const list = (state.settings && state.settings.projects) || [];
  if (list[0] === root) return;
  state.settings = await desk.setSettings({ projects: [root, ...list.filter((f) => f !== root)].slice(0, 50), hiddenProjects: ((state.settings && state.settings.hiddenProjects) || []).filter((f) => f !== root) });
}

async function forgetProject(root) {
  state.settings = await desk.setSettings({
    projects: ((state.settings && state.settings.projects) || []).filter((f) => f !== root),
    hiddenProjects: [...new Set([...((state.settings && state.settings.hiddenProjects) || []), root])].slice(-100),
  });
}

async function switchProject(root) {
  closeProjectMenu();
  if (state.folder && (state.folder.key || state.folder.root) === root) return;
  const info = await desk.openFolder(root).catch((e) => (toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')), null));
  if (!info) return toast(`Couldn't open ${projectName(root)}. It may have been moved or deleted.`);
  await setFolder(info);
  if (!info.elsewhere) await rememberProject(info.key || info.root);
  renderProjectSwitcher();
}

// The top of Desk's chat list: the project you're in, and a menu of the others.
function renderProjectSwitcher() {
  const el = $('#desk-folder');
  if (!el) return;
  const cur = state.folder;
  el.replaceChildren(
    h(
      'button',
      { class: 'project-current', title: cur ? cur.root : 'Pick a project to work in', onclick: (e) => (e.stopPropagation(), toggleProjectMenu()) },
      h('span', { class: 'project-icon' }, cur ? '◆' : '◇'),
      h('span', { class: 'project-label' }, h('span', { class: 'project-kicker' }, 'Project'), h('span', { class: 'project-name' }, cur ? cur.name : 'No project')),
      h('span', { class: 'project-caret' }, '▾')
    ),
    cur
      ? h(
          'div',
          { class: 'project-tools' },
          h('button', { class: 'ghost-btn', title: "This project's instructions, which every agent follows in its chats", onclick: editProjectInstructions }, '✎ Instructions'),
          h('button', { class: 'ghost-btn', title: 'Show the project folder', onclick: () => desk.revealFile('.').catch(() => {}) }, '📁 Files')
        )
      : '',
    h('div', { id: 'project-menu', class: 'project-menu hidden' })
  );
}

function closeProjectMenu() {
  const m = $('#project-menu');
  if (m) m.classList.add('hidden');
}

function toggleProjectMenu() {
  const menu = $('#project-menu');
  if (!menu) return;
  if (!menu.classList.contains('hidden')) return closeProjectMenu();
  const cur = state.folder ? state.folder.key || state.folder.root : null;
  const filter = h('input', { class: 'project-filter', placeholder: 'Find a project', spellcheck: 'false' });
  const list = h('div', { class: 'project-items' });
  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    const rows = projectList().filter((f) => !q || projectName(f).toLowerCase().includes(q) || f.toLowerCase().includes(q));
    list.replaceChildren(
      ...rows.map((f) =>
        h(
          'div',
          { class: `project-item${f === cur ? ' active' : ''}`, title: f, onclick: () => switchProject(f) },
          h('span', { class: 'project-item-name' }, projectName(f)),
          h('span', { class: 'project-item-path' }, f),
          f === cur
            ? null
            : h('button', { class: 'icon-btn project-forget', title: 'Remove from this list (the folder stays)', onclick: async (e) => (e.stopPropagation(), await forgetProject(f), draw()) }, '✕')
        )
      ),
      ...(rows.length ? [] : [h('div', { class: 'muted small', style: 'padding:6px 10px' }, q ? 'No projects match.' : 'No projects yet.')])
    );
  };
  filter.addEventListener('input', draw);
  filter.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') closeProjectMenu();
    if (e.key === 'Enter') {
      const first = $('.project-item', list);
      if (first) first.click();
    }
  });
  menu.replaceChildren(
    filter,
    list,
    h(
      'div',
      { class: 'project-menu-foot' },
      h('button', { class: 'btn small primary', onclick: () => (closeProjectMenu(), newProject()) }, '＋ New project'),
      h('button', { class: 'btn small', onclick: async () => (closeProjectMenu(), switchToPicked(await desk.pickFolder())) }, 'Use a folder…')
    )
  );
  draw();
  menu.classList.remove('hidden');
  filter.focus();
}

async function switchToPicked(info) {
  if (!info) return;
  await setFolder(info);
  if (!info.elsewhere) await rememberProject(info.key || info.root);
  renderProjectSwitcher();
}

// A new project: a name and, if you like, instructions. Switchdesk makes its folder.
function newProject() {
  const name = h('input', { class: 'input', placeholder: 'Name, like "Spring launch" or "Thesis"', spellcheck: 'false' });
  const about = h('textarea', { class: 'input project-instructions', rows: 6, placeholder: 'Instructions (optional): what this project is, who it\'s for, and how you\'d like the agents to work. Every chat in the project follows them.' });
  const go = h('button', { class: 'btn primary' }, 'Create project');
  const cancel = h('button', { class: 'btn' }, 'Cancel');
  const close = modal([
    h(
      'div',
      { class: 'body' },
      h('h3', {}, 'New project'),
      h('p', { class: 'muted small' }, 'A project keeps its own chats, instructions and files together. Its files live in Documents → Switchdesk Projects.'),
      name,
      about
    ),
    h('div', { class: 'foot' }, cancel, go),
  ]);
  cancel.addEventListener('click', close);
  name.addEventListener('keydown', (e) => e.key === 'Enter' && go.click());
  name.focus();
  go.addEventListener('click', async () => {
    if (!name.value.trim()) return name.focus();
    go.disabled = true;
    try {
      const info = await desk.createProject(name.value, about.value);
      close();
      await switchToPicked(info);
      toast(`Made ${info.name}.`);
    } catch (e) {
      go.disabled = false;
      toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
  });
}

// The project's instructions are its AGENTS.md, which every agent reads, with CLAUDE.md pointing at it
// so Claude does too. A project that only had a CLAUDE.md starts from that.
async function readInstructions() {
  const files = await desk.cfg.memory();
  const agents = files.find((f) => f.id === 'agents');
  const claude = files.find((f) => f.id === 'project');
  const shared = await desk.cfg.rulesShared();
  const fromClaude = !shared && !(agents && agents.content.trim()) && !!(claude && claude.content.trim());
  return { text: fromClaude ? claude.content : (agents && agents.content) || '', fromClaude, shared };
}

async function saveInstructions(text, { fromClaude, shared }) {
  await desk.cfg.saveMemory('agents', text.trim() ? text.trim() + '\n' : '');
  if (fromClaude) await desk.cfg.saveMemory('project', '@AGENTS.md\n');
  else if (!shared && text.trim()) await desk.cfg.shareRules();
}

async function editProjectInstructions() {
  if (!state.folder) return;
  const cur = await readInstructions();
  const box = h('textarea', { class: 'input project-instructions', rows: 14, spellcheck: 'true' });
  box.value = cur.text;
  const go = h('button', { class: 'btn primary' }, 'Save');
  const cancel = h('button', { class: 'btn' }, 'Cancel');
  const close = modal([
    h(
      'div',
      { class: 'body' },
      h('h3', {}, `${state.folder.name}: instructions`),
      h('p', { class: 'muted small' }, 'Every agent follows these in this project\'s chats: what the project is, who it\'s for, the tone you want, what to avoid. They\'re kept in AGENTS.md in the project folder.'),
      box
    ),
    h('div', { class: 'foot' }, cancel, go),
  ]);
  cancel.addEventListener('click', close);
  box.focus();
  go.addEventListener('click', async () => {
    try {
      await saveInstructions(box.value, cur);
      close();
      toast('Saved. New messages in this project follow them.');
      fillProjectHome();
    } catch (e) {
      toast(String(e.message || e));
    }
  });
}

// What a new chat in a project shows in Desk: the project's instructions and its latest chats, so a
// project opens like a home page (Claude's app does the same).
async function fillProjectHome(el) {
  const hosts = el ? [el] : [...document.querySelectorAll('.project-home')];
  if (!hosts.length || !document.body.classList.contains('desk')) return;
  if (!state.folder) return hosts.forEach((x) => x.replaceChildren());
  const root = state.folder.root;
  const [ins, claudeRows] = await Promise.all([readInstructions().catch(() => ({ text: '' })), desk.listSessions().catch(() => [])]);
  if (!state.folder || state.folder.root !== root) return;
  const rows = [...claudeRows.map((r) => ({ ...r, agent: 'claude' })), ...(agentRows.root === root ? agentRows.rows : [])].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 5);
  const firstLines = ins.text
    .split('\n')
    .filter((l) => l.trim() && !/^@AGENTS\.md/.test(l))
    .slice(0, 3)
    .join(' ')
    .replace(/^#+\s*/, '')
    .slice(0, 220);
  for (const host of hosts)
    host.replaceChildren(
      h('div', { class: 'project-home-name' }, state.folder.name),
      h(
        'div',
        { class: 'project-card' },
        h('div', { class: 'project-card-head' }, h('b', {}, 'Instructions'), h('button', { class: 'ghost-btn', onclick: editProjectInstructions }, firstLines ? 'Edit' : 'Add')),
        h('div', { class: `small${firstLines ? '' : ' muted'}` }, firstLines || 'Tell the agents what this project is and how you like to work. Every chat here follows it.')
      ),
      rows.length
        ? h(
            'div',
            { class: 'project-card' },
            h('div', { class: 'project-card-head' }, h('b', {}, 'Recent chats')),
            ...rows.map((r) =>
              h(
                'button',
                {
                  class: 'project-chat',
                  onclick: () => {
                    const open = chats.find((c) => c.sessionId === r.id);
                    return open ? switchChat(open.id) : openSession(r);
                  },
                },
                h('span', { class: 'project-chat-t' }, chatTitleFor(r.id, r.title)),
                h('span', { class: 'muted small' }, `${agentInfo(r.agent).label}${r.updatedAt ? ' · ' + new Date(r.updatedAt).toLocaleDateString() : ''}`)
              )
            )
          )
        : ''
    );
}

document.addEventListener('click', (e) => {
  if (!e.target.closest || !e.target.closest('#desk-folder')) closeProjectMenu();
});
