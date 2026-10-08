// Simulates a GitHub Pages PROJECT site, which is served from a subpath like
// /repo/ rather than the domain root. Verifies every asset the page needs
// resolves under that prefix.
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PREFIX = "/some-repo/";
const PORT = Number(process.env.PORT || 8126);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png"
};

http
  .createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    let sub = url;
    if (sub === PREFIX.slice(0, -1) || sub === PREFIX) sub = "/index.html";
    else if (sub.startsWith(PREFIX)) sub = sub.slice(PREFIX.length - 1);
    else {
      res.writeHead(404).end("outside prefix: " + url);
      return;
    }
    if (sub === "/" || sub === "") sub = "/index.html";
    const file = path.join(ROOT, sub);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end("nope"); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end("missing: " + url); return; }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream" });
      res.end(data);
    });
  })
  .listen(PORT, async () => {
    const base = `http://localhost:${PORT}${PREFIX}`;
    const get = async (p) => {
      const r = await fetch(base + p);
      return r.status + " " + (await r.arrayBuffer()).byteLength + "B";
    };

    console.log("simulating Pages at " + base + "\n");
    console.log("  /                  " + (await get("")));
    console.log("  codecs/manifest.js " + (await get("codecs/manifest.js")));

    // every codec the manifest references must resolve under the prefix too,
    // plus the helper modules the codecs import from each other
    const src = fs.readFileSync(path.join(ROOT, "codecs/manifest.js"), "utf8");
    const fromManifest = [...src.matchAll(/\.\/([\w.\-]+\.(?:js|mjs))/g)].map((m) => m[1]);
    const helpers = [];
    for (const f of fromManifest) {
      const codecSrc = fs.readFileSync(path.join(ROOT, "codecs", f), "utf8");
      for (const m of codecSrc.matchAll(/from\s+["']\.\/([\w.\-]+)["']|import\(['"]\.\/([\w.\-]+)['"]\)/g)) {
        if (m[1] || m[2]) helpers.push(m[1] || m[2]);
      }
    }
    const files = [...new Set([...fromManifest, ...helpers])];
    let bad = 0;
    for (const f of files) {
      const status = await get("codecs/" + f);
      if (status.startsWith("404")) bad++;
      console.log("  codecs/" + f.padEnd(20) + status);
    }
    console.log("\n" + (bad === 0 ? "all codec files resolve under the subpath" : bad + " MISSING"));
    process.exitCode = bad === 0 ? 0 : 1;
    setTimeout(() => process.exit(bad === 0 ? 0 : 1), 200);
  });