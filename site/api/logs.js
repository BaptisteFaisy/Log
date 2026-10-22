// Vercel Function : ingestion des logs de la console web « log() » vers Aiven Kafka.
//
//   POST /api/logs   {"lines":[{"level":"err","text":"...","code":"ERR_KAFKA_UNREACHABLE",
//                               "service":"event-worker","ts":"2026-10-22T10:03:55.123Z",
//                               "trace_id":"<32 hex>"}]}
//     -> 200 {"ok":true,"topic":"otel.logs","produced":1,"trace_id":"..."}
//     -> 400 {"ok":false,"error":"bad_request","hint":"..."}
//     -> 503 {"ok":false,"error":"kafka_unreachable","hint":"..."}
//     -> 429 {"ok":false,"error":"rate_limited","hint":"..."}
//
//   GET /api/logs    -> 200 {"ok":true,"kafka":"up"|"down","topic":"otel.logs",...}
//
// Le message produit suit le contrat des messages (§3) : une ligne JSON dont les
// cles sont celles du schema OpenTelemetry standard, la cle Kafka etant le TraceId.
// Les attributs agent.scenario / agent.profile sont presents sur chaque log, comme
// l'exige le watcher d'incidents.
//
// Variables d'environnement : celles de api/_kafka.js, plus
//   KAFKA_AGENT_ROUTING   "0" = logs seulement, sans error.type (aucun agent ne part)
//                         "1" (defaut) = les lignes err/wrn portent error.type et
//                         peuvent declencher un agent via routes.yaml
//   LOGS_MAX_LINES        lignes max par requete (defaut : 40)
//   LOGS_RATE_PER_MIN     requetes max par minute et par IP (defaut : 120)
//
// Le site est public : tout ce qui entre est borne, nettoye et masque.

const crypto = require("crypto");
const { publish, health, KafkaConfigError, KafkaDownError, topicName, configured } = require("./_kafka");
const { redact } = require("./_redact");

const MAX_LINES = Number(process.env.LOGS_MAX_LINES) || 40;
const MAX_LINE_CHARS = 4000;
const MAX_BODY_CHARS = 96 * 1024;
const RATE_PER_MIN = Number(process.env.LOGS_RATE_PER_MIN) || 120;
const AGENT_ROUTING = String(process.env.KAFKA_AGENT_ROUTING || "1") !== "0";
const SERVICE = "log-site";
const SCOPE = { name: "log-site", version: "1.0.0" };

// « err » cote navigateur -> severite OpenTelemetry.
const SEVERITY = {
  dbg: { text: "DEBUG", number: 5 },
  inf: { text: "INFO", number: 9 },
  ok: { text: "INFO", number: 9 },
  wrn: { text: "WARN", number: 13 },
  err: { text: "ERROR", number: 17 },
};

// Code affiche par la console -> error.type attendu par routes.yaml.
// Un code inconnu est simplement derive (minuscules, prefixe ERR_ retire) : le
// watcher retombe alors sur default_agent, il ne casse pas.
const ERROR_TYPES = {
  ERR_DB_POOL_EXHAUSTED: "db_pool_exhausted",
  ERR_PG_TIMEOUT_5432: "db_connection_timeout",
  ERR_KAFKA_UNREACHABLE: "kafka_broker_unreachable",
  ERR_OOM_HEAP: "oom",
  ERR_DISK_FULL: "disk_full",
  ERR_SILENT_FAILURE: "silent_failure",
  ERR_STALE_SOURCE: "stale_source",
  ERR_CACHE_MISS_STORM: "cache_miss_storm",
};

function json(res, code, payload) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function errorTypeFor(code, level) {
  if (!AGENT_ROUTING) return "";
  if (level !== "err" && level !== "wrn") return "";
  const key = String(code || "").toUpperCase();
  if (ERROR_TYPES[key]) return ERROR_TYPES[key];
  const derived = key.replace(/^ERR_/, "").toLowerCase().replace(/[^a-z0-9_]/g, "_");
  return derived.slice(0, 60);
}

function timestamp(value) {
  const date = value ? new Date(value) : new Date();
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  return `${safe.toISOString().slice(0, 19).replace("T", " ")}.${String(safe.getUTCMilliseconds()).padStart(3, "0")}`;
}

