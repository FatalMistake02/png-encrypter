/**
 * xc_range.js  --  NEW codec, "level 2".
 *
 * Raw bitstream straight into pixels (no block characters, no base64), using:
 *   1. LZ77-style match finder over the text produced so far
 *   2. a static dictionary for common words and phrases
 *   3. literals coded with an adaptive binary range coder over mixed
 *      order-0..4 context models
 *
 * Each stage is a superset of the previous, so the coder falls back gracefully:
 * text with no repetition falls back to the dictionary, text with no
 * dictionary words falls back to literals.
 *
 * Every decision the encoder makes is mirrored step-for-step by the decoder,
 * including the hash-chain inserts, so both sides stay byte-identical.
 */

const DICT = [
  " the ", " and ", " to ", " of ", " in ", " for ", " with ", " on ", " that ",
  " is ", " was ", " are ", " be ", " have ", " not ", " it ", " this ",
  " you ", " they ", " we ", " there ", " which ", " their ", " would ",
  " could ", " should ", " about ", " other ", " when ", " while ", " from ",
  "ing ", "tion", "ment", "ness", "able", "less", "ful ", "ous ", "ive",
  "the", "and", "ion", "tio", "ent", "ere", "her", "tha", "hat", "res",
  "ver", "nce", "men", "ith", "ted", "ers", "pro", "thi", "wit", "ess",
  "ect", "rea", "com", "eve", "per", "int", "est", "sta", "our", "ati",
  "ate", "ter", "his", "all", "con", "for", "are", "was", "not", "ive",
  "th", "he", "in", "er", "an", "re", "on", "at", "en", "nd", "ti",
  "es", "or", "te", "of", "ed", "is", "it", "al", "ar", "st", "to",
  "nt", "ng", "se", "ha", "as", "ou", "io", "le", "ve", "co", "me",
  "de", "hi", "ri", "ne", "ea", "ra", "ce", "li", "ch", "ll", "be",
  "un", "re", "dis", "pre", "over", "under", "inter", "non", "trans",
  "have", "they", "your", "were", "there", "these", "those", "been",
  "because", "however", "therefore", "between", "through", "against",
  "compression", "compressed", "information", "encoding", "algorithm",
  "character", "characters", "sequence", "frequent", "language",
  ". ", ", ", "? ", "! ", ": ", "; ", ".\n", ",\n", "?\n", "!\n", "\n\n",
  "n't", "'s ", "'re ", "'ll ", "'ve ", "'d ", "'m "
].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));

// Everything inside the codec works on CODE POINT NUMBERS, not JS strings.
// Mixing the two silently breaks hashing (Math.imul('T', ...) is NaN) and
// equality (number !== string), which desynchronises encoder and decoder.
const DICT_CPS = DICT.map((s) => Array.from(s, (ch) => ch.codePointAt(0)));
const DICT_LEN = DICT_CPS.map((a) => a.length);
const TOKEN_BITS = Math.ceil(Math.log2(DICT.length));

const MIN_MATCH = 4;
const MAX_MATCH = 273;
const MAX_DIST = 1 << 16;
const LITERAL_WIDTHS = [8, 16, 21];   // indexed by transmitted width class

/* ================= binary range coder (LZMA style) ================= */
const TOP = 1 << 24;
const MODEL_BITS = 11;
const MODEL_TOTAL = 1 << MODEL_BITS;   // 2048
const MOVE_BITS = 5;
const PROB_INIT = MODEL_TOTAL >> 1;    // 1024

