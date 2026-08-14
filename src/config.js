// config.js — TUI-local config (display name/prefix etc.), persisted as JSON
// next to the theme file: $DSH_HOME/tui-config.json (or XDG config dir).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { userInfo } from "node:os";

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
export function foldDefaults() {
  const fd = loadTuiConfig().foldDefaults ?? {};
  return {
    think: fd.think !== false,      // think blocks default expanded
    bash: fd.bash === true,         // tool blocks default collapsed
    todos: fd.todos !== false,      // todo list default visible
  };
}
