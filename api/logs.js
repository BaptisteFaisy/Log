const { getPool, fail, methodNotAllowed, isObject, asInt, asIso } = require("./_db");
const { publishLog, topic } = require("../lib/kafka.cjs");
const { normalize: normalizeLog, scenarioFor } = require("../lib/log.cjs");

const MAX_MESSAGE = 2000;

function normalize(body) {
  if (!isObject(body)) return { error: "corps JSON attendu" };

  const scenario = body.error_type ? scenarioFor(body.error_type) : null;
  if (body.error_type && !scenario) return { error: "error_type inconnu" };

  const code = scenario ? scenario.code : typeof body.code === "string" ? body.code.trim() : "";
  const message = scenario
    ? scenario.message
    : typeof body.message === "string"
      ? body.message.trim()
      : "";
  if (!code || code.length > 80) return { error: "code invalide" };
  if (!message) return { error: "message requis" };
  if (message.length > MAX_MESSAGE) return { error: `message trop long (max ${MAX_MESSAGE})` };

  const occurredAt = asIso(body.occurred_at) || new Date().toISOString();
  const traceId = typeof body.trace_id === "string" ? body.trace_id.slice(0, 40) : null;
  const payload = isObject(body.payload) ? body.payload : {};
  const log = normalizeLog({ ...payload, ...scenario, code, severity: body.severity, message });

  return {
    record: {
      code: log.code,
      severity: log.severity,
      message: log.message,
      trace_id: traceId,
      occurred_at: occurredAt,
      payload: log.payload,
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

const logId = (topic, partition, offset) => `${topic}:${partition}:${offset}`;

module.exports = async function handler(req, res) {
  try {
    const pool = getPool();

    if (req.method === "POST") {
      const parsed = normalize(req.body);
      if (parsed.error) return fail(res, 400, parsed.error);
      const record = parsed.record;

      const position = await publishLog(record);
      const id = logId(position.topic, position.partition, position.offset);

      const { rows } = await pool.query(
        `insert into logs
           (id, topic, partition, kafka_offset, kafka_key, code, severity, message, payload, occurred_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (topic, partition, kafka_offset) do nothing
         returning *`,
        [
          id,
          position.topic,
          position.partition,
          position.offset,
          id,
          record.code,
          record.severity,
          record.message,
          JSON.stringify(record.payload),
          record.occurred_at,
        ],
      );

      const saved = rows[0] || (await pool.query("select * from logs where id = $1", [id])).rows[0];

      res.setHeader("cache-control", "no-store");
      return res.status(201).json({
        log: toLog(saved),
        kafka: { topic: position.topic, partition: position.partition, offset: Number(position.offset) },
        sync: saved.id === id,
      });
    }

    if (req.method === "GET") {
      const after = asInt(req.query.after, 0);
      const limit = Math.min(Math.max(asInt(req.query.limit, 60), 1), 200);
      const code = typeof req.query.code === "string" ? req.query.code.trim() : "";
      const tail = Boolean(req.query.tail);

      const { rows } = tail
        ? await pool.query(
            `select * from (
               select * from logs where ($1 = '' or code = $1) order by seq desc limit $2
             ) t order by seq asc`,
            [code, limit],
          )
        : await pool.query(
            `select * from logs
              where seq > $1 and ($2 = '' or code = $2)
              order by seq asc
              limit $3`,
            [after, code, limit],
          );

      const { rows: head } = await pool.query(
        `select coalesce(max(seq), 0)::bigint as seq, count(*)::int as total from logs`,
      );

      const last = rows.length ? Number(rows[rows.length - 1].seq) : null;
      const cursor = tail ? Number(head[0].seq) : last == null ? after : last;

      res.setHeader("cache-control", "no-store");
      return res.status(200).json({
        logs: rows.map(toLog),
        cursor,
        total: head[0] ? head[0].total : 0,
        topic: topic(),
      });
    }

    return methodNotAllowed(res, "GET, POST");
  } catch (error) {
    return fail(res, 500, error.message || "erreur serveur");
  }
};
