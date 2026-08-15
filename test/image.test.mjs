// image.test.mjs — buildPromptParts unit tests (no network, no real send)
import { buildPromptParts, clipboardImageFromWayland } from "../src/views.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}\n    got  ${g}\n    want ${w}`); }
};

// fake PNG file
const png = join("/tmp", "dsh-tui-test.png");
try { writeFileSync(png, Buffer.from("fakepngbytes")); } catch {}

const fs = (content) => (path) => (path === png ? Buffer.from(content).toString("base64") : null);

{
  const r = buildPromptParts(`看这张图 @${png} 然后描述它`, { readFile: fs("fakepngbytes") });
  check("image path parsed", r.images, [png]);
  check("text parts around image", r.parts.map((p) => p.type), ["text", "image", "text"]);
  check("text preserved", r.parts[0].text, "看这张图 ");
  check("media type", r.parts[1].mediaType, "image/png");
  check("data base64", r.parts[1].data, Buffer.from("fakepngbytes").toString("base64"));
  check("trailing text", r.parts[2].text, " 然后描述它");
  check("no errors", r.errors, []);
}
{
  const r = buildPromptParts("纯文本消息", { readFile: fs("x") });
  check("plain text passthrough", r.parts, [{ type: "text", text: "纯文本消息" }]);
  check("no images", r.images, []);
}
{
  const r = buildPromptParts("图 @/nonexistent/foo.png 没了", { readFile: fs("x") });
  check("missing file error", r.errors, ["/nonexistent/foo.png: 文件不存在"]);
  check("missing file keeps text intact", r.parts[0].text, "图 @/nonexistent/foo.png 没了");
}
{
  const r = buildPromptParts("非图片 @/home/user/notes.txt 忽略", { readFile: fs("x") });
  check("non-image @ ignored", r.images, []);
  check("non-image kept as text", r.parts[0].text, "非图片 @/home/user/notes.txt 忽略");
}
{
  const r = buildPromptParts(`两张图 @${png} 和 @${png}`, { readFile: fs("fakepngbytes") });
  check("two images", r.images.length, 2);
  check("mixed parts order", r.parts.map((p) => p.type), ["text", "image", "text", "image", "text"]);
}
{
  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push([cmd, args, opts.encoding]);
    if (args[0] === "--list-types") return { status: 0, stdout: "text/plain\nimage/png\n" };
    return { status: 0, stdout: Buffer.from("clipboard-png") };
  };
  const image = clipboardImageFromWayland(run);
  check("clipboard media type", image.mediaType, "image/png");
  check("clipboard data base64", image.data, Buffer.from("clipboard-png").toString("base64"));
  check("clipboard queries exact mime", calls[1][1], ["--no-newline", "--type", "image/png"]);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
