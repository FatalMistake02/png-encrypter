// Verifies every local codec actually loads and round-trips text.
// Run:  node codecs/_verify.js
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

// The codecs expect a browser-ish global environment.
// Node already provides globalThis.crypto, CompressionStream and TextEncoder.
globalThis.window = globalThis;
// kolbe 2.x reads window.location.href to decide where to import helpers from.
globalThis.location = { href: "http://localhost:8000/web/index.html" };

const FILES = readdirSync(here).filter(
  (f) => /^(kolbe_|fatal_).*\.js$/.test(f)
);

const SAMPLES = [
  "hello there",
  "The quick brown fox jumps over the lazy dog. ".repeat(12),
  "BlockTranslator cross version round trip test 12345!",
  "emoji \u{1F680} and accents caf\u00e9 na\u00efve \u2014 dashes \u2013 quotes \u201cok\u201d",
  "x",
  ""
];

// Several codecs log "Encoding . . ." on every call. Mute that noise.
const realLog = console.log;
const quiet = { log: () => {} };

let failures = 0;

for (const file of FILES) {
  const url = "file:///" + path.join(here, file).replace(/\\/g, "/");
  let mod;
  const t0 = Date.now();
  try {
    mod = await import(url);
  } catch (e) {
    realLog("LOAD FAIL  " + file.padEnd(18) + " " + e.message);
    failures++;
    continue;
  }
  const loadMs = Date.now() - t0;

  const enc = globalThis.encrypt;
  const dec = globalThis.decrypt;
  if (typeof enc !== "function" || typeof dec !== "function") {
    console.log("NO API     " + file.padEnd(18) + " encrypt=" + typeof enc + " decrypt=" + typeof dec);
    failures++;
    continue;
  }

  let out = [];
  let ok = true;
  for (const s of SAMPLES) {
    try {
      console.log = quiet.log;
      const packed = await enc(s, "");
      const back = await dec(packed, "");
      console.log = realLog;
      if (back !== s) {
        out.push(
          "MISMATCH on " + JSON.stringify(s.slice(0, 30)) +
          " (" + s.length + " chars) -> got " + JSON.stringify(back.slice(0, 30))
        );
        ok = false;
      }
    } catch (e) {
      console.log = realLog;
      out.push("THREW on " + JSON.stringify(s.slice(0, 20)) + ": " + e.message);
      ok = false;
    }
  }

  // measure real ratio on a longer sample
  const big = "The quick brown fox jumps over the lazy dog. ".repeat(12);
  console.log = quiet.log;
  const bigPacked = await enc(big, "");
  console.log = realLog;

  console.log(
    (ok ? "OK         " : "FAIL       ") +
      file.padEnd(18) +
      " load=" + String(loadMs).padStart(5) + "ms  " +
      "88 chars -> " + String(bigPacked.length).padStart(4) + " chars" +
      (out.length ? "\n             " + out.join("\n             ") : "")
  );
  if (!ok) failures++;
}

console.log("\n" + (FILES.length - failures) + "/" + FILES.length + " codecs usable");
process.exit(failures ? 1 : 0);