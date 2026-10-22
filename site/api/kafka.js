// Vercel Function : integration reelle du site au cluster Kafka Aiven.
//
// GET  /api/kafka  -> etat de l'integration (configure, joignable, topic present)
// POST /api/kafka  -> publie un message de verification dans le topic et renvoie
//                     le topic, la partition et l'offset reellement ecrits.
//
// Variables d'environnement (Vercel > Settings > Environment Variables, jamais dans le depot) :
//   KAFKA_BROKERS    liste des brokers, separes par des virgules
//   KAFKA_USERNAME   utilisateur SASL (Aiven)
//   KAFKA_PASSWORD   mot de passe SASL (Aiven)
//   KAFKA_CA_PEM     certificat CA Aiven (PEM, ou PEM encode en base64)
//   KAFKA_TOPIC      topic d'ingestion (defaut : otel.logs)
//   KAFKA_MECHANISM  mecanisme SASL (defaut : scram-sha-256)

const { Kafka, logLevel } = require("kafkajs");

const TOPIC = process.env.KAFKA_TOPIC || "otel.logs";
const TIMEOUT_MS = Number(process.env.KAFKA_TIMEOUT_MS) || 8000;

function readCa() {
  const raw = (process.env.KAFKA_CA_PEM || process.env.KAFKA_CA_CERT || "").trim();
  if (!raw) return null;
  return raw.includes("BEGIN CERTIFICATE") ? raw.replace(/\\n/g, "\n") : Buffer.from(raw, "base64").toString("utf8");
}

function kafkaConfig() {
  const brokers = (process.env.KAFKA_BROKERS || process.env.KAFKA_BOOTSTRAP || "")
    .split(",")
    .map((broker) => broker.trim())
    .filter(Boolean);

  if (!brokers.length || !process.env.KAFKA_USERNAME || !process.env.KAFKA_PASSWORD) return null;

  const ca = readCa();
  if (!ca) return null;

  return {
    clientId: "log-site",
    brokers,
    // Verification complete du certificat : sans CA la connexion est refusee.
    ssl: { ca: [ca], rejectUnauthorized: true },
    sasl: {
      mechanism: process.env.KAFKA_MECHANISM || "scram-sha-256",
      username: process.env.KAFKA_USERNAME,
      password: process.env.KAFKA_PASSWORD,
    },
    logLevel: logLevel.NOTHING,
    connectionTimeout: TIMEOUT_MS,
    requestTimeout: TIMEOUT_MS,
    retry: { retries: 2, initialRetryTime: 200 },
  };
}

async function status() {
  const config = kafkaConfig();
  if (!config) return { configured: false, reachable: false, integrated: false, topic: TOPIC };

  const kafka = new Kafka(config);
  const admin = kafka.admin({ retry: { retries: 2 } });
  try {
    await admin.connect();
    const topics = await admin.listTopics();
    const integrated = topics.includes(TOPIC);
    let partitions = 0;
    if (integrated) {
      const metadata = await admin.fetchTopicMetadata({ topics: [TOPIC] });
      partitions = (metadata.topics[0] && metadata.topics[0].partitions.length) || 0;
    }
    return {
      configured: true,
      reachable: true,
      integrated,
      topic: TOPIC,
      partitions,
      brokers: config.brokers.length,
    };
  } finally {
    await admin.disconnect().catch(() => {});
  }
}

async function integrate() {
  const config = kafkaConfig();
  if (!config) throw new Error("not_configured");

  const kafka = new Kafka(config);
  const producer = kafka.producer({ allowAutoTopicCreation: false, idempotent: true, maxInFlightRequests: 1 });
  try {
    await producer.connect();
    const id = `site-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const record = {
      id,
      occurred_at: new Date().toISOString(),
      level: "info",
      code: "KAFKA_INTEGRATION",
      service: "log-site",
      message: "Kafka Aiven integration check from log site",
      source: "site/integrate-kafka",
    };
    const [result] = await producer.send({
      topic: TOPIC,
      acks: -1,
      messages: [{ key: id, value: JSON.stringify(record), timestamp: String(Date.now()) }],
    });
    return {
      integrated: true,
      topic: result.topicName || TOPIC,
      partition: result.partition,
      offset: String(result.baseOffset),
    };
  } finally {
    await producer.disconnect().catch(() => {});
  }
}

function send(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(payload));
}

function detail(error) {
  const message = (error && error.message) || String(error);
  return message.slice(0, 240);
}

module.exports = async function handler(req, res) {
  if (req.method === "GET" || req.method === "HEAD") {
    try {
      const result = await status();
      send(res, result.configured ? 200 : 503, {
        service: "kafka",
        provider: "Aiven for Kafka",
        generatedAt: new Date().toISOString(),
        ...result,
      });
    } catch (error) {
      // Le detail reste dans les logs Vercel : jamais d'identifiants au navigateur.
      console.error(`kafka/status : ${error && error.message}`);
      send(res, 502, { service: "kafka", configured: true, reachable: false, integrated: false, topic: TOPIC, error: "unreachable" });
    }
    return;
  }

  if (req.method === "POST") {
    try {
      const result = await integrate();
      send(res, 200, { service: "kafka", provider: "Aiven for Kafka", ...result });
    } catch (error) {
      console.error(`kafka/integrate : ${error && error.message}`);
      const code = error && error.message === "not_configured" ? "not_configured" : "unreachable";
      send(res, code === "not_configured" ? 503 : 502, { service: "kafka", integrated: false, topic: TOPIC, error: code, detail: detail(error) });
    }
    return;
  }

  res.statusCode = 405;
  res.setHeader("Allow", "GET, HEAD, POST");
  res.end();
};

module.exports.status = status;
module.exports.integrate = integrate;
