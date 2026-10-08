/**
 * xc_bitpack.js  --  NEW codec, "level 1".
 *
 * Deliberately mirrors how the existing Kolbe codecs work, with one change:
 * the output is a raw bitstream instead of base-converted block characters.
 *
 * Existing pipeline:  text -> tokens -> base-2^20 block chars -> UTF-8 -> base64 -> pixels
 * This codec:         text -> tokens -> raw bits -------------------------------> pixels
 *
 * That removes two layers of waste at once:
 *   - a block char carries ~20 bits but costs 3 UTF-8 bytes to store
 *   - base64 then spends 8 bits to move 6
 *
 * Token layout (self-delimiting, so no separate length is needed):
 *   1 <8 bits>            dictionary word, id 0..255
 *   0 <1 bit> <8|21 bits> literal character
 *
 * Exposes encodeBytes/decodeBytes for the page's raw-bit pixel path, plus
 * encrypt/decrypt for compatibility with the block-char codecs.
 */

const DICT = [
  // space-aware phrases first (longest match wins)
  " the ", " and ", " to ", " of ", " in ", " for ", " with ", " on ",
  " that ", " is ", " was ", " are ", " be ", " have ", " not ", " it ",
  " this ", " you ", " they ", " we ", " he ", " she ",

  // common inflected forms
  "ing ", "tion", "ment", "ness", "able", "less", "ful ", "ous ", "ive",
  "ity ", "est ", "ant", "ent", "ance", "ence", "ally", "ward", "wise",

  // frequent trigrams / quadgrams
  "the", "and", "ion", "tio", "ent", "ere", "her", "tha", "hat", "ere",
  "res", "ver", "nce", "men", "ith", "ted", "ers", "pro", "thi", "wit",
  "ess", "ect", "rea", "com", "eve", "per", "int", "est", "sta", "our",
  "ect", "ati", "ate", "ter", "his", "all", "con", "for", "are", "was",

  // bigrams
  "th", "he", "in", "er", "an", "re", "on", "at", "en", "nd", "ti",
  "es", "or", "te", "of", "ed", "is", "it", "al", "ar", "st", "to",
  "nt", "ng", "se", "ha", "as", "ou", "io", "le", "ve", "co", "me",
  "de", "hi", "ri", "ne", "ea", "ra", "ce", "li", "ch", "ll", "be",

  // prefixes
  "un", "re", "dis", "pre", "over", "under", "sub", "inter", "non",
  "trans", "multi", "counter", "micro", "semi",

  // standalone words
  "have", "from", "they", "your", "were", "which", "their", "there",
  "would", "could", "should", "about", "other", "these", "those",
  "when", "where", "while", "because", "however", "therefore",
  "compression", "compressed", "information", "encode", "encoded",
  "algorithm", "character", "characters", "decimal", "dictionary",
  "sequence", "frequent", "language", "english", "letter", "letters",

  // punctuation patterns
  ". ", ", ", "? ", "! ", ": ", "; ", ".\n", ",\n", "?\n", "!\n",
  "\n\n", "n't", "'s ", "'re ", "'ll ", "'ve ", "'d ", "'m "
].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));

const DICT_BASE = 0;
const TOKEN_BITS = 8;                 // dictionary ids are 0..255
const MAX_DICT = 256;
if (DICT.length > MAX_DICT) DICT.length = MAX_DICT;

/* ---------------- bit writer ---------------- */
class BitWriter {
  constructor() { this.bytes = []; this.acc = 0; this.nbits = 0; }
  writeBit(b) {
    this.acc = ((this.acc << 1) | (b & 1)) >>> 0;
    if (++this.nbits === 8) { this.bytes.push(this.acc); this.acc = 0; this.nbits = 0; }
  }
  writeBits(value, count) {
    for (let i = count - 1; i >= 0; i--) this.writeBit((value >>> i) & 1);
  }
  finish() { while (this.nbits !== 0) this.writeBit(0); return Uint8Array.from(this.bytes); }
}

/* ---------------- bit reader ---------------- */
class BitReader {
  constructor(bytes) { this.bytes = bytes; this.pos = 0; this.acc = 0; this.nbits = 0; }
  readBit() {
    if (this.nbits === 0) {
      this.acc = this.pos < this.bytes.length ? this.bytes[this.pos++] : 0;
      this.nbits = 8;
    }
    this.nbits--;
    return (this.acc >>> this.nbits) & 1;
  }
  readBits(count) {
    let v = 0;
    for (let i = 0; i < count; i++) v = (v * 2) + this.readBit();
    return v;
  }
}

/* ---------------- encode ---------------- */
function encodeBytes(text) {
  const bytes = new TextEncoder().encode(text);
  const w = new BitWriter();
  const chars = Array.from(text);          // iterate by code point
  const n = chars.length;

  for (let i = 0; i < n; ) {
    let matched = -1;

    // longest dictionary match at this position
    for (let d = 0; d < DICT.length; d++) {
      const entry = DICT[d];
      if (chars[i] === entry[0] && startsWith(chars, i, entry)) { matched = d; break; }
    }

    if (matched >= 0) {
      w.writeBit(1);
      w.writeBits(matched, TOKEN_BITS);
      i += DICT[matched].length;
    } else {
      const cp = chars[i].codePointAt(0);
      w.writeBit(0);
      if (cp < 256) { w.writeBit(0); w.writeBits(cp, 8); }
      else { w.writeBit(1); w.writeBits(cp, 21); }
      i++;
    }
  }

  const payload = w.finish();

  // prepend the original byte length so decode knows when to stop
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, bytes.length);
  const out = new Uint8Array(4 + payload.length);
  out.set(header, 0);
  out.set(payload, 4);
  return out;
}

function startsWith(arr, i, sub) {
  if (i + sub.length > arr.length) return false;
  for (let k = 0; k < sub.length; k++) if (arr[i + k] !== sub[k]) return false;
  return true;
}

/* ---------------- decode ---------------- */
// UTF-8 byte length of each dictionary entry, used to track how much of the
// original text has been produced.
const DICT_BYTES = DICT.map((s) => new TextEncoder().encode(s).length);

function decodeBytes(all) {
  const byteLen = new DataView(all.buffer, all.byteOffset, 4).getUint32(0);
  const r = new BitReader(all.subarray(4));

  let out = "";
  let produced = 0;
  let guard = 0;

  while (produced < byteLen && guard++ < 100000000) {
    if (r.readBit() === 1) {
      const id = r.readBits(TOKEN_BITS);
      const entry = DICT[id];
      if (entry === undefined) break;      // corrupt stream
      out += entry;
      produced += DICT_BYTES[id];
    } else {
      const wide = r.readBit();
      const cp = wide ? r.readBits(21) : r.readBits(8);
      out += String.fromCodePoint(cp);
      produced += cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4;
    }
  }
  return out;
}

/* ---------------- compatibility shims ---------------- */
// The block-char codecs are transported as strings; this one is transported as
// bytes, so these wrap the bytes in a private-use code point range. The page
// prefers encodeBytes/decodeBytes and never calls these.
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
  name: "xc_bitpack",
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