class RangeEncoder {
  constructor() {
    this.out = []; this.low = 0; this.range = 0xFFFFFFFF;
    this.cache = 0; this.cacheSize = 1;
  }
  shiftLow() {
    // `low` can exceed 2^32, so the carry word must be read with Math.floor.
    // `low >>> 32` is WRONG: >>> applies ToUint32 to its operand first, which
    // truncates 2^32 to 0 and silently drops every carry.
    const carry = Math.floor(this.low / 4294967296);
    if (carry !== 0 || (this.low >>> 0) < 0xFF000000) {
      let temp = this.cache;
      do { this.out.push((temp + carry) & 0xFF); temp = 0xFF; } while (--this.cacheSize);
      this.cache = (this.low >>> 24) & 0xFF;
    }
    this.cacheSize++;
    this.low = ((this.low % 0x1000000) * 256) >>> 0;
  }
  bit(probs, i, b) {
    const p = probs[i];
    const bound = (this.range >>> MODEL_BITS) * p;
    if (b === 0) { this.range = bound >>> 0; probs[i] = p + ((MODEL_TOTAL - p) >>> MOVE_BITS); }
    else { this.low += bound; this.range = (this.range - bound) >>> 0; probs[i] = p - (p >>> MOVE_BITS); }
    while (this.range < TOP) { this.range = (this.range * 256) >>> 0; this.shiftLow(); }
  }
  // Code a bit against an explicit probability, without updating it here.
  // The caller adapts the underlying model afterwards, which keeps the
  // mixed probability and the per-order trees consistent on both sides.
  bitP(p, b) {
    const bound = (this.range >>> MODEL_BITS) * p;
    if (b === 0) { this.range = bound >>> 0; }
    else { this.low += bound; this.range = (this.range - bound) >>> 0; }
    while (this.range < TOP) { this.range = (this.range * 256) >>> 0; this.shiftLow(); }
  }
  finish() { for (let i = 0; i < 5; i++) this.shiftLow(); return Uint8Array.from(this.out); }
}

class RangeDecoder {
  constructor(bytes) {
    this.b = bytes; this.pos = 1; this.range = 0xFFFFFFFF; this.code = 0;
    for (let i = 0; i < 4; i++) this.code = ((this.code * 256) + this.next()) >>> 0;
  }
  next() { return this.pos < this.b.length ? this.b[this.pos++] : 0; }
  bit(probs, i) {
    const p = probs[i];
    const bound = (this.range >>> MODEL_BITS) * p;
    let b;
    if (this.code < bound) { this.range = bound >>> 0; probs[i] = p + ((MODEL_TOTAL - p) >>> MOVE_BITS); b = 0; }
    else { this.code = (this.code - bound) >>> 0; this.range = (this.range - bound) >>> 0; probs[i] = p - (p >>> MOVE_BITS); b = 1; }
    while (this.range < TOP) { this.range = (this.range * 256) >>> 0; this.code = ((this.code * 256) + this.next()) >>> 0; }
    return b;
  }
  bitP(p) {
    const bound = (this.range >>> MODEL_BITS) * p;
    let b;
    if (this.code < bound) { this.range = bound >>> 0; b = 0; }
    else { this.code = (this.code - bound) >>> 0; this.range = (this.range - bound) >>> 0; b = 1; }
    while (this.range < TOP) { this.range = (this.range * 256) >>> 0; this.code = ((this.code * 256) + this.next()) >>> 0; }
    return b;
  }
}

/* ================= context models ================= */
const CTX_BITS = 15;
const CTX_MASK = (1 << CTX_BITS) - 1;
const SLOTS = (CTX_MASK + 1) * 8;
const SLOT_MASK = SLOTS - 1;
// Literal coding uses a per-context adaptive BINARY TREE over the whole byte,
// not a separate model per bit position.
//
// Coding each bit in its own context splits the statistics 8 ways, so every
// context only sees an eighth of the data and learns slowly. A tree indexed by
// the bits already coded for this byte (the PPM-style partial node) lets one
// context learn the joint distribution of the byte, which is what actually
// predicts English letters.
const LIT_CTX_BITS = 11;
const LIT_CTX_MASK = (1 << LIT_CTX_BITS) - 1;
const LIT_ORDERS = 4;
const LIT_SLOTS = (LIT_CTX_MASK + 1) * 256;

function newProbs() { return new Uint16Array(SLOTS).fill(PROB_INIT); }
function newLitProbs() { return new Uint16Array(LIT_SLOTS).fill(PROB_INIT); }

