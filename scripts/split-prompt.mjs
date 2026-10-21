import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lines = readFileSync(join(root, "PROMPT.md"), "utf8").split("\n");

const filesIdx = lines.findIndex((l) => l.startsWith("## 13. Fichiers"));
const footIdx = lines.findIndex((l) => l.startsWith("## 14. "));

if (filesIdx < 0 || footIdx < 0) throw new Error("structure inattendue");

writeFileSync(
  join(root, "scripts", "prompt-head.md"),
  lines.slice(0, filesIdx).join("\n"),
  "utf8"
);
writeFileSync(
  join(root, "scripts", "prompt-foot.md"),
  lines.slice(footIdx).join("\n"),
  "utf8"
);

console.log(`head=${filesIdx} foot=${footIdx} total=${lines.length}`);
