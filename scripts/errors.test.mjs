import assert from "node:assert/strict";
import test from "node:test";
import { ERROR_TYPES, entryFor, fingerprint, normalizeMessage } from "./lib/errors.mjs";

test("les cinq types d'erreur sont présents", () => {
  assert.deepEqual(
    ERROR_TYPES.map((entry) => entry.name),
    [
      "Database connection pool exhausted",
      "Connection timeout on port 5432",
      "Kafka Broker Unreachable",
      "OutOfMemoryError (OOM) / Java heap space saturated",
      "Disk Full / No space left on device",
    ],
  );
});

test("normalisation : ids, nombres, chemins et timestamps retirés", () => {
  const a = normalizeMessage('connection to server at "db.internal" (10.0.0.12), port 5432 failed: timeout expired');
  const b = normalizeMessage('connection to server at "db.internal" (10.0.0.99), port 5433 failed: timeout expired');
  assert.equal(a, b);
  assert.match(a, /<n>/);
});

test("fingerprint stable et sensible au code", () => {
  const entry = ERROR_TYPES[0];
  const one = fingerprint(entry.code, entry.message, entry.stack);
  const two = fingerprint(entry.code, entry.message, entry.stack);
  const other = fingerprint("ERR_OTHER", entry.message, entry.stack);
  assert.equal(one, two);
  assert.notEqual(one, other);
  assert.match(one, /^[0-9a-f]{14}$/);
});

test("recherche par code ou par nom", () => {
  assert.equal(entryFor({ code: "ERR_KAFKA_UNREACHABLE" }).name, "Kafka Broker Unreachable");
  assert.equal(entryFor({ name: "disk full / no space left on device" }).code, "ERR_DISK_FULL");
  assert.equal(entryFor({ name: "inconnu" }), null);
});

test("détection depuis une ligne de log brute", () => {
  const line =
    "2026-10-22T08:13:25.292Z ERROR [checkout-api] Database connection pool exhausted — HikariPool-1";
  assert.equal(entryFor({ message: line }).code, "ERR_DB_POOL_EXHAUSTED");
});
