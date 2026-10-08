// Round-trip + ratio harness for the new xc_* codecs.
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "_density.js"), "utf8");
const SAMPLE = src.match(/const SAMPLE = `([\s\S]*?)`;/)[1];

const BYTES_PER_PIXEL = 3;

const TESTS = [
  ["empty", ""],
  ["one char", "a"],
  ["tiny", "hello there"],
  ["repeated", "The quick brown fox jumps over the lazy dog. ".repeat(12)],
  ["prose", SAMPLE],
  ["unicode", "emoji \u{1F680} accents caf\u00e9 na\u00efve \u2014 dashes \u201cok\u201d \u00fc\u00f1"],
  ["digits", "1234567890 ".repeat(20)],
  ["symbols", "!@#$%^&*()_+-=[]{}|;':\",./<>?".repeat(8)],
  ["mixed", "Lorem ipsum dolor sit amet, 42% of $100.00 \u2014 2026-10-04 (v1.2.3).\n\nNew line here."],
  ["json-ish", '{"id":123,"name":"test","tags":["a","b"],"ok":true,"n":null}']
];

const files = process.argv.slice(2);
if (!files.length) files.push("xc_bitpack.js", "xc_range.js");

for (const f of files) {
  let mod;
  try {
    mod = (await import(pathToFileURL(path.join(here, f)).href)).default;
  } catch (e) {
    console.log(f.padEnd(18) + " LOAD FAIL: " + e.message);
    continue;
  }

  console.log("=== " + f);
  let allOk = true;
  const ratios = [];

  for (const [label, text] of TESTS) {
    let out, back, status;
    try {
      out = mod.encodeBytes(text);
      back = mod.decodeBytes(out);
      status = back === text ? "PASS" : "FAIL";
    } catch (e) {
      status = "THREW";
      out = new Uint8Array(0);
      back = "";
      console.log("   " + e.message);
    }
    if (status !== "PASS") allOk = false;

    const inBytes = new TextEncoder().encode(text).length;
    const px = Math.ceil(out.length / BYTES_PER_PIXEL);
    const chPerPx = px > 0 ? text.length / px : 0;
    const bitsPerChar = text.length > 0 ? (out.length * 8) / text.length : 0;

    ratios.push({ label, bitsPerChar, chPerPx });
    console.log(
      "   " + status.padEnd(5) +
      label.padEnd(12) +
      ("in " + String(inBytes).padStart(5) + "B").padEnd(14) +
      ("out " + String(out.length).padStart(5) + "B").padEnd(14) +
      (bitsPerChar.toFixed(2) + " bits/ch").padStart(14) +
      (chPerPx.toFixed(1) + " ch/px").padStart(13)
    );
  }

  const prose = ratios.find((r) => r.label === "prose");
  console.log("   " + (allOk ? "all round-trips PASS" : "SOME FAILED"));
  if (prose) {
    console.log("   prose: " + prose.bitsPerChar.toFixed(2) + " bits/char -> " +
                prose.chPerPx.toFixed(1) + " chars/pixel");
  }
  console.log("");
}