function hashCtx(hist, histLen, order) {
  let h = 0x9E3779B9;
  for (let k = 1; k <= order; k++) {
    const idx = histLen - k;
    const v = idx >= 0 ? hist[idx] : 0;
    h = (Math.imul(h ^ v, 2654435761) + (h >>> 7)) >>> 0;
  }
  return h & CTX_MASK;
}

class Model {
  constructor() {
    this.lit = []; for (let i = 0; i < LIT_ORDERS; i++) this.lit.push(newLitProbs());
    this.flagWide = newProbs();
    this.isMatch = newProbs();     // LZ match vs not
    this.isDict = newProbs();      // dictionary word vs literal
    this.tokenId = newProbs();
    this.lenBits = newProbs();
    this.distHigh = newProbs();
  }

  // Mix the per-order predictions into one probability for the next literal
  // bit, given the partial node of the byte currently being coded.
  mixLiteral(hist, histLen, node) {
    let sum = 0;
    for (let o = 0; o < LIT_ORDERS; o++) {
      const ctx = hashCtx(hist, histLen, o) & LIT_CTX_MASK;
      sum += this.lit[o][(ctx << 8) | node];
    }
    let p = (sum / LIT_ORDERS) | 0;
    if (p < 1) p = 1; else if (p > MODEL_TOTAL - 1) p = MODEL_TOTAL - 1;
    return p;
  }

  // Feed the observed bit back into every per-order tree. Both sides must run
  // this with the same history, or the probabilities diverge.
  updateLiteral(hist, histLen, node, bit) {
    for (let o = 0; o < LIT_ORDERS; o++) {
      const ctx = hashCtx(hist, histLen, o) & LIT_CTX_MASK;
      const i = (ctx << 8) | node;
      const p = this.lit[o][i];
      if (bit === 0) this.lit[o][i] = p + ((MODEL_TOTAL - p) >>> MOVE_BITS);
      else this.lit[o][i] = p - (p >>> MOVE_BITS);
    }
  }
}

/* ================= match finder =================
 * A single-slot hash table: hash of 4 characters -> most recent position.
 * The decoder never searches, but it MUST perform the identical inserts or
 * the two sides drift apart. Both sides call addChars() for every emitted
 * character, so the tables stay in lockstep.
 */
const HASH_BITS = 17;
const HASH_SIZE = 1 << HASH_BITS;
const HASH_MASK = HASH_SIZE - 1;

function hash4(a, b, c, d) {
  let h = Math.imul(a, 2654435761) ^ Math.imul(b, 40503) ^ Math.imul(c, 2246822519) ^ Math.imul(d, 3266489917);
  return (h ^ (h >>> 15)) & HASH_MASK;
}

class MatchFinder {
  constructor() { this.table = new Int32Array(HASH_SIZE); this.out = []; }

  // Index every 4-gram that starts at p and is fully available. The key is the
  // 4-gram STARTING at p and the stored value is p+1 (0 means empty).
  index(p) {
    const out = this.out;
    if (p + MIN_MATCH > out.length) return;
    this.table[hash4(out[p], out[p + 1], out[p + 2], out[p + 3])] = p + 1;
  }

  // Longest match for srcChars[pos..] against already-produced output.
  find(pos, srcChars) {
    if (pos + MIN_MATCH > srcChars.length) return null;
    const slot = this.table[hash4(
      srcChars[pos], srcChars[pos + 1], srcChars[pos + 2], srcChars[pos + 3]
    )];
    if (slot <= 0) return null;
    const start = slot - 1;
    const dist = pos - start;
    if (dist <= 0 || dist > MAX_DIST) return null;

    let len = 0;
    const limit = Math.min(MAX_MATCH, srcChars.length - pos);
    while (len < limit && srcChars[start + len] === srcChars[pos + len]) len++;
    if (len < MIN_MATCH) return null;
    return { len, dist };
  }

