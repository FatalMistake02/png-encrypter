# PNG Encrypter

Encrypts text into a tiny PNG. Runs entirely in the browser - no server, no
upload, no network calls.

1. **Stage 1** - the text is compressed with whichever codec wins a benchmark run.
2. **Stage 2** - those bytes are written into RGB pixels, 3 per pixel,
   continuously across pixel boundaries.

Decoding reads the codec id out of the image header and reverses only that codec,
so the output is unreadable without this tool.

Live at **<https://fatalmistake02.github.io/png-encrypter/>**

## Running it

**Online:** just open the Pages URL above.

**Locally:** double-click `start.bat`. It serves the folder on
`http://localhost:8000/` and opens the page.

A local server is required when running from disk, because the codecs are ES
modules and browsers block module imports on the `file://` protocol via CORS.
Opening `index.html` directly will fail with a codec load error. `start.bat` uses
Python if available, otherwise Node.

## Layout

```
index.html         the UI and all of the pixel encode/decode logic
.nojekyll          tells GitHub Pages to publish files verbatim
start.bat          launcher for running locally
server.js          fallback static server for Node
explain.js         node explain.js "text"  - annotated byte-level walkthrough
codecs/            local copies of every codec - no internet needed
  manifest.js      codec name -> file, in a fixed order
  kolbe_1.0.0.js   kolbe_2.0.5.js   kolbe_2.1.0.js
  kolbe_2.2.0.js   kolbe_2.3.0.js
  fatal_5.0.0.js   fatal_6.1.0.js
  xc_bitpack.js    new codec, id 8
  xc_range.js      new codec, id 9
  helpers.js       shared helper module used by kolbe 2.x
  pako.esm.mjs     gzip library used by kolbe 2.2/2.3 and fatal
  versions.json    the original upstream manifest, kept for reference
  _*.js            test and benchmark harnesses (see below)
```

All asset paths are relative, so the site works from a domain root or from a
`/repo/` subpath.

## Codecs

Two transports, chosen per codec by feature detection:

- **base64** (ids 1-7) - the upstream codecs return a string of block
  characters. Those are UTF-8 encoded, then base64'd into 64 evenly spaced
  colours so the values survive a trip through 8-bit channels. That step spends
  8 bits to move 6.
- **raw** (ids 8-9) - the new codecs expose `encodeBytes`/`decodeBytes`, so
  their bytes go straight into the pixels with no base64 layer.

`node codecs/_bench.js` measures characters per pixel the way the page actually
stores them:

| codec | prose 10k | prose 50k | corpus 145k |
|---|---|---|---|
| kolbe_2.3.0 *(best upstream)* | 4.2 | 6.3 | 5.9 |
| fatal_5.0.0 | 4.1 | 6.2 | 5.9 |
| xc_bitpack | 3.4 | 3.3 | 2.9 |
| xc_range | **7.1** | **10.7** | **11.6** |

10,000 characters of prose is a 38x38 image with `xc_range`, against 49x49 for the
best upstream codec.

`xc_range` needs a few thousand characters before its adaptive model pays off.
On very short inputs the gzip-based upstream codecs can still win, since gzip has
almost no warm-up cost. The page benchmarks every codec per input and keeps
whichever actually stores smallest, so this resolves itself.

## Test harnesses

```
node codecs/_verify.js          round-trip every codec against edge cases
node codecs/_verify_new.js      round-trip the two new codecs
node codecs/_verify_pixels.js   full pixel pipeline, both transports
node codecs/_verify_page.js     exercises the loader the page uses
node codecs/_verify_cache.js    proves the per-codec cache fix
node codecs/_bench.js           density comparison across all codecs
node _pagestest.js              serves the site under a /repo/ prefix
```

## Two bugs in the upstream codecs

`node codecs/_verify.js` reports 5 of 7 upstream codecs round-tripping cleanly.
The other two have real bugs in their source, left unmodified here:

- **Kolbe 1.0.0** - its tokenizer walks the string with `str[i]`, so surrogate
  pairs get split. Astral characters (emoji) come back corrupted.
- **Kolbe 2.0.5** - calls `numToBits(...)` without the `helper.` prefix, which
  throws on any character outside its Huffman table.

Both only break on non-ASCII input and work fine on plain English. The page
round-trip-tests every codec before trusting it and skips any that fail, so a
broken codec is dropped from the benchmark table instead of corrupting the image.

The kolbe 2.x codecs also originally chose between a local and a CDN copy of
`helpers.js` by testing `window.location.href.includes("http://localhost:")`.
That check fails for `127.0.0.1`, LAN addresses and `file://`, and the fallback
was a CDN fetch that hung. The branch has been collapsed to a plain local import.

## Pixel format

Every pixel is fully opaque (alpha = 255). Browsers premultiply transparent
pixels, which silently destroys the RGB values inside them - that is why data is
never stored in the alpha channel.

`imgData` is interleaved `[r,g,b,a,...]` while the header is packed 3 channels per
pixel, so pixel `p` channel `c` lives at `data[p * 4 + c]`.

| Pixel | Contents |
|---|---|
| 0 | payload length in channel values (3 bytes, LE) |
| 1 | original UTF-8 byte length (3 bytes, LE) |
| 2 | payload checksum (3 bytes) |
| 3 | codec id (0 = raw, else index into `manifest.js`) |
| 4+ | payload, 3 channel values per pixel |

Padding pixels are white (255,255,255). Base64-mode data colours are drawn from
64 evenly spaced values in the range 3-253, so padding can never be mistaken for
data.

**Codec ids are positional and must stay stable.** New codecs are only ever
*appended* to `manifest.js`; reordering would make previously created images
decode with the wrong codec. Ids 1-7 are the upstream codecs, 8 and 9 are new.

## Deploying

Pages is configured to deploy from the `main` branch root. `.nojekyll` makes
GitHub publish the files verbatim rather than running them through Jekyll.

## Requirements

A browser with ES module support and `crypto.subtle` - any current Chrome,
Firefox, Safari or Edge. `crypto.subtle` requires a secure context, which is why
this works on HTTPS Pages and `localhost` but not from a `file://` URL or a plain
HTTP host.
