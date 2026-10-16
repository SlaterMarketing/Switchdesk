/* global monaco, state, toast, send, activeTab */
'use strict';

// ------------------------------------------------------------------ ✨ Fix with the agent
//
// Any error or warning in the editor gets a lightbulb (Ctrl+.) with "Fix with the agent", which
// sends the problem and the code around it to the chat. The command palette has the same for every
// problem in the file.

function problemPrompt(rel, model, markers) {
  const lines = [...new Set(markers.map((m) => m.startLineNumber))];
  const first = Math.max(1, Math.min(...lines) - 6);
  const last = Math.min(model.getLineCount(), Math.max(...lines) + 6);
  const code = [];
  for (let i = first; i <= last; i++) code.push(`${String(i).padStart(4)}  ${model.getLineContent(i)}`);
  const list = markers.map((m) => `- Line ${m.startLineNumber}: ${m.message}${m.source ? ` (${m.source}${m.code ? ` ${m.code}` : ''})` : ''}`).join('\n');
  return `Fix ${markers.length > 1 ? 'these problems' : 'this problem'} in @${rel}:\n\n${list}\n\nThe code around ${lines.length > 1 ? 'them' : 'it'} (lines ${first}–${last}):\n\n\`\`\`\n${code.join('\n')}\n\`\`\`\n\nFix the cause, not just the symptom, and keep the change small.`;
}

function fixWithAgent(model, markers) {
  const t = state.tabs.find((x) => x.model === model);
  if (!t || !markers.length) return;
  // Ask and Plan mode can't change files, so a fix runs in Agent mode.
  const mode = ['ask', 'plan'].includes(state.mode) ? 'agent' : undefined;
  const head = markers[0];
  send(problemPrompt(t.rel, model, markers), mode, `✨ Fix ${markers.length > 1 ? `${markers.length} problems` : 'this problem'} in ${t.rel.split('/').pop()}:${head.startLineNumber}\n${head.message.split('\n')[0].slice(0, 160)}`);
}

// Command palette: every error (or, if there are none, every warning) in the open file.
function fixFileProblems() {
  const t = activeTab();
  if (!t || t.kind !== 'file') return toast('Open a file first.');
  const all = monaco.editor.getModelMarkers({ resource: t.model.uri });
  const errors = all.filter((m) => m.severity === monaco.MarkerSeverity.Error);
  const pick = (errors.length ? errors : all.filter((m) => m.severity === monaco.MarkerSeverity.Warning)).slice(0, 20);
  if (!pick.length) return toast(`No problems in ${t.rel.split('/').pop()}.`);
  fixWithAgent(t.model, pick);
}

function wireQuickFix() {
  monaco.editor.registerCommand('switchdesk.fixWithAgent', (_acc, uri, markers) => {
    const model = monaco.editor.getModel(uri);
    if (model) fixWithAgent(model, markers);
  });
  monaco.languages.registerCodeActionProvider('*', {
    provideCodeActions(model, _range, context) {
      const markers = (context.markers || []).filter((m) => m.severity >= monaco.MarkerSeverity.Warning && !/^conflict/.test(m.source || ''));
      if (!markers.length || !state.tabs.some((x) => x.model === model)) return { actions: [], dispose() {} };
      const action = (title, list) => ({ title, kind: 'quickfix', diagnostics: list, command: { id: 'switchdesk.fixWithAgent', title, arguments: [model.uri, list] } });
      const actions = [action(markers.length > 1 ? `✨ Fix ${markers.length} problems here with the agent` : '✨ Fix with the agent', markers)];
      const inFile = monaco.editor.getModelMarkers({ resource: model.uri }).filter((m) => m.severity === monaco.MarkerSeverity.Error);
      if (inFile.length > markers.length) actions.push(action(`✨ Fix all ${inFile.length} errors in this file with the agent`, inFile.slice(0, 20)));
      return { actions, dispose() {} };
    },
  });
}
