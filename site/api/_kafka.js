// Client Kafka du site « log() » — le site est un client Kafka de plus.
//
// Le prefixe « _ » empeche Vercel d'exposer ce fichier comme une route
// (meme convention que api/_redact.js).
//
// Trois usages, un seul client :
//   - api/logs.js      : ingestion des lignes de console  -> publish()
//   - api/incident.js  : incident du catalogue           -> publishTo()
//   - api/report.js    : rapport publie par le watcher    -> findReport()
//
// Variables d'environnement (Vercel > Settings > Environment Variables) :
//   KAFKA_BOOTSTRAP     un ou plusieurs « hote:port » separes par des virgules
//   KAFKA_USERNAME      utilisateur SASL
//   KAFKA_PASSWORD      mot de passe SASL/SCRAM
//   KAFKA_CA_PEM        certificat CA Aiven (PEM, PEM echappe « \n », ou base64)
//   KAFKA_CA_FILE       variante locale : chemin du ca.pem (jamais sur Vercel)
//   KAFKA_TOPIC_PREFIX  prefixe des topics (defaut : otel -> otel.logs)
//
// ACL necessaires cote Aiven (voir README §6) : Write/Describe sur otel.logs,
// otel.traces, otel.metrics ; Read/Describe sur <prefix>-reports ; Read sur le
// groupe « otel-watch » (le lecteur de rapports).
//
// Regles de surete :
//   - aucun secret ne quitte la fonction : ni dans une reponse, ni dans un log ;
//   - un seul producteur par instance (connexion gardee, fermee par Vercel) ;
//   - toute erreur reseau devient KafkaDownError (message lisible, pas de stack).

const crypto = require("crypto");
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

/**
 * Nom du topic. « reports » est le seul suffixe HORS de l'espace otel.* :
 * les rapports d'agents vivent dans <prefix>-reports (meme regle que
 * tools/kafkalib.py:topic cote machine). Se tromper ici donne un topic
 * inexistant, donc un 404 « pas de rapport » permanent.
 */
