#!/usr/bin/env python3
"""Guides en anglais (choix de Baptiste) : memes traces que la version FR.

Cible par id pour `historique` (les noms sont desormais en anglais) et par
fingerprint pour `error_resolutions`. Chaque champ reste sous 1150 caracteres
(plafond de /api/pg-memoire : 8000, marge de securite).

Usage : write-guides-en.py [--apply]
"""
from __future__ import annotations

import os
import subprocess
import sys

MAX = 1150

HISTORIQUE = {
    1: """TRACE 2026-10-22 07:43 (Aiven project baptiste-c04f, service pg-memoire)
1) avn service get pg-memoire --json | jq .service.service_uri_params -> the password field is REDACTED.
2) same result on the other channels: avn service user-list, then curl -H "authorization: aivenv1 $TOKEN" https://api.aiven.io/v1/project/baptiste-c04f/service/pg-memoire -> masked there too.
3) conclusion: this is not a permission problem, the API NEVER returns a password on read; insisting is pointless.
CAUSE: an Aiven password is only readable at service creation or after a reset-credentials call.
FIX APPLIED: PUT /v1/project/baptiste-c04f/service/pg-memoire/user/avnadmin with {"operation":"reset-credentials","new_password":<value already stored in .secrets/creds.env>}; the value is kept in hackathon-memory/.secrets/creds.env (mode 600).
PITFALL: reset-credentials drops live sessions, and other agents read creds.env: reapply the existing value, never generate a new one.
CHECK: psql "$DATABASE_URL" -c 'select current_user' -> avnadmin.""",
}

