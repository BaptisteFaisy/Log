import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../prompt.html", import.meta.url), "utf8");
const md = readFileSync(new URL("../PROMPT.md", import.meta.url), "utf8");
const start = html.indexOf('<pre id="md">') + '<pre id="md">'.length;
const end = html.indexOf("</pre>", start);
const un = html
  .slice(start, end)
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&amp;/g, "&");

console.log("equal=" + (un === md), "len=" + un.length + "/" + md.length);
