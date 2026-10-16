/* global $, h, state, desk, toast, monaco, editor, openFile, openSettings, runInTerminal, modelUri, languageFor */
'use strict';

// ------------------------------------------------------------------ code intelligence
//
// Go to definition (F12 or Ctrl+click), hover, completions, signature help, find references and
// errors, from the language servers installed on this computer (Settings → Code intelligence).

const intel = {
  models: new WeakSet(), // models a language server knows about
  shadow: new Set(), // URIs of models made only so peek/definition can show another file
  diags: new Map(), // rel -> LSP diagnostics
  servers: new Set(), // languages servers are running for
  timers: new WeakMap(),
  hinted: new Set(),
};

const INTEL_LANGS = ['typescript', 'javascript', 'python', 'go', 'rust', 'c', 'cpp'];
const relOfModel = (model) => (model.uri.scheme === 'file' ? model.uri.path.slice(1) : null);

async function intelOpen(model) {
  const rel = relOfModel(model);
  if (!rel || intel.shadow.has(model.uri.toString()) || !INTEL_LANGS.includes(model.getLanguageId())) return;
  const r = await desk.lsp.open(rel, model.getLanguageId(), model.getValue()).catch(() => null);
  if (!r || model.isDisposed()) return;
  if (r.missing) return hintMissingServer(r);
  if (r.error) {
    if (!intel.hinted.has('error:' + r.error)) toast(`The language server for this file didn't start: ${r.error}`);
    return intel.hinted.add('error:' + r.error);
  }
  intel.models.add(model);
  if (!intel.servers.has(r.server)) {
    intel.servers.add(r.server);
    if (r.server === 'typescript') quietBuiltInTypeScript();
  }
  model.onDidChangeContent(() => {
    clearTimeout(intel.timers.get(model));
    intel.timers.set(model, setTimeout(() => flushModel(model), 250));
  });
  applyDiagnostics(rel);
}

function flushModel(model) {
  if (!intel.timers.has(model) || model.isDisposed()) return;
  clearTimeout(intel.timers.get(model));
  intel.timers.delete(model);
  return desk.lsp.change(relOfModel(model), model.getValue());
}

function hintMissingServer(r) {
  if (intel.hinted.has(r.missing) || (state.settings.langHinted || []).includes(r.missing)) return;
  intel.hinted.add(r.missing);
  desk.setSettings({ langHinted: [...(state.settings.langHinted || []), r.missing] }).then((s) => (state.settings = s));
  toast(`For go to definition and errors in ${r.label} files, install its language server in Settings → Code intelligence.`);
}

// Monaco has its own TypeScript service, which only sees one file at a time. With the real
// language server running, turn its overlapping features off so results don't show twice.
function quietBuiltInTypeScript() {
  const ts = monaco.languages.typescript;
  if (!ts) return;
  const off = { completionItems: false, hovers: false, definitions: false, references: false, signatureHelp: false, diagnostics: false, documentHighlights: true, documentSymbols: true, rename: true, documentRangeFormattingEdits: true, onTypeFormattingEdits: true, codeActions: true, inlayHints: true };
  ts.typescriptDefaults.setModeConfiguration(off);
  ts.javascriptDefaults.setModeConfiguration(off);
}

// ---------- diagnostics

const SEVERITY = () => ({ 1: monaco.MarkerSeverity.Error, 2: monaco.MarkerSeverity.Warning, 3: monaco.MarkerSeverity.Info, 4: monaco.MarkerSeverity.Hint });

function applyDiagnostics(rel) {
  const model = monaco.editor.getModel(modelUri(rel));
  if (!model) return;
  const sev = SEVERITY();
  monaco.editor.setModelMarkers(
    model,
    'lsp',
    (intel.diags.get(rel) || []).map((d) => ({
      severity: sev[d.severity] || monaco.MarkerSeverity.Error,
      message: d.message,
      source: d.source,
      code: d.code != null ? String(typeof d.code === 'object' ? d.code.value : d.code) : undefined,
      startLineNumber: d.range.start.line + 1,
      startColumn: d.range.start.character + 1,
      endLineNumber: d.range.end.line + 1,
      endColumn: d.range.end.character + 1,
    }))
  );
}

function renderProblems() {
  let errors = 0;
  let warnings = 0;
  for (const list of intel.diags.values())
    for (const d of list) {
      if (!d.severity || d.severity === 1) errors++;
      else if (d.severity === 2) warnings++;
    }
  const el = $('#status-problems');
  el.classList.toggle('hidden', !errors && !warnings);
  el.replaceChildren(h('span', { class: errors ? 'err' : '' }, `⊗ ${errors}`), ' ', h('span', { class: warnings ? 'warn' : '' }, `⚠ ${warnings}`));
  el.title = `${errors} error${errors === 1 ? '' : 's'} and ${warnings} warning${warnings === 1 ? '' : 's'} in open files. Click to go to the next one.`;
}

