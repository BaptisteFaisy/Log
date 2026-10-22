// Masquage commun a /api/pg-memoire et /api/dump : le site est public, tout ce qui
// ressemble a un secret est masque avant de quitter la fonction.
// Le prefixe « _ » empeche Vercel d'exposer ce fichier comme une route.

// Tables jamais publiees, meme si elles apparaissent un jour dans la base.
const PRIVATE_NAME = /secret|token|passw|credential|api_?key/i;

// Colonnes au nom de secret : jamais publiees (« tokens », « tokens_used »… restent visibles).
const PRIVATE_COLUMN = /passw|secret|credential|api_?key|private_?key|(^|_)token$/i;

const REDACTIONS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[private key]"],
  [/AVNS_[A-Za-z0-9_-]{6,}/g, "AVNS_•••"],
  [/\b(?:gh[opsur]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/g, "gh_•••"],
  [/\bsk-[A-Za-z0-9_-]{12,}/g, "sk-•••"],
  [/\b(aivenv1|avnpw_)[A-Za-z0-9+/=_-]{6,}/g, "$1•••"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[jwt]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 •••"],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, "$1•••@"],
  [/(\b(?:password|passwd|pwd|secret|token|api[_-]?key|PGPASSWORD)\b["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, "$1•••"],
  [/\b[a-z0-9-]+\.[a-z]\.aivencloud\.com(?::\d+)?/gi, "•••.aivencloud.com"],
];

function redact(text) {
  return REDACTIONS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), String(text));
}

module.exports = { PRIVATE_NAME, PRIVATE_COLUMN, redact };
