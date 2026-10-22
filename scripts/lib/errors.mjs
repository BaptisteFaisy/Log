import { readFileSync } from "node:fs";
import map from "../../lib/errors-map.cjs";

const catalog = JSON.parse(readFileSync(new URL("../../lib/catalog.json", import.meta.url), "utf8"));

/* Les cinq pannes suivies. Le libellé (name) est la liste de référence du
   projet ; le message et la stack viennent du catalogue OTel de
   BaptisteFaisy/Log (lib/catalog.json) : c'est lui qui fait foi pour le
   fingerprint des vrais logs Kafka. */
const TYPES = [
  { code: "ERR_DB_POOL_EXHAUSTED", errorType: "db_pool_exhausted", name: "Database connection pool exhausted" },
  { code: "ERR_PG_TIMEOUT_5432", errorType: "db_connection_timeout", name: "Connection timeout on port 5432" },
  { code: "ERR_KAFKA_UNREACHABLE", errorType: "kafka_broker_unreachable", name: "Kafka Broker Unreachable" },
  { code: "ERR_OOM_HEAP", errorType: "oom", name: "OutOfMemoryError (OOM) / Java heap space saturated" },
  { code: "ERR_DISK_FULL", errorType: "disk_full", name: "Disk Full / No space left on device" },
];

const byErrorType = new Map(catalog.scenarios.map((scenario) => [scenario.error_type, scenario]));

export const ERROR_TYPES = TYPES.map((type) => {
  const scenario = byErrorType.get(type.errorType);
  if (!scenario) throw new Error(`scénario absent de lib/catalog.json : ${type.errorType}`);
  return {
    code: type.code,
    errorType: type.errorType,
    name: type.name,
    label: scenario.label,
    scenario: scenario.id,
    service: catalog.service.name,
    level: scenario.severity,
    message: scenario.log_body,
    stack: scenario.exception_message || "",
  };
});

export const ERROR_BY_CODE = new Map(ERROR_TYPES.map((entry) => [entry.code, entry]));
export const ERROR_BY_TYPE = new Map(ERROR_TYPES.map((entry) => [entry.errorType, entry]));

export function normalizeMessage(message) {
  return String(message || "")
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/\b0x[0-9a-f]+\b/g, "<hex>")
    .replace(/\b[0-9a-f]{12,}\b/g, "<hex>")
    .replace(/\d{4}-\d{2}-\d{2}t[\d:.]+z?/g, "<ts>")
    .replace(/[a-z]:\\[^\s:]+/gi, "<path>")
    .replace(/(^|\s)\/(?:[\w.-]+\/)+[\w.-]+/g, "$1<path>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

export function firstFrame(stack) {
  const line = String(stack || "")
    .split("\n")
    .find((entry) => /\bat\b|:\d+:\d+/.test(entry) && !/metrics\.js|observability\.js/.test(entry));
  return line ? line.trim().slice(0, 120) : "";
}

// Doit rester identique à hash() dans metrics.js : le navigateur et les scripts
// partagent ainsi le même fingerprint pour une même erreur.
function hash(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

export function fingerprint(code, message, stack) {
  return hash(`${code}|${normalizeMessage(message)}|${firstFrame(stack)}`);
}

export function entryFor({ code, name, message, errorType } = {}) {
  if (errorType && ERROR_BY_TYPE.has(errorType)) return ERROR_BY_TYPE.get(errorType);
  if (code && ERROR_BY_CODE.has(code)) return ERROR_BY_CODE.get(code);

  const derived = code ? map.codeFor(code) : null;
  if (derived) return ERROR_BY_TYPE.get(derived);

  const needle = String(name || message || "").toLowerCase();
  if (!needle) return null;

  return (
    ERROR_TYPES.find((entry) => entry.name.toLowerCase() === needle) ||
    ERROR_TYPES.find((entry) => entry.code.toLowerCase() === needle) ||
    ERROR_TYPES.find((entry) => entry.errorType === needle) ||
    ERROR_TYPES.find((entry) => needle.includes(entry.message.toLowerCase())) ||
    ERROR_TYPES.find((entry) => needle.includes(entry.name.toLowerCase())) ||
    null
  );
}

export function logLine(entry, ts = new Date().toISOString()) {
  return `${ts} ${entry.level} [${entry.service}] ${entry.name} — ${entry.message}`;
}

export function logLines(entry, ts = new Date().toISOString()) {
  const stack = entry.stack ? entry.stack.split("\n").map((line) => `    ${line}`) : [];
  return [logLine(entry, ts), ...stack];
}
