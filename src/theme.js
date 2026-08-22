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
  nord: {
    name: "nord",
    BG: 0x2e3440, BG2: 0x272c36, PANEL: 0x3b4252, STATUSBG: 0x3b4252, CARD: 0x3b4252,
    USERBG: 0x434c5e, THINKBG: 0x323845, TOOLBG: 0x363c4c, TOOLOK: 0x37493f, TOOLERR: 0x46363b,
    BORDER: 0x4c566a, BORDER2: 0x5c6a7f,
    TXT: 0xd8dee9, DIM: 0x8c97a9, FAINT: 0x6b7689, BOLD: 0xeceff4,
    ACCENT: 0x88c0d0, ACCENT2: 0x81a1c1, HEADING: 0x81a1c1,
    LINK: 0x88c0d0, CODE: 0x8fbcbb, CODEBG: 0x3b4252,
    OK: 0xa3be8c, WARN: 0xebcb8b, ERR: 0xbf616a,
    PURPLE: 0xb48ead, RED: 0xbf616a, GREEN: 0xa3be8c, PINK: 0xd08770, GREENG: 0xa3be8c,
    KEYWORD: 0xb48ead, STRING: 0xa3be8c, NUMBER: 0xebcb8b,
    TABLEHEAD: 0xeceff4, TABLESEP: 0x4c566a, QUOTE: 0x7b88a1, QUOTEFG: 0xd8dee9,
    SELBG: 0x4c566a, SELFG: 0xeceff4, CURSORBG: 0x4c566a, CURSORFG: 0xeceff4,
    MENUBG: 0x3b4252, MENUSEL: 0x4c566a, SCROLLTHUMB: 0x88c0d0, SCROLLTRACK: 0x4c566a,
  },
  "solarized-dark": {
    name: "solarized-dark",
    BG: 0x002b36, BG2: 0x073642, PANEL: 0x073642, STATUSBG: 0x073642, CARD: 0x073642,
    USERBG: 0x0e4550, THINKBG: 0x0a3540, TOOLBG: 0x0c3a44, TOOLOK: 0x103b2f, TOOLERR: 0x3b2525,
    BORDER: 0x40575e, BORDER2: 0x586e75,
    TXT: 0x93a1a1, DIM: 0x586e75, FAINT: 0x40575e, BOLD: 0xeee8d5,
    ACCENT: 0x268bd2, ACCENT2: 0x2aa198, HEADING: 0x6c71c4,
    LINK: 0x268bd2, CODE: 0x2aa198, CODEBG: 0x073642,
    OK: 0x859900, WARN: 0xb58900, ERR: 0xdc322f,
    PURPLE: 0x6c71c4, RED: 0xdc322f, GREEN: 0x859900, PINK: 0xd33682, GREENG: 0x859900,
    KEYWORD: 0x6c71c4, STRING: 0x2aa198, NUMBER: 0xcb4b16,
    TABLEHEAD: 0x93a1a1, TABLESEP: 0x586e75, QUOTE: 0x586e75, QUOTEFG: 0x93a1a1,
    SELBG: 0x0e4752, SELFG: 0xeee8d5, CURSORBG: 0x073642, CURSORFG: 0x93a1a1,
    MENUBG: 0x073642, MENUSEL: 0x0e4752, SCROLLTHUMB: 0x268bd2, SCROLLTRACK: 0x40575e,
  },
  "solarized-light": {
    name: "solarized-light",
    BG: 0xfdf6e3, BG2: 0xeee8d5, PANEL: 0xeee8d5, STATUSBG: 0xeee8d5, CARD: 0xeee8d5,
    USERBG: 0xe8e0cc, THINKBG: 0xf2ecda, TOOLBG: 0xe8e4d4, TOOLOK: 0xe3ebda, TOOLERR: 0xf2e0dd,
    BORDER: 0xd5cfc3, BORDER2: 0xbeb9ab,
    TXT: 0x586e75, DIM: 0x839496, FAINT: 0x93a1a1, BOLD: 0x073642,
    ACCENT: 0x268bd2, ACCENT2: 0x2aa198, HEADING: 0x6c71c4,
    LINK: 0x268bd2, CODE: 0x2aa198, CODEBG: 0xeee8d5,
    OK: 0x859900, WARN: 0xb58900, ERR: 0xdc322f,
    PURPLE: 0x6c71c4, RED: 0xdc322f, GREEN: 0x859900, PINK: 0xd33682, GREENG: 0x859900,
    KEYWORD: 0x6c71c4, STRING: 0x2aa198, NUMBER: 0xcb4b16,
    TABLEHEAD: 0x073642, TABLESEP: 0xbeb9ab, QUOTE: 0x839496, QUOTEFG: 0x586e75,
    SELBG: 0xc9e1e7, SELFG: 0x073642, CURSORBG: 0xd3e4ea, CURSORFG: 0x073642,
    MENUBG: 0xeee8d5, MENUSEL: 0xc9e1e7, SCROLLTHUMB: 0x268bd2, SCROLLTRACK: 0xd5cfc3,
  },
  dracula: {
    name: "dracula",
    BG: 0x282a36, BG2: 0x21222c, PANEL: 0x282a36, STATUSBG: 0x21222c, CARD: 0x282a36,
    USERBG: 0x313340, THINKBG: 0x262732, TOOLBG: 0x2c2e3d, TOOLOK: 0x2e3b35, TOOLERR: 0x3b2e33,
    BORDER: 0x44475a, BORDER2: 0x6272a4,
    TXT: 0xf8f8f2, DIM: 0xa9b1c6, FAINT: 0x6272a4, BOLD: 0xffffff,
    ACCENT: 0xbd93f9, ACCENT2: 0xff79c6, HEADING: 0x8be9fd,
    LINK: 0x8be9fd, CODE: 0x8be9fd, CODEBG: 0x21222c,
    OK: 0x50fa7b, WARN: 0xffb86c, ERR: 0xff5555,
    PURPLE: 0xbd93f9, RED: 0xff5555, GREEN: 0x50fa7b, PINK: 0xff79c6, GREENG: 0x50fa7b,
    KEYWORD: 0xff79c6, STRING: 0xf1fa8c, NUMBER: 0xbd93f9,
    TABLEHEAD: 0xf8f8f2, TABLESEP: 0x44475a, QUOTE: 0x6272a4, QUOTEFG: 0xf8f8f2,
    SELBG: 0x44475a, SELFG: 0xffffff, CURSORBG: 0x44475a, CURSORFG: 0xffffff,
    MENUBG: 0x21222c, MENUSEL: 0x44475a, SCROLLTHUMB: 0xbd93f9, SCROLLTRACK: 0x44475a,
  },
  onedark: {
    name: "onedark",
    BG: 0x282c34, BG2: 0x21252b, PANEL: 0x282c34, STATUSBG: 0x21252b, CARD: 0x282c34,
    USERBG: 0x2c313a, THINKBG: 0x262b33, TOOLBG: 0x29303c, TOOLOK: 0x2e3b30, TOOLERR: 0x3b2e30,
    BORDER: 0x3b4048, BORDER2: 0x4b5263,
    TXT: 0xabb2bf, DIM: 0x7f848e, FAINT: 0x5c6370, BOLD: 0xffffff,
    ACCENT: 0x61afef, ACCENT2: 0x56b6c2, HEADING: 0xc678dd,
    LINK: 0x61afef, CODE: 0x56b6c2, CODEBG: 0x21252b,
    OK: 0x98c379, WARN: 0xe5c07b, ERR: 0xe06c75,
    PURPLE: 0xc678dd, RED: 0xe06c75, GREEN: 0x98c379, PINK: 0xe06c75, GREENG: 0x98c379,
    KEYWORD: 0xc678dd, STRING: 0x98c379, NUMBER: 0xd19a66,
    TABLEHEAD: 0xabb2bf, TABLESEP: 0x4b5263, QUOTE: 0x7f848e, QUOTEFG: 0xabb2bf,
    SELBG: 0x3e4451, SELFG: 0xffffff, CURSORBG: 0x3e4451, CURSORFG: 0xffffff,
    MENUBG: 0x21252b, MENUSEL: 0x3e4451, SCROLLTHUMB: 0x61afef, SCROLLTRACK: 0x3b4048,
  },
  "catppuccin-mocha": {
    name: "catppuccin-mocha",
    BG: 0x1e1e2e, BG2: 0x181825, PANEL: 0x1e1e2e, STATUSBG: 0x181825, CARD: 0x1e1e2e,
    USERBG: 0x26263a, THINKBG: 0x1d1d2c, TOOLBG: 0x252541, TOOLOK: 0x2a3b33, TOOLERR: 0x3b2a33,
    BORDER: 0x45475a, BORDER2: 0x585b70,
    TXT: 0xcdd6f4, DIM: 0xa6adc8, FAINT: 0x7f849c, BOLD: 0xf5e0dc,
    ACCENT: 0x89b4fa, ACCENT2: 0x89dceb, HEADING: 0xcba6f7,
    LINK: 0x89b4fa, CODE: 0x94e2d5, CODEBG: 0x181825,
    OK: 0xa6e3a1, WARN: 0xf9e2af, ERR: 0xf38ba8,
    PURPLE: 0xcba6f7, RED: 0xf38ba8, GREEN: 0xa6e3a1, PINK: 0xf5c2e7, GREENG: 0xa6e3a1,
    KEYWORD: 0xcba6f7, STRING: 0xa6e3a1, NUMBER: 0xfab387,
    TABLEHEAD: 0xcdd6f4, TABLESEP: 0x585b70, QUOTE: 0x7f849c, QUOTEFG: 0xcdd6f4,
    SELBG: 0x45475a, SELFG: 0xffffff, CURSORBG: 0x45475a, CURSORFG: 0xffffff,
    MENUBG: 0x181825, MENUSEL: 0x45475a, SCROLLTHUMB: 0x89b4fa, SCROLLTRACK: 0x45475a,
  },
  tokyonight: {
    name: "tokyonight",
    BG: 0x1a1b26, BG2: 0x16161e, PANEL: 0x1a1b26, STATUSBG: 0x16161e, CARD: 0x1a1b26,
    USERBG: 0x1f2130, THINKBG: 0x191a24, TOOLBG: 0x202231, TOOLOK: 0x22312c, TOOLERR: 0x312224,
    BORDER: 0x303649, BORDER2: 0x3b4261,
    TXT: 0xc0caf5, DIM: 0x787c99, FAINT: 0x565f89, BOLD: 0xffffff,
    ACCENT: 0x7aa2f7, ACCENT2: 0x7dcfff, HEADING: 0xbb9af7,
    LINK: 0x7aa2f7, CODE: 0x73daca, CODEBG: 0x16161e,
    OK: 0x9ece6a, WARN: 0xe0af68, ERR: 0xf7768e,
    PURPLE: 0xbb9af7, RED: 0xf7768e, GREEN: 0x9ece6a, PINK: 0xf7768e, GREENG: 0x9ece6a,
    KEYWORD: 0xbb9af7, STRING: 0x9ece6a, NUMBER: 0xff9e64,
    TABLEHEAD: 0xc0caf5, TABLESEP: 0x3b4261, QUOTE: 0x787c99, QUOTEFG: 0xc0caf5,
    SELBG: 0x2a3045, SELFG: 0xffffff, CURSORBG: 0x2a3045, CURSORFG: 0xffffff,
    MENUBG: 0x16161e, MENUSEL: 0x2a3045, SCROLLTHUMB: 0x7aa2f7, SCROLLTRACK: 0x303649,
  },
  monokai: {
    name: "monokai",
    BG: 0x272822, BG2: 0x1f201b, PANEL: 0x1f201b, STATUSBG: 0x1f201b, CARD: 0x1f201b,
    USERBG: 0x2d2e24, THINKBG: 0x24251e, TOOLBG: 0x2b2c23, TOOLOK: 0x2c3123, TOOLERR: 0x322322,
    BORDER: 0x3e3d32, BORDER2: 0x55544a,
    TXT: 0xf8f8f2, DIM: 0xcfcfc2, FAINT: 0x8b8b7e, BOLD: 0xffffff,
    ACCENT: 0x66d9ef, ACCENT2: 0xa6e22e, HEADING: 0xa6e22e,
    LINK: 0x66d9ef, CODE: 0xa6e22e, CODEBG: 0x1f201b,
    OK: 0xa6e22e, WARN: 0xfd971f, ERR: 0xf92672,
    PURPLE: 0xae81ff, RED: 0xf92672, GREEN: 0xa6e22e, PINK: 0xf92672, GREENG: 0xa6e22e,
    KEYWORD: 0xf92672, STRING: 0xe6db74, NUMBER: 0xae81ff,
    TABLEHEAD: 0xf8f8f2, TABLESEP: 0x55544a, QUOTE: 0x8b8b7e, QUOTEFG: 0xcfcfc2,
    SELBG: 0x49483e, SELFG: 0xffffff, CURSORBG: 0x49483e, CURSORFG: 0xffffff,
    MENUBG: 0x1f201b, MENUSEL: 0x49483e, SCROLLTHUMB: 0x66d9ef, SCROLLTRACK: 0x3e3d32,
  },
};

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

function themeFile() {
  const base = process.env.DSH_HOME ?? (process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? ".", ".config"));
  return join(base, "tui-theme.txt");
}

let current = "gruvbox";
const ORDER = ["dark", "light", "gruvbox", "nord", "solarized-dark", "solarized-light", "dracula", "onedark", "catppuccin-mocha", "tokyonight", "monokai"];

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