  push(chars) {
    for (let k = 0; k < chars.length; k++) {
      this.out.push(chars[k]);
      this.index(this.out.length - MIN_MATCH);
    }
  }
  pushOne(ch) {
    this.out.push(ch);
    this.index(this.out.length - MIN_MATCH);
  }
  // Copy `len` chars from `dist` back, one at a time.
  // A match may overlap the region being written (dist < len), so slicing the
  // source would truncate it. Reading out[out.length - dist] on each step
  // advances the source as the output grows, which is the standard LZ77
  // overlapping-copy rule.
  copyBack(dist, len) {
    const added = [];
    for (let k = 0; k < len; k++) {
      const srcIdx = this.out.length - dist;
      if (srcIdx < 0) break;
      const cp = this.out[srcIdx];
      added.push(cp);
      this.pushOne(cp);
    }
    return added;
  }
}

function startsWith(arr, i, sub) {
  if (i + sub.length > arr.length) return false;
  for (let k = 0; k < sub.length; k++) if (arr[i + k] !== sub[k]) return false;
  return true;
}

/* ================= encode ================= */
function encodeBytes(text) {
  const cps = Array.from(text, (ch) => ch.codePointAt(0));
  const n = cps.length;

  const rc = new RangeEncoder();
  const m = new Model();
  const mf = new MatchFinder();

  for (let i = 0; i < n; ) {
    const ctx2 = hashCtx(mf.out, mf.out.length, 2);

    const lz = mf.find(i, cps);
    let dictId = -1;
    for (let d = 0; d < DICT_CPS.length; d++) {
      if (cps[i] === DICT_CPS[d][0] && startsWith(cps, i, DICT_CPS[d])) { dictId = d; break; }
    }
    const dictLen = dictId >= 0 ? DICT_LEN[dictId] : 0;

    // prefer the LZ match when it is at least as long as the dictionary hit
    if (lz && lz.len >= Math.max(MIN_MATCH, dictLen)) {
      rc.bit(m.isMatch, (ctx2 << 1) & SLOT_MASK, 1);
      const code = lz.len - MIN_MATCH;
      for (let k = 15; k >= 0; k--) rc.bit(m.lenBits, k & SLOT_MASK, (code >>> k) & 1);
      const d = lz.dist - 1;
      for (let k = 15; k >= 0; k--) rc.bit(m.distHigh, k & SLOT_MASK, (d >>> (k + 8)) & 1);
      for (let k = 7; k >= 0; k--) rc.bit(m.lenBits, (256 + k) & SLOT_MASK, (d >>> k) & 1);
      mf.copyBack(lz.dist, lz.len);
      i += lz.len;
      continue;
    }

    rc.bit(m.isMatch, (ctx2 << 1) & SLOT_MASK, 0);

    if (dictId >= 0) {
      rc.bit(m.isDict, (ctx2 << 1) & SLOT_MASK, 1);
      for (let k = TOKEN_BITS - 1; k >= 0; k--) rc.bit(m.tokenId, k & SLOT_MASK, (dictId >> k) & 1);
      mf.push(DICT_CPS[dictId]);
      i += DICT_CPS[dictId].length;
      continue;
    }

    rc.bit(m.isDict, (ctx2 << 1) & SLOT_MASK, 0);
    const cp = cps[i];
    const cls = cp < 256 ? 0 : cp < 0x10000 ? 1 : 2;
    const width = LITERAL_WIDTHS[cls];
    const wb = hashCtx(mf.out, mf.out.length, 1);
    rc.bit(m.flagWide, ((wb << 1) | 0) & SLOT_MASK, (cls >> 1) & 1);
    rc.bit(m.flagWide, ((wb << 1) | 1) & SLOT_MASK, cls & 1);
    let node = 1;                     // root of the per-context byte tree
    for (let k = 0; k < width; k++) {
      const bit = (cp >>> (width - 1 - k)) & 1;
      const p = m.mixLiteral(mf.out, mf.out.length, node);
      rc.bitP(p, bit);
      m.updateLiteral(mf.out, mf.out.length, node, bit);
      node = node * 2 + bit;
    }
    mf.pushOne(cp);
    i++;
  }

  const body = rc.finish();
  const header = new Uint8Array(8);
  const dv = new DataView(header.buffer);
  dv.setUint32(0, n);
  dv.setUint32(4, mf.out.length);

  const out = new Uint8Array(8 + body.length);
  out.set(header, 0);
  out.set(body, 8);
  return out;
}

