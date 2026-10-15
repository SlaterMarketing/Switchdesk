// Other agents (Codex, Kimi, Gemini, Qwen) speak their own protocols. Their sessions translate
// what happens into the same event shapes Claude Code's stream-json uses, so the chat panel,
// changes card and approvals work the same for every agent.

class ClaudeShape {
  constructor(emit) {
    this.emit = emit; // (ev) => void
    this.index = -1;
    this.open = null; // { kind: 'text' | 'thinking', key }
    this.msg = 0;
  }

  init(sessionId, model) {
    this.emit({ type: 'system', subtype: 'init', session_id: sessionId, model: model || '', slash_commands: [] });
  }

  stream(event) {
    this.emit({ type: 'stream_event', event });
  }

  // A new assistant "message" for the chat panel, started lazily.
  begin() {
    if (this.started) return;
    this.started = true;
    this.stream({ type: 'message_start', message: { id: `m-${Date.now()}-${++this.msg}` } });
  }

  close() {
    if (!this.open) return;
    this.stream({ type: 'content_block_stop', index: this.index });
    this.open = null;
  }

  block(kind, key) {
    if (this.open && this.open.kind === kind && this.open.key === key) return;
    this.close();
    this.begin();
    this.index++;
    this.open = { kind, key };
    this.stream({ type: 'content_block_start', index: this.index, content_block: kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' } });
  }

  text(delta, key = 'text') {
    if (!delta) return;
    this.block('text', key);
    this.stream({ type: 'content_block_delta', index: this.index, delta: { type: 'text_delta', text: delta } });
  }

  thinking(delta, key = 'thinking') {
    if (!delta) return;
    this.block('thinking', key);
    this.stream({ type: 'content_block_delta', index: this.index, delta: { type: 'thinking_delta', thinking: delta } });
  }

  // A tool call shown as a row. name uses Claude's tool names (Bash, Edit, Read...) where one fits.
  tool(id, name, input) {
    this.close();
    this.emit({ type: 'assistant', message: { id: `t-${id}`, content: [{ type: 'tool_use', id, name, input: input || {} }] } });
  }

  toolResult(id, text, { isError, diff } = {}) {
    const ev = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text || '', is_error: !!isError }] } };
    if (diff) ev.tool_use_result = { structuredPatch: [{ lines: diff.split('\n').filter((l) => !/^(\+\+\+|---) /.test(l)) }] };
    this.emit(ev);
  }

  usage({ input = 0, output = 0, model }) {
    this.emit({ type: 'assistant', message: { content: [], model, usage: { input_tokens: input, output_tokens: output } } });
  }

  // Plan-usage windows, shown in the status bar like Claude's 5-hour and weekly use.
  limits(shortPct, longPct) {
    const w = {};
    if (shortPct != null) w.five_hour = { utilization: shortPct / 100 };
    if (longPct != null) w.seven_day = { utilization: longPct / 100 };
    this.emit({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: w } });
  }

  notice(text) {
    this.emit({ type: 'system', subtype: 'notice', text });
  }

  // Ends the turn.
  result({ sessionId, error, started }) {
    this.close();
    this.started = false;
    this.emit({ type: 'result', session_id: sessionId, is_error: !!error, result: error || '', duration_ms: started ? Date.now() - started : undefined, num_turns: 1 });
  }
}

// "/bin/bash -lc 'npm test'" → "npm test", for showing commands the way you'd type them.
function plainCommand(cmd) {
  const m = /^\S*?(?:bash|zsh|sh|pwsh|powershell)(?:\.exe)?\s+(?:-\w+\s+)*-l?c\s+(['"])([\s\S]*)\1$/.exec(String(cmd || '').trim());
  return m ? m[2] : String(cmd || '');
}

// For agents with no way to be given extra folders: say where they are.
function dirsNote(dirs) {
  return `This workspace also includes these folders, outside the current directory. Read and change files in them with absolute paths when the task involves them:\n${dirs.map((d) => `- ${d}`).join('\n')}`;
}

module.exports = { dirsNote, ClaudeShape, plainCommand };
