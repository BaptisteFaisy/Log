const logsHandler = require("../api/logs");
const memosHandler = require("../api/memos");
const metricsHandler = require("../api/metrics");
const runsHandler = require("../api/runs");
const { disconnect } = require("../lib/kafka.cjs");
const { getPool } = require("../lib/db.cjs");

function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) {
      this.headers[k] = v;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

const call = async (handler, req) => {
  const res = fakeRes();
  await handler(req, res);
  return res;
};

(async () => {
  const code = "ERR_PAYLOAD_INVALID";
  const message = "Cannot read properties of null (reading 'order')";

  const created = await call(logsHandler, {
    method: "POST",
    query: {},
    body: {
      code,
      severity: "err",
      message,
      trace_id: "abc123",
      payload: { route: "/api/checkout", region: "cdg1" },
    },
  });
  console.log("POST /api/logs", created.statusCode, JSON.stringify(created.body));
  if (created.statusCode !== 201) process.exit(1);

  const list = await call(logsHandler, { method: "GET", query: { limit: "5" } });
  console.log("GET /api/logs", list.statusCode, JSON.stringify(list.body));

  const memo = await call(memosHandler, {
    method: "POST",
    query: {},
    body: {
      fingerprint: created.body.log.id,
      code,
      cause: "payload.order est null",
      fix: "valider le payload avant lecture",
      files: ["app.js"],
      verification: "tests 12/12",
      tokens_used: 21000,
      duration_ms: 4200,
      agent: "agent/fix-payload-invalid",
    },
  });
  console.log("POST /api/memos", memo.statusCode, JSON.stringify(memo.body));

  const memos = await call(memosHandler, { method: "GET", query: {} });
  console.log("GET /api/memos", memos.statusCode, `memos=${memos.body.memos.length}`);

  const run = await call(runsHandler, {
    method: "POST",
    query: {},
    body: {
      run_id: `run_test_${Date.now()}`,
      fingerprint: created.body.log.id,
      code,
      mode: "cold",
      status: "resolved",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      duration_ms: 4200,
      agent_ms: 3900,
      steps: [{ name: "diagnose", duration_ms: 1200 }],
      tokens: { input: 20000, output: 1000, estimated: true },
      tokens_total: 21000,
      memo: { hit: false, path: null },
      agent: "agent/fix-payload-invalid",
      attempt: 1,
    },
  });
  console.log("POST /api/runs", run.statusCode, JSON.stringify(run.body));

  const snap = await call(metricsHandler, { method: "GET", query: {} });
  console.log(
    "GET /api/metrics",
    snap.statusCode,
    `runs=${snap.body.runs.length} memos=${snap.body.memos.length}`,
  );

  await disconnect();
  await getPool().end();
})().catch(async (error) => {
  console.error("FAIL", error.message);
  await disconnect().catch(() => {});
  process.exit(1);
});
