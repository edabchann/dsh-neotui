// keybindings.js — the single source of truth for editable shortcuts.
//
// Every function owns TWO slots: `key` (primary) and `key2` (alternate).
// User overrides live in tui-config.json under
//   keyBindings.<id> = { "mode": "normal"|"insert"|"all", "key": "...", "key2": "..." }
// and the dispatchers in views.js consult this registry instead of hardcoded
// key checks. A spec is either one press ("Ctrl+F"), or a two-press chord
// ("g g"). Modifier prefixes are Ctrl / Shift / Alt; named keys are
// Up/Down/Left/Right/Enter/Escape(Esc)/Tab/Backtab/PgUp/PgDn/Home/End/
// Insert/Delete/Space and F1–F12; anything else must be a single character.

export const KEYBINDING_MODES = ["normal", "insert", "all"];

export const DEFAULT_KEYBINDINGS = {
  think: { mode: "normal", key: "t", key2: "" },
  tools: { mode: "normal", key: "b", key2: "" },
  insert: { mode: "normal", key: "i", key2: "" },
  leaveInsert: { mode: "insert", key: "Esc", key2: "" },
  sessionFilter: { mode: "normal", key: "Ctrl+F", key2: "/" },
  newSession: { mode: "normal", key: "n", key2: "" },
  top: { mode: "normal", key: "g g", key2: "" },
  bottom: { mode: "normal", key: "G", key2: "" },
  prevQuestion: { mode: "normal", key: "[", key2: "" },
  nextQuestion: { mode: "normal", key: "]", key2: "" },
  expandInput: { mode: "insert", key: "Ctrl+L", key2: "" },
  copyInput: { mode: "insert", key: "Ctrl+Shift+C", key2: "" },
  panel: { mode: "all", key: "Ctrl+Space", key2: "F7" },
  model: { mode: "normal", key: "Ctrl+M", key2: "" },
  trajectory: { mode: "normal", key: "Ctrl+T", key2: "" },
  homeSwitch: { mode: "normal", key: "Ctrl+Left", key2: "Ctrl+Right" },
  permissionRotate: { mode: "normal", key: "F8", key2: "" },
  workspace: { mode: "normal", key: "Ctrl+W", key2: "" },
  settings: { mode: "normal", key: "Ctrl+S", key2: "" },
  subagent: { mode: "normal", key: "Ctrl+A", key2: "" },
  skills: { mode: "normal", key: "Ctrl+H", key2: "" },
  goal: { mode: "normal", key: "Ctrl+G", key2: "" },
  jobs: { mode: "normal", key: "Ctrl+J", key2: "" },
  queue: { mode: "normal", key: "Ctrl+N", key2: "" },
  busyEnter: { mode: "normal", key: "Ctrl+Y", key2: "" },
  attachments: { mode: "normal", key: "Ctrl+O", key2: "" },
  stepJump: { mode: "normal", key: "Ctrl+E", key2: "" },
  sidebar: { mode: "normal", key: "Ctrl+B", key2: "" },
  editConfig: { mode: "normal", key: "Ctrl+K", key2: "" },
  quit: { mode: "all", key: "Ctrl+Q", key2: "" },
};

/** App-level dispatch precedence: the first matching binding wins. */
export const KEYBINDING_ORDER = [
  "sessionFilter", "panel", "homeSwitch", "permissionRotate", "editConfig", "quit",
  "model", "trajectory", "workspace", "settings", "subagent", "skills", "goal",
  "jobs", "queue", "busyEnter", "attachments", "stepJump", "sidebar",
];

/** Transcript-level bindings evaluated inside ChatView.onKey. */
export const CHAT_BINDING_ORDER = ["think", "tools", "insert", "top", "bottom", "prevQuestion", "nextQuestion", "sessionFilter"];

/** Sidebar-level bindings evaluated inside SidebarTree.onKey. */
export const SIDEBAR_BINDING_ORDER = ["insert", "newSession"];

const NAMED_KEYS = {
  up: "up", down: "down", left: "left", right: "right", enter: "enter",
  escape: "escape", esc: "escape", tab: "tab", backtab: "backtab",
  pgup: "pgup", pgdn: "pgdn", home: "home", end: "end",
  insert: "insert", delete: "delete",
};

