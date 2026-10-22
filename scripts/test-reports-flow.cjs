/* Verifie la boucle complete sans Kafka :
   log en base -> rapport d'agent -> memoire (error_resolutions + agent_runs). */
const { getPool } = require("../lib/db.cjs");
const { normalize } = require("../lib/reports.cjs");
const { saveReport, findLog, rememberResolution } = require("./consumer-reports.cjs");

const TRACE = `test-trace-${Date.now()}`;

(async () => {
  const pool = getPool();

  const logId = `test:0:${Date.now()}`;
  await pool.query(
    `insert into logs (id, topic, partition, kafka_offset, kafka_key, code, severity, message, payload, occurred_at)
     values ($1,'otel.logs',0,$2,$3,'ERR_KAFKA_UNREACHABLE','err',$4,$5, now())
     on conflict (id) do nothing`,
    [
      logId,
      Math.floor(Date.now() / 1000),
      TRACE,
      "Kafka Broker Unreachable: broker not reachable (ERR__TRANSPORT)",
      JSON.stringify({ TraceId: TRACE, stack: "BrokerNotAvailableException: broker not reachable" }),
    ],
  );

  const { ok, report } = normalize({
    trace_id: TRACE,
    error_type: "kafka_broker_unreachable",
    agent: "kafka-diagnose",
    status: "resolved",
    report: "Cause : advertised.listeners pointait sur localhost.\nCorrectif : republier l'endpoint du broker.",
  });
  if (!ok) throw new Error("rapport non exploitable");

  const id = await saveReport(pool, { topic: "otel-reports", partition: 0, offset: Date.now() }, report);
  console.log("rapport stocke:", id);

  const log = await findLog(pool, TRACE);
  console.log("log retrouve:", Boolean(log), log && log.code);

  const fp = await rememberResolution(pool, report, log);
  console.log("fingerprint memorise:", fp);

  const memo = await pool.query("select code, runs, fix from error_resolutions where fingerprint = $1", [fp]);
  console.log("memo:", JSON.stringify(memo.rows[0]));

  const run = await pool.query("select run_id, mode, status from agent_runs where fingerprint = $1", [fp]);
  console.log("run:", JSON.stringify(run.rows[0]));

  await pool.query("delete from agent_reports where trace_id = $1", [TRACE]);
  await pool.query("delete from agent_runs where fingerprint = $1", [fp]);
  await pool.query("delete from error_resolutions where fingerprint = $1", [fp]);
  await pool.query("delete from logs where id = $1", [logId]);
  await pool.end();
  console.log("nettoye");
})().catch(async (error) => {
  console.error("FAIL", error.message);
  process.exit(1);
});
