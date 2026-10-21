import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const md = readFileSync(join(root, "PROMPT.md"), "utf8");
const hash = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 16);

for (const name of ["logo.png", "favicon.png", "apple-touch-icon.png"]) {
  const marker = `base64 -d > ${name} <<'EOF'\n`;
  const start = md.indexOf(marker);
  if (start < 0) throw new Error(`bloc absent: ${name}`);
  const bodyStart = start + marker.length;
  const end = md.indexOf("\nEOF", bodyStart);
  const b64 = md.slice(bodyStart, end).replace(/\n/g, "");
  const decoded = Buffer.from(b64, "base64");
  const original = readFileSync(join(root, name));

  const ok =
    decoded.equals(original) &&
    decoded.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";

  console.log(
    `${name}: equal=${ok} bytes=${decoded.length} sha=${hash(decoded)}${ok ? "" : " MISMATCH"}`
  );
}

const urls = md.match(/https?:\/\/log-errors\.vercel\.app[^\s)]*/g);
console.log("deployUrls=" + (urls ? urls.length : 0));

const html = readFileSync(join(root, "prompt.html"), "utf8");
const start = html.indexOf('<pre id="md">') + '<pre id="md">'.length;
const end = html.indexOf("</pre>", start);
const un = html
  .slice(start, end)
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&amp;/g, "&");
console.log("promptHtmlMatchesMd=" + (un === md) + " chars=" + un.length + "/" + md.length);

const single = readFileSync(join(root, "log-single.html"), "utf8");
const realRefs = [...single.matchAll(/(?:src|href)="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((v) => !v.startsWith("data:") && !v.startsWith("#") && !v.startsWith("/"));
console.log("singleRealRefs=" + JSON.stringify(realRefs));
