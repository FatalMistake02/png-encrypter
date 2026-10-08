// Walks one small example through the whole pipeline and prints every
// intermediate value, annotated. Run:  node explain.js "hello there"

const text = process.argv[2] ?? "hello there";

const SAFE = [];
for (let i = 0; i < 64; i++) SAFE.push(Math.round(i * (250 / 63)) + 3);
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const C = 3;
const HP = 4;

const hex2 = (n) => n.toString(16).padStart(2, "0");
const hex3 = (n) => n.toString(16).padStart(3, "0");
const bytesToB64 = (b) => {
  let bin = "";
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/=+$/, "");
};

const codec = (await import("./codecs/xc_range.js")).default;

console.log("=".repeat(72));
console.log("INPUT");
console.log("=".repeat(72));
const originalBytes = new TextEncoder().encode(text);
console.log("text          : " + JSON.stringify(text));
console.log("UTF-8 bytes   : " + originalBytes.length + "  ->  " + hex(originalBytes));

function hex(arr) {
  return Array.from(arr).map(hex2).join(" ");
}

console.log();
console.log("=".repeat(72));
console.log("STAGE 1 - text encoding (xc_range)");
console.log("=".repeat(72));
console.log("The codec turns text into an adaptive range-coded bitstream.");
console.log("Internally it walks the text choosing one of three moves:");
console.log("  LITERAL  a character that is not in the dictionary, coded with a");
console.log("           binary range coder over 4 mixed order-0..3 contexts");
console.log("  DICT     a hit in the built-in word list, coded as an 8-bit id");
console.log("  MATCH    an LZ77 repeat: a length and a distance back");
console.log("Those decisions produce bytes that are NOT valid UTF-8 any more.");
const payload = codec.encodeBytes(text);
console.log();
console.log("payload bytes : " + payload.length);
console.log("               " + hex(payload));
console.log("bits/char      : " + ((payload.length * 8) / text.length).toFixed(2));
console.log();
console.log("payload header inside the codec (its own 8-byte preamble):");
const pv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
console.log("  bytes 0-3  targetChars = " + pv.getUint32(0) + "   characters to reproduce");
console.log("  bytes 4-7  targetBytes = " + pv.getUint32(4) + "   code points produced");
console.log("  byte  8+   the range-coded bitstream itself");

console.log();
console.log("=".repeat(72));
console.log("STAGE 2 - payload to pixels");
console.log("=".repeat(72));
console.log("A pixel has 4 channels: R, G, B, A. Only RGB is used (3 bytes),");
console.log("and A is forced to 255 so the browser can never premultiply and");
console.log("destroy the data. Payload bytes are laid into R,G,B round-robin");
console.log("and simply continue across pixel boundaries - no per-byte rounding.");
console.log();
console.log("image header (4 pixels = 12 bytes), pixel p channel c -> data[p*4+c]:");
console.log("  px0  payload length in channel values   3 bytes little endian = " + payload.length);
console.log("  px1  original UTF-8 byte length         3 bytes little endian = " + originalBytes.length);
console.log("  px2  checksum of the payload            3 bytes");
console.log("  px3  codec id (0 = raw, 1..9 from manifest.js)  = 9  (xc_range)");
console.log();

let stream = Array.from(payload);
let sum = 0;
for (const v of stream) sum += v;
stream = [
  payload.length & 0xFF, (payload.length >> 8) & 0xFF, (payload.length >> 16) & 0xFF,
  originalBytes.length & 0xFF, (originalBytes.length >> 8) & 0xFF, (originalBytes.length >> 16) & 0xFF,
  sum & 0xFF, 0, 0,
  9, 0, 0
].concat(stream);

const totalPixels = HP + Math.ceil((stream.length - HP * C) / C);
const side = Math.ceil(Math.sqrt(totalPixels));
console.log("channel values needed : " + stream.length);
console.log("pixels needed         : " + totalPixels + "  (4 header + " +
            Math.ceil((stream.length - HP * C) / C) + " payload)");
console.log("image is square       : " + side + " x " + side + " = " + side * side + " px");
console.log("unused pixels         : filled with 255,255,255 (white)");
console.log();

console.log("first rows of the image, as R G B (A is always 255):");
const data = new Uint8ClampedArray(side * side * 4).fill(255);
for (let p = 0; p < totalPixels; p++) {
  for (let ch = 0; ch < C; ch++) {
    const s = p * C + ch;
    data[p * 4 + ch] = s < stream.length ? stream[s] : 255;
  }
  data[p * 4 + 3] = 255;
}
for (let y = 0; y < Math.min(side, 6); y++) {
  const cells = [];
  for (let x = 0; x < side; x++) {
    const o = (y * side + x) * 4;
    cells.push(hex2(data[o]) + " " + hex2(data[o + 1]) + " " + hex2(data[o + 2]));
  }
  console.log("  " + cells.join(" | "));
}
console.log("  (row 0 px0 = length, row 0 px1 = orig len, row 0 px2 = checksum, row 0 px3 = codec id)");

console.log();
console.log("=".repeat(72));
console.log("STAGE 3 - the PNG file on disk");
console.log("=".repeat(72));
console.log("The pixels are handed to canvas.toBlob('image/png'). PNG then does");
console.log("its own lossless deflate on the pixel rows, so the file is smaller");
console.log("than the raw pixel data - but that does not matter here, because we");
console.log("never read the file size, only the pixel values.");
console.log("PNG's zlib compression is lossless, so every byte we wrote comes");
console.log("back exactly. A JPEG would not be safe here.");
console.log();
console.log("density: " + (originalBytes.length / (side * side)).toFixed(2) +
            " characters per pixel");

console.log();
console.log("=".repeat(72));
console.log("DECODING - how it is read back");
console.log("=".repeat(72));
console.log("1. draw the PNG to a canvas and getImageData()");
console.log("2. read px0..px3 to learn payload length, orig length, checksum, codec id");
console.log("3. read payload.length channel values starting at pixel 4");
console.log("4. verify the checksum");
console.log("5. load manifest.js, take entry number = codec id");
console.log("6. that codec's decodeBytes() reverses stage 1");
const back = codec.decodeBytes(payload);
console.log();
console.log("round trip: " + (back === text ? "OK" : "FAILED") + "  ->  " + JSON.stringify(back));
void B64; void SAFE; void hex3;