// theme.js — Named terminal palettes. All UI code reads through the live
// proxy T; switching themes takes effect on the next frame render.
export const THEMES = {
  dark: {
    name: "dark",
    BG: 0x12151a, BG2: 0x161a20, PANEL: 0x1c2128, STATUSBG: 0x1f242b, CARD: 0x181d24,
    USERBG: 0x22262e, THINKBG: 0x181b20, TOOLBG: 0x1e1e2e, TOOLOK: 0x1e2e1e, TOOLERR: 0x2e1e1e,
    BORDER: 0x2a323c, BORDER2: 0x3a424c,
    TXT: 0xd4d8dd, DIM: 0x8b939e, FAINT: 0x5c6670, BOLD: 0xffffff,
    ACCENT: 0x67b7ff, ACCENT2: 0x4d9fff, HEADING: 0x7cc7ff,
    LINK: 0x67b7ff, CODE: 0x9ce5ed, CODEBG: 0x1c2128,
    OK: 0x7dde86, WARN: 0xf5c96b, ERR: 0xff7a7a,
    PURPLE: 0x9f86ff, RED: 0xff8a8a, GREEN: 0x8adf95, PINK: 0xffb3b3, GREENG: 0xb3e6b8,
    KEYWORD: 0xc792ea, STRING: 0x98c379, NUMBER: 0xd19a66,
    TABLEHEAD: 0xf2f4f6, TABLESEP: 0x3a424c, QUOTE: 0x8b949e, QUOTEFG: 0xc7ccd1,
    SELBG: 0x3a4a5c, SELFG: 0xffffff, CURSORBG: 0x3a4a5c, CURSORFG: 0xffffff,
    MENUBG: 0x1c2128, MENUSEL: 0x3a4a5c, SCROLLTHUMB: 0x67b7ff, SCROLLTRACK: 0x2a323c,
  },
  light: {
    name: "light",
    BG: 0xf6f6f6, BG2: 0xf0f0f0, PANEL: 0xffffff, STATUSBG: 0xe8e8e8, CARD: 0xffffff,
    USERBG: 0xececec, THINKBG: 0xf2f2f2, TOOLBG: 0xe9edf7, TOOLOK: 0xe9f4e9, TOOLERR: 0xf7e9e9,
    BORDER: 0xd4d4d4, BORDER2: 0xc0c0c0,
    TXT: 0x2a2a2a, DIM: 0x666666, FAINT: 0x999999, BOLD: 0x000000,
    ACCENT: 0x0a5fd7, ACCENT2: 0x0a5fd7, HEADING: 0x0a5fd7,
    LINK: 0x0a5fd7, CODE: 0x9a2b6e, CODEBG: 0xf0f0f0,
    OK: 0x1f8a3d, WARN: 0xa86a00, ERR: 0xd02222,
    PURPLE: 0x6a3fd0, RED: 0xd02222, GREEN: 0x1f8a3d, PINK: 0xc05060, GREENG: 0x2a8a4a,
    KEYWORD: 0x7c2fc0, STRING: 0x1f6f3d, NUMBER: 0xa05a00,
    TABLEHEAD: 0x111111, TABLESEP: 0xc0c0c0, QUOTE: 0x777777, QUOTEFG: 0x444444,
    SELBG: 0xcfe4ff, SELFG: 0x000000, CURSORBG: 0xcfe4ff, CURSORFG: 0x000000,
    MENUBG: 0xffffff, MENUSEL: 0xcfe4ff, SCROLLTHUMB: 0x0a5fd7, SCROLLTRACK: 0xd4d4d4,
  },
  gruvbox: {
    name: "gruvbox",
    BG: 0x282828, BG2: 0x242424, PANEL: 0x32302f, STATUSBG: 0x32302f, CARD: 0x32302f,
    USERBG: 0x3c3836, THINKBG: 0x2e2b28, TOOLBG: 0x2f3a3c, TOOLOK: 0x333c33, TOOLERR: 0x3c3232,
    BORDER: 0x504945, BORDER2: 0x665c54,
    TXT: 0xebdbb2, DIM: 0xa89984, FAINT: 0x7c6f64, BOLD: 0xfbf1c7,
    ACCENT: 0x83a598, ACCENT2: 0x8ec07c, HEADING: 0x8ec07c,
    LINK: 0x83a598, CODE: 0x8ec07c, CODEBG: 0x3c3836,
    OK: 0xb8bb26, WARN: 0xfabd2f, ERR: 0xfb4934,
    PURPLE: 0xd3869b, RED: 0xfb4934, GREEN: 0xb8bb26, PINK: 0xd3869b, GREENG: 0xb8bb26,
    KEYWORD: 0xd3869b, STRING: 0xb8bb26, NUMBER: 0xd65d0e,
    TABLEHEAD: 0xfbf1c7, TABLESEP: 0x665c54, QUOTE: 0xa89984, QUOTEFG: 0xebdbb2,
    SELBG: 0x504945, SELFG: 0xfbf1c7, CURSORBG: 0x665c54, CURSORFG: 0xfbf1c7,
    MENUBG: 0x32302f, MENUSEL: 0x504945, SCROLLTHUMB: 0x83a598, SCROLLTRACK: 0x504945,
  },
};

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

function themeFile() {
  const base = process.env.DSH_HOME ?? (process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? ".", ".config"));
  return join(base, "tui-theme.txt");
}

let current = "gruvbox";
const ORDER = ["dark", "light", "gruvbox"];

try {
  const saved = readFileSync(themeFile(), "utf8").trim();
  if (THEMES[saved]) current = saved;
} catch { /* first run */ }

/** Live theme accessor: T.ACCENT etc. reads the active palette. */
export const T = new Proxy({}, {
  get(_t, key) { return THEMES[current][key]; },
});

function persist() {
  try {
    mkdirSync(dirname(themeFile()), { recursive: true });
    writeFileSync(themeFile(), current + "\n");
  } catch {}
}

export function setTheme(name) {
  if (THEMES[name]) { current = name; persist(); return true; }
  return false;
}

export function cycleTheme() {
  current = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];
  persist();
  return current;
}

export function themeName() { return current; }
