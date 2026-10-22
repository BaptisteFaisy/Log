#!/usr/bin/env python3
"""Les 3 detecteurs (§4, option A : Python, aucun service a payer).

Ce sont exactement les 3 requetes SQL de l'option C, reecrites en Python sur
les memes donnees (messages lus dans Kafka ou generes par seed) :

  1. retry_spiral  : > 2 appels de tool.check_reservation sur une meme trace
  2. silent_failure: booking_confirmed = 1 ET tool_confirmed = 0 sur agent.run
  3. stale_source  : version de source utilisee < version max connue

Le module ne leve jamais : il renvoie une liste de constats.
"""
from __future__ import annotations

import json
from typing import Any, Dict, Iterable, List, Optional

RETRY_SPAN = "tool.check_reservation"
AGENT_SPAN = "agent.run"
SOURCE_SPAN = "tool.search_venues"
RETRY_THRESHOLD = 2


def _json_flag(raw: Any, key: str) -> bool:
    """JSONExtractBool(agent.result, key) : absent / invalide => False."""
    if not isinstance(raw, str) or not raw:
        return False
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return False
    if not isinstance(data, dict):
        return False
    return bool(data.get(key))


def _version(value: Any) -> int:
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return 0


def detect(traces: Iterable[dict], logs: Iterable[dict] = (),
           metrics: Iterable[dict] = ()) -> List[Dict[str, Any]]:
    """Renvoie la liste des constats (un dict par anomalie detectee)."""
    traces = list(traces)
    findings: List[Dict[str, Any]] = []

    # --- 1. retry spiral ---------------------------------------------------
    per_trace: Dict[str, List[dict]] = {}
    for span in traces:
        if span.get("SpanName") != RETRY_SPAN:
            continue
        per_trace.setdefault(span.get("TraceId", ""), []).append(span)
    for trace_id, spans in per_trace.items():
        if len(spans) <= RETRY_THRESHOLD:
            continue
        statuses = []
        for span in spans:
            attrs = span.get("SpanAttributes") or {}
            statuses.append(str(attrs.get("http.response.status_code", "?")))
        sample = spans[0].get("SpanAttributes") or {}
        findings.append({
            "detector": "retry_spiral",
            "trace_id": trace_id,
            "scenario": sample.get("agent.scenario", ""),
            "profile": sample.get("agent.profile", ""),
            "message": (
                f"{len(spans)} appels {RETRY_SPAN} (seuil > {RETRY_THRESHOLD}), "
                f"statuts={statuses}"
            ),
            "details": {
                "attempts": len(spans),
                "statuses": statuses,
                "threshold": RETRY_THRESHOLD,
                "http_status": statuses[-1] if statuses else "",
            },
        })

    # --- 2. echec silencieux ------------------------------------------------
    for span in traces:
        if span.get("SpanName") != AGENT_SPAN:
            continue
        attrs = span.get("SpanAttributes") or {}
        result = attrs.get("agent.result")
        if _json_flag(result, "booking_confirmed") and not _json_flag(result, "tool_confirmed"):
            findings.append({
                "detector": "silent_failure",
                "trace_id": span.get("TraceId", ""),
                "scenario": attrs.get("agent.scenario", ""),
                "profile": attrs.get("agent.profile", ""),
                "message": (
                    "promesse non tenue : booking_confirmed=1 mais tool_confirmed=0 "
                    f"sur {AGENT_SPAN}"
                ),
                "details": {"agent_result": result},
            })

    # --- 3. source perimee -------------------------------------------------
    rows: List[Dict[str, Any]] = []
    for span in traces:
        if span.get("SpanName") != SOURCE_SPAN:
            continue
        attrs = span.get("SpanAttributes") or {}
        source_id = attrs.get("source.id")
        if not source_id:
            continue
        rows.append({
            "trace_id": span.get("TraceId", ""),
            "profile": attrs.get("agent.profile", ""),
            "source_id": source_id,
            "version": _version(attrs.get("source.version")),
            "scenario": attrs.get("agent.scenario", ""),
        })
    max_version: Dict[tuple, int] = {}
    for row in rows:
        key = (row["profile"], row["source_id"])
        max_version[key] = max(max_version.get(key, 0), row["version"])
    for row in rows:
        key = (row["profile"], row["source_id"])
        latest = max_version.get(key, row["version"])
        if row["version"] < latest:
            findings.append({
                "detector": "stale_source",
                "trace_id": row["trace_id"],
                "scenario": row["scenario"],
                "profile": row["profile"],
                "message": (
                    f"source perimee : {row['source_id']} version utilisee="
                    f"{row['version']} < version max={latest}"
                ),
                "details": {
                    "source_id": row["source_id"],
                    "version_used": row["version"],
                    "version_max": latest,
                },
            })

    findings.sort(key=lambda f: (f["detector"], f["trace_id"]))
    return findings


