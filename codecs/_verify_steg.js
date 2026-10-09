// Tests the LSB steganography engine: capacity maths, round trip through a
// synthetic carrier, imperceptibility bound, and rejection of bad headers.

const STEG_MAGIC = [0x50, 0x45, 0x4e, 0x43];
const STEG_VERSION = 1;
const STEG_HEADER_BYTES = 16;
const STEG_CHANNELS = 3;

function stegCapacityBytes(w, h) { return Math.floor((w * h * STEG_CHANNELS) / 8); }

function stegWrite(img, stream, startBit) {
  let bit = startBit;
  const total = (img.length / 4) * STEG_CHANNELS;
  for (let i = 0; i < stream.length; i++) {
    const byte = stream[i];
    for (let b = 7; b >= 0; b--) {
      if (bit >= total) throw new Error("image does not have enough room");
      const p = Math.floor(bit / STEG_CHANNELS);
      const c = bit % STEG_CHANNELS;
      const o = p * 4 + c;
      img[o] = (img[o] & ~1) | ((byte >> b) & 1);
      bit++;
    }
  }
  return bit;
}

function stegRead(img, n, startBit) {
  const out = new Uint8Array(n);
  let bit = startBit;
  const total = (img.length / 4) * STEG_CHANNELS;
  for (let i = 0; i < n; i++) {
    let byte = 0;
    for (let b = 7; b >= 0; b--) {
      if (bit >= total) throw new Error("image does not have enough room");
      const p = Math.floor(bit / STEG_CHANNELS);
      const c = bit % STEG_CHANNELS;
      byte = (byte * 2) | (img[p * 4 + c] & 1);
      bit++;
    }
    out[i] = byte;
  }
  return out;
}

function stegBuildHeader(codecId, payloadLen, origLen, checksum) {
  const h = new Uint8Array(STEG_HEADER_BYTES);
  h.set(STEG_MAGIC, 0);
  h[4] = STEG_VERSION; h[5] = STEG_CHANNELS; h[6] = codecId; h[7] = 0;
  h[8] = payloadLen & 0xFF; h[9] = (payloadLen >> 8) & 0xFF; h[10] = (payloadLen >> 16) & 0xFF;
  h[11] = origLen & 0xFF; h[12] = (origLen >> 8) & 0xFF; h[13] = (origLen >> 16) & 0xFF;
  h[14] = checksum; h[15] = 0;
  return h;
}
function stegParseHeader(h) {
  for (let i = 0; i < 4; i++) if (h[i] !== STEG_MAGIC[i]) return null;
  if (h[4] !== STEG_VERSION) return null;
  return {
    codecId: h[6],
    payloadLen: h[8] | (h[9] << 8) | (h[10] << 16),
    origLen: h[11] | (h[12] << 8) | (h[13] << 16),
    checksum: h[14]
  };
}

// A carrier that looks like a photo-ish gradient with noise, including
// extreme values (0 and 255) that often break naive LSB writers.
function makeCarrier(w, h) {
  const d = new Uint8ClampedArray(w * h * 4);
  let seed = 12345;
  const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 16) & 0xFF; };
  for (let i = 0, p = 0; p < w * h; p++, i += 4) {
    d[i] = (p % w) & 0xFF;
    d[i + 1] = (p % h) & 0xFF;
    d[i + 2] = rnd();
    d[i + 3] = 255;
  }
  return d;
}

let fails = 0;
const check = (ok, label, extra) => {
  if (!ok) fails++;
  console.log("   " + (ok ? "PASS" : "FAIL") + "  " + label + (extra ? "  " + extra : ""));
};

/* ---- capacity maths ---- */
console.log("=== capacity");
check(stegCapacityBytes(100, 100) === 3750, "100x100 -> 3750 bytes",
      "(got " + stegCapacityBytes(100, 100) + ")");