MEMOS = {
    "004aea24350886": {
        "cause": """TRACE 2026-10-22 11:24 (site log-lac-five, trace 004aea24350886)
1) report: the "log()" logo in the header renders as plain text above 640 px wide.
2) grep -n "brand-word|brand-call" styles.css -> the .brand-word / .brand-call rules sat INSIDE @media (max-width:640px).
3) reading: above 640 px the media query does not apply -> no Space Mono, no 26 px, no red on "()".
4) check before the fix: getComputedStyle(.brand-word) at 1440 px -> default font, inherited size.
CAUSE: the logo styling was locked inside a mobile media query; no base rule existed outside it.""",
        "fix": """1) move .brand-word and .brand-call out of @media (max-width:640px) into a global base rule (Space Mono, 26 px, 700, letter-spacing -0.07em for .brand-word; color var(--red) for .brand-call).
2) keep only the mobile reduction inside the media query: .brand-word { font-size: 22px }.
3) no other selector touched: no reformatting, no renaming, no opportunistic cleanup.
RESULT: the logo is styled at every width and still 22 px below 640 px.""",
        "verification": """1) styles.css: .brand-word is defined OUTSIDE the media query (grep -n -A6 "^\\.brand-word" styles.css -> ~line 1008, before the @media 640 at ~line 1767).
2) headless Chrome, 1440 px window: getComputedStyle(.brand-word) -> 26px / 700 / Space Mono.
3) 375 px window: getComputedStyle(.brand-word) -> 22px (mobile override still active).
4) .brand-call: color rgb(255,46,147) = var(--red) at both widths.
VERIFIED on 2026-10-22 13:40 against production: all 4 points hold.""",
    },
    "11be9e0fe720e7": {
        "cause": """TRACE 2026-10-22 09:12 (trace e5a9b1c3, error.type=disk_full)
1) tools/debug-bundle e5a9b1c3 -> java.io.IOException: No space left on device: write /var/lib/app/telemetry-buffer failed; file.path = /var/lib/app/telemetry-buffer.
2) trace-dump e5a9b1c3 --detectors -> system.disk.usage = 100 %, system.disk.free = 0; retry_spiral / silent_failure / stale_source = ok.
3) jvm.* absent from the trace -> OOM hypothesis ruled out for lack of evidence.
4) the trace was consumed from otel.traces -> the Kafka broker is not involved.
CAUSE: the telemetry buffer volume is full (writes with no rotation and no retention); the write failure is the symptom, not the cause.""",
        "fix": """1) unblock on the faulty host, not on the broker: df -h /var/lib/app/telemetry-buffer; du -sh /var/lib/app/telemetry-buffer, then purge old files (find ... -mtime +1 -delete).
2) fix the cause: bound the buffer (size-based rotation ~5 GiB, max 5 files) plus explicit backpressure at the high watermark.
3) if the volume is structurally too small: give /var/lib/app/telemetry-buffer its own volume instead of sharing /var.
4) alert at system.disk.usage > 85 % and free < 5 GiB, i.e. before 100 %.
DO NOT: restart Kafka, touch the broker, open a network ticket.""",
        "verification": """1) df -h on the volume -> usage < 85 %, system.disk.free back above the threshold.
2) replay: app.errors{error.type=disk_full} drops back to 0.
3) SELECT count(*) FROM logs WHERE code='ERR_DISK_FULL' stops moving.
4) debug-bundle on the next trace -> the 3 detectors stay ok.""",
    },
    "0d8832e7af57d2": {
        "cause": """TRACE 2026-10-22 09:11 (trace dbe4d91a, error.type=oom)
1) tools/debug-bundle dbe4d91a -> java.lang.OutOfMemoryError: Java heap space; spans jvm.heap (Error) and agent.run (Error, tool_calls=1).
2) trace-dump dbe4d91a --detectors -> jvm.memory.used = 2 147 483 648 B = jvm.memory.limit (2 GiB), zero headroom; jvm.gc.pause 1600 ms "end of major GC".
3) free -m on the workstation -> 5742/6546 MB used, 0 swap; the local java is the Kafka broker at -Xmx640M, NOT the failing JVM (2 GiB): do not mix them up.
4) disk: no metric, local / at 14 % -> not the factor.
CAUSE: heap saturated (leak or spike) at the 2 GiB ceiling; the major GC is ineffective, this is not a misconfigured GC.""",
        "fix": """1) restore service: raise the limit -Xmx2g -> -Xmx4g (or jvm.memory.limit on the deployer side).
2) capture the leak BEFORE restarting, otherwise the incident comes back: -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/var/log/agent/ then jcmd <pid> GC.heap_dump /tmp/agent.hprof; analyse with Eclipse MAT (histogram of dominant classes).
3) DO NOT touch the GC: -XX:MaxGCPauseMillis or another collector does not fix used == limit.
4) disk: nothing to do, it is not the factor.""",
        "verification": """1) after restart: jvm.memory.used well below jvm.memory.limit (headroom > 25 %).
2) major-GC jvm.gc.pause < 500 ms.
3) no new error.type=oom trace in otel.logs during the control load.
4) the .hprof file exists and is analysable (MAT/jhat): the cause is documented, not merely worked around.""",
    },
    "18ed18556ac80c": {
        "cause": """TRACE 2026-10-22 09:12 (trace e33bccd0, error.type=kafka_unreachable)
1) tools/debug-bundle e33bccd0 -> Kafka Broker Unreachable: broker not reachable (ERR__TRANSPORT); destination topic agent-events.
2) trace-dump e33bccd0 --detectors -> retry_spiral ok: a clean failure, the agent is not hammering.
3) kafka-health --deep -> cluster HEALTHY (brokers reachable) but the expected topic is MISSING from list_topics.
4) reading: ERR__TRANSPORT is what the producer reports when the Write ACL is denied (producer.flush() hides the real ACL error); the topic looks "missing" rather than "forbidden".
CAUSE: missing ACL on agent-events (Describe + Write, LITERAL pattern); neither a broker outage nor a TLS/DNS problem.""",
        "fix": """1) avn service topic-list agent-kafka --project baptiste-c04f: tells "topic does not exist" from "ACL denied".
2) grant the Describe + Write ACL on agent-events in LITERAL pattern for the producer user.
3) fix provision.sh so the ACL prefix covers the application destination, otherwise the scenario returns on the next reprovision.
4) harden the producer: map ERR__TRANSPORT + topic missing from list_topics to TOPIC_AUTHORIZATION_FAILED in tools/kafkalib.py.
DO NOT: restart the broker, open a network ticket, change TLS.""",
        "verification": """1) kafka-health --deep -> agent-events is listed in list_topics.
2) replay the emission scenario -> no ERR__TRANSPORT, messages land (kafka_offset moves).
3) SELECT count(*) FROM logs WHERE code='ERR_KAFKA_UNREACHABLE' stops moving.
4) after a full reprovision, the same emission succeeds: the provision.sh fix is effective.""",
    },
    "0032754cfaa96c": {
        "cause": """TRACE 2026-10-22 07:57 (trace 679f3cf1, error.type=db_connection_timeout)
1) tools/debug-bundle 679f3cf1 -> Connection timeout on port 5432; target host postgres-db.internal, pool HikariPool-1.
2) trace-dump 679f3cf1 --detectors -> no server counter, no pool metric: the trace does not prove the cause.
3) getent hosts postgres-db.internal from the workstation -> fails, but the workstation is NOT on the agent network: this is not evidence of broken DNS.
4) discrimination failed: connectivity (DNS / port / service) versus pool saturation -> an operator readout is missing.
CAUSE (most likely first, to be confirmed): network filtering on 5432, slow internal DNS, or max_connections reached on the server.""",
        "fix": """1) from the application host, not from the workstation: getent hosts postgres-db.internal then nc -vz -w 5 postgres-db.internal 5432 (or pg_isready -h ... -p 5432 -t 5).
2) server side: SELECT state,count(*) FROM pg_stat_activity GROUP BY 1; SELECT count(*) used, current_setting('max_connections')::int max FROM pg_stat_activity.
3) pool side: /actuator/metrics/hikaricp.connections.{active,idle,max,pending} or JMX ActiveConnections / ThreadsAwaitingConnection.
4) reading: ThreadsAwaitingConnection > 0 with Idle = 0 and Active = Max -> connection leak (application fix); nc failing with a healthy pool -> connectivity; old idle in transaction -> leak confirmed in the database.
5) only raise connectTimeout to 10 s and add 2 retries AFTER the cause is identified: a longer timeout hides the problem.""",
        "verification": """1) nc -zv <host>:5432 OK from every application host.
2) 100 cold connections < 10 s, no SQLTransientConnectionException.
3) SELECT count(*) FROM pg_stat_activity stays below max_connections - 5.
4) no new db_connection_timeout trace in otel.logs; debug-bundle -> detectors ok.
If point 1 still fails, the cause is the network: no application fix will hide it.""",
    },
    "log_mvj9itan_72u7b2": {
        "cause": """TRACE 2026-10-22 08:11 (5 logs, service agent-demo, route /api/checkout)
1) SELECT payload FROM logs WHERE code='ERR_PAYLOAD_INVALID' -> {"route":"/api/checkout","region":"cdg1"}: no order field at all.
2) application message -> Cannot read properties of null (reading 'order'): payload.order dereferenced with no guard.
3) reading: this is not an infrastructure problem, the log did arrive through otel.logs (kafka_offset moves); only input validation is missing.
CAUSE: payload.order is absent (null) and dereferenced directly by the /api/checkout handler; no validation before use.""",
        "fix": """1) validate the payload before reading it: if !payload || !payload.order -> answer 400 invalid_payload with an explicit message, without dereferencing order.
2) log it at warn with the route and the missing key, not at err: this is not an outage.
3) regression tests: POST /api/checkout with {} then with {"order":null} -> 400, never 500 or a TypeError.
4) do not add a silent default value: an order without order must not be processed.""",
        "verification": """1) POST /api/checkout with an empty payload -> 400 invalid_payload, no more TypeError.
2) POST /api/checkout with a valid payload -> 200, order processed.
3) SELECT count(*) FROM logs WHERE code='ERR_PAYLOAD_INVALID' stops moving after the fix.
4) site test suite: 12/12 green.""",
    },
    "114474dc77b282": {
        "cause": """TRACE 2026-10-22 09:11 (trace d7cce6a5, error.type=db_pool_exhausted)
1) tools/debug-bundle d7cce6a5 -> error.type=db_pool_exhausted, pool=HikariPool-1, failing tool tool.check_reservation.
2) trace-dump d7cce6a5 --detectors -> pool.active=20, idle=0, max=20, db.client.connection.timeouts=4; retry_spiral [PROBLEM] (4 calls 380 ms apart), silent_failure ok.
3) reading: the 4 failures are ACQUISITION timeouts, the SQL statement is never emitted; 4 x 380 ms ~ 1520 ms = 95 % of the 1600 ms root span.
4) leak versus load: active = max = 20 with idle = 0 permanently is the signature of a leak; a plain load would let idle connections flow through.
CAUSE: connections never returned to the pool (session opened without close) -> pool 20/20 saturated; the retry spiral is the consequence, not the cause.""",
        "fix": """1) locate the unreleased session: SELECT pid,state,now()-state_change age,left(query,80) FROM pg_stat_activity WHERE datname='historique' ORDER BY age DESC LIMIT 20; the oldest "idle in transaction" points at the faulty code.
2) application fix: try-with-resources / @Transactional around every connection use; release stuck sessions with SELECT pg_terminate_backend(pid).
3) do NOT raise maximumPoolSize before closing the leak: it hides the bug.
4) resolve the message contradiction: HikariPool$PoolInitializationException means creation failure (connectivity / credentials), not saturation -> read the full HikariPool-1 log ("Exception during pool initialization" versus "Connection is not available").""",
        "verification": """1) tools/pg-diag "SELECT state,count(*) FROM pg_stat_activity WHERE datname='historique' GROUP BY 1" -> no ageing idle in transaction.
2) 50 req/s for 5 min: pool.active < pool.max, idle > 0, pending = 0.
3) curl /actuator/metrics/hikaricp.connections.pending -> 0.
4) no new db_pool_exhausted trace in otel.logs; debug-bundle on the next trace -> retry_spiral ok.""",
    },
}


