'use strict';
/**
 * POST /api/incident  {"scenario":"<id>"}  ->  {"ok":true,"trace_id":"<32 hex>",...}
 *
 * Publie un VRAI incident dans otel.logs / otel.traces (cle = TraceId). Le
 * watcher de la machine (tools/kafka-incident-watch) le consomme et lance le
 * vrai agent ; son rapport revient par GET /api/report?trace_id=...
 *
 *   scenario inconnu   -> 400 {"ok":false,"error":"unknown_scenario"}
 *   Kafka non configure-> 500 {"ok":false,"error":"config_error"}
 *   Kafka injoignable  -> 503 {"ok":false,"error":"kafka_unreachable"}
 *
 * Jamais de stack trace ni d'identifiant dans la reponse.
 */
const { loadCatalog, scenarioById, buildMessages, newTraceId } = require('../lib/contract.js');
const { publish, publicReason, KafkaConfigError } = require('../lib/kafka.js');

function json(res, code, payload) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  // Sur Vercel, `req.body` est evalue a la demande et LEVE si le JSON est
  // invalide (le runtime repondrait 400 avec un corps vide, hors JSON).
  let body = null;
  try {
    body = req.body;
  } catch (err) {
    return null;
  }
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body || '{}');
    } catch (err) {
      return null;
    }
  }
  if (Buffer.isBuffer(body)) {
    try {
      body = JSON.parse(body.toString('utf8') || '{}');
    } catch (err) {
      return null;
    }
  }
  return body && typeof body === 'object' ? body : null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, {
      ok: false,
      error: 'method_not_allowed',
      hint: 'utilise POST /api/incident avec {"scenario":"<id>"}',
    });
  }

  const body = readBody(req);
  if (!body || !body.scenario) {
    return json(res, 400, {
      ok: false,
      error: 'bad_request',
      hint: 'corps attendu : {"scenario":"<identifiant du scenario>"}',
    });
  }

  let scenario;
  let messages;
  let traceId;
  try {
    const catalog = loadCatalog();
    scenario = scenarioById(catalog, body.scenario, false);
    traceId = newTraceId();
    messages = buildMessages(catalog, scenario, traceId);
  } catch (err) {
    const unknown = /scenario inconnu/.test(err.message || '');
    return json(res, unknown ? 400 : 500, {
      ok: false,
      error: unknown ? 'unknown_scenario' : 'catalog_error',
      hint: unknown
        ? `scenario inconnu : ${body.scenario} — consulte /scenarios/catalog.json pour la liste`
        : 'catalogue des scenarios illisible',
    });
  }

  const bySuffix = {};
  let count = 0;
  for (const suffix of ['traces', 'logs', 'metrics']) {
    const list = [];
    for (const msg of messages[suffix] || []) {
      list.push({ key: msg.TraceId || traceId, value: JSON.stringify(msg) });
      count += 1;
    }
    if (list.length) bySuffix[suffix] = list;
  }

  try {
    await publish(bySuffix, 15000);
  } catch (err) {
    const configError = err instanceof KafkaConfigError;
    // le detail brut (adresse du broker...) reste dans les journaux serveur
    process.stderr.write(`api/incident : ${err.message}\n`);
    return json(res, configError ? 500 : 503, {
      ok: false,
      error: configError ? 'config_error' : 'kafka_unreachable',
      hint: configError
        ? `configuration Kafka incomplete cote serveur : ${err.message}`
        : `Kafka injoignable (${publicReason(err)}) — reessaye dans un instant.`,
    });
  }

  return json(res, 200, {
    ok: true,
    trace_id: traceId,
    scenario: scenario.id,
    error_type: scenario.error_type || null,
    severity: scenario.severity || null,
    messages: count,
    hint: 'incident publie : le watcher de la machine va lancer le vrai agent, '
      + 'le rapport arrive par GET /api/report?trace_id=',
  });
};
