const fs = require("fs"), path = require("path");
const { Kafka, logLevel } = require("kafkajs");
const env = {};
for (const l of fs.readFileSync(path.join(__dirname, "..", ".env.aiven.local"), "utf8").split(/\r?\n/)) {
  const i = l.indexOf("=");
  if (i > 0) env[l.slice(0, i)] = l.slice(i + 1);
}
const brokers = (env.KAFKA_BROKERS || "").split(",").map((b) => b.trim()).filter(Boolean);
const caPath = path.join(__dirname, "..", ".certs", "ca.pem");
(async () => {
  if (!brokers.length) throw new Error("KAFKA_BROKERS manquant dans .env.aiven.local");
  const kafka = new Kafka({
    clientId: "meta",
    brokers,
    ssl: fs.existsSync(caPath) ? { ca: [fs.readFileSync(caPath, "utf8")] } : true,
    sasl: env.KAFKA_USERNAME
      ? { mechanism: "scram-sha-256", username: env.KAFKA_USERNAME, password: env.KAFKA_PASSWORD }
      : undefined,
    logLevel: logLevel.NOTHING,
    connectionTimeout: 8000,
    retry: { retries: 1 },
  });
  const admin = kafka.admin();
  await admin.connect();
  console.log("BROKERS", brokers.join(","));
  console.log("CLUSTER", JSON.stringify(await admin.describeCluster()));
  console.log("TOPICS", JSON.stringify(await admin.listTopics()));
  await admin.disconnect();
  process.exit(0);
})().catch((e) => {
  console.log("FAIL", e.message);
  process.exit(1);
});
