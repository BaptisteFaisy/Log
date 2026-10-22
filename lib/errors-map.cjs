/* Catalogue OTel de BaptisteFaisy/Log -> codes du site.
   Source unique : lib/catalog.json (copie de kafka-log-generator/scenarios/catalog.json).
   Utilise par lib/log.cjs (ingestion Kafka), scripts/consumer.cjs et
   scripts/lib/errors.mjs (memoire des resolutions). */

const catalog = require("./catalog.json");

const NAMES = {
  ERR_DB_POOL_EXHAUSTED: "Database connection pool exhausted",
  ERR_PG_TIMEOUT_5432: "Connection timeout on port 5432",
  ERR_KAFKA_UNREACHABLE: "Kafka Broker Unreachable",
  ERR_OOM_HEAP: "OutOfMemoryError (OOM) / Java heap space saturated",
  ERR_DISK_FULL: "Disk Full / No space left on device",
};

const CODE_BY_ERROR_TYPE = {
  db_pool_exhausted: "ERR_DB_POOL_EXHAUSTED",
  db_connection_timeout: "ERR_PG_TIMEOUT_5432",
  kafka_broker_unreachable: "ERR_KAFKA_UNREACHABLE",
  oom: "ERR_OOM_HEAP",
  disk_full: "ERR_DISK_FULL",
};

const ERROR_TYPE_BY_CODE = Object.fromEntries(
  Object.entries(CODE_BY_ERROR_TYPE).map(([type, code]) => [code, type]),
);

const CODE_BY_SCENARIO = Object.fromEntries(
  catalog.scenarios
    .filter((scenario) => scenario.error_type && CODE_BY_ERROR_TYPE[scenario.error_type])
    .map((scenario) => [scenario.id, CODE_BY_ERROR_TYPE[scenario.error_type]]),
);

const SCENARIO_BY_CODE = Object.fromEntries(
  Object.entries(CODE_BY_SCENARIO).map(([id, code]) => [code, id]),
);

const SCENARIO_BY_ERROR_TYPE = Object.fromEntries(
  catalog.scenarios
    .filter((scenario) => scenario.error_type)
    .map((scenario) => [scenario.error_type, scenario]),
);

function codeFor(errorType) {
  return CODE_BY_ERROR_TYPE[String(errorType || "").toLowerCase()] || null;
}

function codeForScenario(scenarioId) {
  return CODE_BY_SCENARIO[String(scenarioId || "")] || null;
}

function errorTypeFor(code) {
  return ERROR_TYPE_BY_CODE[String(code || "").toUpperCase()] || null;
}

function scenarioFor(code) {
  const errorType = errorTypeFor(code);
  return errorType ? SCENARIO_BY_ERROR_TYPE[errorType] || null : null;
}

module.exports = {
  catalog,
  NAMES,
  CODE_BY_ERROR_TYPE,
  ERROR_TYPE_BY_CODE,
  CODE_BY_SCENARIO,
  SCENARIO_BY_CODE,
  SCENARIO_BY_ERROR_TYPE,
  codeFor,
  codeForScenario,
  errorTypeFor,
  scenarioFor,
};
