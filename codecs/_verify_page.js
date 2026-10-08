// Mimics web/index.html's loadCodec(): imports each codec into ONE global
// scope and snapshots window.encrypt/window.decrypt right after, to confirm
// the snapshot is not clobbered by the next import.
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
globalThis.window = globalThis;
globalThis.location = { href: "http://localhost:8000/web/index.html" };

const quiet = { log: () => {} };
const realLog = console.log;

const files = readdirSync(here).filter((f) => /^(kolbe_|fatal_).*\.js$/.test(f));
const loaded = [];

for (const f of files) {
  const url = pathToFileURL(path.join(here, f)).href;
  const t0 = Date.now();
  let codec;
  try {
    await import(url);
    const enc = window.encrypt;
    const dec = window.decrypt;
    if (typeof enc !== "function" || typeof dec !== "function") {
      throw new Error("no encrypt/decrypt exposed");
    }
    codec = { encrypt: enc, decrypt: dec };
  } catch (e) {
    realLog("FAIL  " + f.padEnd(18) + " " + e.message);
    continue;
  }

  // verify the snapshot still works after later modules were imported
  console.log = quiet.log;
  let ok = false;
  let ratio = "?";
  try {
    const sample = "The quick brown fox jumps over the lazy dog. ".repeat(12);
    const packed = await codec.encrypt(sample, "");
    const back = await codec.decrypt(packed, "");
    ok = back === sample;
    ratio = sample.length + " -> " + packed.length;
  } catch (e) {
    ratio = "threw: " + e.message;
  }
  console.log = realLog;

  realLog(
    (ok ? "OK    " : "BROKEN") + "  " + f.padEnd(18) +
    " load=" + String(Date.now() - t0).padStart(4) + "ms  " + ratio
  );
  loaded.push(f);
}

realLog("\n" + loaded.length + "/" + files.length + " loaded and usable");