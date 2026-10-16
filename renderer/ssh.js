/* global $, h, state, desk, toast, modal, setFolder */
'use strict';

// ------------------------------------------------------------------ SSH folders
//
// Open a folder on another machine: pick the host (from ~/.ssh/config, or user@host), browse to the
// folder, and the window works there: files, search, git, the terminal and the agents all run on
// the host. It signs in with your SSH keys, like `ssh` in a terminal.

const sshErr = (err) => String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

async function openSshFolder(initial) {
  const hosts = await desk.ssh.hosts().catch(() => []);
  const list = h('datalist', { id: 'ssh-hosts' }, ...hosts.map((x) => h('option', { value: x })));
  const host = h('input', { type: 'text', list: 'ssh-hosts', placeholder: 'user@host, or a Host from ~/.ssh/config', spellcheck: 'false', value: initial || state.settings.lastSshHost || '' });
  const connect = h('button', { class: 'btn primary' }, 'Connect');
  const status = h('div', { class: 'muted small ssh-status' }, 'Uses your SSH keys or ssh-agent, the same as `ssh` in a terminal. The host needs Python 3, and the agents you use installed there.');
  const browser = h('div', { class: 'ssh-browser hidden' });
  const body = h('div', { class: 'body ssh-dialog' }, h('h3', {}, 'Open a folder over SSH'), h('div', { class: 'row' }, host, connect), list, status, browser);
  const close = modal([body]);
  const done = () => (desk.ssh.doneBrowsing(), close());
  let spec = '';

  const show = async (dir) => {
    status.textContent = `Connecting to ${spec}…`;
    let r;
    try {
      r = await desk.ssh.dirs(spec, dir);
    } catch (err) {
      status.textContent = sshErr(err);
      status.classList.add('bad');
      connect.disabled = false;
      return;
    }
    status.classList.remove('bad');
    status.textContent = `Connected to ${spec}. Pick a folder.`;
    const where = h('input', { type: 'text', value: r.path, spellcheck: 'false' });
    where.addEventListener('keydown', (e) => e.key === 'Enter' && show(where.value.trim()));
    const up = r.path.replace(/\/[^/]+\/?$/, '') || '/';
    const open = h('button', { class: 'btn primary' }, `Open ${r.path.split('/').pop() || r.path}`);
    open.addEventListener('click', async () => {
      open.disabled = true;
      open.textContent = 'Opening…';
      try {
        const info = await desk.openFolder(`ssh://${spec}${encodeURI(where.value.trim() || r.path)}`);
        desk.setSettings({ lastSshHost: spec });
        done();
        setFolder(info);
      } catch (err) {
        open.disabled = false;
        open.textContent = 'Open';
        status.textContent = sshErr(err);
        status.classList.add('bad');
      }
    });
    browser.classList.remove('hidden');
    browser.replaceChildren(
      h('div', { class: 'row' }, where, h('button', { class: 'btn small', onclick: () => show(where.value.trim()) }, 'Go')),
      h(
        'div',
        { class: 'results ssh-dirs' },
        r.path !== '/' ? h('div', { class: 'result', onclick: () => show(up) }, h('b', {}, '↑ '), '..') : null,
        ...r.dirs.map((d) => h('div', { class: 'result', ondblclick: () => show(`${r.path.replace(/\/$/, '')}/${d}`), onclick: (e) => ((where.value = `${r.path.replace(/\/$/, '')}/${d}`), [...e.currentTarget.parentNode.children].forEach((x) => x.classList.toggle('active', x === e.currentTarget))) }, '📁 ', d))
      ),
      h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: done }, 'Cancel'), open)
    );
  };

  const go = () => {
    spec = host.value.trim();
    if (!spec) return host.focus();
    connect.disabled = true;
    show('~').finally(() => (connect.disabled = false));
  };
  connect.addEventListener('click', go);
  host.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  host.focus();
}

function wireSsh() {
  desk.ssh.onClosed(({ spec, message }) => {
    if (!state.folder || state.folder.remote !== spec) return;
    toast(`Lost the connection to ${spec}. ${message || ''} Reopen the folder (File → Open Recent) to carry on.`);
  });
}
