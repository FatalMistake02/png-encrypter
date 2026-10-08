// End-to-end density benchmark: every codec, measured the way the page
// actually stores it.
//
//   existing codecs -> block-char string -> UTF-8 -> base64 -> 3 bytes/pixel
//   new xc_* codecs -> raw bytes        -> 3 bytes/pixel
//
// Short samples are misleading for adaptive models, so a large corpus is used
// as well as small ones.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const BYTES_PER_PIXEL = 3;

/* ---------- corpus ---------- */
let corpus = "";
const add = (p) => { try { corpus += readFileSync(p, "utf8") + "\n"; } catch {} };
add(path.join(root, "README.md"));
for (const f of readdirSync(here)) {
  if (f.endsWith(".js") && !f.startsWith("_")) add(path.join(here, f));
}

const words = corpus
  .replace(/[^A-Za-z\s]/g, " ")
  .split(/\s+/)
  .filter((w) => w.length > 0);
const english = words.join(" ");
// Deterministic shuffle-ish interleave so repetitions are not trivially
// adjacent (otherwise the LZ stage flatters the numbers).
function interleave(arr, parts) {
  const out = [];
  for (let i = 0; i < parts; i++) {
    for (let j = i; j < arr.length; j += parts) out.push(arr[j]);
  }
  return out.join(" ");
}

const SAMPLES = {
  "small (11 chars)": "hello there",
  "medium (540 chars)": "The quick brown fox jumps over the lazy dog. ".repeat(12).slice(0, 540),
  "prose 1k": english.slice(0, 1000),
  "prose 10k": english.slice(0, 10000),
  "prose 50k": english.slice(0, 50000),
  "corpus 145k (prose+code)": corpus,
  "interleaved 100k": interleave(words, 4).slice(0, 100000)
};

/* ---------- how the page stores each codec ---------- */
function viaBase64(packed) {
  // block-char string -> UTF-8 -> base64 -> pixels
  const utf8 = new TextEncoder().encode(packed).length;
  const b64 = Math.ceil((utf8 * 8) / 6);
  return Math.ceil(b64 / BYTES_PER_PIXEL);
}
function viaBytes(bytes) {
  return Math.ceil(bytes.length / BYTES_PER_PIXEL);
}

/* ---------- load codecs ---------- */
globalThis.window = globalThis;
globalThis.location = { href: "http://localhost:8000/web/index.html" };
const quiet = { log: () => {} };

const OLD = ["fatal_5.0.0.js", "fatal_6.1.0.js", "kolbe_1.0.0.js", "kolbe_2.0.5.js",
             "kolbe_2.1.0.js", "kolbe_2.2.0.js", "kolbe_2.3.0.js"];
const NEW = ["xc_bitpack.js", "xc_range.js"];

const rows = [];
const realLog = console.log;
for (const f of OLD) {
  try { await import(pathToFileURL(path.join(here, f)).href); }
  catch (e) { rows.push({ name: f, err: "load: " + e.message }); continue; }
  // Capture BOTH functions now. Reading globalThis.decrypt later would return
  // whichever codec was imported last, not this one.
  const enc = globalThis.encrypt;
  const dec = globalThis.decrypt;
  rows.push({ name: f, kind: "old", enc, dec });
}
for (const f of NEW) {
  const mod = (await import(pathToFileURL(path.join(here, f)).href)).default;
  rows.push({ name: f, kind: "new", mod });
}

const keys = Object.keys(SAMPLES);
console.log("chars per pixel (higher is better)\n");

let header = "codec".padEnd(20);
for (const k of keys) header += k.replace(/\s*\(.*\)/, "").padStart(12);
console.log(header);
console.log("-".repeat(header.length));

const results = [];
for (const r of rows) {
  if (r.err) { console.log(r.name.padEnd(20) + r.err); continue; }
  const cells = [];
  let ok = true;
  for (const k of keys) {
    const text = SAMPLES[k];
    console.log = quiet.log;
    try {
      let px;
      if (r.kind === "old") {
        const packed = await r.enc(text);   // several codecs are async
        const back = await r.dec(packed, "");
        console.log = realLog;
        if (back !== text) { ok = false; cells.push("n/a"); continue; }
        px = viaBase64(packed);
      } else {
        const bytes = r.mod.encodeBytes(text);
        const back = r.mod.decodeBytes(bytes);
        console.log = realLog;
        if (back !== text) { ok = false; cells.push("n/a"); continue; }
        px = viaBytes(bytes);
      }
      cells.push((text.length / px).toFixed(1));
    } catch (e) {
      console.log = realLog;
      ok = false;
      cells.push("bad");
    }
  }
  console.log = realLog;
  const line = r.name.padEnd(20) + cells.map((c) => c.padStart(12)).join("");
  console.log(line + (ok ? "" : "   (some inputs failed)"));
  results.push({ name: r.name, cells });
}

/* ---------- image sizes for the winner on prose 10k ---------- */
console.log("\nimage size for 10,000 characters of prose:");
for (const r of results) {
  const idx = keys.indexOf("prose 10k");
  const v = parseFloat(r.cells[idx]);
  if (!v || Number.isNaN(v)) continue;
  const px = Math.ceil(10000 / v);
  const side = Math.ceil(Math.sqrt(px));
  console.log("   " + r.name.padEnd(20) + v.toFixed(1) + " ch/px  ->  " +
              side + "x" + side + " px  (" + (side * side) + " px)");
}