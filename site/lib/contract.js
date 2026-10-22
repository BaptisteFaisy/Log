'use strict';
/**
 * Miroir JavaScript de tools/contract.py (§3 du prompt).
 *
 * Regle du projet : le message produit par la console web (api/incident.js) et
 * le message produit par `seed` doivent etre IDENTIQUES. On ne compare pas deux
 * implementations « a peu pres » : les deux lisent le meme catalogue
 * (scenarios/catalog.json) et appliquent les memes regles de derivation.
 * `tools/contract-check` le verifie scenario par scenario.
 *
 * Derivation (identique en Python et en JS) :
 *   - TraceId  : fourni par l'appelant (uuid4().hex en production)
 *   - SpanId   : sha256(TraceId + ":" + SpanName).slice(0, 16)   (16 hex)
 *   - Parent   : sha256(TraceId + ":" + parent).slice(0, 16) ou ""
 *   - Timestamp: base_timestamp + offset_ms, format "YYYY-MM-DD HH:MM:SS.mmm"
 *   - Duration : duration_ms * 1e6 (nanosecondes)
 *   - TimeUnix : timestamp en nanosecondes depuis l'epoch (entiers exacts)
 *   - Value    : Number(value) du catalogue
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HERE = path.dirname(__filename);
const SITE_ROOT = path.resolve(HERE, '..');
const DEFAULT_CATALOG = path.join(SITE_ROOT, 'scenarios', 'catalog.json');
// Le catalogue canonique vit a la racine du projet ; le dossier site/ est la
// racine du deploiement Vercel, ou une copie est generee par
// tools/sync-site-catalog.sh. On tente le canonique en premier.
const CATALOG_CANDIDATES = [
  path.resolve(HERE, '..', '..', 'scenarios', 'catalog.json'),
  DEFAULT_CATALOG,
];

class ContractError extends Error {}

function loadCatalog(catalogPath) {
  const candidates = catalogPath || process.env.SCENARIO_CATALOG
    ? [catalogPath || process.env.SCENARIO_CATALOG]
    : CATALOG_CANDIDATES;
  let p = null;
  let raw = null;
  for (const candidate of candidates) {
    try {
      raw = fs.readFileSync(candidate, 'utf8');
      p = candidate;
      break;
    } catch (err) {
      /* on essaie le suivant */
    }
  }
  if (raw === null) {
    throw new ContractError(`catalogue introuvable : ${candidates.join(' | ')}`);
  }
  let cat;
  try {
    cat = JSON.parse(raw);
  } catch (err) {
    throw new ContractError(`catalogue illisible (JSON invalide) : ${p}`);
  }
  if (!cat.service || !cat.scenarios) {
    throw new ContractError(`catalogue invalide : cle service/scenarios absente (${p})`);
  }
  return cat;
}

function allScenarios(catalog, includeProof) {
  const out = (catalog.scenarios || []).slice();
  if (includeProof) {
    for (const s of catalog.proof_scenarios || []) out.push(s);
  }
  return out;
}

function scenarioById(catalog, scenarioId, includeProof) {
  const found = allScenarios(catalog, includeProof).find((s) => s.id === scenarioId);
  if (!found) throw new ContractError(`scenario inconnu : '${scenarioId}'`);
  return found;
}

function newTraceId() {
  return crypto.randomBytes(16).toString('hex');
}

function sha256hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function spanId(traceId, spanName) {
  return sha256hex(`${traceId}:${spanName}`).slice(0, 16);
}

function parseTs(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(text);
  if (!m) throw new ContractError(`timestamp invalide : '${text}'`);
  return {
    y: Number(m[1]),
    mo: Number(m[2]),
    d: Number(m[3]),
    h: Number(m[4]),
    mi: Number(m[5]),
    s: Number(m[6]),
    ms: Number(m[7]),
  };
}

function baseMs(parts) {
  return Date.UTC(parts.y, parts.mo - 1, parts.d, parts.h, parts.mi, parts.s, parts.ms);
}

function pad(n, width) {
  return String(n).padStart(width || 2, '0');
}

