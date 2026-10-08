// Reproduces the page's exact flow and the real failure mode:
//   1. benchmark: import + run EVERY codec in one global scope, snapshotting each
//   2. later:     ask loadCodec() for codec N and use it to DECODE a payload that
//                 was produced by codec N's true implementation
//
// A self round-trip does not catch this: a wrong codec happily round-trips with
// itself. Cross-checking against the true snapshot does.
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
globalThis.window = globalThis;
globalThis.location = { href: "http://localhost:8000/web/index.html" };

const quiet = { log: () => {} };
const realLog = console.log;

const USE_CACHE = process.argv[2] !== "--no-cache";

const CODEC_CACHE = new Map();
async function loadCodec(url) {
  if (USE_CACHE && CODEC_CACHE.has(url)) return CODEC_CACHE.get(url);
  await import(url);
  const codec = { encrypt: window.encrypt, decrypt: window.decrypt };
  if (USE_CACHE) CODEC_CACHE.set(url, codec);
  return codec;
}

const FILES = readdirSync(here).filter((f) => /^(kolbe_|fatal_).*\.js$/.test(f));
const urls = FILES.map((f) => pathToFileURL(path.join(here, f)).href);

/* ---- step 1: benchmark, keeping the true snapshot per codec ---- */
const truth = new Map();
for (let i = 0; i < urls.length; i++) {
  try {
    console.log = quiet.log;
    const c = await loadCodec(urls[i]);
    console.log = realLog;
    truth.set(i, c);
  } catch (e) {
    console.log = realLog;
    realLog("skip " + FILES[i] + ": " + e.message);
  }
}
realLog("benchmarked " + truth.size + " codecs (cache " + (USE_CACHE ? "ON" : "OFF") + ")\n");

/* ---- step 2: decode each codec's real output using a fresh loadCodec call ---- */
const SAMPLE = "The quick brown fox jumps over the lazy dog. ".repeat(12);
let failures = 0;

for (const [i, t] of truth) {
  const name = FILES[i];
  console.log = quiet.log;
  let packed, verdict, detail;
  try {
    packed = await t.encrypt(SAMPLE, "");
    const loaded = await loadCodec(urls[i]);
    const back = await loaded.decrypt(packed, "");
    const sameImpl = loaded.decrypt === t.decrypt;
    verdict = back === SAMPLE ? "OK  " : "BAD ";
    detail = sameImpl ? "" : "  <-- WRONG CODEC RETURNED";
  } catch (e) {
    verdict = "THREW";
    detail = "  " + e.message;
  }
  console.log = realLog;
  if (verdict !== "OK  ") failures++;
  realLog(verdict + "  id=" + String(i + 1).padStart(2) + "  " + name.padEnd(18) + detail);
}

realLog("\n" + (truth.size - failures) + "/" + truth.size + " codecs decode correctly");