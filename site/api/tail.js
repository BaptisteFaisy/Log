'use strict';
/**
 * GET /api/tail?limit=60
 *   -> 200 {"ok":true,"topic":"otel.logs","count":N,"messages":[...]}
 *   -> 503 {"ok":false,"error":"kafka_unreachable","hint":"..."}
 *   -> 500 {"ok":false,"error":"config_error","hint":"..."}
 *
 * Le terminal du site n'affiche QUE ces messages : ils sont lus dans le topic
 * Aiven `otel.logs` (consommateur de api/_kafka.js), pas fabriques cote
 * navigateur. Un topic vide renvoie une liste vide, ce qui est la verite.
 *
 * Chaque message : { partition, offset, ts, level, text, code, service,
 *                    trace_id, error_type }
 */
const { tailMessages, publicReason, KafkaConfigError } = require('./_kafka.js');

function json(res, code, payload) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(payload));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return json(res, 405, { ok: false, error: 'method_not_allowed' });
  }

  const requested = Number((req.query && req.query.limit) || 60);
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(requested, 200)) : 60;

  let result;
  try {
    result = await tailMessages(limit, 5000);
  } catch (err) {
    const configError = err instanceof KafkaConfigError;
    // le detail brut (adresse du broker...) reste dans les journaux serveur
    process.stderr.write(`api/tail : ${err.message}\n`);
    return json(res, configError ? 500 : 503, {
      ok: false,
      error: configError ? 'config_error' : 'kafka_unreachable',
      hint: configError
        ? `configuration Kafka incomplete cote serveur : ${err.message}`
        : `Kafka injoignable (${publicReason(err)}) — reessaie dans un instant.`,
    });
  }

  return json(res, 200, {
    ok: true,
    topic: result.topic,
    ready: result.ready,
    count: result.messages.length,
    messages: result.messages,
  });
};
