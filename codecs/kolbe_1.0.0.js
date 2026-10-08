/* Shared block encoder/decoder — pure logic (no DOM).
   Exposes: encodeToBlocks(input, key = ''), decodeFromBlocks(str, key = '')
   Attaches to window.BlockCodec and window.encodeToBlocks / window.decodeFromBlocks
*/
(function(global){
  'use strict';

  // ================= CONFIG =================
  // Generate printable Unicode dynamically
  const blockChars = (() => {
    const out = [];

    for (let cp = 0x21; cp <= 0x10FFFF; cp++) {
      // skip surrogates
      if (cp >= 0xD800 && cp <= 0xDFFF) continue;

      try {
        const ch = String.fromCodePoint(cp);

        // reject whitespace
        if (/\s/.test(ch)) continue;

        // reject control / format
        if (/[\p{Cc}\p{Cf}]/u.test(ch)) continue;

        // reject combining marks
        if (/\p{Mn}|\p{Me}/u.test(ch)) continue;

        out.push(ch);
      } catch (e) {
        // some codepoints may throw in older environments — ignore
      }
    }

    return out;
  })();

  const bigrams = [
    "th","he","in","er","an","re","on","at","en","nd",
    "ti","es","or","te","of","ed","is","it","al","ar",
    "st","to","nt","ng","se","ha","as","ou","io","le",
    "ve","co","me","de","hi","ri"
  ];

  const DICT = [
    // space aware
    " the ", " and ", " to ", " of ", " in ", " for ", " with ", " on ", " that ",
    " is ", " was ", " are ", " be ", " have ", " not ", " it ", " this ", " you ",

    // core trigrams
    "the","and","ing","ion","tio","ent","for","tha","ati","her","ter","ere","ate",
    "his","con","res","ver","all","nce","men","ith","ted","ers","pro","thi","wit",
    "are","ess","not","ive","was","ect","rea","com","eve","per","int","est","sta",

    // bigrams (real English only)
    "th","he","in","er","an","re","on","at","en","nd","ti","es","or","te","of","ed",
    "is","it","al","ar","st","to","nt","ng","se","ha","as","ou","io","le","ve","co",

    // suffixes
    "ing ","tion","ment","ness","able","less","ful","ous","ive","ity","est","ant","ent",

    // prefixes
    "un","re","dis","pre","over","under","sub","inter","non",

    // common short words
    "the","and","for","you","with","this","that","have","from","they","your","were",
    "which","their","there","would","could","should",

    // punctuation patterns
    ". ", ", ", "? ", "! ", "\n\n"
  ].sort(function(a, b) {
    return b.length - a.length;
  });

  // map allowed chars to small ints
  const allowedChars = `\u{200C}ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 !@#$%^&*()-_=+/?.,:"'<>[]{}\\|;\n\t`;

  const CHAR_TO_ID = Object.fromEntries([...allowedChars].map((c,i)=>[c,i]));
  const ID_TO_CHAR = [...allowedChars];

  // dictionary IDs start AFTER chars
  const DICT_BASE = allowedChars.length;

  // ================= KEY =================
  async function sha256ToOffset(str, mod) {
    const data = new TextEncoder().encode(str);
    const hash = await crypto.subtle.digest("SHA-256", data);
    const view = new DataView(hash);
    const high = BigInt(view.getUint32(0));
    const low  = BigInt(view.getUint32(4));
    return Number(((high<<32n)|low) % BigInt(mod));
  }

  async function getKeyedBlockChars(key) {
    const k = key || "";
    if (!k) return blockChars;
    const off = await sha256ToOffset(k, blockChars.length);
    return blockChars.slice(off).concat(blockChars.slice(0, off));
  }

  // ================= TOKENIZER =================
  // Converts string → integer tokens
  function tokenize(str) {
    const out = [];
    let i = 0;

    while (i < str.length) {
      let matched = false;

      // dictionary longest-first
      for (const entry of DICT) {
        if (str.startsWith(entry, i)) {
          out.push(DICT_BASE + DICT.indexOf(entry));
          i += entry.length;
          matched = true;
          break;
        }
      }

      if (matched) continue;

      const c = str[i];
      if (c in CHAR_TO_ID) {
        out.push(CHAR_TO_ID[c]);
      } else {
        // literal passthrough using negative UTF codepoint
        out.push(-str.codePointAt(i));
      }

      i++;
    }

    return out;
  }

  // integer tokens → string
  function detokenize(tokens) {
    let out = "";

    for (const t of tokens) {
      if (t < 0) {
        out += String.fromCodePoint(-t);
      } else if (t < DICT_BASE) {
        out += ID_TO_CHAR[t];
      } else {
        out += DICT[t - DICT_BASE];
      }
    }

    return out;
  }

  // ================= BITPACK =================
  function removeInvisible(input) {
    let result = "";
    for (const char of input) {
      if (char != "\u{200C}") {
        result += char;
      }
    }
    return result;
  }

  async function encodeToBlocks(input, key = "") {
    input = removeInvisible(input);
    const keyed = await getKeyedBlockChars(key);

    const tokens = tokenize(input);

    const maxToken = DICT_BASE + DICT.length;
    const bitsPerToken = Math.ceil(Math.log2(maxToken));
    const bitsPerBlock = Math.floor(Math.log2(keyed.length));

    let buf = 0n;
    let bits = 0n;
    let out = "";

    for (const t of tokens) {
      if (t < 0) {
        // flush
        while (bits >= BigInt(bitsPerBlock)) {
          bits -= BigInt(bitsPerBlock);
          out += keyed[Number((buf >> bits) & BigInt((1<<bitsPerBlock)-1))];
        }
        buf = 0n;
        bits = 0n;
        out += String.fromCodePoint(-t);
        continue;
      }

      buf = (buf << BigInt(bitsPerToken)) | BigInt(t);
      bits += BigInt(bitsPerToken);

      while (bits >= BigInt(bitsPerBlock)) {
        bits -= BigInt(bitsPerBlock);
        out += keyed[Number((buf >> bits) & BigInt((1<<bitsPerBlock)-1))];
      }
    }

    if (bits > 0n) {
      out += keyed[Number((buf << (BigInt(bitsPerBlock)-bits)) & BigInt((1<<bitsPerBlock)-1))];
    }

    return out;
  }

  async function decodeFromBlocks(str, key = "") {
    const keyed = await getKeyedBlockChars(key);
    const map = Object.fromEntries(keyed.map((c,i)=>[c,i]));

    const maxToken = DICT_BASE + DICT.length;
    const bitsPerToken = Math.ceil(Math.log2(maxToken));
    const bitsPerBlock = Math.floor(Math.log2(keyed.length));

    let buf = 0n;
    let bits = 0n;
    const tokens = [];

    for (const c of str) {
      if (!(c in map)) {
        // literal passthrough
        while (bits >= BigInt(bitsPerToken)) {
          bits -= BigInt(bitsPerToken);
          tokens.push(Number((buf>>bits)&BigInt((1<<bitsPerToken)-1)));
        }
        buf = 0n;
        bits = 0n;
        tokens.push(-c.codePointAt(0));
        continue;
      }

      buf = (buf << BigInt(bitsPerBlock)) | BigInt(map[c]);
      bits += BigInt(bitsPerBlock);

      while (bits >= BigInt(bitsPerToken)) {
        bits -= BigInt(bitsPerToken);
        tokens.push(Number((buf>>bits)&BigInt((1<<bitsPerToken)-1)));
      }
    }

    return removeInvisible(detokenize(tokens));
  }

  // expose a small surface on window for legacy callers
  const api = {
    encodeToBlocks,
    decodeFromBlocks,
    // new clearer names (aliases)
    encrypt: encodeToBlocks,
    decrypt: decodeFromBlocks,
    // also expose tokenizer for testing/debugging
    tokenize,
    detokenize
  };

  global.BlockCodec = api;
  // backward-compatible globals
  global.encodeToBlocks = encodeToBlocks;
  global.decodeFromBlocks = decodeFromBlocks;
  // new global convenience API
  global.encrypt = encodeToBlocks;
  global.decrypt = decodeFromBlocks;

})(window);
