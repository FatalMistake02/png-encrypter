// Reproduces the full page pipeline for one codec:
//   text -> codec.encrypt -> UTF-8 bytes -> base64 -> pixels -> base64 -> bytes
//        -> TextDecoder -> codec.decrypt
// and reports where it breaks.
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
globalThis.window = globalThis;
globalThis.location = { href: "http://localhost:8000/web/index.html" };

const quiet = { log: () => {} };
const realLog = console.log;

const SAFE = [];
for (let i = 0; i < 64; i++) SAFE.push(Math.round(i * (250 / 63)) + 3);
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const C = 3, HP = 4;

function bytesToB64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  return btoa(bin).replace(/=+$/, "");
}
function b64ToBytes(b64) {
  while (b64.length % 4 !== 0) b64 += "=";
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// count unpaired surrogates / lone code points in a JS string
function analyse(s) {
  let lone = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (n >= 0xdc00 && n <= 0xdfff) { i++; continue; }
      lone++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      lone++;
    }
  }
  return lone;
}

const SAMPLES = [
  "hello there",
  "The quick brown fox jumps over the lazy dog. ".repeat(12),
  "emoji \u{1F680} accents caf\u00e9 \u2014 dashes",
  "a",
  ""
];

const files = readdirSync(here).filter((f) => /^(kolbe_|fatal_).*\.js$/.test(f));

for (const f of files) {
  await import(pathToFileURL(path.join(here, f)).href);
  const enc = window.encrypt, dec = window.decrypt;
  realLog("=== " + f);

  for (const s of SAMPLES) {
    const label = JSON.stringify(s.slice(0, 26));
    try {
      console.log = quiet.log;
      const packed = await enc(s, "");
      console.log = realLog;

      const lone = analyse(packed);
      const bytes = new TextEncoder().encode(packed);
      const back = new TextDecoder().decode(bytes);

      if (back !== packed) {
        realLog("   " + label.padEnd(30) + " UTF-8 ROUND TRIP BROKE (lone surrogates: " + lone + ")");
        continue;
      }
      if (lone) realLog("   " + label.padEnd(30) + " note: " + lone + " unpaired surrogate(s) in output");

      const b64 = bytesToB64(bytes);
      const restored = new TextDecoder().decode(b64ToBytes(b64));
      if (restored !== packed) {
        realLog("   " + label.padEnd(30) + " BASE64 ROUND TRIP BROKE");
        continue;
      }

      console.log = quiet.log;
      const out = await dec(restored, "");
      console.log = realLog;
      realLog(
        "   " + label.padEnd(30) +
        (out === s ? " OK" : " DECODE MISMATCH") +
        "   packed=" + packed.length + " chars, " + bytes.length + " bytes"
      );
    } catch (e) {
      console.log = realLog;
      realLog("   " + label.padEnd(30) + " THREW: " + e.message);
    }
  }
  realLog("");
}