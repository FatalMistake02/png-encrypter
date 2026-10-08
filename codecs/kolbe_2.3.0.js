import pako from "./pako.esm.mjs";

let helper;

// local copy only (no CDN dependency)
helper = await import('./helpers.js');

const enc = new TextEncoder();
const dec = new TextDecoder();

/* --- CONFIGURATION --- */
const STATIC_DICT = [
  " the "," and "," to "," of "," in "," that "," is "," for ",
  "ing","tion","ion","ed ","ly ","er ","re ","on ","th","he","in","er"
].sort((a,b)=>b.length-a.length);

const MIN_MATCH = 4;
const MAX_MATCH = 10;
const MIN_OCCURRENCE = 2;
const MAX_DICT_ENTRIES = 200; // keep <=254 so token indices fit in one byte
const ESC = 0xFF; // escape marker for tokens (safe in UTF-8 byte stream)

/* --- BLOCK_CHARS / keyed alphabet --- */
let BLOCK_CHARS = null;
function buildBlockChars() {
  if (BLOCK_CHARS) return BLOCK_CHARS;
  const out = [];
  const reCcCf = /[\p{Cc}\p{Cf}]/u;
  const reMnMe = /\p{Mn}|\p{Me}/u;
  for (let cp = 0x21; cp <= 0xFFFD; cp++) {
    if (cp >= 0xD800 && cp <= 0xDFFF) { cp = 0xDFFF; continue; }
    try {
      const ch = String.fromCodePoint(cp);
      if (/\s/.test(ch)) continue;
      if (reCcCf.test(ch)) continue;
      if (reMnMe.test(ch)) continue;
      out.push(ch);
    } catch (e) {
      // ignore invalid codepoints
    }
  }
  BLOCK_CHARS = out;
  return out;
}

async function getKeyedChars(key) {
  if (!BLOCK_CHARS) BLOCK_CHARS = buildBlockChars();
  if (!key) return BLOCK_CHARS;
  const off = await helper.sha256ToOffset(key, BLOCK_CHARS.length);
  return BLOCK_CHARS.slice(off).concat(BLOCK_CHARS.slice(0, off));
}

/* --- Dynamic dictionary (digger) --- */
function findCandidates(text, sampleLimit = 200000) {
  const s = (text.length > sampleLimit) ? text.slice(0, sampleLimit) : text;
  const counts = new Map();

  for (let L = MIN_MATCH; L <= MAX_MATCH; L++) {
    const seen = new Map();
    for (let i = 0; i + L <= s.length; i++) {
      const sub = s.slice(i, i + L);
      const v = (seen.get(sub) || 0) + 1;
      seen.set(sub, v);
    }
    for (const [sub, cnt] of seen.entries()) {
      if (cnt >= MIN_OCCURRENCE) {
        counts.set(sub, (counts.get(sub) || 0) + cnt);
      }
    }
  }

  const candidates = [];
  for (const [sub, cnt] of counts.entries()) {
    const len = sub.length;
    const savingPer = len - 3; // ESC + 1-byte index (3 bytes)
    const estSavings = cnt * savingPer - (2 + len); // dict storage cost
    if (estSavings > 0) candidates.push({ sub, cnt, len, estSavings });
  }

  candidates.sort((a,b)=>b.estSavings - a.estSavings);
  return candidates.slice(0, MAX_DICT_ENTRIES);
}

function buildDynamicDict(text) {
  const candidates = findCandidates(text);
  const dict = candidates.map(c => c.sub);
  const merged = dict.concat(STATIC_DICT.filter(s => !dict.includes(s)));
  return merged.slice(0, 254);
}

/* --- Tokenize / detokenize using ESC + single-byte index --- */
function tokenizeWithDict(str, dict) {
  const out = [];
  let i = 0;
  while (i < str.length) {
    let matched = false;
    for (let j = 0; j < dict.length; j++) {
      const d = dict[j];
      if (str.startsWith(d, i)) {
        out.push(ESC, j);
        i += d.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    const cp = str.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const bs = enc.encode(ch);
    for (const b of bs) out.push(b);
    i += ch.length;
  }
  return new Uint8Array(out);
}

function detokenizeFromBytesWithDict(bytes, dict) {
  const result = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === ESC) {
      if (i + 1 >= bytes.length) throw new Error("Truncated token stream");
      const idx = bytes[++i];
      if (idx >= dict.length) throw new Error("Invalid token index");
      const chunk = enc.encode(dict[idx]);
      for (const cb of chunk) result.push(cb);
    } else {
      result.push(b);
    }
  }
  return dec.decode(new Uint8Array(result));
}

