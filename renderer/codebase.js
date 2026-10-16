/* global $, h, state, desk, toast, openFile, renderChips */
'use strict';

// ------------------------------------------------------------------ codebase search by meaning
//
// @codebase in the chat box finds the parts of the project your message is about and attaches
// them; the Search panel's ≈ button searches the same way. Main keeps the index (see
// src/codebase.js); the model runs here, in a worker. Until it's switched on (or while the model
// downloads) searches still work, ranked by keywords alone.

const CODEBASE_MODEL = 'Xenova/all-MiniLM-L6-v2';
const cb = { workers: null, seq: 0, waits: new Map(), status: null, indexing: false, timer: null, again: false, progress: null };

const codebaseOn = () => !!(state.settings.codebase && state.settings.codebase.enabled);

// A few workers side by side: each runs the model on one CPU core (or the graphics card).
const POOL = Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 2) / 2)));

function startWorker() {
  const w = { worker: new Worker('embed-worker.js', { type: 'module' }), busy: 0 };
  w.worker.onmessage = ({ data }) => {
    const wait = cb.waits.get(data.id);
    if (!wait) return;
    cb.waits.delete(data.id);
    w.busy--;
    data.error ? wait.reject(new Error(data.error)) : wait.resolve(data.vectors);
  };
  w.worker.onerror = (e) => {
    for (const [id, wait] of cb.waits) if (wait.w === w) (wait.reject(new Error(e.message || 'The search model stopped.')), cb.waits.delete(id));
    cb.workers.splice(cb.workers.indexOf(w), 1);
  };
  cb.workers.push(w);
  return w;
}

function embed(texts) {
  if (!cb.workers) cb.workers = [];
  if (cb.workers.length < POOL && cb.workers.every((w) => w.busy)) startWorker();
  const w = cb.workers.reduce((a, b) => (b.busy < a.busy ? b : a));
  w.busy++;
  const id = ++cb.seq;
  return new Promise((resolve, reject) => {
    cb.waits.set(id, { resolve, reject, w });
    w.worker.postMessage({ id, model: CODEBASE_MODEL, texts });
  });
}

function renderIndexStatus() {
  const el = $('#status-index');
  if (!el) return;
  const s = cb.status;
  let text = '';
  if (cb.progress != null) text = `Downloading the search model ${Math.round(cb.progress * 100)}%`;
  else if (cb.indexing && s && s.chunks) text = `Indexing ${Math.round((s.embedded / s.chunks) * 100)}%`;
  el.textContent = text;
  el.classList.toggle('hidden', !text);
}

function queueCodebaseIndex(delay = 4000) {
  if (!codebaseOn() || !state.folder) return;
  clearTimeout(cb.timer);
  cb.timer = setTimeout(indexCodebase, delay);
}

// Brings the index up to date: finds changed files, then embeds whatever has no vector yet.
async function indexCodebase() {
  if (!codebaseOn() || !state.folder) return;
  if (cb.indexing) return void (cb.again = true);
  cb.indexing = true;
  const folder = state.folder.root;
  try {
    cb.status = await desk.codebase.status();
    if (!cb.status.model) await downloadCodebaseModel();
    cb.status = await desk.codebase.scan();
    renderIndexStatus();
    for (;;) {
      if (!state.folder || state.folder.root !== folder || !codebaseOn()) break;
      const batch = await desk.codebase.pending(8 * POOL);
      if (!batch.length) break;
      const parts = [];
      for (let i = 0; i < batch.length; i += 8) parts.push(batch.slice(i, i + 8));
      await Promise.all(
        parts.map(async (part) => {
          const vectors = await embed(part.map((b) => b.text));
          await desk.codebase.put(part.map((b, i) => ({ hash: b.hash, vector: vectors[i] })));
          cb.status.embedded = Math.min(cb.status.chunks, cb.status.embedded + part.length);
          renderIndexStatus();
        })
      );
    }
    cb.status = await desk.codebase.status();
  } catch (e) {
    console.warn('codebase index:', e);
    cb.error = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  } finally {
    cb.indexing = false;
    renderIndexStatus();
    if (cb.again) {
      cb.again = false;
      queueCodebaseIndex(1000);
    }
  }
}

async function downloadCodebaseModel() {
  cb.progress = 0;
  renderIndexStatus();
  try {
    await desk.codebase.download();
  } catch (e) {
    throw new Error(`Couldn't download the search model (${String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}). Searches use keywords until it can; it tries again next time you open a folder.`);
  } finally {
    cb.progress = null;
    renderIndexStatus();
  }
}

async function enableCodebase(on = true) {
  state.settings = await desk.setSettings({ codebase: { ...(state.settings.codebase || {}), enabled: on } });
  cb.error = null;
  if (on) indexCodebase();
}

// The parts of the project that best match a question: [{ rel, start, end, text }].
async function codebaseSearch(query, k = 12) {
  let vector = null;
  if (codebaseOn() && cb.status && cb.status.model) vector = await embed([query]).then((v) => v[0]).catch(() => null);
  else if (!cb.status) cb.status = await desk.codebase.status();
  if (!vector && !cb.indexing) await desk.codebase.scan(); // keyword ranking still needs the chunks
  return desk.codebase.search(query, vector, k);
}