/* ================= decode ================= */
function decodeBytes(all) {
  const dv = new DataView(all.buffer, all.byteOffset, all.byteLength);
  const targetChars = dv.getUint32(0);
  const targetBytes = dv.getUint32(4);

  const rc = new RangeDecoder(all.subarray(8));
  const m = new Model();
  const mf = new MatchFinder();

  const parts = [];
  let producedChars = 0;
  let guard = 0;

  while (producedChars < targetChars && mf.out.length < targetBytes && guard++ < 500000000) {
    const ctx2 = hashCtx(mf.out, mf.out.length, 2);

    if (rc.bit(m.isMatch, (ctx2 << 1) & SLOT_MASK) === 1) {
      let code = 0;
      for (let k = 15; k >= 0; k--) code = (code * 2) + rc.bit(m.lenBits, k & SLOT_MASK);
      // 16 bits of (d >>> 8), then 8 raw bits of d. The low byte must be
      // added by weight: shift-accumulating it after `hi * 256` would shift
      // the whole value left another 8 times.
      let hi = 0;
      for (let k = 15; k >= 0; k--) hi = (hi * 2) + rc.bit(m.distHigh, k & SLOT_MASK);
      let d = hi * 256;
      for (let k = 7; k >= 0; k--) d += rc.bit(m.lenBits, (256 + k) & SLOT_MASK) * (1 << k);
      const len = code + MIN_MATCH;
      const dist = d + 1;
      if (dist > mf.out.length || len <= 0) break;      // corrupt stream
      // Incremental copy: the match may overlap what is being written.
      const chunk = mf.copyBack(dist, len);
      if (chunk.length !== len) break;
      // parts must hold STRINGS: Array.join stringifies numbers, which would
      // turn code point 97 into the two characters "97". The arrow is
      // required because Array.map also passes (element, index, array), and
      // String.fromCodePoint would treat those extra arguments as code points.
      parts.push(chunk.map((c) => String.fromCodePoint(c)).join(""));
      producedChars += len;
    } else if (rc.bit(m.isDict, (ctx2 << 1) & SLOT_MASK) === 1) {
      let id = 0;
      for (let k = TOKEN_BITS - 1; k >= 0; k--) id = (id * 2) + rc.bit(m.tokenId, k & SLOT_MASK);
      const entry = DICT_CPS[id];
      if (entry === undefined) break;                 // corrupt stream
      parts.push(DICT[id]);
      mf.push(entry);
      producedChars += entry.length;
    } else {
      const wb = hashCtx(mf.out, mf.out.length, 1);
      const cls = (rc.bit(m.flagWide, ((wb << 1) | 0) & SLOT_MASK) << 1)
                | rc.bit(m.flagWide, ((wb << 1) | 1) & SLOT_MASK);
      const width = LITERAL_WIDTHS[cls];
      let cp = 0;
      let node = 1;
      for (let k = 0; k < width; k++) {
        const p = m.mixLiteral(mf.out, mf.out.length, node);
        const bit = rc.bitP(p);
        m.updateLiteral(mf.out, mf.out.length, node, bit);
        node = node * 2 + bit;
        cp = (cp * 2) + bit;
      }
      parts.push(String.fromCodePoint(cp));
      mf.pushOne(cp);
      producedChars += 1;
    }
  }

  return parts.join("");
}

/* ================= compatibility shims ================= */
const SHIFT = 0xE000;
const bytesToString = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] + SHIFT);
  return s;
};
const stringToBytes = (s) => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) - SHIFT;
  return out;
};

const api = {
  name: "xc_range",
  encodeBytes,
  decodeBytes,
  encrypt: (text) => bytesToString(encodeBytes(text)),
  decrypt: (s) => decodeBytes(stringToBytes(s))
};

if (typeof window !== "undefined") {
  window.encrypt = api.encrypt;
  window.decrypt = api.decrypt;
  window.XCCodec = api;
}
export default api;