/* --- Huffman coding (canonical) --- */
function buildHuffmanLengths(bytes) {
  const freq = new Uint32Array(256);
  for (const b of bytes) freq[b]++;

  const nodes = [];
  for (let s = 0; s < 256; s++) {
    if (freq[s] > 0) nodes.push({ sym: s, w: freq[s] });
  }
  if (nodes.length === 0) return {};

  if (nodes.length === 1) {
    return { lengths: { [nodes[0].sym]: 1 } };
  }

  const pq = nodes.slice();
  pq.sort((a,b)=>a.w - b.w);
  while (pq.length > 1) {
    const a = pq.shift();
    const b = pq.shift();
    const parent = { w: a.w + b.w, left: a, right: b };
    let inserted = false;
    for (let i = 0; i < pq.length; i++) {
      if (parent.w <= pq[i].w) { pq.splice(i, 0, parent); inserted = true; break; }
    }
    if (!inserted) pq.push(parent);
  }
  const root = pq[0];

  const lengths = {};
  function walk(n, depth) {
    if (!n) return;
    if (n.sym !== undefined) {
      lengths[n.sym] = depth;
      return;
    }
    walk(n.left, depth + 1);
    walk(n.right, depth + 1);
  }
  walk(root, 0);

  return { lengths };
}

function buildCanonicalCodes(lengthsMap) {
  const items = Object.entries(lengthsMap).map(([s,l]) => ({ sym: Number(s), len: l }));
  items.sort((a,b) => a.len - b.len || a.sym - b.sym);
  const codes = {};
  let code = 0;
  let prevLen = 0;
  for (const it of items) {
    if (it.len !== prevLen) {
      code <<= (it.len - prevLen);
      prevLen = it.len;
    }
    codes[it.sym] = { code: code, len: it.len };
    code++;
  }
  const byLen = {};
  for (const symStr in codes) {
    const s = Number(symStr);
    const { code: c, len } = codes[s];
    if (!byLen[len]) byLen[len] = new Map();
    byLen[len].set(c, s);
  }
  return { codes, byLen };
}

function huffmanEncodeWithBitlen(bytes, codes) {
  const out = [];
  let cur = 0;
  let nbits = 0;
  let totalBits = 0;
  for (const b of bytes) {
    const e = codes[b];
    if (!e) throw new Error("Missing Huffman code for symbol: " + b);
    const { code, len } = e;
    totalBits += len;
    for (let k = len - 1; k >= 0; k--) {
      const bit = (code >> k) & 1;
      cur = (cur << 1) | bit;
      nbits++;
      if (nbits === 8) {
        out.push(cur & 0xFF);
        cur = 0; nbits = 0;
      }
    }
  }
  if (nbits > 0) {
    cur = cur << (8 - nbits);
    out.push(cur & 0xFF);
  }
  return { bytes: new Uint8Array(out), bitLen: totalBits };
}

function huffmanDecodeFromBits(bytes, bitLen, byLen) {
  const out = [];
  let acc = 0;
  let accLen = 0;
  let bitsConsumed = 0;
  for (let i = 0; i < bytes.length; i++) {
    let val = bytes[i];
    for (let b = 7; b >= 0; b--) {
      if (bitsConsumed >= bitLen) break;
      const bit = (val >> b) & 1;
      acc = (acc << 1) | bit;
      accLen++;
      bitsConsumed++;
      const mp = byLen[accLen];
      if (mp && mp.has(acc)) {
        out.push(mp.get(acc));
        acc = 0;
        accLen = 0;
      }
    }
  }
  return new Uint8Array(out);
}

/* --- framing helpers --- */
function u32(n){ return [(n>>24)&0xFF,(n>>16)&0xFF,(n>>8)&0xFF,n&0xFF]; }