check(stegCapacityBytes(1920, 1080) === 777600, "1920x1080 -> 777600 bytes",
      "(got " + stegCapacityBytes(1920, 1080) + ")");

/* ---- round trip ---- */
console.log("\n=== round trip");
const W = 200, H = 150;
const orig = makeCarrier(W, H);
const payload = new Uint8Array(4000);
for (let i = 0; i < payload.length; i++) payload[i] = (i * 37 + 11) & 0xFF;
let sum = 0; for (const v of payload) sum += v;

const header = stegBuildHeader(9, payload.length, 12345, sum & 0xFF);
const stream = new Uint8Array(STEG_HEADER_BYTES + payload.length);
stream.set(header, 0);
stream.set(payload, STEG_HEADER_BYTES);

const mod = new Uint8ClampedArray(orig);
stegWrite(mod, stream, 0);

const gotHeader = stegParseHeader(stegRead(mod, STEG_HEADER_BYTES, 0));
check(gotHeader !== null, "header parses");
check(gotHeader && gotHeader.codecId === 9, "codec id survives", JSON.stringify(gotHeader));
check(gotHeader && gotHeader.payloadLen === payload.length, "payload length survives");
check(gotHeader && gotHeader.origLen === 12345, "orig length survives");
check(gotHeader && gotHeader.checksum === (sum & 0xFF), "checksum survives");

const gotPayload = stegRead(mod, gotHeader.payloadLen, STEG_HEADER_BYTES * 8);
let same = gotPayload.length === payload.length;
for (let i = 0; i < payload.length; i++) if (gotPayload[i] !== payload[i]) { same = false; break; }
check(same, "payload bytes identical after round trip");

/* ---- imperceptibility bound ---- */
console.log("\n=== invisibility bound");
let maxDelta = 0, changed = 0, alphaChanged = 0;
for (let i = 0; i < orig.length; i += 4) {
  for (let c = 0; c < 3; c++) {
    const d = Math.abs(mod[i + c] - orig[i + c]);
    if (d > 0) changed++;
    if (d > maxDelta) maxDelta = d;
  }
  if (mod[i + 3] !== orig[i + 3]) alphaChanged++;
}
check(maxDelta <= 1, "every channel moves by at most 1", "max delta = " + maxDelta);
check(alphaChanged === 0, "alpha is never touched", "alpha changes = " + alphaChanged);
const expectedChanged = stream.length * 8 * 0.5;
console.log("   info  " + changed + " channel writes (expect about " +
            Math.round(expectedChanged) + ", i.e. half the bits differ from what was there)");

/* ---- capacity refusal ---- */
console.log("\n=== capacity refusal");
const tiny = makeCarrier(4, 4);
let threw = null;
try { stegWrite(tiny, stream, 0); } catch (e) { threw = e.message; }
check(threw !== null, "oversized payload is rejected, not truncated", threw || "");
check(stegCapacityBytes(4, 4) === 6, "4x4 holds only 6 bytes");

/* ---- foreign image ---- */
console.log("\n=== foreign image");
const foreign = makeCarrier(50, 50);
check(stegParseHeader(stegRead(foreign, STEG_HEADER_BYTES, 0)) === null,
      "a plain image reports no hidden data");

/* ---- corruption detection ---- */
console.log("\n=== corruption");
const damaged = new Uint8ClampedArray(mod);
for (let i = 0; i < 40; i++) damaged[200 + i] ^= 1;
const dh = stegParseHeader(stegRead(damaged, STEG_HEADER_BYTES, 0));
let dsum = 0;
if (dh) {
  const dp = stegRead(damaged, dh.payloadLen, STEG_HEADER_BYTES * 8);
  for (const v of dp) dsum += v;
}
check(dh !== null && (dsum & 0xFF) !== dh.checksum,
      "flipped bits are caught by the checksum");

console.log("\n" + (fails === 0 ? "all steganography tests PASS" : fails + " FAILURES"));
process.exitCode = fails ? 1 : 0;