function formatTs(ms) {
  const d = new Date(ms);
  return (
    `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`
  );
}

function substitute(value, traceId) {
  if (typeof value !== 'string') return value;
  return value.replace(/\{\{([a-z_]+)\}\}/g, (whole, name) => {
    if (name === 'trace_id') return traceId;
    if (name.startsWith('span_id:')) return spanId(traceId, name.slice('span_id:'.length));
    return whole;
  });
}

function attrs(raw, traceId) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) out[String(k)] = substitute(String(v), traceId);
  return out;
}

function buildMessages(catalog, scenario, traceId, baseTimestamp) {
  const tid = traceId || newTraceId();
  const base = parseTs(baseTimestamp || catalog.base_timestamp);
  const baseMillis = baseMs(base);
  const svc = catalog.service;
  const resAttrs = {};
  for (const [k, v] of Object.entries(svc.resource_attributes || {})) resAttrs[String(k)] = String(v);

  const scenarioId = scenario.id;
  const profile = scenario.profile || 'reference';
  const errorType = scenario.error_type || null;

  const traces = [];
  const logs = [];
  const metrics = [];

  for (const sp of scenario.spans || []) {
    const name = sp.name;
    const parent = sp.parent || null;
    const a = { 'agent.scenario': scenarioId, 'agent.profile': profile };
    if (errorType) a['error.type'] = errorType;
    Object.assign(a, attrs(sp.attributes, tid));
    if (name === 'agent.run' && scenario.agent_result) a['agent.result'] = scenario.agent_result;
    traces.push({
      Timestamp: formatTs(baseMillis + Number(sp.offset_ms || 0)),
      TraceId: tid,
      SpanId: spanId(tid, name),
      ParentSpanId: parent ? spanId(tid, parent) : '',
      TraceState: '',
      SpanName: name,
      SpanKind: sp.kind || 'SPAN_KIND_INTERNAL',
      ServiceName: svc.name,
      ResourceAttributes: resAttrs,
      ScopeName: svc.scope_name,
      ScopeVersion: svc.scope_version,
      SpanAttributes: a,
      Duration: Number(sp.duration_ms || 0) * 1000000,
      StatusCode: sp.status || 'Unset',
      StatusMessage: '',
    });
  }

  for (const lg of scenario.logs || []) {
    const spanName = lg.span || null;
    const la = { 'agent.scenario': scenarioId, 'agent.profile': profile };
    if (errorType) la['error.type'] = errorType;
    Object.assign(la, attrs(lg.attributes, tid));
    logs.push({
      Timestamp: formatTs(baseMillis + Number(lg.offset_ms || 0)),
      TraceId: tid,
      SpanId: spanName ? spanId(tid, spanName) : '',
      ParentSpanId: '',
      TraceFlags: '01',
      SeverityText: lg.severity || 'INFO',
      SeverityNumber: Number(lg.severity_number || 9),
      Body: substitute(String(lg.body || ''), tid),
      LogAttributes: la,
      SpanAttributes: la,
      ScopeName: svc.scope_name,
      ScopeVersion: svc.scope_version,
      ResourceAttributes: resAttrs,
      ServiceName: svc.name,
    });
  }

  for (const mt of scenario.metrics || []) {
    const ma = { 'agent.scenario': scenarioId, 'agent.profile': profile };
    if (errorType) ma['error.type'] = errorType;
    Object.assign(ma, attrs(mt.attributes, tid));
    metrics.push({
      MetricName: mt.name,
      MetricUnit: mt.unit || '1',
      Attributes: ma,
      TimeUnix: (baseMillis + Number(mt.offset_ms || 0)) * 1000000,
      Value: Number(mt.value || 0),
      HistogramBucketCounts: [],
      HistogramExplicitBounds: [],
      HistogramExemplars: [],
      HistogramCounts: [],
    });
  }

  return { trace_id: tid, traces, logs, metrics };
}

module.exports = {
  ContractError,
  loadCatalog,
  allScenarios,
  scenarioById,
  newTraceId,
  spanId,
  buildMessages,
};
