/* global $, h, state, monaco, editor, activeTab, activateTab, renderMarkdown, modal */
'use strict';

// ------------------------------------------------------------------ plans as documents
//
// When Claude proposes a plan, it opens in its own editor tab as a Markdown document you can edit
// freely, like Cursor. Build it sends your edited version; Keep planning sends feedback instead.

let planSeq = 0;

function planTitle(markdown) {
  const m = /^#{1,3}\s+(.+)$/m.exec(markdown);
  return (m ? m[1].replace(/[*_`]/g, '') : 'Plan').trim().slice(0, 40);
}

function attachPlanModel(t) {
  t.model = monaco.editor.createModel(t.plan.text, 'markdown');
  t.model.onDidChangeContent(() => {
    t.plan.text = t.model.getValue();
    if (t.plan.preview && activeTab() === t) renderPlanPreview(t);
  });
}

// Opens the plan in a tab. Returns handles the chat's plan card uses.
function openPlanDoc(markdown, { onBuild, onKeep }) {
  const t = { id: `plan:${++planSeq}`, kind: 'plan', rel: `Plan: ${planTitle(markdown)}`, plan: { text: markdown, state: '', preview: false, onBuild, onKeep } };
  attachPlanModel(t);
  state.tabs.push(t);
  activateTab(t.id);
  return {
    text: () => t.plan.text,
    open: () => {
      if (!state.tabs.includes(t)) {
        attachPlanModel(t);
        state.tabs.push(t);
      }
      activateTab(t.id);
    },
    resolve: (label) => {
      t.plan.state = label;
      if (activeTab() === t) renderPlanBar(t);
    },
  };
}

function renderPlanBar(t) {
  const bar = $('#plan-bar');
  const p = t.plan;
  const toggle = h('button', { class: 'btn small', title: p.preview ? 'Edit the Markdown' : 'See it formatted', onclick: () => ((p.preview = !p.preview), showPlan(t)) }, p.preview ? 'Edit' : 'Preview');
  bar.replaceChildren(
    ...[
      h('span', { class: 'plan-tag' }, 'Plan'),
      h('span', { class: 'muted small' }, p.state || 'Edit anything here, then build it.'),
      h('span', { class: 'spacer' }),
      toggle,
      p.state ? null : h('button', { class: 'btn small', onclick: () => keepPlanningPrompt(t) }, 'Keep planning'),
      p.state ? null : h('button', { class: 'btn small primary', onclick: () => p.onBuild() }, 'Build it'),
    ].filter(Boolean)
  );
}

function renderPlanPreview(t) {
  renderMarkdown($('#plan-preview'), t.plan.text);
}

// Called by activateTab for plan tabs (and with null to hide the plan UI).
function showPlan(t) {
  const on = !!(t && t.kind === 'plan');
  editor.updateOptions({ wordWrap: on ? 'on' : 'off' });
  $('#editor-host').classList.toggle('with-plan', on);
  $('#plan-bar').classList.toggle('hidden', !on);
  $('#plan-preview').classList.toggle('hidden', !on || !t.plan.preview);
  if (!on) return;
  renderPlanBar(t);
  if (t.plan.preview) renderPlanPreview(t);
  else editor.focus();
}

function keepPlanningPrompt(t) {
  const box = h('textarea', { class: 'plan-feedback', rows: 4, placeholder: 'What should change? Your edits to the plan are sent too.' });
  const send = h('button', { class: 'btn primary' }, 'Send back');
  const cancel = h('button', { class: 'btn' }, 'Cancel');
  const close = modal([h('div', { class: 'body' }, h('h3', {}, 'Keep planning'), box), h('div', { class: 'foot' }, cancel, send)]);
  cancel.addEventListener('click', close);
  send.addEventListener('click', () => {
    close();
    t.plan.onKeep(box.value.trim());
  });
  box.focus();
}
