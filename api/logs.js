const { getPool, fail, methodNotAllowed, isObject, asInt, asIso } = require("./_db");
const { publishLog, topic } = require("../lib/kafka.cjs");

const SEVERITIES = new Set(["dbg", "inf", "wrn", "ok", "err"]);
const MAX_MESSAGE = 2000;

function normalize(body) {
  if (!isObject(body)) return { error: "corps JSON attendu" };

  const code = typeof body.code === "string" ? body.code.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!code || code.length > 80) return { error: "code invalide" };
  if (!message) return { error: "message requis" };
  if (message.length > MAX_MESSAGE) return { error: `message trop long (max ${MAX_MESSAGE})` };

  const severity = SEVERITIES.has(body.severity) ? body.severity : "err";
  const occurredAt = asIso(body.occurred_at) || new Date().toISOString();
  const traceId = typeof body.trace_id === "string" ? body.trace_id.slice(0, 40) : null;

  return {
    record: {
      id: typeof body.id === "string" && body.id.trim() ? body.id.trim().slice(0, 160) : null,
      code,
      severity,
      message,
      trace_id: traceId,
      occurred_at: occurredAt,
      payload: isObject(body.payload) ? body.payload : {},
    },
  };
}

const toLog = (row) => ({
  seq: Number(row.seq),
  id: row.id,
  topic: row.topic,
  partition: row.partition,
  offset: Number(row.kafka_offset),
  code: row.code,
  severity: row.severity,
  message: row.message,
  payload: row.payload,
  occurred_at: row.occurred_at,
  received_at: row.received_at,
});

function newId() {
  return `log_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = async function handler(req, res) {
  try {
    const pool = getPool();

    if (req.method === "POST") {
      const parsed = normalize(req.body);
      if (parsed.error) return fail(res, 400, parsed.error);
      const record = parsed.record;
      if (!record.id) record.id = newId();

      const position = await publishLog(record);

      const { rows } = await pool.query(
        `insert into logs
           (id, topic, partition, kafka_offset, kafka_key, code, severity, message, payload, occurred_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (id) do update set received_at = now()
         returning *`,
        [
          record.id,
          position.topic,
          position.partition,
          position.offset,
          record.id,
          record.code,
          record.severity,
          record.message,
          JSON.stringify(record.payload),
          record.occurred_at,
        ],
      );

      res.setHeader("cache-control", "no-store");
      return res.status(201).json({
        log: toLog(rows[0]),
        kafka: { topic: position.topic, partition: position.partition, offset: Number(position.offset) },
        sync: rows[0].id === record.id,
      });
    }

    if (req.method === "GET") {
      const after = asInt(req.query.after, 0);
      const limit = Math.min(Math.max(asInt(req.query.limit, 60), 1), 200);
      const code = typeof req.query.code === "string" ? req.query.code.trim() : "";

      const { rows } = await pool.query(
        `select * from logs
          where seq > $1 and ($2 = '' or code = $2)
          order by seq asc
          limit $3`,
        [after, code, limit],
      );

      const { rows: head } = await pool.query(
        `select coalesce(max(seq), 0)::bigint as seq, count(*)::int as total from logs`,
      );

      res.setHeader("cache-control", "no-store");
      return res.status(200).json({
        logs: rows.map(toLog),
        cursor: head[0] ? Number(head[0].seq) : 0,
        total: head[0] ? head[0].total : 0,
        topic: topic(),
      });
    }

    return methodNotAllowed(res, "GET, POST");
  } catch (error) {
    return fail(res, 500, error.message || "erreur serveur");
  }
};
