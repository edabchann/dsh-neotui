// term.test.mjs — feed raw terminal byte sequences into Term, assert decoded events.
import { PassThrough } from "node:stream";
import { Term } from "../src/term.js";

let pass = 0, fail = 0;
const activeTerms = new Set();
function track(term) { activeTerms.add(term); return term; }
function stopAll() { for (const term of activeTerms) term.stop(); activeTerms.clear(); }
function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}\n    got  ${g}\n    want ${w}`); }
}

function harness(bytes, kitty = false) {
  const input = new PassThrough();
  const output = { write: () => true };
  const events = [];
  const term = track(new Term({ input, output, onEvent: (e) => events.push(e), kitty }));
  term.start();
  input.write(Buffer.from(bytes, "utf8"));
  // All ordinary decoder cases settle synchronously; release their process
  // listener immediately. A lone ESC intentionally stays alive for its 30ms
  // fallback assertion in the async tail.
  if (bytes !== "\x1b") { term.stop(); activeTerms.delete(term); }
  return { term, events };
}

console.log("term.js decoder tests:");

// SGR mouse (1006): CSI < b ; x ; y M/m — 1-based coords → 0-based
{
  const { events } = harness("\x1b[<0;11;6M");
  check("left press @ (10,5)", events[0], { type: "mouse", kind: "press", button: 0, x: 10, y: 5, ctrl: false, shift: false, alt: false, motion: false });
}
{
  const { events } = harness("\x1b[<0;11;6m");
  check("left release", events[0], { type: "mouse", kind: "release", button: 0, x: 10, y: 5, ctrl: false, shift: false, alt: false, motion: false });
}
{
  const { events } = harness("\x1b[<2;3;8M");
  check("right press @ (2,7)", events[0], { type: "mouse", kind: "press", button: 2, x: 2, y: 7, ctrl: false, shift: false, alt: false, motion: false });
}
{
  const { events } = harness("\x1b[<32;11;6M");
  check("drag (motion flag)", events[0], { type: "mouse", kind: "drag", button: 0, x: 10, y: 5, ctrl: false, shift: false, alt: false, motion: true });
}
{
  const { events } = harness("\x1b[<64;11;6M");
  check("wheel up", events[0], { type: "mouse", kind: "wheel-up", button: 4, x: 10, y: 5, ctrl: false, shift: false, alt: false, motion: false });
}
{
  const { events } = harness("\x1b[<65;11;6M");
  check("wheel down", events[0], { type: "mouse", kind: "wheel-down", button: 5, x: 10, y: 5, ctrl: false, shift: false, alt: false, motion: false });
}
{
  const { events } = harness("\x1b[<16;11;6M");
  check("ctrl+click (bit 16)", events[0], { type: "mouse", kind: "press", button: 0, x: 10, y: 5, ctrl: true, shift: false, alt: false, motion: false });
}

// keys
{
  const { events } = harness("\x1b[A");
  check("arrow up", events[0], { type: "key", name: "up", ctrl: false, alt: false, shift: false });
}
{
  const { events } = harness("\x1b[1;5A");
  check("ctrl+up", events[0], { type: "key", name: "up", ctrl: true, alt: false, shift: false });
}
{
  const { events } = harness("\x1b[1;3D");
  check("alt+left", events[0], { type: "key", name: "left", ctrl: false, alt: true, shift: false });
}
{
  const { events } = harness("\x1b[5~");
  check("pgup", events[0], { type: "key", name: "pgup", ctrl: false, alt: false, shift: false });
}
{
  const { events } = harness("\x1bO\x1bOH".slice(0, 3) + "\x1bOH");
  check("home (SS3)", events[0], { type: "key", name: "home", ctrl: false, alt: false, shift: false });
}
{
  const { events } = harness("\r");
  check("enter (CR)", events[0], { type: "key", name: "enter", ctrl: false, alt: false, shift: false });
}
{
  const { events } = harness("\x7f");
  check("backspace", events[0], { type: "key", name: "backspace", ctrl: false, alt: false, shift: false });
}
{
  const { events } = harness("\x01");
  check("ctrl+a", events[0], { type: "key", name: "char", key: "a", text: "a", ctrl: true, alt: false, shift: false });
}
{
  const { events } = harness("hello");
  check("text run", events[0], { type: "text", text: "hello" });
}
{
  const { events } = harness("你好，世界");
  check("CJK text", events[0], { type: "text", text: "你好，世界" });
}
{
  const { events } = harness("\x1bx");
  check("alt+x", events[0], { type: "key", name: "char", key: "x", text: "x", ctrl: false, alt: true, shift: false });
}
{
  const { events } = harness("\x1b[200~paste me\x1b[201~");
  check("bracketed paste passes text", events[0], { type: "paste", text: "paste me" });
}
{
  const { events } = harness("\x1b[200~paste me\x1b[201~");
  check("bracketed paste passes text", events[0], { type: "paste", text: "paste me" });
}
{
  const { events } = harness("[<32;68;35M[<0;70;35m[99;5u");
  check("orphan restart control tails discarded", events.length, 0);
}
{
  const { events } = harness("\x1b[97;5u", true);
  check("kitty ctrl+a", events[0], { type: "key", name: "char", key: "a", text: "a", ctrl: true, alt: false, shift: false });
}
{
  const { events } = harness("\x1b[57360;5u", true);
  check("kitty ctrl+pgup", events[0], { type: "key", name: "pgup", ctrl: true, alt: false, shift: false });
}
{
  const { events } = harness("\x1b[13;1u", true);
  check("kitty enter (no mods)", events[0], { type: "key", name: "enter", ctrl: false, alt: false, shift: false });
}
{
  const { events } = harness("\x1b[13;2u", true);
  check("kitty shift+enter = newline key", events[0], { type: "key", name: "enter", ctrl: false, alt: false, shift: true });
}
{
  const { events } = harness("\x1b[13;2:1u", true);
  check("kitty shift+enter with event-type suffix", events[0], { type: "key", name: "enter", ctrl: false, alt: false, shift: true });
}
{
  const { events } = harness("\x1b[97:65;2u", true);
  check("kitty shift+a with alternate-key field", events[0], { type: "key", name: "char", key: "a", text: "a", ctrl: false, alt: false, shift: true });
}
{
  const { term } = harness("\x1b[?5u", true);
  check("kitty flags query reply marks protocol active", term.kittyActive, true);
}
{
  const { term } = harness("plain", true);
  check("no flags reply = protocol not active", term.kittyActive, false);
}
{
  const { events } = harness("\x1b]52;c;dGhp\x07rest");
  check("OSC 52 skipped, text after survives", events[0], { type: "text", text: "rest" });
}
{
  const { events } = harness("\x1b[32;5u", true);
  check("kitty ctrl+space", events[0], { type: "key", name: "char", key: " ", text: " ", ctrl: true, alt: false, shift: false });
}
{
  const { events } = harness("\x1b[18~");
  check("f7", events[0], { type: "key", name: "f7", ctrl: false, alt: false, shift: false });
}
{
  // fragmented input: split a CJK char across two chunks
  const input = new PassThrough();
  const output = { write: () => true };
  const events = [];
  const term = track(new Term({ input, output, onEvent: (e) => events.push(e) }));
  term.start();
  const bytes = Buffer.from("你好", "utf8");
  input.write(bytes.slice(0, 4));
  input.write(bytes.slice(4));
  check("split UTF-8 reassembled", events[0], { type: "text", text: "你" });
  check("split UTF-8 second chunk", events[1], { type: "text", text: "好" });
}

// Split-sequence checks need the real event loop (timers cannot fire while
// the synchronous harness above is still on the stack), so they run as an
// async tail: a lone ESC waits for the rest of its sequence, and an SGR
// mouse report whose ESC arrived in a separate chunk is reassembled instead
// of leaking into input text (the /restart-handoff leak).
setTimeout(() => {
  {
    const { events } = harness("\x1b");
    setTimeout(() => {
      check("bare ESC = escape key", events[0], { type: "key", name: "escape", ctrl: false, alt: false, shift: false });
      {
        const input = new PassThrough();
        const output = { write: () => true };
        const events = [];
        const term = new Term({ input, output, onEvent: (e) => events.push(e) });
        term.start();
        input.write("\x1b");
        input.write("[<0;11;6M");
        setTimeout(() => {
          check("split SGR mouse reassembled", events[0], { type: "mouse", kind: "press", button: 0, x: 10, y: 5, ctrl: false, shift: false, alt: false, motion: false });
          term.stop();
          // a large bracketed paste arriving in arbitrary chunks (even the
          // END marker split) must emit ONE text event — the input's
          // two-stage paste depends on seeing the whole clipboard at once
          {
            const input2 = new PassThrough();
            const events2 = [];
            const term2 = track(new Term({ input: input2, output: { write: () => true }, onEvent: (e) => events2.push(e) }));
            term2.start();
            input2.write("\x1b[200~line one\nline two\nline t");
            input2.write("hree\x1b[20");
            input2.write("1~tail");
            setTimeout(() => {
              check("chunked bracketed paste = one text event", events2[0], { type: "paste", text: "line one\nline two\nline three" });
              check("text after paste parses normally", events2[1], { type: "text", text: "tail" });
              term2.stop();
              stopAll();
              console.log(`\n${pass} passed, ${fail} failed`);
              process.exit(fail > 0 ? 1 : 0);
            }, 70);
          }
        }, 70);
      }
    }, 70);
  }
}, 0);