function hex32(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function traceIdFor(raw) {
  const candidate = String(raw || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  if (candidate.length === 32) return candidate;
  return hex32(`${Date.now()}:${Math.random()}`).slice(0, 32);
}

function clean(text) {
  return redact(String(text == null ? "" : text))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .slice(0, MAX_LINE_CHARS);
}

/** Transforme une ligne de console en log OpenTelemetry du contrat. */
function toRecord(line, index, traceId) {
  const level = String(line.level || "inf").toLowerCase();
  const severity = SEVERITY[level] || SEVERITY.inf;
  const code = clean(line.code || "").toUpperCase().slice(0, 64);
  const service = clean(line.service || "").slice(0, 64) || SERVICE;
  const errorType = errorTypeFor(code, level);
  const attributes = {
    "agent.scenario": code || "site-console",
    "agent.profile": "site",
    "site.level": level,
    "site.service": service,
    "site.host": clean(line.host || "").slice(0, 120) || "unknown",
    "site.page": clean(line.page || "/").slice(0, 200),
    "site.session": clean(line.session || "").slice(0, 64),
    "site.source": "vercel-function",
  };
  if (errorType) attributes["error.type"] = errorType;
  return {
    Timestamp: timestamp(line.ts),
    TraceId: traceId,
    SpanId: hex32(`${traceId}:${index}:${line.text || ""}`).slice(0, 16),
    ParentSpanId: "",
    TraceFlags: "01",
    SeverityText: severity.text,
    SeverityNumber: severity.number,
    Body: clean(line.text || ""),
    LogAttributes: attributes,
    SpanAttributes: { ...attributes },
    ScopeName: SCOPE.name,
    ScopeVersion: SCOPE.version,
    ResourceAttributes: {
      "service.name": SERVICE,
      "deployment.environment": "vercel",
      "site.region": process.env.VERCEL_REGION || "",
    },
    ServiceName: SERVICE,
  };
}

// Limiteur best effort : chaque instance de fonction a sa propre memoire, ce qui
// suffit a empecher une boucle navigateur de saturer un petit plan Kafka.
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const window = hits.get(ip);
  if (!window || now - window.start > 60000) {
    hits.set(ip, { start: now, count: 1 });
    if (hits.size > 5000) hits.clear();
    return false;
  }
  window.count += 1;
  return window.count > RATE_PER_MIN;
}

function bodyOf(req) {
  let body = req.body;
  if (typeof body === "string") {
    if (body.length > MAX_BODY_CHARS) return null;
    try {
      body = JSON.parse(body);
    } catch (err) {
      return null;
    }
  }
  if (!body || typeof body !== "object") return null;
  return body;
}

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    if (!configured()) {
      return json(res, 200, {
        ok: true,
        kafka: "down",
        error: "config_error",
        hint: "variables KAFKA_BOOTSTRAP / KAFKA_USERNAME / KAFKA_PASSWORD / KAFKA_CA_PEM absentes du projet Vercel",
        topic: topicName("logs"),
      });
    }
    try {
      const state = await health();
      return json(res, 200, {
        ok: true,
        kafka: "up",
        topic: state.topic,
        brokers: state.brokers,
        routing: AGENT_ROUTING ? "agents" : "logs_only",
      });
    } catch (err) {
      const config = err instanceof KafkaConfigError;
      return json(res, 200, {
        ok: true,
        kafka: "down",
        error: config ? "config_error" : "kafka_unreachable",
        hint: config ? err.message : `Kafka injoignable (${err.message})`,
        topic: topicName("logs"),
      });
    }
  }

  if (req.method !== "POST") {
    return json(res, 405, {
      ok: false,
      error: "method_not_allowed",
      hint: 'utilise POST /api/logs avec {"lines":[...]} ou GET /api/logs pour l\'etat',
    });
  }

  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    (req.socket && req.socket.remoteAddress) ||
    "unknown";
  if (rateLimited(ip)) {
    return json(res, 429, {
      ok: false,
      error: "rate_limited",
      hint: `plus de ${RATE_PER_MIN} envois par minute depuis cette adresse`,
    });
  }

  const body = bodyOf(req);
  const lines = body && Array.isArray(body.lines) ? body.lines : body && body.line ? [body.line] : null;
  if (!lines || !lines.length) {
    return json(res, 400, {
      ok: false,
      error: "bad_request",
      hint: 'corps attendu : {"lines":[{"level":"err","text":"..."}]}',
    });
  }
  if (lines.length > MAX_LINES) {
    return json(res, 413, {
      ok: false,
      error: "too_many_lines",
      hint: `maximum ${MAX_LINES} lignes par requete`,
    });
  }

  const traceId = traceIdFor(body.trace_id || (lines[0] && lines[0].trace_id));
  let records;
  try {
    records = lines
      .filter((line) => line && (typeof line === "object" || typeof line === "string"))
      .map((line, index) =>
        typeof line === "string" ? toRecord({ text: line }, index, traceId) : toRecord(line, index, traceId)
      );
  } catch (err) {
    return json(res, 400, { ok: false, error: "bad_request", hint: "ligne illisible dans lines" });
  }
  if (!records.length) {
    return json(res, 400, { ok: false, error: "bad_request", hint: "aucune ligne exploitable" });
  }

  const messages = records.map((record) => ({ key: traceId, value: JSON.stringify(record) }));
  try {
    const produced = await publish(messages);
    return json(res, 200, {
      ok: true,
      topic: topicName("logs"),
      produced,
      trace_id: traceId,
      routing: AGENT_ROUTING ? "agents" : "logs_only",
    });
  } catch (err) {
    const config = err instanceof KafkaConfigError;
    return json(res, 503, {
      ok: false,
      error: config ? "config_error" : "kafka_unreachable",
      hint: config ? err.message : `Kafka injoignable (${err.message})`,
    });
  }
};
