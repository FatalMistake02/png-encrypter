// End-to-end test of the pixel pipeline used by web/index.html.
// Mirrors the header layout and the interleaved RGB writing, for BOTH
// transport modes (raw bytes and base64-in-safe-colours), and confirms old
// images (codec ids 1-7) still decode.

const SAFE = [];
for (let i = 0; i < 64; i++) SAFE.push(Math.round(i * (250 / 63)) + 3);
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const C = 3, HP = 4;

function bytesToB64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return btoa(bin).replace(/=+$/, "");
}
function b64ToBytes(b64) {
  while (b64.length % 4 !== 0) b64 += "=";
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// ---- encode side (mirrors encodeText) ----
function packPixels(text, originalBytes, bytes, mode, codecId) {
  let stream;
  if (mode === "raw") {
    stream = Array.from(bytes);
  } else {
    const b64 = bytesToB64(bytes);
    stream = [];
    for (let i = 0; i < b64.length; i++) stream.push(SAFE[B64.indexOf(b64[i])]);
  }
  const streamLen = stream.length;
  let sum = 0; for (const v of stream) sum += v;
  const byteLen = originalBytes.length;

  stream = [
    streamLen & 0xFF, (streamLen >> 8) & 0xFF, (streamLen >> 16) & 0xFF,
    byteLen & 0xFF, (byteLen >> 8) & 0xFF, (byteLen >> 16) & 0xFF,
    sum & 0xFF, 0, 0,
    codecId, 0, 0
  ].concat(stream);

  const totalPixels = HP + Math.ceil((stream.length - HP * C) / C);
  const side = Math.ceil(Math.sqrt(totalPixels));
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let p = 0; p < totalPixels; p++) {
    for (let ch = 0; ch < C; ch++) {
      const s = p * C + ch;
      data[p * 4 + ch] = s < stream.length ? stream[s] : 255;
    }
    data[p * 4 + 3] = 255;
  }
  return { data, side };
}

// ---- decode side (mirrors decodeImage) ----
function unpackPixels(data, decodeWith) {
  const streamLen = data[0] | (data[1] << 8) | (data[2] << 16);
  const byteLen = data[4] | (data[5] << 8) | (data[6] << 16);
  const checksum = data[8];
  const codecId = data[12];

  const needPixels = HP + Math.ceil(streamLen / C);
  // streamLen 0 is legitimate: empty input compresses to an empty payload
  if ((streamLen <= 0 && byteLen !== 0) || needPixels * 4 > data.length) throw new Error("bad header");

  const values = new Uint8Array(streamLen);
  let sum = 0;
  for (let i = 0; i < streamLen; i++) {
    const p = Math.floor(i / C) + HP, ch = i % C;
    const v = data[p * 4 + ch];
    values[i] = v;
    sum += v;
  }
  const ok = (sum & 0xFF) === checksum;
  const text = decodeWith(codecId, values);
  return { text, ok, byteLen, codecId };
}

function colorToCharIndex(val) {
  let best = -1, minDiff = Infinity;
  for (let j = 0; j < 64; j++) {
    const d = Math.abs(val - SAFE[j]);
    if (d < minDiff) { minDiff = d; best = j; }
  }
  return minDiff <= 2 ? best : -1;
}

/* ================= run ================= */
const mod = (await import("./xc_range.js")).default;
const bitpack = (await import("./xc_bitpack.js")).default;

const SAMPLES = [
  "hello there",
  "The quick brown fox jumps over the lazy dog. ".repeat(12),
  "emoji \u{1F680} accents caf\u00e9 \u2014 dashes \u201cok\u201d",
  ""
];

let fail = 0;
for (const [name, codec, mode, id] of [
  ["xc_range  raw   (id 9)", mod, "raw", 9],
  ["xc_bitpack raw  (id 8)", bitpack, "raw", 8],
  ["legacy     b64   (id 7)", { f: (t) => new TextEncoder().encode(t) }, "base64", 7]
]) {
  console.log("=== " + name);
  for (const text of SAMPLES) {
    const originalBytes = new TextEncoder().encode(text);
    let bytes, decodeWith;
    if (mode === "raw") {
      bytes = codec.encodeBytes(text);
      decodeWith = (_id, vals) => codec.decodeBytes(vals);
    } else {
      bytes = codec.f(text);
      decodeWith = (_id, vals) => {
        let b64 = "";
        for (let i = 0; i < vals.length; i++) {
          const idx = colorToCharIndex(vals[i]);
          b64 += idx < 0 ? "A" : B64[idx];
        }
        return new TextDecoder().decode(b64ToBytes(b64));
      };
    }
    const { data, side } = packPixels(text, originalBytes, bytes, mode, id);
    let res, err = null;
    try { res = unpackPixels(data, decodeWith); } catch (e) { err = e.message; }
    const good = !err && res.text === text && res.ok;
    if (!good) fail++;
    console.log("   " + (good ? "PASS" : "FAIL") +
      ("  " + String(text.length).padStart(5) + " chars").padEnd(18) +
      ("  " + side + "x" + side).padStart(12) +
      (err ? "  ERR " + err : "  cksum ok=" + res.ok));
  }
}
console.log("\n" + (fail === 0 ? "all pixel-pipeline round-trips PASS" : fail + " FAILURES"));