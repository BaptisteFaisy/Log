const { codeFor } = require("./errors-map.cjs");
const catalog = require("./catalog.json");

const SEVERITIES = new Set(["dbg", "inf", "wrn", "ok", "err"]);

const NAMES = {
  ERR_DB_POOL_EXHAUSTED: "Database connection pool exhausted",
  ERR_PG_TIMEOUT_5432: "Connection timeout on port 5432",
  ERR_KAFKA_UNREACHABLE: "Kafka Broker Unreachable",
  ERR_OOM_HEAP: "OutOfMemoryError (OOM) / Java heap space saturated",
  ERR_DISK_FULL: "Disk Full / No space left on device",
};

function scenarioFor(errorType) {
  const type = String(errorType || "").toLowerCase();
  const scenario = catalog.scenarios.find((s) => s.error_type === type);
  if (!scenario) return null;
  const code = codeFor(type);
  return {
    code,
    name: NAMES[code] || scenario.label,
    message: scenario.log_body,
    stack: scenario.exception_message || "",
    service: catalog.service.name,
  };
}

function severityOf(value, fallback = "err") {
  const text = String(value || "").toLowerCase();
  if (SEVERITIES.has(text)) return text;
  if (text === "error" || text === "fatal") return "err";
  if (text === "warn" || text === "warning") return "wrn";
  if (text === "debug") return "dbg";
  if (text === "info") return "inf";
  return fallback;
}

function codeOf(value, attrs, message) {
  if (value.code) return String(value.code).slice(0, 80);

  const mapped = codeFor(value.error_type || attrs["error.type"]);
  if (mapped) return mapped;

  const text = `${attrs["exception.type"] || ""} ${message}`.toLowerCase();
  if (text.includes("outofmemory") || text.includes("heap space")) return "ERR_OOM_HEAP";
  if (text.includes("no space left") || text.includes("disk full")) return "ERR_DISK_FULL";
  if (text.includes("pool") && text.includes("connection")) return "ERR_DB_POOL_EXHAUSTED";
  if (text.includes("5432")) return "ERR_PG_TIMEOUT_5432";
  if (text.includes("kafka") || text.includes("broker")) return "ERR_KAFKA_UNREACHABLE";
  return "ERR_UNKNOWN";
}

function normalize(payload) {
  const value = payload && typeof payload === "object" ? payload : { Body: String(payload || "") };
  const attrs = value.LogAttributes && typeof value.LogAttributes === "object" ? value.LogAttributes : {};
  const message = String(value.message || value.Body || "(message vide)").slice(0, 2000);
  const code = codeOf(value, attrs, message);

  return {
    code,
    severity: severityOf(value.severity || value.SeverityText),
    message,
    payload: {
      ...value,
      code,
      service: value.service || value.ServiceName || "",
      name: value.name || NAMES[code] || code,
      stack: value.stack || attrs["exception.stacktrace"] || attrs["exception.message"] || "",
    },
  };
}

module.exports = { normalize, severityOf, scenarioFor, NAMES };