/** Parse one key press spec ("Ctrl+Shift+C", "F8", "g"). Null when malformed. */
function parseKeyPart(part) {
  if (typeof part !== "string") return null;
  const pieces = part.split("+");
  const base = pieces.pop() ?? "";
  if (!base) return null;
  const mods = { ctrl: false, shift: false, alt: false };
  for (const piece of pieces) {
    if (piece === "Ctrl") mods.ctrl = true;
    else if (piece === "Shift") mods.shift = true;
    else if (piece === "Alt") mods.alt = true;
    else return null;
  }
  const named = NAMED_KEYS[base.toLowerCase()];
  if (named) return { ...mods, named };
  if (base === " " || base.toLowerCase() === "space") return { ...mods, space: true };
  if (/^f\d{1,2}$/i.test(base)) return { ...mods, fkey: base.toLowerCase() };
  if (base.length === 1) {
    const lower = base.toLowerCase();
    // An uppercase letter implies Shift only for unmodified letters ("G"):
    // "Ctrl+F" denotes the Ctrl chord, not Ctrl+Shift+F.
    const wantsShift = base !== lower && !mods.ctrl && !mods.alt;
    return { ...mods, shift: mods.shift || wantsShift, char: lower };
  }
  return null;
}

/** Split a full spec into its presses ("g g" → ["g", "g"]). */
export function specParts(spec) {
  return String(spec ?? "").split(/\s+/).filter(Boolean);
}

/** Whether one key event satisfies one press spec. */
export function matchKeyPart(ev, part) {
  if (!ev || ev.type !== "key") return false;
  const parsed = parseKeyPart(part);
  if (!parsed) return false;
  const ctrl = ev.ctrl === true, shift = ev.shift === true, alt = ev.alt === true;
  if (ctrl !== parsed.ctrl || alt !== parsed.alt) return false;
  if (parsed.space) return ev.name === "char" && ev.key === " " && shift === parsed.shift;
  if (parsed.named) return ev.name === parsed.named && shift === parsed.shift;
  if (parsed.fkey) return ev.name === parsed.fkey && shift === parsed.shift;
  return ev.name === "char" && ev.key === parsed.char && shift === parsed.shift;
}

/**
 * Match an event against one binding's two slots. Returns
 * { kind:"full", slot } | { kind:"pending", slot, part } | null.
 * `pending` carries an in-progress two-press chord across events.
 */
export function matchKeyBinding(ev, spec, pending = null) {
  if (!spec) return null;
  for (const slot of ["key", "key2"]) {
    const parts = specParts(spec[slot]);
    if (parts.length === 0) continue;
    if (pending && pending.slot === slot) {
      const part = parts[pending.part];
      if (!part || !matchKeyPart(ev, part)) continue;
      return pending.part + 1 >= parts.length ? { kind: "full", slot } : { kind: "pending", slot, part: pending.part + 1 };
    }
    if (parts.length === 1 && matchKeyPart(ev, parts[0])) return { kind: "full", slot };
    if (parts.length === 2 && matchKeyPart(ev, parts[0])) return { kind: "pending", slot, part: 1 };
  }
  return null;
}

/** First matching binding across an ordered id list. `editing` = INSERT mode. */
export function bindingMatchFor(ev, bindings, editing, order = KEYBINDING_ORDER) {
  for (const id of order) {
    const spec = bindings?.[id];
    if (!spec) continue;
    if (spec.mode === "normal" && editing) continue;
    if (spec.mode === "insert" && !editing) continue;
    const hit = matchKeyBinding(ev, spec);
    if (hit?.kind === "full") return { id, slot: hit.slot };
  }
  return null;
}

/** Human-readable spec ("Ctrl+Left", "g, g"); "—" when empty. */
export function describeSpec(spec) {
  const parts = specParts(spec);
  return parts.length ? parts.join(", ") : "—";
}

/** Validate a user-supplied key spec. */
export function validateKeySpec(spec) {
  const parts = specParts(spec);
  if (parts.length === 0 || parts.length > 2) {
    return { ok: false, reason: `需要 1–2 次按键（如 "Ctrl+F" 或 "g g"），得到 ${parts.length || 0} 次` };
  }
  for (const part of parts) {
    if (!parseKeyPart(part)) {
      return { ok: false, reason: `无法解析按键 "${part}"（支持 Ctrl/Shift/Alt 修饰、方向/功能键、单字符，如 Ctrl+Left、F8、g g）` };
    }
  }
  return { ok: true };
}

/** Normalize a raw user override into { mode, key, key2 } (backwards compatible). */
export function normalizeKeyBinding(value) {
  const mode = KEYBINDING_MODES.includes(value?.mode) ? value.mode : "normal";
  const key = typeof value?.key === "string" ? value.key.trim() : "";
  const key2 = typeof value?.key2 === "string" ? value.key2.trim() : "";
  return { mode, key, key2 };
}
