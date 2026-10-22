'use strict';
/**
 * GET /api/report?trace_id=<id>
 *   -> 200 {"ok":true,"status":"done","agent":"...","report":"..."}
 *   -> 404 {"ok":false,"error":"pending"}   (l'agent n'a pas encore fini)
 *   -> 503 {"ok":false,"error":"kafka_unreachable"}
 *
 * Le rapport est publie dans otel-reports par le watcher, apres la fin du vrai
 * agent. Le navigateur interroge cet endpoint tant que status = pending.
 */
const { findReport, publicReason, KafkaConfigError } = require('./_kafka.js');

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

  const traceId = String((req.query && req.query.trace_id) || '').trim();
  if (!/^[0-9A-Za-z_-]{1,64}$/.test(traceId)) {
    return json(res, 400, {
      ok: false,
      error: 'bad_request',
      hint: 'parametre trace_id manquant ou invalide (?trace_id=<32 hex>)',
    });
  }

  let report = null;
  try {
    report = await findReport(traceId, 8000);
  } catch (err) {
    const configError = err instanceof KafkaConfigError;
    process.stderr.write(`api/report : ${err.message}\n`);
    return json(res, configError ? 500 : 503, {
      ok: false,
      error: configError ? 'config_error' : 'kafka_unreachable',
      hint: configError
        ? `configuration Kafka incomplete cote serveur : ${err.message}`
        : `Kafka injoignable (${publicReason(err)}) — reessaie dans un instant.`,
    });
  }

  if (!report) {
    return json(res, 404, {
      ok: false,
      error: 'pending',
      trace_id: traceId,
      hint: "l'agent n'a pas encore publie de rapport pour cette trace",
    });
  }

  return json(res, 200, {
    ok: true,
    status: 'done',
    trace_id: report.TraceId || traceId,
    agent: report.agent || '',
    agent_group: report.agent_group || '',
    agent_group_label: report.agent_group_label || '',
    agent_origin: report.agent_origin || '',
    agent_origin_label: report.agent_origin_label || '',
    error_type: report.error_type || '',
    scenario: report.scenario || '',
    title: report.title || '',
    exit_code: report.exit_code,
    session_id: report.session_id || '',
    report: report.report || '',
  });
};
