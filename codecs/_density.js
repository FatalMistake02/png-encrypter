// Measures real density for every codec: how many original characters of text
// end up in one pixel, under the current base64 scheme and under a direct
// bit-packing scheme.
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
globalThis.window = globalThis;
globalThis.location = { href: "http://localhost:8000/web/index.html" };

const quiet = { log: () => {} };
const realLog = console.log;

const FILES = readdirSync(here).filter((f) => /^(kolbe_|fatal_).*\.js$/.test(f));

const SAMPLE = `The quick brown fox jumps over the lazy dog.
Compression is the process of encoding information in a way that is likely to
be stored efficiently. Many types of digital media, including archive files,
multimedia (audio, video, and images), as well as databases, are commonly
compressed using compression algorithms. A compressed file is a virtual file,
a representation of a file that facilitates the storage or transmission of
the data in a more compact "packed" form. Such a file can be decompressed by
using a decompression algorithm or a computer program that can execute such
algorithm. The word compression may also be used in the context of data
compression, wherein the sense of compression is applied to the amount of data
used to represent information and therefore to its size. Compressed data is
often, but not exclusively, used to reduce the size of data sent over a data
link, or stored as data in a storage medium. Data storage devices have a
physical size limit and every digital device has a limited capacity, so the
spectrum of data that can be stored is finite. Compression is used whenever
there is a shortage of space or bandwidth and it is valuable to preserve as
much information as possible within those constraints.`;

const BYTES_PER_PIXEL = 3;

const CODEC_CACHE = new Map();
async function loadCodec(url) {
  if (CODEC_CACHE.has(url)) return CODEC_CACHE.get(url);
  await import(url);
  const c = { encrypt: window.encrypt, decrypt: window.decrypt };
  CODEC_CACHE.set(url, c);
  return c;
}

// Reproduce the blockChars alphabet the codecs use, to find bits-per-char.
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
const BITS_PER_BLOCK = Math.floor(Math.log2(blockChars.length));

realLog("blockChars alphabet size: " + blockChars.length.toLocaleString());
realLog("bits carried per block char: " + BITS_PER_BLOCK);
realLog("bytes per pixel (R,G,B): " + BYTES_PER_PIXEL + "  = " + BYTES_PER_PIXEL * 8 + " bits\n");

realLog(
  "codec".padEnd(17) +
  "chars".padStart(7) +
  "blocks".padStart(8) +
  "b64 px".padStart(8) +
  "direct px".padStart(10) +
  "ch/px now".padStart(11) +
  "ch/px direct".padStart(14)
);
realLog("-".repeat(75));

const rows = [];
for (const f of FILES) {
  const url = pathToFileURL(path.join(here, f)).href;
  let packed;
  try {
    console.log = quiet.log;
    const c = await loadCodec(url);
    packed = await c.encrypt(SAMPLE, "");
    console.log = realLog;
  } catch (e) {
    console.log = realLog;
    realLog(f.padEnd(17) + "  unusable: " + e.message);
    continue;
  }

  const blocks = [...packed].length;

  // current scheme: block chars -> UTF-8 -> base64 -> pixels
  const utf8 = new TextEncoder().encode(packed).length;
  const b64 = Math.ceil((utf8 * 8) / 6);
  const pxNow = Math.ceil(b64 / BYTES_PER_PIXEL);

  // direct scheme: recover the raw bit string, pack at 8 bits per byte
  const bitStream = blocks * BITS_PER_BLOCK;
  const pxDirect = Math.ceil(bitStream / (BYTES_PER_PIXEL * 8));

  rows.push({
    name: f.replace(".js", ""),
    chars: SAMPLE.length,
    blocks,
    pxNow,
    pxDirect,
    now: SAMPLE.length / pxNow,
    direct: SAMPLE.length / pxDirect
  });
}

for (const r of rows.sort((a, b) => b.direct - a.direct)) {
  realLog(
    r.name.padEnd(17) +
    String(r.chars).padStart(7) +
    String(r.blocks).padStart(8) +
    String(r.pxNow).padStart(8) +
    String(r.pxDirect).padStart(10) +
    r.now.toFixed(1).padStart(11) +
    r.direct.toFixed(1).padStart(14)
  );
}

const best = rows.sort((a, b) => b.direct - a.direct)[0];
realLog("\nbest codec: " + best.name);
realLog("  1000 chars of English  -> " + Math.ceil(1000 / best.now) + " px now, " +
        Math.ceil(1000 / best.direct) + " px with direct bit packing");
realLog("  10,000 chars (2 pages)  -> " + Math.ceil(10000 / best.now) + " px now, " +
        Math.ceil(10000 / best.direct) + " px with direct bit packing");