// What @codebase attaches to a message.
async function codebaseContext(query) {
  const hits = await codebaseSearch(query, 12);
  if (!hits.length) return '';
  let out = '';
  for (const r of hits) {
    const block = `\n### ${r.rel} (lines ${r.start}-${r.end})\n\`\`\`\n${r.text}\n\`\`\`\n`;
    if (out.length + block.length > 40000) break;
    out += block;
  }
  return `Parts of the project that look relevant to my message, found by searching the codebase (best match first; it may have missed things, so look further if you need to):\n${out}`;
}

// @codebase picked: a chip that's filled in with the search results when the message is sent.
function attachCodebase() {
  if (state.chips.some((c) => c.kind === 'codebase')) return;
  state.chips.push({ kind: 'codebase', icon: '≈', label: 'Codebase', context: 'Searched when you send, for what your message asks about' });
  renderChips();
  if (!codebaseOn()) enableCodebase(true); // using it is the opt-in; keyword search covers the wait
}

// Called from send(): swaps each codebase chip for what the search found.
async function resolveCodebaseChips(text) {
  for (const c of state.chips.filter((x) => x.kind === 'codebase')) {
    const context = await codebaseContext(text).catch(() => '');
    c.kind = 'context';
    c.label = 'Codebase';
    c.context = context || 'I asked Switchdesk to search the codebase for this, but nothing matched.';
  }
}

// ---------- Search panel: ≈ searches by meaning

async function runMeaningSearch(query, summary, host, seq, current) {
  summary.textContent = 'Searching by meaning…';
  const hits = await codebaseSearch(query, 30).catch((e) => ({ error: String(e.message || e) }));
  if (seq !== current()) return;
  if (hits.error) return void ((summary.textContent = hits.error), host.replaceChildren());
  const note = codebaseOn() ? (cb.indexing ? ' (still indexing)' : '') : ' by keywords. Turn on search by meaning in Settings → Codebase search';
  summary.textContent = hits.length ? `${hits.length} closest match${hits.length === 1 ? '' : 'es'}${note}` : `No matches${note}.`;
  host.replaceChildren(
    ...hits.map((r) => {
      const first = r.text.split('\n').find((l) => l.trim()) || '';
      return h(
        'div',
        { class: 'meaning-hit', title: `${r.rel}:${r.start}-${r.end}`, onclick: () => openFile(r.rel, r.start) },
        h('div', { class: 'search-file' }, h('span', { class: 'name' }, r.rel.split('/').pop()), h('span', { class: 'dir' }, `${r.rel.includes('/') ? r.rel.slice(0, r.rel.lastIndexOf('/')) : ''}`), h('span', { class: 'spacer' }), h('span', { class: 'count' }, `${r.start}–${r.end}`)),
        h('div', { class: 'meaning-snippet' }, first.trim().slice(0, 140))
      );
    })
  );
}

// ---------- Settings → Codebase search

async function settingsCodebase(body) {
  const s = await desk.codebase.status();
  cb.status = { ...(cb.status || {}), ...s };
  const on = codebaseOn();
  const rerender = () => settingsCodebase(body);
  const toggle = h('input', { type: 'checkbox', checked: on });
  toggle.addEventListener('change', async () => {
    await enableCodebase(toggle.checked);
    setTimeout(rerender, 300);
  });
  const stat = !state.folder
    ? 'Open a folder to index it.'
    : !on
      ? 'Off. @codebase and the Search panel still work, ranked by keywords only.'
      : cb.progress != null
        ? `Downloading the search model (${Math.round(cb.progress * 100)}%).`
        : !s.model
          ? 'The search model is not downloaded yet.'
          : `${s.files.toLocaleString()} files, ${s.embedded.toLocaleString()} of ${s.chunks.toLocaleString()} parts indexed${cb.indexing ? ', indexing now' : ''}.`;
  body.replaceChildren(
    h('h2', {}, 'Codebase search'),
    h('p', { class: 'muted' }, 'Finds code by what it does, not just by the words in it, so "where do we handle refunds" finds the right files even if they never say "refund". Type @codebase in the chat box to give the agent the parts of the project your message is about, or use ≈ in the Search panel.'),
    h('div', { class: 'set-box' }, h('label', { class: 'perm-toggle' }, toggle, h('div', {}, h('b', {}, 'Search by meaning'), h('div', { class: 'muted small' }, 'Downloads a small search model (about 50 MB, once) and indexes each folder you open, on this computer. Nothing is sent anywhere.'))), h('p', { class: 'muted small' }, stat), cb.error ? h('p', { class: 'small error' }, cb.error) : null, on && s.model ? h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => (indexCodebase(), setTimeout(rerender, 800)) }, 'Update the index now')) : null)
  );
}

function wireCodebase() {
  desk.codebase.onProgress((p) => {
    cb.progress = p >= 1 ? null : p;
    renderIndexStatus();
  });
  desk.onFsChanged(() => queueCodebaseIndex(5000));
}
