// Producteur Kafka du site « log() » — le site est un client Kafka de plus.
//
// Le prefixe « _ » empeche Vercel d'exposer ce fichier comme une route
// (meme convention que api/_redact.js).
//
// Variables d'environnement (Vercel > Settings > Environment Variables) :
//   KAFKA_BOOTSTRAP     un ou plusieurs « hote:port » separes par des virgules
//   KAFKA_USERNAME      utilisateur SASL (ici « site-logs », ACL write+describe)
//   KAFKA_PASSWORD      mot de passe SASL/SCRAM
//   KAFKA_CA_PEM        certificat CA Aiven (PEM, PEM echappe « \n », ou base64)
//   KAFKA_CA_FILE       variante locale : chemin du ca.pem (jamais sur Vercel)
//   KAFKA_TOPIC_PREFIX  prefixe des topics (defaut : otel -> otel.logs)
//
// Regles de surete :
//   - aucun secret ne quitte la fonction : ni dans une reponse, ni dans un log ;
//   - un seul producteur par instance (connexion gardee, fermee par Vercel) ;
//   - toute erreur reseau devient KafkaDownError (message lisible, pas de stack).

const fs = require("fs");
const { Kafka, logLevel } = require("kafkajs");

const REQUIRED = ["KAFKA_BOOTSTRAP", "KAFKA_USERNAME", "KAFKA_PASSWORD"];

class KafkaConfigError extends Error {}
class KafkaDownError extends Error {}

function readCa() {
  const raw = String(process.env.KAFKA_CA_PEM || "").trim();
  if (raw) {
    // PEM colle tel quel, PEM avec « \n » litteraux (copier-coller), ou base64.
    if (raw.includes("BEGIN CERTIFICATE")) return raw.replace(/\\n/g, "\n");
    try {
      const decoded = Buffer.from(raw, "base64").toString("utf8");
      if (decoded.includes("BEGIN CERTIFICATE")) return decoded;
    } catch (err) {
      /* base64 invalide : on retombe sur le fichier local */
    }
  }
  const file = process.env.KAFKA_CA_FILE;
  if (file) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch (err) {
      return null;
    }
  }
  return null;
}

function topicName(suffix) {
  const prefix = process.env.KAFKA_TOPIC_PREFIX || "otel";
  return `${prefix}.${suffix}`;
}

function config() {
  const missing = REQUIRED.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new KafkaConfigError(
      `variable(s) manquante(s) : ${missing.join(", ")} — configure-les dans les variables du projet Vercel`
    );
  }
  const brokers = String(process.env.KAFKA_BOOTSTRAP)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!brokers.length) throw new KafkaConfigError("KAFKA_BOOTSTRAP ne contient aucun broker");
  const ca = readCa();
  if (!ca) throw new KafkaConfigError("certificat CA Aiven absent (KAFKA_CA_PEM)");
  return {
    brokers,
    ssl: { ca: [ca], rejectUnauthorized: true },
    sasl: {
      mechanism: "scram-sha-256",
      username: process.env.KAFKA_USERNAME,
      password: process.env.KAFKA_PASSWORD,
    },
  };
}

/** true quand la configuration suffit a tenter une connexion (sans la valider). */
function configured() {
  try {
    config();
    return true;
  } catch (err) {
    return false;
  }
}

function kafkaClient(cfg) {
  return new Kafka({
    clientId: "log-site",
    brokers: cfg.brokers,
    ssl: cfg.ssl,
    sasl: cfg.sasl,
    connectionTimeout: 8000,
    requestTimeout: 12000,
    authenticationTimeout: 8000,
    retry: { retries: 2, initialRetryTime: 200, maxRetryTime: 2000 },
    logLevel: logLevel.NOTHING,
  });
}

// Une seule connexion par instance de fonction : Vercel reutilise l'instance
// chaude, on evite donc de payer un handshake SASL a chaque requete.
let producerPromise = null;

function producer() {
  if (producerPromise) return producerPromise;
  const cfg = config();
  const instance = kafkaClient(cfg).producer({
    allowAutoTopicCreation: false,
    idempotent: true,
    maxInFlightRequests: 1,
  });
  producerPromise = instance
    .connect()
    .then(() => instance)
    .catch((err) => {
      producerPromise = null;
      throw new KafkaDownError(readable(err));
    });
  return producerPromise;
}

/** Message d'erreur court et sans secret (kafkajs peut inclure l'hote). */
function readable(err) {
  const text = String((err && err.message) || err || "erreur inconnue");
  return text
    .replace(/AVNS_[A-Za-z0-9_-]+/g, "AVNS_•••")
    .replace(/\b[a-z0-9-]+\.[a-z]\.aivencloud\.com(?::\d+)?/gi, "•••.aivencloud.com")
    .replace(/\s+/g, " ")
    .slice(0, 200);
}

/** Publie des messages deja serialises. Retourne le nombre accepte par le broker. */
async function publish(messages) {
  if (!messages.length) return 0;
  const instance = await producer();
  let result;
  try {
    result = await instance.send({
      topic: topicName("logs"),
      acks: -1,
      messages,
    });
  } catch (err) {
    // Une connexion cassee ne doit pas rester en cache : la prochaine requete
    // repart d'un producteur neuf (sinon l'instance chaude echoue indefiniment).
    producerPromise = null;
    throw new KafkaDownError(readable(err));
  }
  // kafkajs renvoie un resultat PAR PARTITION (pas par message) : un lot de N
  // messages dans une seule partition donne un seul element. On compte donc les
  // messages, et on echoue si une partition a rejete le lot.
  const failed = result.find((item) => item.errorCode);
  if (failed) {
    throw new KafkaDownError(`le broker a rejete le lot (errorCode=${failed.errorCode})`);
  }
  return messages.length;
}

/** Etat du cluster, sans lire aucun topic (l'ACL du site est limitee a otel.logs). */
async function health() {
  const cfg = config();
  const admin = kafkaClient(cfg).admin();
  try {
    await admin.connect();
    const cluster = await admin.describeCluster();
    return {
      up: true,
      brokers: (cluster.brokers || []).length,
      cluster_id: cluster.clusterId || "",
      topic: topicName("logs"),
    };
  } catch (err) {
    throw new KafkaDownError(readable(err));
  } finally {
    await admin.disconnect().catch(() => {});
  }
}

module.exports = {
  KafkaConfigError,
  KafkaDownError,
  publish,
  health,
  configured,
  topicName,
};
