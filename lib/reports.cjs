/* Normalisation d'un rapport d'agent publie sur `otel-reports` par le watcher
   de BaptisteFaisy/Log (tools/kafka-incident-watch). Le format exact n'est pas
   garanti : on accepte les variantes connues et on conserve le message brut. */

const { codeFor, scenarioFor } = require("./errors-map.cjs");

const STATUSES = new Set(["resolved", "blocked", "failed", "abandoned"]);

function pick(payload, keys) {
  for (const key of keys) {
    const value = payload[key];
    if (value != null && value !== "") return value;
  }
  return null;
}

function attrsOf(payload) {
  const merged = {};
  for (const source of [payload.Attributes, payload.LogAttributes, payload.SpanAttributes, payload.ResourceAttributes]) {
    if (source && typeof source === "object") Object.assign(merged, source);
  }
  return merged;
}

function statusOf(value) {
  const text = String(value || "").toLowerCase();
  if (STATUSES.has(text)) return text;
  if (text.includes("resolv") || text.includes("success") || text === "ok") return "resolved";
  if (text.includes("block")) return "blocked";
  if (text.includes("fail") || text.includes("error")) return "failed";
  return "unknown";
}

function textOf(value, max) {
  if (value == null) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.slice(0, max);
}

/* Retourne { report, ok } ; ok=false quand le message n'est pas un rapport
   exploitable (on l'ignore plutot que d'ecrire une ligne vide). */
function normalize(raw) {
  const payload = raw && typeof raw === "object" ? raw : { report: String(raw || "") };
  const attrs = attrsOf(payload);

  const traceId = pick(payload, ["trace_id", "TraceId", "traceId"]) || attrs["trace.id"] || null;
  const errorType = pick(payload, ["error_type", "errorType", "error.type"]) || attrs["error.type"] || null;
  const code = codeFor(errorType) || pick(payload, ["code"]) || "ERR_UNKNOWN";

  const agent =
    pick(payload, ["agent", "agent_name", "agentName"]) ||
    attrs["agent.name"] ||
    attrs["agent.scenario"] ||
    "agent/unknown";

  const status = statusOf(
    pick(payload, ["status", "outcome", "result.status"]) || attrs["agent.status"],
  );

  const report =
    textOf(
      pick(payload, ["report", "summary", "message", "body", "Body", "text"]),
      8000,
    ) || "";

  const summary = report.split("\n").find((line) => line.trim()) || "";
  const publishedAt = pick(payload, ["published_at", "timestamp", "Timestamp", "ts"]);

  return {
    ok: Boolean(traceId || errorType || report),
    report: {
      trace_id: traceId,
      error_type: errorType,
      code,
      scenario: (scenarioFor(code) || {}).id || null,
      agent: String(agent).slice(0, 120),
      status,
      summary: summary.slice(0, 400),
      report,
      payload,
      published_at: publishedAt,
    },
  };
}

module.exports = { normalize, statusOf };
