import assert from "node:assert/strict";
import test from "node:test";
import { normalize, statusOf } from "../lib/reports.cjs";

test("rapport watcher : trace, agent, statut et resume", () => {
  const { ok, report } = normalize({
    trace_id: "abc123",
    error_type: "db_pool_exhausted",
    agent: "db-diagnose",
    status: "resolved",
    report: "Cause : fuite de connexions.\nCorrectif : try-with-resources.",
  });

  assert.equal(ok, true);
  assert.equal(report.code, "ERR_DB_POOL_EXHAUSTED");
  assert.equal(report.scenario, "platform_db_pool_exhausted");
  assert.equal(report.agent, "db-diagnose");
  assert.equal(report.status, "resolved");
  assert.equal(report.summary, "Cause : fuite de connexions.");
});

test("attributs OTel utilises quand les champs directs manquent", () => {
  const { report } = normalize({
    TraceId: "t-1",
    LogAttributes: { "error.type": "oom" },
    Body: "java.lang.OutOfMemoryError: Java heap space",
    SeverityText: "ERROR",
  });

  assert.equal(report.code, "ERR_OOM_HEAP");
  assert.equal(report.trace_id, "t-1");
  assert.match(report.report, /OutOfMemoryError/);
});

test("message brut (non JSON) reste exploitable", () => {
  const { ok, report } = normalize({ report: "agent termine sans conclusion" });
  assert.equal(ok, true);
  assert.equal(report.code, "ERR_UNKNOWN");
  assert.equal(report.status, "unknown");
});

test("statuts normalises", () => {
  assert.equal(statusOf("SUCCESS"), "resolved");
  assert.equal(statusOf("resolved"), "resolved");
  assert.equal(statusOf("blocked"), "blocked");
  assert.equal(statusOf("error"), "failed");
  assert.equal(statusOf(""), "unknown");
});
