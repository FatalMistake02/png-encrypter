/**
 * Local codec manifest.
 *
 * The encoder writes a codec's POSITION in this list into the PNG header, so
 * the first seven entries must keep their existing order or previously created
 * images will decode with the wrong codec.
 *
 * New codecs are appended at the end. The page decides how to store a codec's
 * output by feature detection: if a codec exposes encodeBytes/decodeBytes it
 * writes raw bytes straight into pixels, otherwise it falls back to the legacy
 * block-char + base64 path. No header change is needed for this.
 *
 * Paths are relative to this file (codecs/), so the page must be served over
 * http:// -- see start.bat. ES module imports are blocked on file:// by CORS.
 */
window.LOCAL_VERSIONS = {
  // 1..7 - upstream codecs, transport is block chars + base64
  "Kolbe 1.0.0": "./kolbe_1.0.0.js",
  "Kolbe 2.0.5": "./kolbe_2.0.5.js",
  "Kolbe 2.1.0": "./kolbe_2.1.0.js",
  "Kolbe 2.2.0": "./kolbe_2.2.0.js",
  "Kolbe 2.3.0": "./kolbe_2.3.0.js",
  "Fatal 5.0.0": "./fatal_5.0.0.js",
  "Fatal 6.1.0": "./fatal_6.1.0.js",

  // 8, 9 - new codecs, transport is raw bytes (no base64)
  "xc_bitpack": "./xc_bitpack.js",
  "xc_range": "./xc_range.js"
};