function topicName(suffix) {
  const prefix = process.env.KAFKA_TOPIC_PREFIX || "otel";
  return suffix === "reports" ? `${prefix}-reports` : `${prefix}.${suffix}`;
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
      mechanism: process.env.KAFKA_SASL_MECHANISM || "scram-sha-256",
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

/**
 * Raison courte et lisible, SANS adresse, port ni identifiant : elle part dans le
 * navigateur (champ `hint` des reponses 503) et ne doit rien reveler.
 */
function publicReason(err) {
  const text = String((err && (err.message || err.code || err.name)) || err || "").toLowerCase();
  if (/econnrefused|connection refused/.test(text)) return "connexion refusee";
  if (/enotfound|eai_again|getaddrinfo/.test(text)) return "nom de serveur introuvable";
  if (/ehostunreach|enetunreach|unreachable/.test(text)) return "reseau injoignable";
  if (/etimedout|timed out|timeout|trop long/.test(text)) return "delai depasse";
  if (/sasl|authenticat|authoriz|not authorized|topic_authorization/.test(text)) {
    return "authentification ou droits refuses";
  }
  if (/ssl|tls|certificate/.test(text)) return "erreur TLS";
  if (/econnreset|closed|epipe|socket/.test(text)) return "connexion interrompue";
  return "erreur de connexion";
}

/**
 * Publie des messages deja serialises sur otel.logs (ingestion de la console).
 * Retourne le nombre de messages acceptes par le broker.
 */
async function publish(messages) {
  if (!messages.length) return 0;
  const sent = await send("logs", messages);
  return sent.count;
}

/**
 * Publie par suffixe de topic : { traces: [...], logs: [...], metrics: [...] }.
 * Chaque message est { key, value } — la cle est le TraceId, ce qui garde une
 * trace entiere sur la meme partition.
 */
async function publishTo(bySuffix) {
  const out = {};
  for (const [suffix, messages] of Object.entries(bySuffix)) {
    if (!messages || !messages.length) continue;
    out[suffix] = await send(suffix, messages);
  }
  return out;
}

async function send(suffix, messages) {
  const instance = await producer();
  let result;
  try {
    result = await instance.send({
      topic: topicName(suffix),
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
  return {
    topic: topicName(suffix),
    count: messages.length,
    partitions: result.map((item) => item.partition),
  };
}

/** Etat du cluster, sans lire aucun topic. */
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

/* ------------------------------------------------------------------ */
/* Lecture des rapports (<prefix>-reports)                            */
/* ------------------------------------------------------------------ */

/**
 * UN consommateur par instance chaude, dans un groupe PROPRE A L'INSTANCE,
 * relu depuis le debut, sans commit d'offset.
 *
 * Un groupe fixe ne marcherait pas : Kafka memorise l'offset du groupe, donc une
 * instance neuve (demarrage a froid) reprendrait a la FIN du topic et ne verrait
 * plus aucun rapport existant — /api/report repondrait 404 pour des rapports
 * pourtant presents. Avec un groupe par instance, chaque instance retrouve tout.
 * Le nom commence par « otel-watch » : c'est le prefixe couvert par l'ACL Read
 * de groupe du compte applicatif.
 */
const REPORT_GROUP_PREFIX = "otel-watch-site-reader";
const REPORT_CACHE_MAX = 1000;
const CATCHUP_MS = 5000;
const COLD_START_GRACE_MS = 15000;
const READER_START_TIMEOUT_MS = 60000;

let reader = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function discardReader(err) {
  if (!reader) return;
  reader.error = err instanceof Error ? err : new KafkaDownError(String(err));
  const dead = reader;
  reader = null;
  dead.consumer.disconnect().catch(() => {
    /* deja deconnecte */
  });
}

function getReader(cfg) {
  if (reader && !reader.error) return reader;
  const topic = topicName("reports");
  const consumer = kafkaClient(cfg).consumer({
    groupId: `${REPORT_GROUP_PREFIX}-${crypto.randomBytes(4).toString("hex")}`,
    allowAutoTopicCreation: false, // le site ne cree jamais de topic
  });
  reader = {
    consumer,
    reports: new Map(),
    error: null,
    joinedAt: 0,
    topicMissing: false,
    startedAt: Date.now(),
  };
  const self = reader;

  consumer.on(consumer.events.GROUP_JOIN, () => {
    self.joinedAt = Date.now();
  });
  // run() se termine SANS erreur quand le groupe est refuse (ACL...) : seul
  // CRASH le signale. restart=true : kafkajs relance seul.
  consumer.on(consumer.events.CRASH, (event) => {
    const { error, restart } = event.payload;
    process.stderr.write(`lecteur de rapports : arret (${error && error.message}), restart=${restart}\n`);
    if (restart) {
      self.joinedAt = 0;
      return;
    }
    discardReader(new KafkaDownError((error && error.message) || "lecteur de rapports arrete"));
  });

  (async () => {
    try {
      await consumer.connect();
      await consumer.subscribe({ topics: [topic], fromBeginning: true });
      await consumer.run({
        autoCommit: false,
        eachMessage: async ({ message }) => {
          if (!message.value) return;
          try {
            const parsed = JSON.parse(message.value.toString("utf8"));
            const key = parsed.TraceId || (message.key && message.key.toString("utf8"));
            if (!key) return;
            self.reports.delete(key); // le plus recent en fin de Map : le dernier gagne
            self.reports.set(key, parsed);
            if (self.reports.size > REPORT_CACHE_MAX) {
              self.reports.delete(self.reports.keys().next().value);
            }
          } catch (err) {
            /* message illisible : ignore */
          }
        },
      });
    } catch (err) {
      process.stderr.write(`lecteur de rapports : ${err.message}\n`);
      self.topicMissing = /UNKNOWN_TOPIC_OR_PARTITION|does not host this topic-partition/i.test(
        `${err.type || ""} ${err.message || ""}`,
      );
      discardReader(new KafkaDownError(readable(err)));
    }
  })();
  return reader;
}

/**
 * Rend le rapport d'une trace, ou null s'il n'est pas (encore) publie.
 * Leve KafkaConfigError / KafkaDownError si Kafka est injoignable — jamais un
 * faux « pas de rapport ».
 */
async function findReport(traceId, timeoutMs) {
  const cfg = config();
  const budget = timeoutMs || 8000;
  const started = Date.now();
  for (;;) {
    const current = getReader(cfg);
    if (current.reports.has(traceId)) return current.reports.get(traceId);
    if (current.error) {
      if (current.topicMissing) return null; // aucun rapport n'a jamais ete publie
      throw current.error;
    }
    const now = Date.now();
    if (!current.joinedAt && now - current.startedAt > READER_START_TIMEOUT_MS) {
      throw new KafkaDownError("connexion Kafka trop longue (lecteur de rapports)");
    }
    // Apres l'adhesion on laisse CATCHUP_MS a la relecture du topic ; tant que
    // le groupe n'est pas forme (demarrage a froid) on accorde plus de temps.
    const limit = current.joinedAt
      ? Math.max(started + budget, current.joinedAt + CATCHUP_MS)
      : started + budget + COLD_START_GRACE_MS;
    if (now >= limit) return null;
    await sleep(200);
  }
}

/* ------------------------------------------------------------------ */
/* Lecture de otel.logs (terminal du site)                            */
/* ------------------------------------------------------------------ */

/**
 * Le terminal n'affiche QUE des messages reellement lus dans otel.logs.
 *
 * Un consommateur par instance chaude, dans un groupe PROPRE A L'INSTANCE
 * (kafkajs 2.x n'a pas consumer.assign : on passe par un groupe). Sans commit
 * d'offset, chaque instance relit le topic depuis le debut ; l'anneau garde les
 * TAIL_MAX derniers messages, donc le resultat est « la fin du topic ».
 *
 * `ready` = tous les watermarks hauts releves au demarrage ont ete atteints :
 * avant cela, la lecture est un rattrapage et le site le dit.
 */
const TAIL_MAX = 400;
const TAIL_BACKFILL = 60;
const TAIL_READY_TIMEOUT_MS = 30000;
/* Le prefixe de groupe doit rester dans le perimetre autorise par l'ACL Aiven
   du compte du site (meme prefixe que le lecteur de rapports, qui fonctionne
   en production) : un groupe hors de ce prefixe est refuse par le broker. */
const TAIL_GROUP_PREFIX = "otel-watch-site-reader";

let tailReader = null;

function discardTail(err) {
  if (!tailReader) return;
  const dead = tailReader;
  tailReader = null;
  dead.error = err;
  dead.consumer.disconnect().catch(() => {
    /* deja deconnecte */
  });
}

/** Severite OpenTelemetry -> niveau affiche par la console. */
function levelOf(parsed) {
  const attrs = parsed.LogAttributes || {};
  const siteLevel = String(attrs["site.level"] || "");
  if (siteLevel && ["dbg", "inf", "wrn", "ok", "err"].includes(siteLevel)) return siteLevel;
  const sev = String(parsed.SeverityText || "").toUpperCase();
  if (sev.startsWith("ERROR") || sev === "FATAL") return "err";
  if (sev.startsWith("WARN")) return "wrn";
  if (sev.startsWith("DEBUG") || sev.startsWith("TRACE")) return "dbg";
  return "inf";
}

/** Forme compacte renvoyee au navigateur : ni secret, ni message geant. */
function compactMessage(partition, offset, parsed, fallbackTs) {
  const attrs = parsed.LogAttributes || {};
  return {
    partition,
    offset,
    ts: parsed.Timestamp || fallbackTs || "",
    level: levelOf(parsed),
    text: String(parsed.Body || "").slice(0, 500),
    code: String(attrs["agent.scenario"] || attrs["site.code"] || ""),
    service: String(parsed.ServiceName || attrs["site.service"] || ""),
    trace_id: String(parsed.TraceId || ""),
    error_type: String(attrs["error.type"] || ""),
  };
}

function pushTail(self, partition, message) {
  let parsed = null;
  const raw = message.value ? message.value.toString("utf8") : "";
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    parsed = { Body: raw.slice(0, 500), SeverityText: "INFO", LogAttributes: {} };
  }
  if (!parsed || typeof parsed !== "object") return;
  const ts = message.timestamp ? new Date(Number(message.timestamp)).toISOString() : "";
  self.messages.push(compactMessage(partition, Number(message.offset), parsed, ts));
  if (self.messages.length > TAIL_MAX) {
    self.messages.splice(0, self.messages.length - TAIL_MAX);
  }
}

function startTail(cfg) {
  const topic = topicName("logs");
  const consumer = kafkaClient(cfg).consumer({
    groupId: `${TAIL_GROUP_PREFIX}-${crypto.randomBytes(4).toString("hex")}`,
    allowAutoTopicCreation: false,
  });
  const self = {
    consumer,
    topic,
    messages: [],
    error: null,
    ready: false,
    targets: new Map(),
    reached: new Map(),
    startedAt: Date.now(),
  };
  tailReader = self;

  consumer.on(consumer.events.CRASH, (event) => {
    const { error, restart } = event.payload;
    process.stderr.write(`tail otel.logs : arret (${error && error.message}), restart=${restart}\n`);
    // kafkajs relance seul (restart=true) : c'est le cas normal d'un SASL
    // transitoire sur le coordinateur de groupe (Vercel lhr1 -> do-fra).
    // Jeter le lecteur ici transformerait une coupure d'une seconde en 503.
    if (restart) {
      self.ready = self.messages.length > 0;
      return;
    }
    discardTail(new KafkaDownError(readable(error)));
  });

  const settled = () => {
    if (!self.targets.size) return true;
    return [...self.targets].every(([partition, target]) => (self.reached.get(partition) || 0) >= target);
  };

  (async () => {
    try {
      // Watermarks hauts AVANT de consommer : c'est la ligne d'arrivee du
      // rattrapage. Un topic vide (high = low = 0) est pret immediatement.
      try {
        const admin = kafkaClient(cfg).admin();
        await admin.connect();
        try {
          const offsets = await admin.fetchTopicOffsets(topic);
          for (const item of offsets) {
            self.targets.set(Number(item.partition), Number(item.high));
            self.reached.set(Number(item.partition), Number(item.low));
          }
        } finally {
          await admin.disconnect().catch(() => {});
        }
      } catch (err) {
        // Watermarks illisibles (ACL Describe...) : on consomme quand meme,
        // et on considerera la lecture prete apres le delai de grace.
        process.stderr.write(`tail otel.logs : watermarks indisponibles (${readable(err)})\n`);
      }

      await consumer.connect();
      await consumer.subscribe({ topics: [topic], fromBeginning: true });
      if (settled()) self.ready = true;

      const seeked = new Set();
      await consumer.run({
        autoCommit: false,
        // eachBatch (et non eachMessage) pour pouvoir SAUTER le debut du topic :
        // relire 10 000 messages a chaque demarrage a froid ferait expirer la
        // fonction Vercel. On recule seulement de TAIL_BACKFILL messages.
        eachBatch: async ({ batch }) => {
          const partition = Number(batch.partition);
          const high = self.targets.get(partition);
          if (!seeked.has(partition)) {
            seeked.add(partition);
            let first = null;
            try {
              first = Number(batch.firstOffset());
            } catch (err) {
              first = null; // lot vide : rien a sauter
            }
            if (first !== null && high != null && first < high - TAIL_BACKFILL) {
              const target = Math.max(0, high - TAIL_BACKFILL);
              consumer.seek({
                topic: batch.topic,
                partition: batch.partition,
                offset: String(target),
              });
              self.reached.set(partition, target);
              return;
            }
          }
          for (const message of batch.messages) {
            self.reached.set(partition, Number(message.offset) + 1);
            pushTail(self, partition, message);
          }
          if (!self.ready && settled()) self.ready = true;
        },
      });
    } catch (err) {
      process.stderr.write(`tail otel.logs : ${err.message}\n`);
      discardTail(new KafkaDownError(readable(err)));
    }
  })();

  return self;
}

/**
 * Derniers messages de otel.logs, du plus ancien au plus recent.
 * Leve KafkaConfigError / KafkaDownError — jamais une liste vide qui ferait
 * croire a un topic muet alors que le broker est injoignable.
 */
async function tailMessages(limit, waitMs) {
  const cfg = config();
  const self = tailReader && !tailReader.error ? tailReader : startTail(cfg);
  const wanted = Math.max(1, Math.min(Number(limit) || 60, TAIL_MAX));
  const deadline = Date.now() + (Number(waitMs) || 5000);
  // On attend soit le rattrapage complet, soit le premier message : la premiere
  // negociation de groupe peut prendre plusieurs secondes depuis Vercel.
  while (!self.error && !(self.ready && self.messages.length) && Date.now() < deadline) {
    await sleep(150);
  }
  if (self.error && !self.messages.length) throw self.error;
  if (!self.ready && !self.messages.length && Date.now() - self.startedAt > TAIL_READY_TIMEOUT_MS) {
    throw new KafkaDownError("lecture de otel.logs trop longue (consommateur non pret)");
  }
  return {
    topic: self.topic,
    ready: self.ready,
    messages: self.messages.slice(-wanted),
  };
}

module.exports = {
  KafkaConfigError,
  KafkaDownError,
  publicReason,
  publish,
  publishTo,
  health,
  findReport,
  tailMessages,
  configured,
  topicName,
};
