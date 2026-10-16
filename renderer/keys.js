/* global h, state, desk, toast, isMac, paletteCommands, commandPalette, setMode, MODES */
'use strict';

// ------------------------------------------------------------------ keyboard shortcuts
//
// Settings → Keyboard changes the shortcut for any command in the command palette, or removes it.
// Shortcuts are written like "Ctrl+Shift+K" ("Cmd" on a Mac). The app menu takes the new ones too;
// everything else is caught here before the editor sees the key.

// Commands the app menu runs: the menu's own accelerator changes with them (main.js).
const MENU_COMMANDS = new Set(['New Window', 'Open Folder…', 'Save', 'Close Tab', 'Command Palette', 'Go to File…', 'Search in Files', 'New Chat', 'New Chat in Its Own Copy', 'Add Selection to Chat', 'Edit Selection with the Agent', 'Cycle Mode', 'Toggle Sidebar', 'Toggle Terminal', 'Split Editor', 'Show Source Control', 'Preview', 'Settings']);

// "⌘⇧N" (the palette's notation) → "Ctrl+Shift+N", or "Cmd+Shift+N" on a Mac.
function shortcutFromSymbols(sym) {
  if (!sym) return '';
  const mods = [];
  let rest = sym;
  const take = (ch, name) => rest.includes(ch) && (mods.push(name), (rest = rest.replace(ch, '')));
  take('⌘', isMac ? 'Cmd' : 'Ctrl');
  take('⌥', 'Alt');
  take('⇧', 'Shift');
  if (/^[A-Z0-9]$|^F\d+$|^[`\\,./]$/i.test(rest)) return [...mods, rest.toUpperCase()].join('+');
  return [...mods, rest].join('+');
}

// A key press as a shortcut string, or null for a lone modifier.
function shortcutOf(e) {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  const mods = [];
  if (e.ctrlKey) mods.push(isMac ? 'Ctrl' : 'Ctrl');
  if (e.metaKey) mods.push(isMac ? 'Cmd' : 'Meta');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  let key = e.code && /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : e.code && /^Digit\d$/.test(e.code) ? e.code.slice(5) : e.key;
  const named = { Backquote: '`', Backslash: '\\', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=' };
  if (named[e.code]) key = named[e.code];
  if (key === ' ') key = 'Space';
  if (key.length === 1) key = key.toUpperCase();
  return [...mods, key].join('+');
}

// Puts the modifiers in one order so "Shift+Ctrl+K" and "Ctrl+Shift+K" match.
function normShortcut(s) {
  if (!s) return '';
  const parts = s.split('+').filter(Boolean);
  const order = ['Ctrl', 'Cmd', 'Meta', 'Alt', 'Shift'];
  const mods = order.filter((m) => parts.slice(0, -1).some((p) => p.toLowerCase() === m.toLowerCase()));
  const key = parts[parts.length - 1] || '';
  return [...mods, key.length === 1 ? key.toUpperCase() : key].join('+');
}

const bindings = () => state.settings.keybindings || {};
function shortcutFor(label, defaultSym) {
  const b = bindings();
  return label in b ? b[label] : shortcutFromSymbols(defaultSym);
}

// The palette's commands that can have a shortcut (not the per-folder and per-agent ones).
function bindableCommands() {
  return [['Command Palette', '⌘⇧P', () => commandPalette()], ['Cycle Mode', '⌘.', () => setMode(MODES[(MODES.indexOf(state.mode) + 1) % MODES.length])], ...paletteCommands().filter(([label]) => !/^(Agent|Open Recent)/.test(label))];
}

// Before anything else sees the key: a custom shortcut runs its command, and the old shortcut of a
// command you've moved stops doing it.
addEventListener(
  'keydown',
  (e) => {
    const b = bindings();
    if (!Object.keys(b).length || document.querySelector('.key-recording')) return;
    const combo = normShortcut(shortcutOf(e) || '');
    if (!combo) return;
    const cmds = bindableCommands();
    const custom = cmds.find(([label]) => label in b && normShortcut(b[label]) === combo);
    if (custom) {
      if (MENU_COMMANDS.has(custom[0])) return; // the menu has it now
      e.preventDefault();
      e.stopImmediatePropagation(); // other shortcut handlers listen on the window too
      return custom[2]();
    }
    const moved = cmds.find(([label, sym]) => label in b && normShortcut(shortcutFromSymbols(sym)) === combo);
    if (moved) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  },
  true
);

async function saveBinding(label, value) {
  const keybindings = { ...bindings() };
  if (value === undefined) delete keybindings[label];
  else keybindings[label] = value;
  state.settings = await desk.setSettings({ keybindings });
}

async function settingsKeyboard(body) {
  const search = h('input', { type: 'text', placeholder: 'Search commands or shortcuts', spellcheck: 'false' });
  const list = h('div', { class: 'keys-list' });
  const render = () => {
    const q = search.value.trim().toLowerCase();
    const cmds = bindableCommands();
    const taken = new Map();
    for (const [label, sym] of cmds) {
      const s = normShortcut(shortcutFor(label, sym));
      if (s) taken.set(s, [...(taken.get(s) || []), label]);
    }
    list.replaceChildren(
      ...cmds
        .filter(([label, sym]) => !q || label.toLowerCase().includes(q) || shortcutFor(label, sym).toLowerCase().includes(q))
        .map(([label, sym]) => {
          const current = shortcutFor(label, sym);
          const changed = label in bindings();
          const clash = current && (taken.get(normShortcut(current)) || []).filter((x) => x !== label);
          const chip = h('button', { class: `key-chip${current ? '' : ' empty'}`, title: 'Click, then press the new shortcut. Backspace removes it, Esc cancels.' }, current || 'Add shortcut');
          chip.addEventListener('click', () => {
            chip.classList.add('key-recording');
            chip.textContent = 'Press keys…';
            const onKey = async (e) => {
              e.preventDefault();
              e.stopPropagation();
              if (e.key === 'Escape') return done();
              if (e.key === 'Backspace' || e.key === 'Delete') return done('');
              const combo = shortcutOf(e);
              if (!combo) return;
              if (!/^(F\d+)$/.test(combo.split('+').pop()) && !/(Ctrl|Cmd|Meta|Alt)\+/.test(combo)) return toast('Use Ctrl, Alt or Cmd with the key (F-keys work on their own).');
              done(normShortcut(combo));
            };
            const done = async (value) => {
              removeEventListener('keydown', onKey, true);
              chip.classList.remove('key-recording');
              if (value !== undefined) {
                await saveBinding(label, value === shortcutFromSymbols(sym) ? undefined : value);
              }
              render();
            };
            addEventListener('keydown', onKey, true);
          });
          return h(
            'div',
            { class: 'key-row' },
            h('span', { class: 'key-label' }, label),
            clash && clash.length ? h('span', { class: 'key-clash', title: `Also used by ${clash.join(', ')}` }, `also ${clash[0]}`) : null,
            h('span', { class: 'spacer' }),
            chip,
            changed ? h('button', { class: 'icon-btn', title: `Back to ${shortcutFromSymbols(sym) || 'no shortcut'}`, onclick: async () => (await saveBinding(label, undefined), render()) }, '↺') : null
          );
        })
    );
  };
  search.addEventListener('input', render);
  const resetAll = h('button', { class: 'btn small', onclick: async () => (confirm('Put every shortcut back to the default?') && (state.settings = await desk.setSettings({ keybindings: {} }), render())) }, 'Reset all');
  body.replaceChildren(
    h('h3', {}, 'Keyboard shortcuts'),
    h('p', { class: 'muted small' }, 'Click a shortcut, then press the keys you want. Backspace removes it, Esc cancels, ↺ puts one back. The defaults follow Cursor and VS Code.'),
    h('div', { class: 'row' }, search, resetAll),
    list
  );
  render();
  search.focus();
}
