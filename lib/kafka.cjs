const fs = require("fs");
const path = require("path");
const { Kafka, logLevel } = require("kafkajs");
const { loadEnv, ROOT } = require("./db.cjs");

function kafkaConfig() {
  loadEnv();

  const brokers = (process.env.KAFKA_BROKERS || "").split(",").map((b) => b.trim()).filter(Boolean);
  if (!brokers.length) throw new Error("KAFKA_BROKERS est requis");

  const caPath = process.env.KAFKA_CA_PATH || path.join(ROOT, ".certs", "ca.pem");
  const ca = process.env.KAFKA_CA_CERT || (fs.existsSync(caPath) ? fs.readFileSync(caPath, "utf8") : null);

  const sasl = process.env.KAFKA_USERNAME
    ? {
        mechanism: process.env.KAFKA_MECHANISM || "scram-sha-256",
        username: process.env.KAFKA_USERNAME,
        password: process.env.KAFKA_PASSWORD,
      }
    : undefined;

  return {
    clientId: process.env.KAFKA_CLIENT_ID || "logsite",
    brokers,
    ssl: ca
      ? { ca: [ca], rejectUnauthorized: process.env.KAFKA_TLS_STRICT === "1" }
      : { rejectUnauthorized: false },
    sasl,
    logLevel: logLevel.NOTHING,
    connectionTimeout: 10000,
    requestTimeout: 20000,
    retry: { retries: 5 },
  };
}

function topic() {
  loadEnv();
  return process.env.KAFKA_TOPIC || "otel.logs";
}

let producer = null;

async function getProducer() {
  if (!producer) {
    const kafka = new Kafka(kafkaConfig());
    producer = kafka.producer({ allowAutoTopicCreation: false, idempotent: true });
    await producer.connect();
  }
  return producer;
}

async function publishLog(record) {
  const p = await getProducer();
  const value = JSON.stringify(record);
  const [result] = await p.send({
    topic: topic(),
    messages: [{ key: record.id, value, timestamp: String(Date.parse(record.occurred_at) || Date.now()) }],
  });
  return { topic: result.topicName, partition: result.partition, offset: String(result.baseOffset) };
}

async function disconnect() {
  if (!producer) return;
  await producer.disconnect().catch(() => {});
  producer = null;
}

module.exports = { kafkaConfig, topic, getProducer, publishLog, disconnect };
