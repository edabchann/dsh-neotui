import test from "node:test";
import assert from "node:assert/strict";
import { THEMES, setTheme, cycleTheme, themeName, T } from "../src/theme.js";

const SEMANTIC_KEYS = Object.keys(THEMES.dark).filter((k) => k !== "name").sort();

test("every theme defines the complete semantic key set", () => {
  assert.ok(SEMANTIC_KEYS.length >= 35, "palette carries the full semantic set");
  for (const [name, palette] of Object.entries(THEMES)) {
    const mine = Object.keys(palette).filter((k) => k !== "name").sort();
    assert.deepEqual(mine, SEMANTIC_KEYS, `${name} covers every semantic key`);
    for (const key of SEMANTIC_KEYS) {
      assert.equal(typeof palette[key], "number", `${name}.${key} is a 24-bit color`);
      assert.ok(palette[key] >= 0 && palette[key] <= 0xffffff, `${name}.${key} in range`);
    }
  }
});

test("theme cycling walks the whole catalog and setTheme accepts every name", () => {
  const names = Object.keys(THEMES);
  assert.ok(names.length >= 10, "a rich catalog of common schemes");
  setTheme(names[0]);
  const seen = [themeName()];
  for (let i = 0; i < names.length - 1; i++) seen.push(cycleTheme());
  assert.equal(seen.length, names.length);
  assert.equal(new Set(seen).size, names.length, "cycle visits each theme exactly once");
  assert.equal(seen[0], names[0], "cycle wraps back to the start");
  for (const name of names) assert.ok(setTheme(name), `${name} is settable`);
  assert.equal(setTheme("no-such-theme"), false, "unknown names are rejected");
});

test("the live proxy resolves every theme without holes", () => {
  for (const [name, palette] of Object.entries(THEMES)) {
    assert.ok(setTheme(name));
    assert.equal(T.ACCENT, palette.ACCENT, `${name} accent resolves`);
    assert.equal(T.BG, palette.BG, `${name} bg resolves`);
    assert.equal(T.BORDER2, palette.BORDER2, `${name} border resolves`);
    assert.equal(themeName(), name);
  }
  setTheme("gruvbox");
});
