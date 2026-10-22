// GET /api/agents — la flotte d'agents et ses passages reels.
//
// Repond a « qui traite les incidents, et depuis quelle machine ? » a partir de
// deux sources seulement :
//   1. le manifeste des groupes (api/_groups.js, genere depuis
//      ~/aiven-kafka-demo/agents/group.json par tools/sync-log-site-group.sh) :
//      groupe -> cas d'usage -> machine d'origine -> membres ;
//   2. le topic otel-reports, ou le watcher republie chaque rapport avec
//      l'identification du groupe (agent_group, agent_origin, agent_role).
//
// Rien n'est simule ici : un agent qui n'a jamais tourne apparait avec runs: 0.
// Si Kafka est injoignable, la flotte reste lisible et la reponse porte
// kafka: "down" + une raison courte (aucune adresse, aucun secret).
//
//   200 {"ok":true,"kafka":"up"|"down"|"unconfigured","groups":[...],"runs":[...]}
//   405 {"ok":false,"error":"method_not_allowed"}
//
// Jamais de pile d'appels, jamais de secret : l'extrait de rapport passe par
// _redact (le site est public).
"use strict";

const groups = require("./_groups.js");
const { listReports, publicReason, KafkaConfigError } = require("./_kafka.js");
const { redact } = require("./_redact.js");

const MAX_RUNS = 8;
const EXCERPT_MAX = 700;
const BUDGET_MS = 12000;

const MANIFEST = Array.isArray(groups.groups) ? groups.groups : [];

function json(res, code, payload) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(payload));
}

/** Index agent -> { groupe, membre }. */
function agentIndex() {
  const index = new Map();
  for (const group of MANIFEST) {
    for (const member of group.members || []) index.set(member.name, { group, member });
  }
  return index;
}

function defaultGroup() {
  return MANIFEST.find((group) => group.default) || MANIFEST[0] || null;
}

function excerpt(report) {
  const text = String(report || "").trim();
  if (!text) return "";
  return redact(text.length > EXCERPT_MAX ? `${text.slice(0, EXCERPT_MAX)}…` : text);
}

function runFrom(report, index) {
  const name = String(report.agent || "");
  const known = index.get(name);
  const groupId = String(report.agent_group || (known ? known.group.id : ""));
  const group = MANIFEST.find((entry) => entry.id === groupId) || (known ? known.group : null);
  const exitCode = report.exit_code === null || report.exit_code === undefined ? null : Number(report.exit_code);
  return {
    trace_id: String(report.TraceId || ""),
    agent: name,
    group: groupId,
    group_label: String(report.agent_group_label || (group ? group.label : "")),
    use_case: String(report.agent_use_case || (group ? group.use_case : "")),
    origin: String(report.agent_origin || (group ? group.origin.machine : "")),
    origin_label: String(report.agent_origin_label || (group ? group.origin.machine_label : "")),
    role: String(report.agent_role || (known ? known.member.role : "")),
    error_type: String(report.error_type || ""),
    scenario: String(report.scenario || ""),
    exit_code: Number.isFinite(exitCode) ? exitCode : null,
    timestamp: String(report.Timestamp || ""),
    excerpt: excerpt(report.report),
  };
}

/** Statistiques par agent : nombre de passages + dernier passage. */
function statsByAgent(runs) {
  const stats = new Map();
  for (const run of runs) {
    const current = stats.get(run.agent) || {
      runs: 0,
      last_seen: "",
      last_error_type: "",
      last_trace_id: "",
      last_exit_code: null,
    };
    current.runs += 1;
    if (!current.last_seen) {
      // runs est trie du plus recent au plus ancien
      current.last_seen = run.timestamp;
      current.last_error_type = run.error_type;
      current.last_trace_id = run.trace_id;
      current.last_exit_code = run.exit_code;
    }
    stats.set(run.agent, current);
  }
  return stats;
}

function publicGroups(stats) {
  return MANIFEST.map((group) => ({
    id: group.id,
    label: group.label,
    use_case: group.use_case,
    default: Boolean(group.default),
    origin: {
      machine: group.origin.machine,
      machine_label: group.origin.machine_label,
      created_on: group.origin.created_on,
      created_by: group.origin.created_by,
    },
    members: (group.members || []).map((member) => ({
      name: member.name,
      mode: member.mode,
      role: member.role,
      routes: Boolean(member.routes),
      summary: member.summary,
      stats:
        stats.get(member.name) || {
          runs: 0,
          last_seen: "",
          last_error_type: "",
          last_trace_id: "",
          last_exit_code: null,
        },
    })),
  }));
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return json(res, 405, { ok: false, error: "method_not_allowed" });
  }

  const active = defaultGroup();
  const base = {
    ok: true,
    generated_at: new Date().toISOString(),
    active_group: active ? active.id : "",
    active_group_source: "manifeste (groupe par defaut)",
  };

  let listing;
  try {
    listing = await listReports(BUDGET_MS);
  } catch (error) {
    // La flotte reste affichable : seul l'etat Kafka change.
    const unconfigured = error instanceof KafkaConfigError;
    return json(res, 200, {
      ...base,
      kafka: unconfigured ? "unconfigured" : "down",
      reason: unconfigured ? "Kafka non configure" : publicReason(error),
      topic: "",
      totals: {
        groups: MANIFEST.length,
        agents: MANIFEST.reduce((n, group) => n + (group.members || []).length, 0),
        agents_seen: 0,
        runs: 0,
      },
      groups: publicGroups(new Map()),
      runs: [],
    });
  }

  const index = agentIndex();
  const all = (listing.reports || []).map((report) => runFrom(report, index));
  const stats = statsByAgent(all);

  return json(res, 200, {
    ...base,
    kafka: listing.kafka,
    reason: listing.reason || "",
    topic: listing.topic || "",
    totals: {
      groups: MANIFEST.length,
      agents: MANIFEST.reduce((n, group) => n + (group.members || []).length, 0),
      agents_seen: stats.size,
      runs: all.length,
    },
    groups: publicGroups(stats),
    runs: all.slice(0, MAX_RUNS),
  });
};
