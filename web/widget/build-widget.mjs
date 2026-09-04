// Builds altovix-widget.js from the template, the plan data and the embedded logo PNGs.
// usage: node build-widget.mjs [outfile]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] ?? join(here, "altovix-widget.js");
const b64 = (f) => readFileSync(join(here, "embed", f)).toString("base64");
const pngSize = (f) => { const b = readFileSync(join(here, "embed", f)); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

const data = JSON.parse(readFileSync(join(here, "data.json"), "utf8"));
const [mw, mh] = pngSize("mark-alpha.png");
const [ww, wh] = pngSize("wordmark-alpha.png");
for (const f of ["mark-white.png", "wordmark-white.png"]) {
  const [a, b] = pngSize(f);
  const [x, y] = f.startsWith("mark") ? [mw, mh] : [ww, wh];
  if (a !== x || b !== y) throw new Error(`${f} is ${a}x${b}, expected ${x}x${y}`);
}

const js = readFileSync(join(here, "altovix-widget.template.js"), "utf8")
  .replace("__GENERATED__", data.generated)
  .replace("__DATA__", JSON.stringify(data))
  .replace("__MARK_ALPHA__", b64("mark-alpha.png"))
  .replace("__MARK_WHITE__", b64("mark-white.png"))
  .replace("__WORD_ALPHA__", b64("wordmark-alpha.png"))
  .replace("__WORD_WHITE__", b64("wordmark-white.png"))
  .replace("__MARK_W__", String(mw)).replace("__MARK_H__", String(mh))
  .replace("__WORD_W__", String(ww)).replace("__WORD_H__", String(wh));
if (/__[A-Z_]+__/.test(js)) throw new Error("unfilled placeholder: " + js.match(/__[A-Z_]+__/)[0]);
writeFileSync(out, js);
console.log(`wrote ${out} (${js.length} bytes; mark ${mw}x${mh}, wordmark ${ww}x${wh})`);