// ---------- conversions between LSP and Monaco

const toRange = (r) => new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);
const toPos = (p) => ({ line: p.lineNumber - 1, character: p.column - 1 });

function markdownOf(c) {
  if (!c) return null;
  if (typeof c === 'string') return { value: c };
  if (c.kind) return { value: c.kind === 'markdown' ? c.value : '```\n' + c.value + '\n```' };
  if (c.language) return { value: '```' + c.language + '\n' + c.value + '\n```' };
  return null;
}

const LSP_KIND = ['', 'Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface', 'Module', 'Property', 'Unit', 'Value', 'Enum', 'Keyword', 'Snippet', 'Color', 'File', 'Reference', 'Folder', 'EnumMember', 'Constant', 'Struct', 'Event', 'Operator', 'TypeParameter'];

function toTextEdit(e) {
  return { range: toRange(e.range), text: e.newText };
}

async function ensureModel(rel) {
  const uri = modelUri(rel);
  if (monaco.editor.getModel(uri)) return true;
  const res = await desk.readFile(rel).catch(() => null);
  if (!res || res.binary || res.tooLarge || monaco.editor.getModel(uri)) return !!monaco.editor.getModel(uri);
  intel.shadow.add(uri.toString());
  monaco.editor.createModel(res.content, languageFor(rel), uri);
  return true;
}

async function placesToLocations(places) {
  const inside = places.filter((p) => p.rel != null);
  if (!inside.length && places.length) toast(`Defined in ${places[0].file}, outside the open folders.`);
  const out = [];
  for (const p of inside) if (await ensureModel(p.rel)) out.push({ uri: modelUri(p.rel), range: toRange(p.range) });
  return out;
}

async function ask(model, method, params) {
  if (!intel.models.has(model)) return null;
  await flushModel(model);
  return desk.lsp.request(relOfModel(model), method, params).catch(() => null);
}

// ---------- providers

