/* Consommateur Aiven/Kafka → PostgreSQL.
   Chaque message de `otel.logs` devient une ligne de `logs`, avec
   l'identifiant Kafka (topic:partition:offset) comme clé de synchronisation. */
const { Kafka } = require("kafkajs");
const { getPool } = require("../lib/db.cjs");
const { kafkaConfig, topic } = require("../lib/kafka.cjs");
const { normalize } = require("../lib/log.cjs");

const TOPIC = topic();
const GROUP = process.env.KAFKA_GROUP || "logsite-consumer";

const toText = (value, max) => {
  if (value == null) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.slice(0, max);
};

function parse(raw) {
  const text = String(raw || "");
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : { message: text };
  } catch {
    return { message: text };
  }
}

async function insertLog(pool, message, raw) {
  const id = `${message.topic}:${message.partition}:${message.offset}`;
  const payload = normalize(raw);

  const occurredAt = raw && raw.occurred_at && !Number.isNaN(Date.parse(raw.occurred_at))
    ? new Date(raw.occurred_at).toISOString()
    : new Date(Number(message.timestamp) || Date.now()).toISOString();

  const { rows } = await pool.query(
    `insert into logs
       (id, topic, partition, kafka_offset, kafka_key, code, severity, message, payload, occurred_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (topic, partition, kafka_offset) do nothing
     returning seq, id, kafka_offset`,
    [
      id,
      message.topic,
      message.partition,
      message.offset,
      message.key == null ? null : String(message.key),
      payload.code,
      payload.severity,
      payload.message,
      JSON.stringify(payload.payload),
      occurredAt,
    ],
  );

  return rows[0] || null;
}

async function main() {
  const pool = getPool();
  const kafka = new Kafka(kafkaConfig());
  const consumer = kafka.consumer({ groupId: GROUP, sessionTimeout: 30000 });

  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC, fromBeginning: true });

  let count = 0;
  console.log(`[consumer] ${TOPIC} → PostgreSQL (groupe ${GROUP})`);

  const shutdown = async (signal) => {
    console.log(`\n[consumer] ${signal} · arrêt (${count} message(s) ingéré(s))`);
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
        const payload = parse(message.value);
        const meta = {
          topic: batch.topic,
          partition: batch.partition,
          offset: message.offset,
          key: message.key,
          timestamp: message.timestamp,
        };
        try {
          const inserted = await insertLog(pool, meta, payload);
          if (inserted) {
            count += 1;
            console.log(`[consumer] + ${inserted.id} (offset ${inserted.kafka_offset})`);
          }
        } catch (error) {
          console.error(`[consumer] échec offset ${message.offset}: ${error.message}`);
        }
        resolveOffset(message.offset);
        await heartbeat();
      }
      await commitOffsetsIfNecessary();
    },
  });
}

main().catch((error) => {
  console.error("[consumer] fatal:", error.message);
  process.exit(1);
});