function makeFrameRaw(dict, huffEntries, dataBitLen, dataBytes) {
  const dictEncoded = dict.map(s => enc.encode(s));
  let dictBytesLen = 0;
  for (const d of dictEncoded) dictBytesLen += d.length;
  const huffEntriesLen = huffEntries.length;
  const headerLen = 2 + dict.length*2 + (huffEntriesLen?2 + (huffEntriesLen*2):2) + 4;
  const totalLen = headerLen + dictBytesLen + dataBytes.length;
  const out = new Uint8Array(totalLen);
  let p = 0;
  out[p++] = (dict.length >> 8) & 0xFF;
  out[p++] = dict.length & 0xFF;
  for (const b of dictEncoded) {
    out[p++] = (b.length >> 8) & 0xFF;
    out[p++] = b.length & 0xFF;
    out.set(b, p); p += b.length;
  }
  out[p++] = (huffEntriesLen >> 8) & 0xFF;
  out[p++] = huffEntriesLen & 0xFF;
  for (const h of huffEntries) {
    out[p++] = h.sym & 0xFF;
    out[p++] = h.len & 0xFF;
  }
  out.set(u32(dataBitLen), p); p += 4;
  out.set(dataBytes, p); p += dataBytes.length;
  return out;
}

function parseFrameRaw(frameBytes) {
  let p = 0;
  if (frameBytes.length < 6) throw new Error("Frame too small");
  const dictCount = (frameBytes[p++]<<8) | frameBytes[p++];
  const dict = [];
  for (let i = 0; i < dictCount; i++) {
    const ln = (frameBytes[p++]<<8) | frameBytes[p++];
    const slice = frameBytes.slice(p, p + ln);
    dict.push(dec.decode(slice));
    p += ln;
  }
  const huffCount = (frameBytes[p++]<<8) | frameBytes[p++];
  const huffEntries = [];
  for (let i = 0; i < huffCount; i++) {
    const sym = frameBytes[p++];
    const len = frameBytes[p++];
    huffEntries.push({ sym, len });
  }
  const dataBitLen = (frameBytes[p++]<<24) | (frameBytes[p++]<<16) | (frameBytes[p++]<<8) | frameBytes[p++];
  const data = frameBytes.slice(p);
  return { dict, huffEntries, dataBitLen, data };
}

/* --- bitpack keyed chars --- */
function encodeBytesToChars(bytes, keyedChars) {
  const bitsPerChar = Math.floor(Math.log2(keyedChars.length));
  if (bitsPerChar <= 0) throw new Error("charset too small");
  let buf = 0n;
  let bits = 0n;
  let out = "";
  const mask = (1 << bitsPerChar) - 1;
  for (let i = 0; i < bytes.length; i++) {
    buf = (buf << 8n) | BigInt(bytes[i]);
    bits += 8n;
    while (bits >= BigInt(bitsPerChar)) {
      bits -= BigInt(bitsPerChar);
      const idx = Number((buf >> bits) & BigInt(mask));
      out += keyedChars[idx];
    }
  }
  if (bits > 0n) {
    const idx = Number((buf << (BigInt(bitsPerChar) - bits)) & BigInt(mask));
    out += keyedChars[idx];
  }
  return out;
}

function decodeCharsToBytes(str, keyedChars) {
  const map = Object.fromEntries(keyedChars.map((c, i) => [c, i]));
  const bitsPerChar = Math.floor(Math.log2(keyedChars.length));
  let buf = 0n;
  let bits = 0n;
  const out = [];
  const mask = (1 << bitsPerChar) - 1;
  for (let i = 0; i < str.length;) {
    const code = str.codePointAt(i);
    const ch = String.fromCodePoint(code);
    i += ch.length;
    const idx = map[ch];
    if (idx === undefined) throw new Error("Invalid encoded character during decode");
    buf = (buf << BigInt(bitsPerChar)) | BigInt(idx);
    bits += BigInt(bitsPerChar);
    while (bits >= 8n) {
      bits -= 8n;
      const byte = Number((buf >> bits) & 0xFFn);
      out.push(byte);
    }
  }
  return new Uint8Array(out);
}

