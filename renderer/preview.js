/* global $, h, state, desk, toast, activeTab, activateTab, renderTabs, renderChips, send, toggleTerminal, newTerminal */
'use strict';

// ------------------------------------------------------------------ preview pane
//
// Your running site in a tab next to the code. Page errors can go straight to Claude, and
// "Pick element" lets you click part of the page to attach it (with a screenshot) to the chat.

const LOCAL_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}(?:\/[^\s'"`)\]]*)?/;
const preview = { url: '', errors: [], seen: [], view: null, picking: false };

function previewTab() {
  let t = state.tabs.find((x) => x.kind === 'preview');
  if (!t) {
    t = { id: 'preview', kind: 'preview', rel: 'Preview' };
    state.tabs.push(t);
  }
  return t;
}

function openPreview(url) {
  ensureWebview();
  activateTab(previewTab().id);
  if (url) navigatePreview(url);
  else if (!preview.url && preview.seen.length) navigatePreview(preview.seen[preview.seen.length - 1]);
  renderPreviewEmpty();
}

function ensureWebview() {
  if (preview.view) return preview.view;
  const v = document.createElement('webview');
  v.id = 'preview-view';
  v.setAttribute('partition', 'persist:preview');
  v.setAttribute('src', 'about:blank');
  $('#preview-frame').append(v);
  v.addEventListener('console-message', (e) => {
    if (e.level === 3) addPreviewError(`${e.message}${e.sourceId ? `\n    at ${e.sourceId}:${e.line}` : ''}`);
  });
  v.addEventListener('did-fail-load', (e) => {
    if (e.isMainFrame && e.errorCode !== -3) addPreviewError(`Couldn't load ${e.validatedURL}: ${e.errorDescription || e.errorCode}`);
  });
  v.addEventListener('did-start-navigation', (e) => {
    if (e.isMainFrame && !e.isSameDocument) {
      preview.errors = [];
      renderPreviewBar();
    }
  });
  v.addEventListener('did-navigate', (e) => setPreviewUrl(e.url));
  v.addEventListener('did-navigate-in-page', (e) => e.isMainFrame && setPreviewUrl(e.url));
  preview.view = v;
  return v;
}

function normaliseUrl(url) {
  url = url.trim();
  if (!url) return '';
  if (!/^[a-z]+:/i.test(url)) url = (/^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(url) ? 'http://' : 'https://') + url;
  return url.replace('//0.0.0.0', '//localhost');
}

function navigatePreview(url) {
  url = normaliseUrl(url);
  if (!url) return;
  ensureWebview().loadURL(url).catch(() => {});
  setPreviewUrl(url);
}

function setPreviewUrl(url) {
  if (url === 'about:blank') return;
  preview.url = url;
  const input = $('#preview-url');
  if (input && document.activeElement !== input) input.value = url;
  renderPreviewEmpty();
}

function addPreviewError(text) {
  if (preview.errors.length >= 50 || preview.errors.includes(text)) return;
  preview.errors.push(text);
  renderPreviewBar();
}

function renderPreviewBar() {
  const btn = $('#preview-errors');
  const n = preview.errors.length;
  btn.classList.toggle('hidden', !n);
  btn.textContent = `⚠ ${n} error${n > 1 ? 's' : ''} · Fix with Claude`;
  btn.title = preview.errors.join('\n\n').slice(0, 2000);
}

function renderPreviewEmpty() {
  const empty = $('#preview-empty');
  empty.classList.toggle('hidden', !!preview.url);
  if (preview.url) return;
  const urls = [...new Set(preview.seen)].slice(-4).reverse();
  empty.replaceChildren(
    h(
      'div',
      { class: 'welcome-inner' },
      h('h2', {}, 'Preview your site'),
      h('p', { class: 'muted' }, 'Start your dev server, or type an address above. Addresses your terminal prints show up here.'),
      h('button', { class: 'btn primary', onclick: runDevServer }, '▶ Start dev server'),
      ...urls.map((u) => h('button', { class: 'recent', onclick: () => navigatePreview(u) }, u))
    )
  );
}

// Called by the terminal for every address like http://localhost:5173 it prints.
function noticeLocalUrl(text) {
  const plain = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const m = LOCAL_URL_RE.exec(plain);
  if (!m) return;
  const url = normaliseUrl(m[0].replace(/[.,;:]+$/, ''));
  if (preview.seen[preview.seen.length - 1] === url) return;
  preview.seen.push(url);
  const pill = $('#btn-term-preview');
  pill.textContent = `◉ Preview ${url.replace(/^https?:\/\//, '')}`;
  pill.dataset.url = url;
  pill.classList.remove('hidden');
  if (activeTab()?.kind === 'preview' && !preview.url) navigatePreview(url);
  else renderPreviewEmpty();
}

async function runDevServer() {
  if (!state.folder) return toast('Open a folder first.');
  let scripts = {};
  try {
    scripts = JSON.parse((await desk.readFile('package.json')).content || '{}').scripts || {};
  } catch {
    /* no package.json */
  }
  const name = ['dev', 'start', 'serve', 'preview'].find((s) => scripts[s]);
  if (!name) {
    if (state.fileSet.has('index.html')) return navigatePreview(`file://${state.folder.root.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:')}/index.html`);
    return toast("Couldn't find a dev script in package.json. Start your server in the terminal and its address will show up here.");
  }
  const t = await newTerminal();
  toggleTerminal(true);
  if (t) setTimeout(() => desk.term.write(t.id, `npm run ${name}\r`), 600);
}

function resetPreview() {
  preview.url = '';
  preview.seen = [];
  preview.errors = [];
  if (preview.view) preview.view.loadURL('about:blank').catch(() => {});
  $('#btn-term-preview').classList.add('hidden');
  renderPreviewBar();
}

function fixPreviewErrors() {
  if (!preview.errors.length) return;
  const list = preview.errors.map((e) => `- ${e}`).join('\n');
  send(`My site at ${preview.url} shows these errors in the browser console:\n\n${list}\n\nFind the cause in the code and fix it.`, undefined, `⚠ Fix ${preview.errors.length} error${preview.errors.length > 1 ? 's' : ''} from the preview`);
}

async function captureToChat(rect) {
  const v = preview.view;
  if (!v || !preview.url) return null;
  const data = await desk.preview.capture(v.getWebContentsId(), rect || null);
  if (!data) return null;
  state.chips.push({ kind: 'image', mediaType: 'image/png', data });
  return data;
}

async function screenshotPreview() {
  if (await captureToChat()) {
    renderChips();
    $('#input').focus();
    toast('Screenshot added to the chat.');
  }
}

// Injected into the page: outline whatever's under the mouse and report what gets clicked.
const PICKER = `new Promise((resolve) => {
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #d97757;background:rgba(217,119,87,.12);border-radius:3px;transition:all .05s';
  const tag = document.createElement('div');
  tag.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;background:#d97757;color:#fff;font:11px system-ui;padding:2px 6px;border-radius:3px';
  document.documentElement.append(box, tag);
  let cur = null;
  const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + [...el.classList].slice(0, 3).map((c) => '.' + c).join('');
  const path = (el) => { const parts = []; while (el && el.nodeType === 1 && parts.length < 6) { parts.unshift(name(el)); if (el.id) break; el = el.parentElement; } return parts.join(' > '); };
  const move = (e) => { cur = e.target; const r = cur.getBoundingClientRect(); Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' }); tag.textContent = name(cur); Object.assign(tag.style, { left: r.left + 'px', top: Math.max(0, r.top - 20) + 'px' }); };
  const done = (value) => { removeEventListener('mousemove', move, true); removeEventListener('click', click, true); removeEventListener('keydown', key, true); box.remove(); tag.remove(); resolve(value); };
  const click = (e) => { e.preventDefault(); e.stopPropagation(); const el = cur || e.target; const r = el.getBoundingClientRect(); done({ selector: path(el), name: name(el), text: (el.innerText || '').trim().slice(0, 300), html: el.outerHTML.slice(0, 1500), rect: { x: Math.max(0, Math.round(r.left)), y: Math.max(0, Math.round(r.top)), width: Math.max(1, Math.round(Math.min(r.width, innerWidth))), height: Math.max(1, Math.round(Math.min(r.height, innerHeight))) } }); };
  const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
  addEventListener('mousemove', move, true);
  addEventListener('click', click, true);
  addEventListener('keydown', key, true);
})`;

async function pickElement() {
  const v = preview.view;
  if (!v || !preview.url) return toast('Open a page in the preview first.');
  if (preview.picking) return;
  preview.picking = true;
  $('#preview-pick').classList.add('on');
  try {
    v.focus();
    const el = await v.executeJavaScript(PICKER, true);
    if (!el) return;
    state.chips.push({
      kind: 'element',
      label: el.name,
      context: `Element on ${preview.url} (\`${el.selector}\`)${el.text ? `, showing "${el.text.slice(0, 120)}"` : ''}:\n\`\`\`html\n${el.html}\n\`\`\``,
    });
    await captureToChat(el.rect);
    renderChips();
    const input = $('#input');
    input.focus();
    if (!input.value) input.placeholder = `What should change about ${el.name}?`;
  } catch (e) {
    toast(`Couldn't pick an element: ${e.message || e}`);
  } finally {
    preview.picking = false;
    $('#preview-pick').classList.remove('on');
  }
}

function wirePreview() {
  const url = $('#preview-url');
  url.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') navigatePreview(url.value), url.blur();
    if (e.key === 'Escape') (url.value = preview.url), url.blur();
  });
  $('#preview-back').addEventListener('click', () => preview.view?.canGoBack() && preview.view.goBack());
  $('#preview-fwd').addEventListener('click', () => preview.view?.canGoForward() && preview.view.goForward());
  $('#preview-reload').addEventListener('click', () => preview.url && preview.view?.reload());
  $('#preview-pick').addEventListener('click', pickElement);
  $('#preview-shot').addEventListener('click', screenshotPreview);
  $('#preview-errors').addEventListener('click', fixPreviewErrors);
  $('#preview-external').addEventListener('click', () => preview.url && desk.preview.openExternal(preview.url));
  $('#btn-term-preview').addEventListener('click', (e) => openPreview(e.currentTarget.dataset.url));
}
