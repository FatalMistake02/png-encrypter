// Proves the "direct bit packing" scheme is lossless, rather than just
// asserting better arithmetic.
//
// The Kolbe codecs call helpers.encodeBinaryString(), which base-converts a
// bit string into block chars using a leading sentinel bit. That mapping is
// invertible: map each char back to its alphabet index, re-accumulate the
// base-N value, and drop the sentinel. If we get the exact bit string back, we
// can pack it 8 bits per byte instead of paying base64's 33% overhead.
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
globalThis.window = globalThis;
globalThis.location = { href: "http://localhost:8000/web/index.html" };
await import(pathToFileURL(path.join(here, "helpers.js")).href);
const helper = globalThis.helper || (await import(pathToFileURL(path.join(here, "helpers.js")).href));

const quiet = { log: () => {} };
const realLog = console.log;

function buildBlockChars() {
  const out = [];
  for (let cp = 0x21; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    let ch;
    try { ch = String.fromCodePoint(cp); } catch { continue; }
    if (/\s/.test(ch)) continue;
    if (/[\p{Cc}\p{Cf}]/u.test(ch)) continue;
    if (/\p{Mn}|\p{Me}/u.test(ch)) continue;
    out.push(ch);
  }
  return out;
}
const blockChars = buildBlockChars();

const SAMPLE =
  "Compression is the process of encoding information in a way that is likely " +
  "to be stored efficiently. Many types of digital media are compressed.";

// bits -> bytes -> bits, at a fixed 8 bits per byte
function bitsToBytes(bits) {
  const padded = bits + "0".repeat((8 - (bits.length % 8)) % 8);
  const out = new Uint8Array(padded.length / 8);
  for (let i = 0; i < padded.length; i += 8) out[i / 8] = parseInt(padded.slice(i, i + 8), 2);
  return out;
}
function bytesToBits(bytes, bitLen) {
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  return bitLen ? bits.slice(0, bitLen) : bits;
}

for (const file of ["kolbe_2.3.0.js", "kolbe_2.1.0.js", "kolbe_2.2.0.js", "fatal_5.0.0.js"]) {
  await import(pathToFileURL(path.join(here, file)).href);
  const enc = globalThis.encrypt, dec = globalThis.decrypt;

  realLog("=== " + file);
  console.log = quiet.log;
  const packed = await enc(SAMPLE, "");
  console.log = realLog;

  let bits;
  try {
    bits = helper.decodeBinaryString(packed, blockChars);
  } catch (e) {
    realLog("   not helpers-based, cannot invert: " + e.message + "\n");
    continue;
  }

  realLog("   block chars        : " + [...packed].length);
  realLog("   recovered bits     : " + bits.length);

  // round trip the bits through bytes (what a pixel would store)
  const bytes = bitsToBytes(bits);
  const back = bytesToBits(bytes, bits.length);

  // re-encode the bits and confirm we get the identical block string
  const rebuilt = helper.encodeBinaryString(back, blockChars);

  const bitsMatch = back === bits;
  const charsMatch = rebuilt === packed;

  // and the real proof: does the codec still decode correctly?
  let decoded = null, threw = null;
  console.log = quiet.log;
  try {
    decoded = await dec(rebuilt, "");
  } catch (e) {
    threw = e.message;
  }
  console.log = realLog;

  realLog("   bits survive bytes : " + (bitsMatch ? "YES" : "NO"));
  realLog("   block string equal : " + (charsMatch ? "YES" : "NO"));
  realLog("   decodes to input   : " +
    (threw ? "THREW " + threw : decoded === SAMPLE ? "YES" : "NO"));
  realLog("");
}