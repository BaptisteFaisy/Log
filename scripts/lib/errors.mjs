export const ERROR_TYPES = [
  {
    code: "ERR_DB_POOL_EXHAUSTED",
    name: "Database connection pool exhausted",
    service: "checkout-api",
    level: "ERROR",
    message:
      "HikariPool-1 - Connection is not available, request timed out after 30000ms (total=20, active=20, idle=0, waiting=17)",
    stack: [
      "java.sql.SQLTransientConnectionException: HikariPool-1 - Connection is not available, request timed out after 30000ms",
      "    at com.zaxxer.hikari.pool.HikariPool.createTimeoutException(HikariPool.java:696)",
      "    at com.zaxxer.hikari.pool.HikariPool.getConnection(HikariPool.java:181)",
      "    at com.acme.checkout.OrderRepository.find(OrderRepository.java:88)",
      "    at com.acme.checkout.OrderService.checkout(OrderService.java:42)",
    ],
  },
  {
    code: "ERR_PG_TIMEOUT_5432",
    name: "Connection timeout on port 5432",
    service: "orders-api",
    level: "ERROR",
    message: 'connection to server at "db.internal" (10.0.0.12), port 5432 failed: timeout expired',
    stack: [
      "org.postgresql.util.PSQLException: connection to server at \"db.internal\" (10.0.0.12), port 5432 failed: timeout expired",
      "    at org.postgresql.core.v3.ConnectionFactoryImpl.openConnectionImpl(ConnectionFactoryImpl.java:315)",
      "    at org.postgresql.core.v3.ConnectionFactoryImpl.tryConnect(ConnectionFactoryImpl.java:117)",
      "    at com.acme.orders.Db.connect(Db.java:31)",
    ],
  },
  {
    code: "ERR_KAFKA_UNREACHABLE",
    name: "Kafka Broker Unreachable",
    service: "event-worker",
    level: "ERROR",
    message:
      "Kafka broker unreachable: Connection to node -1 (kafka:9092) could not be established. Broker may not be available.",
    stack: [
      "org.apache.kafka.common.errors.TimeoutException: Topic orders.created not present in metadata after 60000 ms.",
      "    at org.apache.kafka.clients.producer.KafkaProducer.doSend(KafkaProducer.java:1000)",
      "    at org.apache.kafka.clients.producer.KafkaProducer.send(KafkaProducer.java:936)",
      "    at com.acme.events.OrderPublisher.publish(OrderPublisher.java:57)",
    ],
  },
  {
    code: "ERR_OOM_HEAP",
    name: "OutOfMemoryError (OOM) / Java heap space saturated",
    service: "reporting-worker",
    level: "FATAL",
    message: "java.lang.OutOfMemoryError: Java heap space",
    stack: [
      "java.lang.OutOfMemoryError: Java heap space",
      "    at java.base/java.util.Arrays.copyOf(Arrays.java:3537)",
      "    at java.base/java.util.ArrayList.grow(ArrayList.java:238)",
      "    at com.acme.reporting.CsvExporter.export(CsvExporter.java:74)",
    ],
  },
  {
    code: "ERR_DISK_FULL",
    name: "Disk Full / No space left on device",
    service: "postgres",
    level: "ERROR",
    message: "write /var/lib/postgresql/data/base/pgsql_tmp/pgsql_tmp1421.0: No space left on device",
    stack: [
      "org.postgresql.util.PSQLException: ERROR: could not write to file \"base/pgsql_tmp/pgsql_tmp1421.0\": No space left on device",
      "    at org.postgresql.core.v3.QueryExecutorImpl.receiveErrorResponse(QueryExecutorImpl.java:2725)",
      "    at com.acme.reports.MaterializedView.refresh(MaterializedView.java:63)",
    ],
  },
];

export const ERROR_BY_CODE = new Map(ERROR_TYPES.map((entry) => [entry.code, entry]));

export function normalizeMessage(message) {
  return String(message || "")
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/\b0x[0-9a-f]+\b/g, "<hex>")
    .replace(/\b[0-9a-f]{12,}\b/g, "<hex>")
    .replace(/\d{4}-\d{2}-\d{2}t[\d:.]+z?/g, "<ts>")
    .replace(/[a-z]:\\[^\s:]+/gi, "<path>")
    .replace(/(^|\s)\/(?:[\w.-]+\/)+[\w.-]+/g, "$1<path>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

export function firstFrame(stack) {
  const line = String(stack || "")
    .split("\n")
    .find((entry) => /\bat\b|:\d+:\d+/.test(entry) && !/metrics\.js|observability\.js/.test(entry));
  return line ? line.trim().slice(0, 120) : "";
}

// Doit rester identique à hash() dans metrics.js : le navigateur et les scripts
// partagent ainsi le même fingerprint pour une même erreur.
function hash(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

export function fingerprint(code, message, stack) {
  return hash(`${code}|${normalizeMessage(message)}|${firstFrame(stack)}`);
}

export function entryFor({ code, name, message }) {
  if (code && ERROR_BY_CODE.has(code)) return ERROR_BY_CODE.get(code);
  const needle = String(name || message || "").toLowerCase();
  return (
    ERROR_TYPES.find((entry) => entry.name.toLowerCase() === needle) ||
    ERROR_TYPES.find((entry) => entry.code.toLowerCase() === needle) ||
    ERROR_TYPES.find((entry) => needle.includes(entry.name.toLowerCase())) ||
    ERROR_TYPES.find((entry) => needle.includes(entry.message.toLowerCase().slice(0, 40))) ||
    ERROR_TYPES.find((entry) => entry.name.toLowerCase().includes(needle) && needle.length > 3) ||
    null
  );
}

export function logLine(entry, ts = new Date().toISOString()) {
  return `${ts} ${entry.level} [${entry.service}] ${entry.name} — ${entry.message}`;
}

export function logLines(entry, ts = new Date().toISOString()) {
  return [logLine(entry, ts), ...entry.stack.map((line) => `    ${line}`)];
}