def findings_by_detector(findings: Iterable[dict]) -> Dict[str, int]:
    counts: Dict[str, int] = {"retry_spiral": 0, "silent_failure": 0, "stale_source": 0}
    for f in findings:
        counts[f["detector"]] = counts.get(f["detector"], 0) + 1
    return counts


def verdict_lines(findings: Iterable[dict]) -> List[str]:
    """Rend le verdict comme dans §4 (une ligne par detecteur)."""
    findings = list(findings)
    lines: List[str] = []
    for detector in ("retry_spiral", "silent_failure", "stale_source"):
        matches = [f for f in findings if f["detector"] == detector]
        if not matches:
            if detector == "retry_spiral":
                lines.append("[ok      ] retry_spiral     aucune spirale de retry (> 2 appels)")
            elif detector == "silent_failure":
                lines.append("[ok      ] silent_failure   aucune promesse non tenue par l'outil")
            else:
                lines.append("[ok      ] stale_source     aucune version perimee")
            continue
        for f in matches:
            lines.append(f"[PROBLEME] {detector:16s} {f['message']}")
    return lines


def build_broken_variants(catalog: dict, build_messages) -> Dict[str, List[dict]]:
    """Jeux de donnees SAINS mais CASSES, jamais publies.

    Ils servent au self-check : un detecteur qui ne se déclenche pas sur un
    run casse est un detecteur casse.
    """
    broken: Dict[str, List[dict]] = {"traces": [], "logs": [], "metrics": []}
    scenarios = catalog.get("scenarios", [])
    if not scenarios:
        return broken

    # (a) echec silencieux : booking_confirmed=1 mais tool_confirmed=0
    base = dict(scenarios[-1])
    silent = json.loads(json.dumps(base))
    silent["id"] = "broken_silent_failure"
    silent["error_type"] = "silent_failure"
    silent["agent_result"] = (
        '{"success":true,"booking_confirmed":true,"tool_confirmed":false,"tool_calls":1}'
    )
    for span in silent["spans"]:
        if span["name"] == "agent.run":
            span["attributes"]["error.type"] = "silent_failure"
    msgs = build_messages(catalog, silent, trace_id="b" * 32)
    for key in broken:
        broken[key].extend(msgs[key])

    # (b) source perimee : version 5 utilisee alors que la version 7 existe
    stale = json.loads(json.dumps(base))
    stale["id"] = "broken_stale_source"
    stale["error_type"] = "stale_source"
    for span in stale["spans"]:
        if span["name"] == "tool.search_venues":
            span["attributes"]["source.version"] = "5"
    msgs = build_messages(catalog, stale, trace_id="c" * 32)
    for key in broken:
        broken[key].extend(msgs[key])

    # (c) reference "fraîche" (version 7) : le detecteur ne doit PAS la flaguer
    fresh = json.loads(json.dumps(base))
    fresh["id"] = "reference_fresh_source"
    fresh["error_type"] = None
    msgs = build_messages(catalog, fresh, trace_id="d" * 32)
    for key in broken:
        broken[key].extend(msgs[key])

    # (d) spirale de retry : 3 appels (seuil > 2) -> DOIT etre detectee
    pool = next((s for s in scenarios if s.get("error_type") == "db_pool_exhausted"), None)
    if pool:
        spiral = json.loads(json.dumps(pool))
        spiral["id"] = "broken_retry_spiral"
        spiral["spans"] = [s for s in spiral["spans"] if s["name"] == "agent.run"]
        parent = spiral["spans"][0]
        for i in range(3):
            child = json.loads(json.dumps(parent))
            child["name"] = "tool.check_reservation"
            child["parent"] = "agent.run"
            child["offset_ms"] = 100 + i * 400
            child["duration_ms"] = 380
            spiral["spans"].append(child)
        msgs = build_messages(catalog, spiral, trace_id="e" * 32)
        for key in broken:
            broken[key].extend(msgs[key])

        # (e) 2 appels seulement : sous le seuil -> NE DOIT PAS etre detecte
        below = json.loads(json.dumps(spiral))
        below["id"] = "reference_below_threshold"
        below["spans"] = [s for s in below["spans"] if s["name"] != "tool.check_reservation"]
        parent = below["spans"][0]
        for i in range(2):
            child = json.loads(json.dumps(parent))
            child["name"] = "tool.check_reservation"
            child["parent"] = "agent.run"
            child["offset_ms"] = 100 + i * 400
            child["duration_ms"] = 380
            below["spans"].append(child)
        msgs = build_messages(catalog, below, trace_id="f" * 32)
        for key in broken:
            broken[key].extend(msgs[key])

    return broken
