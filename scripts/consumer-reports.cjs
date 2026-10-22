/* Consommateur Aiven/Kafka `otel-reports` -> PostgreSQL.
   C'est la sortie du watcher de BaptisteFaisy/Log : chaque rapport d'agent est
   stocke dans `agent_reports`, et quand il est `resolved` il alimente la
   memoire (error_resolutions + agent_runs) sans intervention manuelle. */

const { Kafka } = require("kafkajs");
const { getPool } = require("../lib/db.cjs");
const { kafkaConfig } = require("../lib/kafka.cjs");
const { normalize } = require("../lib/reports.cjs");

const REPORTS_TOPIC = process.env.KAFKA_REPORTS_TOPIC || "otel-reports";
const GROUP = process.env.KAFKA_REPORTS_GROUP || "logsite-reports";

function parse(raw) {
  const text = String(raw || "");
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : { report: text };
  } catch {
    return { report: text };
  }
}

async function saveReport(pool, meta, normalized) {
  const { rows } = await pool.query(
    `insert into agent_reports
       (topic, partition, kafka_offset, trace_id, error_type, code, scenario,
        agent, status, summary, report, payload, published_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, coalesce($13::timestamptz, now()))
     on conflict (topic, partition, kafka_offset) do nothing
     returning id`,
    [
      meta.topic,
      meta.partition,
      meta.offset,
      normalized.trace_id,
      normalized.error_type,
      normalized.code,
      normalized.scenario,
      normalized.agent,
      normalized.status,
      normalized.summary,
      normalized.report,
      JSON.stringify(normalized.payload),
      normalized.published_at,
    ],
  );
  return rows[0] ? rows[0].id : null;
}

/* Le log d'origine (meme TraceId) fournit le message exact : c'est lui qui
   determine le fingerprint, donc la cle de la memoire. */
async function findLog(pool, traceId) {
  if (!traceId) return null;
  const { rows } = await pool.query(
    `select code, message, payload
       from logs
      where payload->>'TraceId' = $1
      order by seq desc
      limit 1`,
    [traceId],
  );
  return rows[0] || null;
}

async function rememberResolution(pool, normalized, log) {
  const { fingerprint, entryFor } = await import("../scripts/lib/errors.mjs");
  const entry = entryFor({ code: normalized.code, errorType: normalized.error_type });
  const code = normalized.code;
  const message = log ? log.message : entry ? entry.message : normalized.summary || "";
  const stack = log && log.payload && log.payload.stack ? String(log.payload.stack) : entry ? entry.stack : "";
  const fp = fingerprint(code, message, stack);

  const fix = normalized.report || normalized.summary || "";
  if (!fix) return null;

  const existing = await pool.query("select runs from error_resolutions where fingerprint = $1", [fp]);
  const mode = existing.rows.length ? "warm" : "cold";

  await pool.query(
    `insert into error_resolutions (fingerprint, code, cause, fix, verification, agent, runs, updated_at)
     values ($1,$2,$3,$4,$5,$6,1,now())
     on conflict (fingerprint) do update set
       fix = excluded.fix,
       agent = excluded.agent,
       runs = error_resolutions.runs + 1,
       updated_at = now()`,
    [fp, code, entry ? entry.label : null, fix, null, normalized.agent],
  );

  const now = new Date().toISOString();
  const runId = `run_${normalized.trace_id || "notrace"}_${code}`.slice(0, 120);
  await pool.query(
    `insert into agent_runs
       (run_id, fingerprint, code, mode, status, started_at, ended_at, memo_hit, memo_path, agent, attempt)
     values ($1,$2,$3,$4,'resolved',$5,$5,$6,$7,$8,$9)
     on conflict (run_id) do nothing`,
    [runId, fp, code, mode, now, mode === "warm", `db://error_resolutions/${fp}`, normalized.agent,
      (existing.rows[0]?.runs || 0) + 1],
  );

  return fp;
}

async function main() {
  const pool = getPool();
  const kafka = new Kafka(kafkaConfig());
  const consumer = kafka.consumer({ groupId: GROUP, sessionTimeout: 30000 });

  await consumer.connect();
  await consumer.subscribe({ topic: REPORTS_TOPIC, fromBeginning: true });

  let stored = 0;
  let learned = 0;
  console.log(`[reports] ${REPORTS_TOPIC} → PostgreSQL (groupe ${GROUP})`);

  const shutdown = async (signal) => {
    console.log(`\n[reports] ${signal} · arrêt (${stored} rapport(s), ${learned} résolution(s) mémorisée(s))`);
    await consumer.disconnect().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await consumer.run({
    autoCommit: false,
    eachBatch: async ({ batch, resolveOffset, heartbeat, commitOffsetsIfNecessary, isRunning, isStale }) => {
      for (const message of batch.messages) {
        if (!isRunning() || isStale()) break;
        const { ok, report } = normalize(parse(message.value));
        const meta = {
          topic: batch.topic,
          partition: batch.partition,
          offset: message.offset,
        };

        if (ok) {
          try {
            const id = await saveReport(pool, meta, report);
            if (id) stored += 1;
            if (report.status === "resolved") {
              const log = await findLog(pool, report.trace_id);
              const fp = await rememberResolution(pool, report, log);
              if (fp) {
                learned += 1;
                console.log(`[reports] + ${report.code} · ${report.agent} · résolution mémorisée (${fp})`);
              }
            }
          } catch (error) {
            console.error(`[reports] échec offset ${message.offset}: ${error.message}`);
          }
        }

        resolveOffset(message.offset);
        await heartbeat();
      }
      await commitOffsetsIfNecessary();
    },
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error("[reports] fatal:", error.message);
    process.exit(1);
  });
}

module.exports = { normalize, parse, saveReport, findLog, rememberResolution };
