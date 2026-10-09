// End-to-end image-mode test using a real codec, mirroring encryptIntoImage()
// and extractFromImage() including the fit check.

const STEG_HEADER_BYTES = 16, STEG_CHANNELS = 3;
const MAGIC = [0x50, 0x45, 0x4e, 0x43], VERSION = 1;

globalThis.window = globalThis;
globalThis.location = { href: "http://localhost:8000/index.html" };
const realLog = console.log;
const quiet = { log: () => {} };

const codec = (await import("./xc_range.js")).default;
const bitpack = (await import("./xc_bitpack.js")).default;

function capacity(w, h) { return Math.floor((w * h * STEG_CHANNELS) / 8); }
function write(img, stream, bit0) {
  let bit = bit0;
  const total = (img.length / 4) * STEG_CHANNELS;
  for (let i = 0; i < stream.length; i++)
    for (let b = 7; b >= 0; b--) {
      if (bit >= total) throw new Error("no room");
      const o = Math.floor(bit / STEG_CHANNELS) * 4 + (bit % STEG_CHANNELS);
      img[o] = (img[o] & ~1) | ((stream[i] >> b) & 1);
      bit++;
    }
  return bit;
}
function read(img, n, bit0) {
  const out = new Uint8Array(n);
  let bit = bit0;
  const total = (img.length / 4) * STEG_CHANNELS;
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let b = 7; b >= 0; b--) {
      if (bit >= total) throw new Error("no room");
      v = (v * 2) | (img[Math.floor(bit / STEG_CHANNELS) * 4 + (bit % STEG_CHANNELS)] & 1);
      bit++;
    }
    out[i] = v;
  }
  return out;
}
function header(id, plen, olen, cks) {
  const h = new Uint8Array(16);
  h.set(MAGIC, 0); h[4] = VERSION; h[5] = 3; h[6] = id; h[7] = 0;
  h[8] = plen & 255; h[9] = (plen >> 8) & 255; h[10] = (plen >> 16) & 255;
  h[11] = olen & 255; h[12] = (olen >> 8) & 255; h[13] = (olen >> 16) & 255;
  h[14] = cks; h[15] = 0;
  return h;
}
function parse(h) {
  for (let i = 0; i < 4; i++) if (h[i] !== MAGIC[i]) return null;
  if (h[4] !== VERSION) return null;
  return { codecId: h[6], payloadLen: h[8] | (h[9] << 8) | (h[10] << 16),
           origLen: h[11] | (h[12] << 8) | (h[13] << 16), checksum: h[14] };
}
function carrier(w, h) {
  const d = new Uint8ClampedArray(w * h * 4);
  let s = 999;
  const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s >>> 16) & 255; };
  for (let p = 0, i = 0; p < w * h; p++, i += 4) { d[i] = rnd(); d[i+1] = rnd(); d[i+2] = rnd(); d[i+3] = 255; }
  return d;
}

let fails = 0;
const check = (ok, label, extra) => { if (!ok) fails++; realLog("   " + (ok ? "PASS" : "FAIL") + "  " + label + (extra ? "  " + extra : "")); };

const TEXT = ("Steganography hides data inside an ordinary picture. " +
              "The only change is the lowest bit of each colour channel. ").repeat(60);

for (const [name, c, id] of [["xc_range", codec, 9], ["xc_bitpack", bitpack, 8]]) {
  realLog("=== " + name);
  console.log = quiet.log;
  const payload = c.encodeBytes(TEXT);
  console.log = realLog;

  const orig = carrier(400, 300);
  let sum = 0; for (const v of payload) sum += v;
  const stream = new Uint8Array(16 + payload.length);
  stream.set(header(id, payload.length, TEXT.length, sum & 255), 0);
  stream.set(payload, 16);

  const cap = capacity(400, 300);
  check(stream.length <= cap, "payload fits", stream.length + " / " + cap + " bytes");
  realLog("   info  " + TEXT.length + " chars -> " + stream.length + " bytes of " + cap +
          " (" + ((stream.length / cap) * 100).toFixed(1) + "% used)");

  const mod = new Uint8ClampedArray(orig);
  write(mod, stream, 0);

  let maxD = 0, alphaCh = 0;
  for (let i = 0; i < orig.length; i += 4) {
    for (let ch = 0; ch < 3; ch++) { const d = Math.abs(mod[i+ch] - orig[i+ch]); if (d > maxD) maxD = d; }
    if (mod[i+3] !== orig[i+3]) alphaCh++;
  }
  check(maxD === 1, "max channel delta is 1", "delta " + maxD);
  check(alphaCh === 0, "alpha untouched");

  const h = parse(read(mod, 16, 0));
  check(h && h.codecId === id, "header codec id");
  const got = read(mod, h.payloadLen, 128);
  let s2 = 0; for (const v of got) s2 += v;
  check((s2 & 255) === h.checksum, "checksum valid");
  console.log = quiet.log;
  const back = c.decodeBytes(got);
  console.log = realLog;
  check(back === TEXT, "text recovered exactly");
}

realLog("\n=== does not fit");
console.log = quiet.log;
// Random-ish text, which does not compress. ("x".repeat(200000) would be
// the wrong test: it is one LZ match and fits in a handful of pixels.)
let rs = 4242;
const incompressible = Array.from({ length: 200000 }, () =>
  String.fromCharCode(33 + (((rs = (Math.imul(rs, 1103515245) + 12345) >>> 0) >>> 16) % 90))
).join("");
const huge = codec.encodeBytes(incompressible);
console.log = realLog;
realLog("   info  incompressible " + incompressible.length + " chars -> " +
        huge.length + " bytes, carrier capacity " + capacity(60, 60));
const small = carrier(60, 60);
let rejected = false;
try { write(small, new Uint8Array(16 + huge.length), 0); } catch (e) { rejected = true; }
check(rejected, "oversized text is refused rather than truncated");

// and the reverse: highly repetitive text really does fit
console.log = quiet.log;
const repetitive = codec.encodeBytes("ab".repeat(100000));
console.log = realLog;
let fitsFine = false;
try { write(carrier(60, 60), new Uint8Array(16 + repetitive.length), 0); fitsFine = true; } catch (e) {}
check(fitsFine, "repetitive text still fits when it genuinely can");

realLog("\n" + (fails === 0 ? "all image-mode end-to-end tests PASS" : fails + " FAILURES"));
process.exitCode = fails ? 1 : 0;