function wireIntel() {
  for (const lang of INTEL_LANGS) {
    monaco.languages.registerHoverProvider(lang, {
      async provideHover(model, position) {
        const r = await ask(model, 'textDocument/hover', { position: toPos(position) });
        if (!r || !r.contents) return null;
        const contents = (Array.isArray(r.contents) ? r.contents : [r.contents]).map(markdownOf).filter((c) => c && c.value.trim());
        return contents.length ? { contents, range: r.range ? toRange(r.range) : undefined } : null;
      },
    });
    for (const [method, register] of [
      ['textDocument/definition', 'registerDefinitionProvider'],
      ['textDocument/typeDefinition', 'registerTypeDefinitionProvider'],
      ['textDocument/implementation', 'registerImplementationProvider'],
    ]) {
      const fn = method === 'textDocument/definition' ? 'provideDefinition' : method === 'textDocument/typeDefinition' ? 'provideTypeDefinition' : 'provideImplementation';
      monaco.languages[register](lang, {
        async [fn](model, position) {
          const places = await ask(model, method, { position: toPos(position) });
          return places ? placesToLocations(places) : null;
        },
      });
    }
    monaco.languages.registerReferenceProvider(lang, {
      async provideReferences(model, position, context) {
        const places = await ask(model, 'textDocument/references', { position: toPos(position), context: { includeDeclaration: !!context.includeDeclaration } });
        return places ? placesToLocations(places) : null;
      },
    });
    monaco.languages.registerCompletionItemProvider(lang, {
      triggerCharacters: ['.', ':', '<', '"', "'", '/', '@', '#', '>'],
      async provideCompletionItems(model, position, context) {
        const r = await ask(model, 'textDocument/completion', {
          position: toPos(position),
          context: context.triggerCharacter ? { triggerKind: 2, triggerCharacter: context.triggerCharacter } : { triggerKind: 1 },
        });
        if (!r) return null;
        const list = Array.isArray(r) ? r : r.items || [];
        const word = model.getWordUntilPosition(position);
        const fallback = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
        const K = monaco.languages.CompletionItemKind;
        return {
          incomplete: !!r.isIncomplete,
          suggestions: list.slice(0, 500).map((it) => {
            const edit = it.textEdit;
            const range = edit ? (edit.range ? toRange(edit.range) : { insert: toRange(edit.insert), replace: toRange(edit.replace) }) : fallback;
            return {
              label: it.labelDetails && it.labelDetails.description ? { label: it.label, description: it.labelDetails.description, detail: it.labelDetails.detail } : it.label,
              kind: K[LSP_KIND[it.kind] || 'Text'] ?? K.Text,
              detail: it.detail,
              documentation: markdownOf(it.documentation) || undefined,
              insertText: (edit && edit.newText) || it.insertText || it.label,
              insertTextRules: it.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
              range,
              sortText: it.sortText,
              filterText: it.filterText,
              preselect: it.preselect,
              tags: it.deprecated || (it.tags || []).includes(1) ? [monaco.languages.CompletionItemTag.Deprecated] : undefined,
              additionalTextEdits: (it.additionalTextEdits || []).map(toTextEdit),
            };
          }),
        };
      },
    });
    monaco.languages.registerSignatureHelpProvider(lang, {
      signatureHelpTriggerCharacters: ['(', ','],
      signatureHelpRetriggerCharacters: [')'],
      async provideSignatureHelp(model, position) {
        const r = await ask(model, 'textDocument/signatureHelp', { position: toPos(position) });
        if (!r || !r.signatures || !r.signatures.length) return null;
        return {
          value: {
            activeSignature: r.activeSignature || 0,
            activeParameter: r.activeParameter || 0,
            signatures: r.signatures.map((s) => ({
              label: s.label,
              documentation: markdownOf(s.documentation) || undefined,
              parameters: (s.parameters || []).map((p) => ({ label: p.label, documentation: markdownOf(p.documentation) || undefined })),
              activeParameter: s.activeParameter,
            })),
          },
          dispose() {},
        };
      },
    });
  }

  // Going to a definition in another file opens it in a tab.
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selection) {
      if (resource.scheme !== 'file') return false;
      const rel = resource.path.slice(1);
      openFile(rel).then(() => {
        if (!selection) return;
        const range = monaco.Range.isIRange(selection) ? selection : new monaco.Range(selection.lineNumber, selection.column, selection.lineNumber, selection.column);
        editor.setSelection(range);
        editor.revealRangeInCenterIfOutsideViewport(range);
        editor.focus();
      });
      return true;
    },
  });

  monaco.editor.onDidCreateModel((m) => intelOpen(m));
  monaco.editor.onWillDisposeModel((m) => {
    intel.shadow.delete(m.uri.toString());
    if (intel.models.has(m)) {
      intel.models.delete(m);
      clearTimeout(intel.timers.get(m));
      desk.lsp.close(relOfModel(m)).catch(() => {});
    }
  });
  desk.lsp.onDiagnostics(({ rel, diagnostics }) => {
    if (rel == null) return;
    if (diagnostics.length) intel.diags.set(rel, diagnostics);
    else intel.diags.delete(rel);
    applyDiagnostics(rel);
    renderProblems();
  });
  $('#status-problems').addEventListener('click', () => {
    editor.focus();
    editor.trigger('status', 'editor.action.marker.nextInFiles', null);
  });
}

// ------------------------------------------------------------------ Settings → Code intelligence

async function settingsIntel(body) {
  const rerender = () => settingsIntel(body);
  const list = await desk.lsp.status();
  const off = new Set(state.settings.langServersOff || []);
  const rows = list.map((s) => {
    const toggle = h('input', { type: 'checkbox', checked: !off.has(s.id) });
    toggle.addEventListener('change', async () => {
      const next = new Set(state.settings.langServersOff || []);
      if (toggle.checked) next.delete(s.id);
      else next.add(s.id);
      state.settings = await desk.setSettings({ langServersOff: [...next] });
      await desk.lsp.restart();
      toast(toggle.checked ? `${s.label} turned on. Reopen its files to start it.` : `${s.label} turned off.`);
    });
    return h(
      'div',
      { class: 'set-box' },
      h('div', { class: 'row' }, h('span', { class: `agent-dot ${s.bin ? (s.running ? 'ok' : 'warn') : 'bad'}` }), h('b', {}, s.label), h('span', { class: 'spacer' }), s.bin ? h('label', { class: 'row small' }, toggle, 'On') : null),
      h('div', { class: 'muted small' }, s.bin ? `${s.bin}${s.running ? ' · running' : ''}` : 'Not installed.'),
      s.bin
        ? null
        : h('div', { class: 'row' }, h('button', { class: 'btn small primary', onclick: () => runInTerminal(s.install) }, 'Install'), h('button', { class: 'btn small', onclick: rerender }, 'Check again'), h('code', { class: 'small' }, s.install))
    );
  });
  body.replaceChildren(
    h('h3', {}, 'Code intelligence'),
    h('p', { class: 'muted small' }, 'Go to definition (F12 or Ctrl+click), hover info, completions, find references (Shift+F12) and errors as you type come from the same language servers other editors use, installed on this computer. Each one starts the first time you open a file in its language.'),
    ...rows,
    h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: async () => (await desk.lsp.restart(), toast('Language servers restarted. They start again as you open files.')) }, 'Restart language servers'))
  );
}

