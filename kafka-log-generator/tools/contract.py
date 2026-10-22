#!/usr/bin/env python3
"""Contrat des messages (§3 du prompt) — source unique de construction.

Ce module est le *seul* endroit ou un message Kafka est fabrique en Python.
Le site web (site/api/contract.js) en est le miroir exact en JavaScript :
`tools/contract-check` compare les deux productions, scenario par scenario.

Regles du contrat :
  - un message = une ligne JSON, les cles sont exactement les colonnes du
    schema OpenTelemetry standard, aucun champ enveloppe ;
  - la cle Kafka est le TraceId ;
  - Duration est en nanosecondes, Timestamp en "YYYY-MM-DD HH:MM:SS.mmm" UTC ;
  - agent.scenario + agent.profile sont sur TOUS les spans ;
  - agent.result est une chaine JSON.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent
DEFAULT_CATALOG = PROJECT_ROOT / "scenarios" / "catalog.json"

TS_FORMAT = "%Y-%m-%d %H:%M:%S.%f"


class ContractError(Exception):
    """Erreur de contrat (scenario inconnu, catalogue illisible...)."""


# --------------------------------------------------------------------------
# catalogue
# --------------------------------------------------------------------------
def load_catalog(path: Optional[str] = None) -> Dict[str, Any]:
    p = Path(path or os.environ.get("SCENARIO_CATALOG") or DEFAULT_CATALOG)
    try:
        with p.open("r", encoding="utf-8") as fh:
            cat = json.load(fh)
    except FileNotFoundError as exc:
        raise ContractError(f"catalogue introuvable : {p}") from exc
    except json.JSONDecodeError as exc:
        raise ContractError(f"catalogue illisible (JSON invalide) : {p} ({exc})") from exc
    for key in ("service", "scenarios"):
        if key not in cat:
            raise ContractError(f"catalogue invalide : cle '{key}' absente ({p})")
    return cat


def all_scenarios(catalog: Dict[str, Any], include_proof: bool = False) -> List[Dict[str, Any]]:
    out = list(catalog.get("scenarios", []))
    if include_proof:
        out += list(catalog.get("proof_scenarios", []))
    return out


def scenario_by_id(catalog: Dict[str, Any], scenario_id: str,
                   include_proof: bool = False) -> Dict[str, Any]:
    for sc in all_scenarios(catalog, include_proof=include_proof):
        if sc.get("id") == scenario_id:
            return sc
    raise ContractError(f"scenario inconnu : '{scenario_id}'")


# --------------------------------------------------------------------------
# identifiants derives (deterministes => le site et seed produisent la meme chose)
# --------------------------------------------------------------------------
def new_trace_id() -> str:
    return uuid.uuid4().hex


def span_id(trace_id: str, span_name: str) -> str:
    """16 hex derives du TraceId et du nom du span (deterministe)."""
    digest = hashlib.sha256(f"{trace_id}:{span_name}".encode("utf-8")).hexdigest()
    return digest[:16]


def parse_ts(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%d %H:%M:%S.%f")


def format_ts(value: datetime) -> str:
    return value.strftime("%Y-%m-%d %H:%M:%S.") + f"{value.microsecond // 1000:03d}"


def shift_ts(base: datetime, offset_ms: int) -> str:
    return format_ts(base + timedelta(milliseconds=int(offset_ms)))


def ts_to_unix_ns(value: datetime) -> int:
    """Nanosecondes depuis l'epoch, en arithmetique entiere exacte.

    On evite total_seconds()*1e9 : le passage par un float perdrait les
    microsecondes et le JS ne tomberait pas sur la meme valeur.
    """
    epoch = datetime(1970, 1, 1)
    delta = value - epoch
    return delta.days * 86_400_000_000_000 + delta.seconds * 1_000_000_000 + delta.microseconds * 1_000


_PLACEHOLDER = re.compile(r"\{\{([a-z_]+)\}\}")


def substitute(value: Any, trace_id: str) -> Any:
    """Remplace {{trace_id}} dans les chaines ; laisse les autres types intacts."""
    if not isinstance(value, str):
        return value

    def repl(match: "re.Match[str]") -> str:
        name = match.group(1)
        if name == "trace_id":
            return trace_id
        if name.startswith("span_id:"):
            return span_id(trace_id, name.split(":", 1)[1])
        return match.group(0)

    return _PLACEHOLDER.sub(repl, value)


def _attrs(raw: Optional[Dict[str, Any]], trace_id: str) -> Dict[str, str]:
    return {str(k): substitute(str(v), trace_id) for k, v in (raw or {}).items()}


def _number(raw: Any) -> Any:
    """Nombre JSON identique en Python et en JavaScript.

    JSON.stringify(20) -> 20 ; json.dumps(20.0) -> 20.0 : les deux
    langages ne s'accordent pas sur la forme. On renvoie donc un entier
    quand la valeur est integrale, comme le fait JavaScript.
    """
    value = float(raw)
    return int(value) if value.is_integer() else value


# --------------------------------------------------------------------------
# construction des messages
# --------------------------------------------------------------------------
def build_messages(catalog: Dict[str, Any], scenario: Dict[str, Any],
                   trace_id: Optional[str] = None,
                   base_timestamp: Optional[str] = None) -> Dict[str, List[Dict[str, Any]]]:
    """Retourne {"traces": [...], "logs": [...], "metrics": [...]} pour un scenario.

    La construction est purement fonctionnelle : meme scenario + meme trace_id
    + meme base_timestamp => memes messages (c'est ce que verifie
    tools/contract-check entre Python et JavaScript).
    """
    trace_id = trace_id or new_trace_id()
    base = parse_ts(base_timestamp or catalog["base_timestamp"])
    svc = catalog["service"]
    res_attrs = {str(k): str(v) for k, v in (svc.get("resource_attributes") or {}).items()}
    scenario_id = scenario["id"]
    profile = scenario.get("profile") or "reference"
    error_type = scenario.get("error_type")

    traces: List[Dict[str, Any]] = []
    logs: List[Dict[str, Any]] = []
    metrics: List[Dict[str, Any]] = []

    for sp in scenario.get("spans", []):
        name = sp["name"]
        parent = sp.get("parent")
        attrs: Dict[str, str] = {
            "agent.scenario": scenario_id,
            "agent.profile": profile,
        }
        if error_type:
            attrs["error.type"] = error_type
        attrs.update(_attrs(sp.get("attributes"), trace_id))
        if name == "agent.run" and scenario.get("agent_result"):
            attrs["agent.result"] = scenario["agent_result"]
        traces.append({
            "Timestamp": shift_ts(base, sp.get("offset_ms", 0)),
            "TraceId": trace_id,
            "SpanId": span_id(trace_id, name),
            "ParentSpanId": span_id(trace_id, parent) if parent else "",
            "TraceState": "",
            "SpanName": name,
            "SpanKind": sp.get("kind", "SPAN_KIND_INTERNAL"),
            "ServiceName": svc["name"],
            "ResourceAttributes": res_attrs,
            "ScopeName": svc["scope_name"],
            "ScopeVersion": svc["scope_version"],
            "SpanAttributes": attrs,
            "Duration": int(sp.get("duration_ms", 0)) * 1_000_000,
            "StatusCode": sp.get("status", "Unset"),
            "StatusMessage": "",
        })

    for lg in scenario.get("logs", []):
        span_name = lg.get("span")
        log_attrs: Dict[str, str] = {
            "agent.scenario": scenario_id,
            "agent.profile": profile,
        }
        if error_type:
            log_attrs["error.type"] = error_type
        log_attrs.update(_attrs(lg.get("attributes"), trace_id))
        logs.append({
            "Timestamp": shift_ts(base, lg.get("offset_ms", 0)),
            "TraceId": trace_id,
            "SpanId": span_id(trace_id, span_name) if span_name else "",
            "ParentSpanId": "",
            "TraceFlags": "01",
            "SeverityText": lg.get("severity", "INFO"),
            "SeverityNumber": int(lg.get("severity_number", 9)),
            "Body": substitute(str(lg.get("body", "")), trace_id),
            "LogAttributes": dict(log_attrs),
            # §3 : SpanAttributes est obligatoire sur les logs (agent.scenario y est lu)
            "SpanAttributes": dict(log_attrs),
            "ScopeName": svc["scope_name"],
            "ScopeVersion": svc["scope_version"],
            "ResourceAttributes": res_attrs,
            "ServiceName": svc["name"],
        })

    for mt in scenario.get("metrics", []):
        metric_attrs: Dict[str, str] = {
            "agent.scenario": scenario_id,
            "agent.profile": profile,
        }
        if error_type:
            metric_attrs["error.type"] = error_type
        metric_attrs.update(_attrs(mt.get("attributes"), trace_id))
        ts = base + timedelta(milliseconds=int(mt.get("offset_ms", 0)))
        metrics.append({
            "MetricName": mt["name"],
            "MetricUnit": mt.get("unit", "1"),
            "Attributes": metric_attrs,
            "TimeUnix": ts_to_unix_ns(ts),
            "Value": _number(mt.get("value", 0)),
            "HistogramBucketCounts": [],
            "HistogramExplicitBounds": [],
            "HistogramExemplars": [],
            "HistogramCounts": [],
        })

    return {"trace_id": trace_id, "traces": traces, "logs": logs, "metrics": metrics}


def iter_messages(messages: Dict[str, List[Dict[str, Any]]]) -> Iterable[tuple]:
    """(topic_suffix, cle_kafka, message) pour chaque message produit.

    La cle Kafka est TOUJOURS le TraceId, y compris pour les metriques :
    §3 dit que la table otel.metrics n'a pas de colonne TraceId, mais la
    cle de partition reste celle de la trace.
    """
    trace_id = messages.get("trace_id", "")
    if not trace_id:
        for msg in messages.get("traces", []):
            trace_id = msg.get("TraceId", "")
            break
    for suffix in ("traces", "logs", "metrics"):
        for msg in messages.get(suffix, []):
            yield suffix, trace_id, msg


def dumps(msg: Dict[str, Any]) -> str:
    """Une ligne JSON par message (separateurs compacts, ordre stable)."""
    return json.dumps(msg, separators=(",", ":"), ensure_ascii=False)


if __name__ == "__main__":  # pragma: no cover - utilitaire CLI
    import sys

    cat = load_catalog()
    if len(sys.argv) < 2:
        for sc in all_scenarios(cat, include_proof=True):
            print(f"{sc['id']:34s} error_type={sc.get('error_type')}")
        raise SystemExit(0)
    sc = scenario_by_id(cat, sys.argv[1], include_proof=True)
    msgs = build_messages(cat, sc, trace_id=sys.argv[2] if len(sys.argv) > 2 else None)
    for _suffix, _key, msg in iter_messages(msgs):
        print(dumps(msg))
