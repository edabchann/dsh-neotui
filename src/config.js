// config.js — TUI-local config (display name/prefix etc.), persisted as JSON
// next to the theme file: $DSH_HOME/tui-config.json (or XDG config dir).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { userInfo } from "node:os";
import { DEFAULT_KEYBINDINGS, normalizeKeyBinding, validateKeySpec } from "./keybindings.js";

export { DEFAULT_KEYBINDINGS };

export function tuiConfigFile() {
  const base = process.env.DSH_HOME ?? (process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? ".", ".config"));
  return join(base, "tui-config.json");
}

let cache = { file: null, data: null, at: 0 };

/** Read the TUI config ({} when absent); cached for 1s per file path. */
export function loadTuiConfig() {
  const now = Date.now();
  const file = tuiConfigFile();
  if (cache.file === file && cache.data && now - cache.at < 1000) return cache.data;
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    data = {};
  }
  cache = { file, data, at: now };
  return data;
}

/** Merge a patch into the TUI config and write it back. Returns success. */
export function saveTuiConfig(patch) {
  const file = tuiConfigFile();
  const cfg = { ...loadTuiConfig(), ...patch };
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
    cache = { file, data: cfg, at: Date.now() };
    return true;
  } catch {
    return false;
  }
}

let OS_USERNAME = null;
function osUsername() {
  if (OS_USERNAME !== null) return OS_USERNAME;
  try { OS_USERNAME = userInfo().username; } catch { OS_USERNAME = ""; }
  return OS_USERNAME;
}

/** Effective display name: config → env → OS login → fallback. */
export function userName() {
  const cfg = loadTuiConfig();
  return cfg.userPrefix
    || process.env.DSH_TUI_USER_PREFIX
    || osUsername()
    || process.env.USER
    || process.env.LOGNAME
    || "user";
}

/** "edabchann > " style prefix for the user's own messages. */
export function userPrefix() {
  return `${userName()} > `;
}

/** Fold defaults (settings → 默认展开/折叠): think/tool blocks and the
 *  todo list, with the shipped defaults when nothing is configured. */
export function busyEnter() {
  return loadTuiConfig().busyEnter === "steer" ? "steer" : "queue";
}

/** Persist the newest 20 unique cross-session search queries (oldest→newest). */
export function searchHistory() {
  const raw = loadTuiConfig().searchHistory;
  if (!Array.isArray(raw)) return [];
  return raw.filter((query) => typeof query === "string" && query.trim()).map((query) => query.trim()).slice(-20);
}
export function rememberSearchQuery(query) {
  query = String(query ?? "").trim();
  if (!query) return false;
  const next = searchHistory().filter((item) => item !== query);
  next.push(query);
  return saveTuiConfig({ searchHistory: next.slice(-20) });
}

/** Pre-registry one-slot defaults that would silently kill the new two-slot
 *  bindings (e.g. an old sessionFilter "/" override removes Ctrl+F). */
const LEGACY_KEY_VALUES = {
  sessionFilter: { mode: "normal", key: "/" },
  homeSwitch: { mode: "normal", key: "Ctrl+Left/Right" },
  skills: { mode: "normal", key: "Ctrl+K" },
};

/** Effective two-slot keybindings: defaults merged per id with user overrides. */
export function keyBindings() {
  const overrides = loadTuiConfig().keyBindings ?? {};
  const merged = {};
  for (const id of Object.keys(DEFAULT_KEYBINDINGS)) {
    const def = DEFAULT_KEYBINDINGS[id];
    const raw = overrides[id];
    if (!raw) { merged[id] = { ...def }; continue; }
    const normalized = normalizeKeyBinding(raw);
    // A saved legacy default value maps back onto the current defaults so
    // remapped chords (Ctrl+F, Ctrl+Left/Right, Ctrl+H) keep working.
    const legacy = LEGACY_KEY_VALUES[id];
    if (legacy && !Object.hasOwn(raw, "key2") && normalized.mode === legacy.mode && normalized.key === legacy.key) {
      merged[id] = { ...def };
      continue;
    }
    if (!normalized.key || !validateKeySpec(normalized.key).ok) { merged[id] = { ...def }; continue; }
    const key2 = Object.hasOwn(raw, "key2")
      ? (normalized.key2 && validateKeySpec(normalized.key2).ok ? normalized.key2 : "")
      : def.key2;
    merged[id] = { mode: normalized.mode, key: normalized.key, key2 };
  }
  return merged;
}
export function setKeyBinding(id, value) {
  if (!Object.hasOwn(DEFAULT_KEYBINDINGS, id)) return false;
  const normalized = normalizeKeyBinding(value);
  if (!normalized.key || !validateKeySpec(normalized.key).ok) return false;
  if (normalized.key2 && !validateKeySpec(normalized.key2).ok) return false;
  const all = { ...(loadTuiConfig().keyBindings ?? {}) };
  all[id] = normalized;
  return saveTuiConfig({ keyBindings: all });
}
export function resetKeyBinding(id) { const all = { ...(loadTuiConfig().keyBindings ?? {}) }; delete all[id]; return saveTuiConfig({ keyBindings: all }); }

/** Drop the 1s read cache so an external editor's changes apply immediately. */
export function reloadTuiConfig() { cache = { file: null, data: null, at: 0 }; }

export function foldDefaults() {
  const fd = loadTuiConfig().foldDefaults ?? {};
  return {
    think: fd.think !== false,      // think blocks default expanded
    bash: fd.bash === true,         // tool blocks default collapsed
    todos: fd.todos !== false,      // todo list default visible
  };
}