def sql_literal(text: str) -> str:
    return "'" + text.replace("'", "''") + "'"


def check() -> None:
    sizes = [(f"historique#{i}", len(t)) for i, t in HISTORIQUE.items()]
    sizes += [(f"{fp}.{f}", len(m[f])) for fp, m in MEMOS.items() for f in ("cause", "fix", "verification")]
    bad = [s for s in sizes if s[1] > MAX]
    for where, size in bad:
        print(f"TOO LONG {where}: {size} > {MAX}")
    print(f"{len(sizes)} champs, max {max(s for _, s in sizes)} car.")
    if bad:
        sys.exit(1)


def main() -> None:
    check()
    statements = ["BEGIN;"]
    for row_id, text in HISTORIQUE.items():
        statements.append(f"UPDATE historique SET resolution = {sql_literal(text)} WHERE id = {row_id};")
    for fp, memo in MEMOS.items():
        statements.append(
            "UPDATE error_resolutions SET "
            f"cause = {sql_literal(memo['cause'])}, "
            f"fix = {sql_literal(memo['fix'])}, "
            f"verification = {sql_literal(memo['verification'])} "
            f"WHERE fingerprint = {sql_literal(fp)};"
        )
    statements.append("COMMIT;")
    sql = "\n".join(statements)

    if "--apply" not in sys.argv:
        print(sql[:600] + " [...]")
        return

    url = os.environ["DATABASE_URL"].replace("/defaultdb", "/historique")
    proc = subprocess.run(["psql", url, "-v", "ON_ERROR_STOP=1", "-q", "-c", sql], capture_output=True, text=True)
    print(proc.stdout.strip(), proc.stderr.strip())
    print("rc =", proc.returncode)


if __name__ == "__main__":
    main()
