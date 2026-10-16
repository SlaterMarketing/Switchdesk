/* global $, h, state, desk, toast, activeTab, activateTab, renderTabs, renderChips, send, toggleTerminal, newTerminal */
'use strict';

// ------------------------------------------------------------------ preview pane
//
// Your running site in a tab next to the code. Page errors can go straight to Claude, and
// "Pick element" lets you click part of the page to attach it (with a screenshot) to the chat.

const LOCAL_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}(?:\/[^\s'"`)\]]*)?/;
const preview = { url: '', errors: [], seen: [], logs: [], view: null, picking: false };

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
  // A new webview can't load or run anything until its first page is up.
  v.ready = new Promise((resolve) => v.addEventListener('dom-ready', resolve, { once: true }));
  $('#preview-frame').append(v);
  v.addEventListener('console-message', (e) => {
    if (/Electron Security Warning/.test(e.message)) return; // Electron's own note, not the page's
    if (preview.logs.length >= 300) preview.logs.shift();
    preview.logs.push(`[${['debug', 'log', 'warn', 'error'][e.level] || 'log'}] ${e.message}${e.level === 3 && e.sourceId ? ` (${e.sourceId}:${e.line})` : ''}`);
    if (e.level === 3) addPreviewError(`${e.message}${e.sourceId ? `\n    at ${e.sourceId}:${e.line}` : ''}`);
  });
  v.addEventListener('did-fail-load', (e) => {
    if (e.isMainFrame && e.errorCode !== -3) addPreviewError(`Couldn't load ${e.validatedURL}: ${e.errorDescription || e.errorCode}`);
  });
  v.addEventListener('did-start-navigation', (e) => {
    if (e.isMainFrame && !e.isSameDocument) {
      preview.errors = [];
      preview.logs = [];
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
  const v = ensureWebview();
  v.ready.then(() => v.loadURL(url)).catch(() => {});
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
    if (state.fileSet.has('index.html') && !state.folder.remote) return navigatePreview(`file://${state.folder.root.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:')}/index.html`);
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
  if (preview.view) preview.view.ready.then(() => preview.view.loadURL('about:blank')).catch(() => {});
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

// ---------- the agent's Preview tools (src/preview-mcp.js)
//
// An agent can open a page in the Preview, look at it, click, type and read the console. The tab
// comes to the front while it does, so you see what it sees.

// Run in the page (as source, via executeJavaScript): finds an element by selector or visible text,
// scrolls to it and keeps it for the next step.
function findInPage(sel, txt) {
  txt = (txt || '').trim().toLowerCase();
  let el = null;
  if (sel) {
    try {
      el = document.querySelector(sel);
    } catch {
      return { error: 'Not a valid CSS selector: ' + sel };
    }
  }
  if (!el && txt) {
    const all = [...document.querySelectorAll('button, a, [role=button], input[type=submit], input[type=button], label, summary, [onclick]')];
    el = all.find((x) => (x.innerText || x.value || '').trim().toLowerCase() === txt) || all.find((x) => (x.innerText || x.value || x.getAttribute('aria-label') || '').toLowerCase().includes(txt));
  }
  if (!el) return { error: 'Nothing on the page matches ' + (sel || '"' + txt + '"') + '. Use preview_page to see what is there.' };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  window.__sdTarget = el;
  return { ok: true, name: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') };
}

// Run in the page: its text, and its controls with a selector for each.
function pageInPage() {
  const sel = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    const n = el.getAttribute('name');
    if (n) return el.tagName.toLowerCase() + '[name="' + n + '"]';
    const parts = [];
    while (el && el.nodeType === 1 && parts.length < 4) {
      let p = el.tagName.toLowerCase();
      const sib = el.parentElement ? [...el.parentElement.children].filter((c) => c.tagName === el.tagName) : [];
      if (sib.length > 1) p += ':nth-of-type(' + (sib.indexOf(el) + 1) + ')';
      parts.unshift(p);
      if (el.id) break;
      el = el.parentElement;
    }
    return parts.join(' > ');
  };
  const seen = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };
  const controls = [...document.querySelectorAll('a[href], button, input, textarea, select, [role=button]')]
    .filter(seen)
    .slice(0, 80)
    .map((el) => {
      const label = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || el.getAttribute('href') || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      return '- ' + el.tagName.toLowerCase() + (el.tagName === 'INPUT' ? '[' + el.type + ']' : '') + ' "' + label + '" -> ' + sel(el);
    });
  const text = (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n').slice(0, 8000);
  return `URL: ${location.href}\nTitle: ${document.title}\n\nText on the page:\n${text}\n\nButtons, links and fields:\n${controls.join('\n') || '(none)'}`;
}

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

async function showPreviewForAgent() {
  const v = ensureWebview();
  if (activeTab()?.kind !== 'preview') activateTab(previewTab().id);
  renderPreviewEmpty();
  await Promise.race([v.ready, settle(10000)]);
  return v;
}

async function runPreviewTool(name, args) {
  const v = await showPreviewForAgent();
  const needPage = () => (preview.url ? null : { error: 'Nothing is open in the Preview yet. Call preview_open with the address of the running app (start its dev server first if needed).' });
  if (name === 'preview_open') {
    const url = args.url ? normaliseUrl(args.url) : preview.url;
    if (!url) return { error: preview.seen.length ? `Give a url. The terminal has shown: ${[...new Set(preview.seen)].join(', ')}` : 'Give the url of the running app, for example http://localhost:5173.' };
    setPreviewUrl(url);
    await Promise.race([v.loadURL(url).catch((e) => e), settle(15000)]);
    await settle();
    return { text: `Opened ${v.getURL()} ("${v.getTitle()}").${preview.errors.length ? `\n\nConsole errors so far:\n${preview.errors.join('\n')}` : ''}` };
  }
  if (needPage()) return needPage();
  if (name === 'preview_screenshot') {
    await settle(150);
    const image = await desk.preview.capture(v.getWebContentsId(), null);
    return image ? { image, text: `Screenshot of ${v.getURL()}` } : { error: "Couldn't take a screenshot of the Preview." };
  }
  if (name === 'preview_page') return { text: await v.executeJavaScript(`(${pageInPage})()`) };
  if (name === 'preview_console') return { text: preview.logs.length ? preview.logs.slice(-150).join('\n') : 'The console is empty since the page loaded.' };
  if (name === 'preview_eval') {
    const out = await v.executeJavaScript(`(async () => { try { const r = await (0, eval)(${JSON.stringify(String(args.expression || ''))}); return { ok: true, value: JSON.stringify(r === undefined ? null : r, null, 1) }; } catch (e) { return { error: String(e && e.stack || e) }; } })()`);
    return out.error ? { error: out.error } : { text: String(out.value).slice(0, 20000) };
  }
  if (name === 'preview_click' || name === 'preview_type') {
    const found = await v.executeJavaScript(`(${findInPage})(${JSON.stringify(args.selector || '')}, ${JSON.stringify(name === 'preview_click' ? args.text || '' : '')})`);
    if (found.error) return found;
    if (name === 'preview_click') {
      // A real click at the element's centre, so the page's own handlers run as they would for you.
      const r = await v.executeJavaScript(`(() => { const b = window.__sdTarget.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
      for (const type of ['mouseDown', 'mouseUp']) v.sendInputEvent({ type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
      await settle(600);
      return { text: `Clicked ${found.name}. The page is now ${v.getURL()}.${preview.errors.length ? `\n\nConsole errors:\n${preview.errors.slice(-5).join('\n')}` : ''}` };
    }
    await v.executeJavaScript(`(() => { const el = window.__sdTarget; el.focus(); if ('value' in el) { el.select && el.select(); } return true; })()`);
    v.focus();
    v.insertText(String(args.text || ''));
    if (args.submit) for (const type of ['keyDown', 'char', 'keyUp']) v.sendInputEvent({ type, keyCode: type === 'char' ? '\r' : 'Enter' });
    await settle(args.submit ? 800 : 200);
    return { text: `Typed into ${found.name}${args.submit ? ' and pressed Enter' : ''}.` };
  }
  return { error: `Unknown tool ${name}` };
}

function wirePreviewTools() {
  desk.previewTools.onCall(async ({ id, name, args }) => {
    let out;
    try {
      out = await runPreviewTool(name, args || {});
    } catch (err) {
      out = { error: String(err.message || err) };
    }
    desk.previewTools.answer(id, out);
  });
}

function wirePreview() {
  wirePreviewTools();
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