/* --- XOR helper --- */
function xorBytesWithKey(u8, keyStr) {
  if (!keyStr) return u8;
  const k = enc.encode(keyStr);
  if (k.length === 0) return u8;
  const out = new Uint8Array(u8.length);
  for (let i = 0; i < u8.length; i++) out[i] = u8[i] ^ k[i % k.length];
  return out;
}

/* --- HIGH LEVEL: encode / decode --- */
const MODE_SIMPLE = 0;
const MODE_ADVANCED = 1;

async function compressAndEncode(text, key) {
  const utf8 = enc.encode(text);

  // Mode 0: plain deflate of UTF-8 (low overhead for short inputs)
  const simpleCompressed = pako.deflate(utf8);
  const simpleFrame = new Uint8Array(1 + 4 + simpleCompressed.length);
  simpleFrame[0] = MODE_SIMPLE;
  simpleFrame.set(u32(simpleCompressed.length), 1);
  simpleFrame.set(simpleCompressed, 5);

  // Mode 1: dynamic dict + huffman + deflate (better for larger/repetitive text)
  const dynamic = buildDynamicDict(text);
  const dict = dynamic.slice(0, MAX_DICT_ENTRIES).concat(STATIC_DICT.filter(s => !dynamic.includes(s))).slice(0, 254);

  const tokenBytes = tokenizeWithDict(text, dict);

  const { lengths } = buildHuffmanLengths(tokenBytes);
  const lengthMap = lengths || {};
  const canonical = buildCanonicalCodes(lengthMap);
  const codes = canonical.codes || {};

  const huffEntries = Object.keys(lengthMap).map(k => ({ sym: Number(k), len: lengthMap[k] }));

  const { bytes: huffBytes, bitLen } = huffmanEncodeWithBitlen(tokenBytes, codes);

  const preframe = makeFrameRaw(dict, huffEntries, bitLen, huffBytes);

  const advancedCompressed = pako.deflate(preframe);
  const advancedFrame = new Uint8Array(1 + 4 + advancedCompressed.length);
  advancedFrame[0] = MODE_ADVANCED;
  advancedFrame.set(u32(advancedCompressed.length), 1);
  advancedFrame.set(advancedCompressed, 5);

  const frame = (advancedFrame.length <= simpleFrame.length) ? advancedFrame : simpleFrame;
  const xored = xorBytesWithKey(frame, key);

  const keyed = await getKeyedChars(key || "");
  return encodeBytesToChars(xored, keyed);
}

async function decodeAndDecompress(str, key) {
  const keyed = await getKeyedChars(key || "");
  const bytes = decodeCharsToBytes(str, keyed);
  const descr = xorBytesWithKey(bytes, key);

  if (descr.length < 4) throw new Error("Frame too small");

  let mode = descr[0];
  let headerOffset = 1;
  // Legacy support: no mode byte, length starts at 0
  if (mode !== MODE_SIMPLE && mode !== MODE_ADVANCED) {
    mode = MODE_ADVANCED;
    headerOffset = 0;
  }

  if (descr.length < headerOffset + 4) throw new Error("Frame too small");
  const clen = (descr[headerOffset]<<24)|(descr[headerOffset+1]<<16)|(descr[headerOffset+2]<<8)|descr[headerOffset+3];
  if (descr.length < headerOffset + 4 + clen) throw new Error("Frame truncated or invalid compressed length");
  const compressed = descr.slice(headerOffset + 4, headerOffset + 4 + clen);

  if (mode === MODE_SIMPLE) {
    const raw = pako.inflate(compressed);
    return dec.decode(raw);
  }

  const preframe = pako.inflate(compressed);
  const { dict, huffEntries, dataBitLen, data } = parseFrameRaw(preframe);

  const lengthsMap = {};
  for (const he of huffEntries) lengthsMap[he.sym] = he.len;
  const canonical = buildCanonicalCodes(lengthsMap);
  const byLen = canonical.byLen || {};

  const tokenBytes = huffmanDecodeFromBits(data, dataBitLen, byLen);
  return detokenizeFromBytesWithDict(tokenBytes, dict);
}

async function encode(text, key) {
  return compressAndEncode(String(text ?? ""), key || "");
}

async function decode(str, key) {
  if (!str) return "";
  return decodeAndDecompress(String(str ?? ""), key || "");
}

window.encrypt = encode;
window.decrypt = decode;
