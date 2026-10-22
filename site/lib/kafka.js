'use strict';
/**
 * Client Kafka du site « log() » — publie un incident et relit le rapport.
 *
 * Le site est « un client Kafka de plus » : il publie le contrat d'otel.logs /
 * otel.traces avec la cle = TraceId. Le watcher de la machine (tools/
 * kafka-incident-watch) consomme ces topics et lance le VRAI agent ; il
 * republie ensuite le rapport dans otel-reports, que /api/report relit ici.
 *
 * Secrets : uniquement des variables d'environnement serveur (Vercel). Rien ne
 * part dans le navigateur. Le CA passe par KAFKA_CA_PEM (PEM ou PEM base64),
 * sinon KAFKA_CA_FILE en local.
 *
 * Variables lues (les deux orthographes sont acceptees, le projet Vercel « log »
 * utilise KAFKA_BOOTSTRAP / KAFKA_TOPIC_PREFIX) :
 *   KAFKA_BOOTSTRAP | KAFKA_BROKERS   brokers separes par des virgules
 *   KAFKA_USERNAME / KAFKA_PASSWORD   SASL (Aiven)
 *   KAFKA_CA_PEM | KAFKA_CA_FILE      certificat CA
 *   KAFKA_TOPIC_PREFIX                prefixe des topics (defaut : otel)
 *   KAFKA_SASL_MECHANISM | KAFKA_MECHANISM   defaut : scram-sha-256
 */
const crypto = require('crypto');
const fs = require('fs');
const { Kafka, Partitioners, logLevel } = require('kafkajs');

class KafkaConfigError extends Error {}
class KafkaDownError extends Error {}

const TIMEOUT_MS = Number(process.env.KAFKA_TIMEOUT_MS) || 15000;

function bootstrap() {
  return (process.env.KAFKA_BOOTSTRAP || process.env.KAFKA_BROKERS || '')
    .split(',')
    .map((b) => b.trim())
    .filter(Boolean);
}

function prefix() {
  return (process.env.KAFKA_TOPIC_PREFIX || 'otel').trim() || 'otel';
}

function readCa() {
  const raw = (process.env.KAFKA_CA_PEM || '').trim();
  if (raw) {
    // PEM en clair, ou PEM encode en base64 (les sauts de ligne survivent mal
    // dans certains tableaux de bord) : on accepte les deux.
    return raw.includes('BEGIN CERTIFICATE')
      ? raw.replace(/\\n/g, '\n')
      : Buffer.from(raw, 'base64').toString('utf8');
  }
  const file = process.env.KAFKA_CA_FILE;
  if (!file) return null;
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    return null;
  }
}

/** Raison courte, sans adresse ni identifiant : elle part dans le navigateur. */
function publicReason(err) {
  const text = String((err && (err.message || err.code || err.name)) || err || '').toLowerCase();
  if (/econnrefused|connection refused/.test(text)) return 'connexion refusee';
  if (/enotfound|eai_again|getaddrinfo/.test(text)) return 'nom de serveur introuvable';
  if (/ehostunreach|enetunreach|unreachable/.test(text)) return 'reseau injoignable';
  if (/etimedout|timed out|timeout|trop long/.test(text)) return 'delai depasse';
  if (/sasl|authenticat|authoriz|not authorized/.test(text)) return 'authentification ou droits refuses';
  if (/ssl|tls|certificate/.test(text)) return 'erreur TLS';
  if (/econnreset|closed|epipe|socket/.test(text)) return 'connexion interrompue';
  return 'erreur de connexion';
}

/** Configuration kafkajs, ou null si le serveur n'est pas configure. */
function config() {
  const brokers = bootstrap();
  if (!brokers.length || !process.env.KAFKA_USERNAME || !process.env.KAFKA_PASSWORD) return null;
  const ca = readCa();
  if (!ca) return null;
  return {
    clientId: 'log-site',
    brokers,
    // Verification complete du certificat : sans CA la connexion est refusee.
    ssl: { ca: [ca], rejectUnauthorized: true },
    sasl: {
      mechanism: process.env.KAFKA_SASL_MECHANISM || process.env.KAFKA_MECHANISM || 'scram-sha-256',
      username: process.env.KAFKA_USERNAME,
      password: process.env.KAFKA_PASSWORD,
    },
    logLevel: logLevel.NOTHING,
    connectionTimeout: TIMEOUT_MS,
    requestTimeout: TIMEOUT_MS,
    retry: { retries: 2, initialRetryTime: 200 },
  };
}

