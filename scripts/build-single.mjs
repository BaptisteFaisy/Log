import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(join(root, name), "utf8");
const dataUri = (name, mime) =>
  `data:${mime};base64,${readFileSync(join(root, name)).toString("base64")}`;

/* ------------------------------------------------------------------ */
/* 1. log-single.html — le site entier dans un seul fichier             */
/* ------------------------------------------------------------------ */

const css = read("styles.css");
const bg = read("bg.js");
const metrics = read("metrics.js");
const app = read("app.js");
const observability = read("observability.js");
const logo = dataUri("logo.png", "image/png");
const icon = dataUri("favicon.png", "image/png");
const touch = dataUri("apple-touch-icon.png", "image/png");

let html = read("index.html");

const swaps = [
  [
    '<link rel="stylesheet" href="styles.css" />',
    `<style>\n${css}\n</style>`,
  ],
  ['<link rel="icon" href="favicon.png" type="image/png" />', `<link rel="icon" href="${icon}" type="image/png" />`],
  ['<link rel="apple-touch-icon" href="apple-touch-icon.png" />', `<link rel="apple-touch-icon" href="${touch}" />`],
  ['<img class="brand-logo" src="logo.png" alt="Log" />', `<img class="brand-logo" src="${logo}" alt="Log" />`],
  ['<script src="bg.js"></script>', `<script>\n${bg}\n</script>`],
  ['<script src="metrics.js"></script>', `<script>\n${metrics}\n</script>`],
  ['<script src="app.js"></script>', `<script>\n${app}\n</script>`],
  ['<script src="observability.js"></script>', `<script>\n${observability}\n</script>`],
];

for (const [from, to] of swaps) {
  if (!html.includes(from)) throw new Error(`motif introuvable: ${from}`);
  html = html.replace(from, to);
}

if (html.includes('href="previews.html"')) {
  html = html.replace(
    '<a class="btn btn-ghost" href="previews.html">Fonds &amp; états</a>',
    '<span class="btn btn-ghost" role="note" title="Les fonds se choisissent avec ?bg=gloss|space|aurora|topo|halo">?bg= pour les fonds</span>'
  );
}

html = html.replace(
  "<title>Log — Console de test d'erreurs</title>",
  "<title>Log — Console de test d'erreurs (fichier unique)</title>"
);

writeFileSync(join(root, "log-single.html"), html, "utf8");

/* ------------------------------------------------------------------ */
/* 2. prompt.html — le prompt complet, copiable                        */
/* ------------------------------------------------------------------ */

const mdPath = join(root, "PROMPT.md");
if (existsSync(mdPath)) {
  const md = read("PROMPT.md");
  const esc = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const page = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Prompt — reproduire le site Log</title>
<link rel="icon" href="${icon}" type="image/png" />
<style>
  :root {
    --paper:#fdfcfb; --ink:#1a1614; --ink-2:#57504c; --ink-3:#928a85;
    --line:rgba(26,22,20,.09); --red:#c8382f; --red-deep:#a52a23; --red-soft:#fbe9e7;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: radial-gradient(120% 90% at 50% -10%, #fff, #fbf7f6 55%, #f6efed 100%);
    color: var(--ink); font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased; min-height: 100vh;
  }
  .bar {
    position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 12px;
    padding: 11px clamp(16px, 4vw, 40px); background: rgba(255,255,255,.34);
    backdrop-filter: blur(26px) saturate(180%); border-bottom: 1px solid rgba(26,22,20,.07);
  }
  .bar img { height: 26px; width: auto; opacity: .92; }
  .bar .t { font-size: 12px; letter-spacing: .14em; text-transform: uppercase; color: var(--ink-3); }
  .bar .acts { margin-left: auto; display: flex; gap: 8px; }
  .btn {
    font: inherit; font-size: 13px; font-weight: 500; border-radius: 999px;
    padding: 10px 18px; cursor: pointer; text-decoration: none; line-height: 1;
    display: inline-flex; align-items: center; gap: 7px; border: 1px solid transparent;
    transition: background .18s ease, border-color .18s ease, box-shadow .18s ease;
  }
  .btn-primary {
    color: #fff; background: linear-gradient(180deg,#d2463d,#bd3129);
    border-color: rgba(150,32,26,.35); box-shadow: 0 10px 24px -12px rgba(200,56,47,.75);
  }
  .btn-primary:hover { background: linear-gradient(180deg,#db5147,#c63a31); }
  .btn-ghost { color: var(--ink-2); background: rgba(255,255,255,.66); border-color: rgba(26,22,20,.1); }
  .btn-ghost:hover { background: #fff; color: var(--ink); }
  main { max-width: 1080px; margin: 0 auto; padding: 26px clamp(14px, 3vw, 28px) 70px; }
  .head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 6px; }
  h1 { font-size: clamp(20px, 2.6vw, 26px); letter-spacing: -.02em; margin: 0; font-weight: 600; }
  .meta { font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 10.5px; color: var(--ink-3); }
  .hint { font-size: 12.5px; color: var(--ink-2); margin: 0 0 16px; }
  .box {
    background: rgba(255,255,255,.8); border: 1px solid var(--line); border-radius: 16px;
    box-shadow: 0 24px 60px -50px rgba(70,30,24,.6); overflow: hidden;
  }
  pre {
    margin: 0; padding: 18px; max-height: calc(100vh - 210px); overflow: auto;
    font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 11.5px;
    line-height: 1.62; white-space: pre-wrap; word-break: break-word; color: #2c2724;
    tab-size: 2;
  }
  pre::-webkit-scrollbar { width: 10px; }
  pre::-webkit-scrollbar-thumb { background: rgba(26,22,20,.16); border-radius: 10px; }
  .toast {
    position: fixed; left: 50%; bottom: 26px; transform: translate(-50%, 12px);
    background: #1a1614; color: #fff; font-size: 12.5px; padding: 9px 16px;
    border-radius: 999px; opacity: 0; pointer-events: none;
    transition: opacity .2s ease, transform .2s ease;
  }
  .toast.on { opacity: 1; transform: translate(-50%, 0); }
</style>
</head>
<body>
  <div class="bar">
    <img src="${logo}" alt="Log" />
    <span class="t">prompt de reproduction</span>
    <span class="acts">
      <a class="btn btn-ghost" href="PROMPT.md" download>Télécharger .md</a>
      <button class="btn btn-primary" id="copy" type="button">Copier tout le prompt</button>
    </span>
  </div>
  <main>
    <div class="head">
      <h1>Prompt — reproduire le site Log</h1>
      <span class="meta">${(md.length / 1024).toFixed(1)} Ko · ${md.split("\n").length} lignes</span>
    </div>
    <p class="hint">Colle ce texte intégral dans une nouvelle conversation : elle reconstruira le site à l'identique, sans rien connaître du projet.</p>
    <div class="box">
      <pre id="md">${esc}</pre>
    </div>
  </main>
  <div class="toast" id="toast">Prompt copié</div>
  <script>
    const md = document.getElementById("md");
    const toast = document.getElementById("toast");
    document.getElementById("copy").addEventListener("click", async () => {
      const text = md.textContent;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const range = document.createRange();
        range.selectNodeContents(md);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand("copy");
        sel.removeAllRanges();
      }
      toast.classList.add("on");
      setTimeout(() => toast.classList.remove("on"), 1600);
    });
  </script>
</body>
</html>
`;
  writeFileSync(join(root, "prompt.html"), page, "utf8");
}

console.log("ok");