function requireConfig() {
  const cfg = config();
  if (!cfg) {
    throw new KafkaConfigError(
      'KAFKA_BOOTSTRAP, KAFKA_USERNAME, KAFKA_PASSWORD et KAFKA_CA_PEM doivent etre definis cote serveur',
    );
  }
  return cfg;
}

function topicName(suffix) {
  return `${prefix()}.${suffix}`;
}

function withTimeout(promise, ms, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new KafkaDownError(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Publie des messages par suffixe de topic : { logs: [...], traces: [...] }.
 * `key` = TraceId et LegacyPartitioner (murmur2) : la cle atterrit sur la meme
 * partition que cote Python/librdkafka, donc le watcher relit la trace entiere.
 */
async function publish(bySuffix, timeoutMs) {
  const cfg = requireConfig();
  const budget = timeoutMs || TIMEOUT_MS;
  const kafka = new Kafka(cfg);
  const producer = kafka.producer({
    allowAutoTopicCreation: false,
    idempotent: false,
    createPartitioner: Partitioners.LegacyPartitioner,
  });
  const sent = {};
  try {
    await withTimeout(producer.connect(), budget, 'connexion Kafka trop longue');
    for (const [suffix, msgs] of Object.entries(bySuffix)) {
      if (!msgs || !msgs.length) continue;
      const results = await withTimeout(
        producer.send({
          topic: topicName(suffix),
          messages: msgs.map((m) => ({
            key: m.key,
            value: typeof m.value === 'string' ? m.value : JSON.stringify(m.value),
          })),
        }),
        budget,
        `envoi sur ${suffix} trop long`,
      );
      sent[suffix] = results.map((r) => ({
        topic: r.topicName || topicName(suffix),
        partition: r.partition,
        offset: String(r.baseOffset),
        count: (r.recordCount != null ? r.recordCount : (r.logAppendTime ? 1 : 1)),
      }));
    }
    return sent;
  } catch (err) {
    if (err instanceof KafkaConfigError) throw err;
    process.stderr.write(`publication impossible : ${err.message}\n`);
    throw err instanceof KafkaDownError ? err : new KafkaDownError(err.message || String(err));
  } finally {
    try {
      await producer.disconnect();
    } catch (err) {
      /* deja deconnecte */
    }
  }
}

/* ------------------------------------------------------------------ */
/* Lecture des rapports (otel-reports)                                */
/* ------------------------------------------------------------------ */

/**
 * UN consommateur par instance chaude, dans un groupe PROPRE A L'INSTANCE,
 * relu depuis le debut, sans commit d'offset.
 *
 * Un groupe fixe ne marcherait pas : Kafka memorise l'offset du groupe, donc une
 * instance neuve (demarrage a froid) reprendrait a la FIN du topic et ne verrait
 * plus aucun rapport existant — /api/report repondrait 404 pour des rapports
 * presents. Avec un groupe par instance, chaque instance retrouve tout.
 * Le nom commence par « otel-watch » : c'est le prefixe couvert par l'ACL Read
 * de groupe du compte applicatif.
 */
const REPORT_GROUP_PREFIX = 'otel-watch-site-reader';
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
  const topic = topicName('reports');
  const consumer = new Kafka(cfg).consumer({
    groupId: `${REPORT_GROUP_PREFIX}-${crypto.randomBytes(4).toString('hex')}`,
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
  // run() se termine SANS erreur quand le groupe est refuse (ACL) : seul CRASH
  // le signale. restart=true : kafkajs relance seul.
  consumer.on(consumer.events.CRASH, (event) => {
    const { error, restart } = event.payload;
    process.stderr.write(`lecteur de rapports : arret (${error && error.message}), restart=${restart}\n`);
    if (restart) {
      self.joinedAt = 0;
      return;
    }
    discardReader(new KafkaDownError((error && error.message) || 'lecteur de rapports arrete'));
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
            const parsed = JSON.parse(message.value.toString('utf8'));
            const key = parsed.TraceId || (message.key && message.key.toString('utf8'));
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
        `${err.type || ''} ${err.message || ''}`,
      );
      discardReader(err instanceof KafkaConfigError ? err : new KafkaDownError(err.message || String(err)));
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
  const cfg = requireConfig();
  const budget = timeoutMs || TIMEOUT_MS;
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
      discardReader(new KafkaDownError('connexion Kafka trop longue (lecteur de rapports)'));
      throw new KafkaDownError('connexion Kafka trop longue (lecteur de rapports)');
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

module.exports = {
  KafkaConfigError,
  KafkaDownError,
  publicReason,
  config,
  publish,
  findReport,
  topicName,
};
