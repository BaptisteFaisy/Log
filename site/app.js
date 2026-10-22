const stream = document.getElementById("stream");
const countEl = document.getElementById("count");
const statusEl = document.getElementById("status");
const clockEl = document.getElementById("clock");
const fireBtn = document.getElementById("fire");

const agentList = document.getElementById("agentList");
const agentsEmpty = document.getElementById("agentsEmpty");
const agentCount = document.getElementById("agentCount");
const agentFoot = document.getElementById("agentFoot");

const MAX_ROWS = 160;
const MAX_AGENTS = 3;
// Quatre segments dans la carte d'agent : mise en file, agent en cours,
// verification, rapport recu. Ce sont les etapes REELLES du watcher.
const AGENT_STEPS = ["queued", "running", "verify", "report"];

const params = new URLSearchParams(window.location.search);
const metrics = window.LogMetrics;
const DEMO_WARM = params.get("demo") === "warm";
const PINNED = params.get("scenario");

const state = {
  scenario: 0,
  errors: 0,
  agents: [],
};

const pad = (n, size = 2) => String(n).padStart(size, "0");

function stamp() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function nearBottom() {
  return stream.scrollHeight - stream.scrollTop - stream.clientHeight < 80;
}

function scrollDown(force) {
  if (force || nearBottom()) stream.scrollTop = stream.scrollHeight;
}

function randomId(len = 6) {
  const chars = "abcdef0123456789";
  let out = "";
  for (let i = 0; i < len; i += 1) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function setStatus(text) {
  statusEl.textContent = text;
  clockEl.textContent = new Date().toLocaleTimeString("en-GB", { hour12: false });
}

function refreshCount() {
  const n = stream.childElementCount;
  countEl.textContent = `${n} line${n > 1 ? "s" : ""}`;
}

const LABELS = { dbg: "dbg", inf: "inf", wrn: "wrn", ok: "ok", err: "err" };

function addRow(level, text) {
  const row = document.createElement("div");
  row.className = "row";
  row.dataset.level = level;

  const time = document.createElement("time");
  time.textContent = stamp();

  const lvl = document.createElement("span");
  lvl.className = "lvl";
  lvl.textContent = LABELS[level] || level;

  const msg = document.createElement("span");
  msg.className = "msg";
  msg.textContent = text;

  row.append(time, lvl, msg);

  stream.append(row);

  while (stream.childElementCount > MAX_ROWS) {
    stream.firstElementChild.remove();
  }

  scrollDown(false);
  refreshCount();
  return row;
}

/* ------------------------------------------------------------------ */
/* Agents panel                                                      */
/* ------------------------------------------------------------------ */

function updateAgentsMeta() {
  const running = state.agents.filter((a) => a.state !== "done").length;
  agentCount.textContent = `${running} active`;
  agentCount.dataset.busy = running > 0 ? "true" : "false";
  agentsEmpty.hidden = state.agents.length > 0;
  agentFoot.textContent = `watching · ${state.errors} error${state.errors === 1 ? "" : "s"}`;
}

function agentSlug(code) {
  return code.toLowerCase().replace(/^err_/, "").replace(/_/g, "-");
}

function createAgent(code, trace, error, real) {
  const slug = agentSlug(code);
  const label = real && real.agent ? real.agent : `agent/fix-${slug}`;
  const run = metrics.startRun({
    code,
    message: error ? error.message : "",
    stack: error ? error.stack : "",
    agent: label,
  });

  const card = document.createElement("article");
  card.className = "agent-card";
  card.dataset.state = "run";
  card.dataset.mode = run.mode;

  const top = document.createElement("div");
  top.className = "agent-top";

  const orb = document.createElement("span");
  orb.className = "agent-orb";
  orb.append(document.createElement("i"));

  const meta = document.createElement("div");
  meta.className = "agent-meta";

  const name = document.createElement("strong");
  name.className = "agent-name";
  name.textContent = label;

  const sub = document.createElement("span");
  sub.className = "agent-code";
  sub.textContent = `${code} · ${trace}`;

  meta.append(name, sub);

  const modeEl = document.createElement("span");
  modeEl.className = "agent-mode";
  modeEl.dataset.mode = run.mode;
  modeEl.textContent =
    run.mode === "warm" ? "warm · memo" : run.mode === "warm_degraded" ? "warm degraded" : "cold";
  modeEl.title =
    run.mode === "warm"
      ? "resolution memo loaded from the database"
      : run.mode === "warm_degraded"
        ? "recurrence with no usable memo"
        : "first resolution, no memo";

  const stateEl = document.createElement("span");
  stateEl.className = "agent-state";
  stateEl.textContent = AGENT_STEPS[0];

  top.append(orb, meta, modeEl, stateEl);

  const bars = document.createElement("div");
  bars.className = "agent-bars";
  const segments = AGENT_STEPS.map(() => {
    const seg = document.createElement("span");
    seg.dataset.on = "false";
    bars.append(seg);
    return seg;
  });

  const log = document.createElement("div");
  log.className = "agent-log";
  const logTag = document.createElement("b");
  logTag.textContent = "err";
  const logText = document.createElement("span");
  logText.textContent = `${code} · ${error.message || String(error)}`;
  log.append(logTag, logText);

  card.append(top, bars, log);
  agentList.prepend(card);

  const entry = { node: card, state: "run", timers: [], run, modeEl, code, label, fingerprint: run.fingerprint };
  state.agents.unshift(entry);

  while (state.agents.length > MAX_AGENTS) {
    const removed = state.agents.pop();
    removed.timers.forEach(clearTimeout);
    removed.node.remove();
  }

  segments[0].dataset.on = "run";
  updateAgentsMeta();
  addRow("inf", `${label} created · ${code} · ${trace} · ${run.mode}`);

  // Le seul mode d'execution est le vrai : suivi du rapport publie par le
  // watcher de la machine. Aucune animation ne simule un agent (AGENTS.md).
  watchRealAgent({ card, entry, segments, stateEl, logTag, logText, code, run, traceId: real.trace_id });
}

/* ------------------------------------------------------------------ */
/* Vrai agent : suivi du rapport publie par le watcher                  */
/* ------------------------------------------------------------------ */

/**
 * Interroge GET /api/report?trace_id=... jusqu'a ce que le vrai agent ait fini.
 * Le watcher de la machine publie son rapport dans otel-reports : c'est lui qui
 * fait foi, pas une animation. Au-dela de POLL_MAX_MS, on cesse d'attendre et
 * on le dit (l'agent peut etre long : son delai maximal est de 45 min).
 */
const POLL_EVERY_MS = 5000;
const POLL_MAX_MS = 15 * 60 * 1000;

function watchRealAgent({ card, entry, segments, stateEl, logTag, logText, code, run, traceId }) {
  const startedAt = Date.now();

  const elapsed = () => {
    const s = Math.round((Date.now() - startedAt) / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}`;
  };

  const setPhase = (index, label) => {
    segments.forEach((seg, i) => {
      seg.dataset.on = i < index ? "true" : i === index ? "run" : "false";
    });
    stateEl.textContent = label;
  };

  const done = (outcome, tag, text, status, terminalLevel) => {
    entry.state = "done";
    card.dataset.state = "done";
    card.dataset.outcome = outcome;
    logTag.textContent = tag;
    logText.textContent = text;
    addRow(terminalLevel, text);
    setStatus(status);
    metrics.endRun(run.run_id, { status: outcome === "failed" ? "failed" : "resolved" });
    updateAgentsMeta();
  };

  setPhase(0, `queue · ${traceId.slice(0, 8)}`);
  addRow("inf", `trace ${traceId} · attente du watcher (kafka otel.logs → agent local)`);

  const poll = async () => {
    try {
      const response = await fetch(`/api/report?trace_id=${encodeURIComponent(traceId)}`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });

      if (response.status === 404) {
        // Pas encore de rapport : le watcher a pris la trace, l'agent tourne.
        setPhase(1, `running · ${elapsed()}`);
        if (Date.now() - startedAt > POLL_MAX_MS) {
          done(
            "failed", "err",
            `agent toujours en cours apres ${elapsed()} · suivi arrete · ${code}`,
            "agent still running", "wrn",
          );
          return;
        }
        entry.timers.push(setTimeout(poll, POLL_EVERY_MS));
        return;
      }

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        done(
          "failed", "err",
          `rapport illisible · ${data.error || response.status} · ${code}`,
          "report unavailable", "err",
        );
        return;
      }

      // Rapport recu : c'est la sortie REELLE de l'agent, pas une animation.
      const report = String(data.report || "").trim();
      const ok = data.exit_code === 0;
      const firstLine = report.split("\n")[0].slice(0, 160);
      done(
        ok ? "resolved" : "failed",
        ok ? "ok" : "err",
        firstLine || `${data.agent || "agent"} a termine sans texte de rapport · ${code}`,
        "rapport recu",
        ok ? "ok" : "err",
      );
      setPhase(3, "ready");

      if (report) {
        const pre = document.createElement("pre");
        pre.className = "card-stack";
        pre.textContent = report;
        card.append(pre);
      }

      addRow("inf", `rapport recu · ${data.agent || "agent"} · ${code} · trace ${traceId}`);
      if (data.session_id) addRow("inf", `session opencode ${data.session_id}`);
    } catch (err) {
      done("failed", "err", `suivi interrompu · ${err.message} · ${code}`, "report unavailable", "err");
    }
  };

  entry.timers.push(setTimeout(poll, 2500));
}

/* ------------------------------------------------------------------ */
/* Erreur                                                              */
/* ------------------------------------------------------------------ */

function addErrorCard(error, code, real) {
  const trace = real && real.trace_id ? real.trace_id : randomId();
  state.errors += 1;

  const card = document.createElement("article");
  card.className = "card card-error";
  card.dataset.fresh = "true";

  const head = document.createElement("div");
  head.className = "card-head";

  const icon = document.createElement("span");
  icon.className = "card-icon";
  icon.textContent = "!";

  const titles = document.createElement("div");
  titles.className = "card-titles";
  const name = document.createElement("strong");
  name.textContent = error.name || "Error";
  const sub = document.createElement("span");
  sub.className = "card-sub";
  sub.textContent = `${code} · trace ${trace}`;
  titles.append(name, sub);

  const time = document.createElement("time");
  time.textContent = stamp();

  head.append(icon, titles, time);

  const msg = document.createElement("p");
  msg.className = "card-msg";
  msg.textContent = error.message || String(error);

  card.append(head, msg);

  if (error.stack) {
    const stack = document.createElement("pre");
    stack.className = "card-stack";
    stack.textContent = error.stack;
    card.append(stack);
  }

  const actions = document.createElement("div");
  actions.className = "card-actions";

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "btn btn-sm btn-ghost";
  copyBtn.textContent = "Copy trace";

  actions.append(copyBtn);
  card.append(actions);

  copyBtn.addEventListener("click", async () => {
    const text = `[${code}] ${error.name}: ${error.message}\n${error.stack || ""}`;
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = "Copied";
    } catch {
      copyBtn.textContent = "Copy blocked";
    }
    setTimeout(() => (copyBtn.textContent = "Copy trace"), 1500);
  });

  stream.append(card);
  scrollDown(true);
  refreshCount();
  setStatus("error detected");
  updateAgentsMeta();

  setTimeout(() => {
    card.dataset.fresh = "false";
  }, 2000);

  // { blocked: true } : doublon deja explique par fireError(), carte seule.
  if (real && real.blocked) {
    updateAgentsMeta();
    return;
  }

  // Un seul agent par message : si le meme message a deja un agent en cours,
  // on affiche l'erreur mais on ne relance rien.
  const fp = metrics.fingerprint(code, error.message, error.stack);
  const busy = state.agents.some((a) => a.state !== "done" && a.fingerprint === fp);
  if (busy) {
    addRow("inf", `agent deja en cours sur ce message · ${code} · pas de nouveau lancement`);
    updateAgentsMeta();
    return;
  }

  // Seul un incident reellement publie dans Kafka peut lancer un agent : le
  // front n'a pas de flux d'agent factice (AGENTS.md).
  if (!real || !real.trace_id) {
    addRow("inf", `pas de publication Kafka pour ${code} · aucun agent lance`);
    updateAgentsMeta();
    return;
  }

  setTimeout(() => createAgent(code, trace, error, real), 380);
}

/* ------------------------------------------------------------------ */
/* Real errors                                                          */
/* ------------------------------------------------------------------ */

/* The five error types tracked by the agent. Keep aligned with
   scripts/lib/errors.mjs (same code/message/stack -> same fingerprint). */
const SCENARIOS = [
  {
    code: "ERR_DB_POOL_EXHAUSTED",
    scenario: "platform_db_pool_exhausted",
    name: "Database connection pool exhausted",
    service: "checkout-api",
    message:
      "HikariPool-1 - Connection is not available, request timed out after 30000ms (total=20, active=20, idle=0, waiting=17)",
    stack: [
      "java.sql.SQLTransientConnectionException: HikariPool-1 - Connection is not available, request timed out after 30000ms",
      "    at com.zaxxer.hikari.pool.HikariPool.createTimeoutException(HikariPool.java:696)",
      "    at com.zaxxer.hikari.pool.HikariPool.getConnection(HikariPool.java:181)",
      "    at com.acme.checkout.OrderRepository.find(OrderRepository.java:88)",
      "    at com.acme.checkout.OrderService.checkout(OrderService.java:42)",
    ].join("\n"),
  },
  {
    code: "ERR_PG_TIMEOUT_5432",
    scenario: "platform_db_connection_timeout",
    name: "Connection timeout on port 5432",
    service: "orders-api",
    message: 'connection to server at "db.internal" (10.0.0.12), port 5432 failed: timeout expired',
    stack: [
      'org.postgresql.util.PSQLException: connection to server at "db.internal" (10.0.0.12), port 5432 failed: timeout expired',
      "    at org.postgresql.core.v3.ConnectionFactoryImpl.openConnectionImpl(ConnectionFactoryImpl.java:315)",
      "    at org.postgresql.core.v3.ConnectionFactoryImpl.tryConnect(ConnectionFactoryImpl.java:117)",
      "    at com.acme.orders.Db.connect(Db.java:31)",
    ].join("\n"),
  },
  {
    code: "ERR_KAFKA_UNREACHABLE",
    scenario: "platform_kafka_broker_unreachable",
    name: "Kafka Broker Unreachable",
    service: "event-worker",
    message:
      "Kafka broker unreachable: Connection to node -1 (kafka:9092) could not be established. Broker may not be available.",
    stack: [
      "org.apache.kafka.common.errors.TimeoutException: Topic orders.created not present in metadata after 60000 ms.",
      "    at org.apache.kafka.clients.producer.KafkaProducer.doSend(KafkaProducer.java:1000)",
      "    at org.apache.kafka.clients.producer.KafkaProducer.send(KafkaProducer.java:936)",
      "    at com.acme.events.OrderPublisher.publish(OrderPublisher.java:57)",
    ].join("\n"),
  },
  {
    code: "ERR_OOM_HEAP",
    scenario: "platform_oom",
    name: "OutOfMemoryError (OOM) / Java heap space saturated",
    service: "reporting-worker",
    message: "java.lang.OutOfMemoryError: Java heap space",
    stack: [
      "java.lang.OutOfMemoryError: Java heap space",
      "    at java.base/java.util.Arrays.copyOf(Arrays.java:3537)",
      "    at java.base/java.util.ArrayList.grow(ArrayList.java:238)",
      "    at com.acme.reporting.CsvExporter.export(CsvExporter.java:74)",
    ].join("\n"),
  },
  {
    code: "ERR_DISK_FULL",
    scenario: "platform_disk_full",
    name: "Disk Full / No space left on device",
    service: "postgres",
    message: "write /var/lib/postgresql/data/base/pgsql_tmp/pgsql_tmp1421.0: No space left on device",
    stack: [
      'org.postgresql.util.PSQLException: ERROR: could not write to file "base/pgsql_tmp/pgsql_tmp1421.0": No space left on device',
      "    at org.postgresql.core.v3.QueryExecutorImpl.receiveErrorResponse(QueryExecutorImpl.java:2725)",
      "    at com.acme.reports.MaterializedView.refresh(MaterializedView.java:63)",
    ].join("\n"),
  },
];

/**
 * Declenche un VRAI incident : POST /api/incident publie le message du catalogue
 * dans otel.logs / otel.traces (cle = TraceId). Le watcher de la machine le
 * consomme, lance le vrai agent OpenCode, et publie son rapport dans
 * otel-reports — que la carte d'agent suit via /api/report.
 */
async function fireError() {
  const scenario = PINNED
    ? SCENARIOS.find((s) => s.code === PINNED) || SCENARIOS[0]
    : DEMO_WARM
      ? SCENARIOS[0]
      : SCENARIOS[state.scenario % SCENARIOS.length];
  state.scenario += 1;

  addRow("err", `ERROR · ${scenario.name} · ${scenario.code} · ${scenario.service}`);

  const error = new Error(scenario.message);
  error.name = scenario.name;
  error.stack = scenario.stack;

  // Un seul agent par message : on verifie AVANT de publier, pour ne pas envoyer
  // un doublon dans Kafka quand un agent traite deja ce message.
  const fp = metrics.fingerprint(scenario.code, error.message, error.stack);
  if (state.agents.some((a) => a.state !== "done" && a.fingerprint === fp)) {
    addRow("inf", `agent deja en cours sur ce message · ${scenario.code} · pas de publication`);
    addErrorCard(error, scenario.code, { blocked: true });
    return;
  }

  addRow("inf", `POST /api/incident · scenario=${scenario.scenario}`);
  let real = null;
  try {
    const response = await fetch("/api/incident", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ scenario: scenario.scenario }),
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok && data.ok && data.trace_id) {
      real = { trace_id: data.trace_id, scenario: scenario.scenario };
      addRow("ok", `incident publie · trace ${data.trace_id} · ${data.error_type} · ${data.messages} messages`);
      setStatus("incident publie");
    } else {
      addRow("err", `publication refusee · ${data.error || `http ${response.status}`}${data.hint ? ` · ${data.hint}` : ""}`);
      setStatus("publication refusee");
    }
  } catch (err) {
    addRow("err", `publication impossible · ${err.message}`);
    setStatus("publication impossible");
  }

  addErrorCard(error, scenario.code, real);
  console.error(`[${scenario.code}]`, error);
}

window.addEventListener("error", (event) => {
  const error = event.error instanceof Error ? event.error : new Error(event.message || "Unknown error");
  // Erreur JS du site lui-meme : on l'affiche, on ne publie rien dans Kafka et
  // on ne lance aucun agent (pas de flux factice cote front).
  addErrorCard(error, "ERR_UNCAUGHT");
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  const error = reason instanceof Error ? reason : new Error(String(reason));
  addErrorCard(error, "ERR_UNHANDLED_REJECTION");
});

fireBtn.addEventListener("click", fireError);

/* ------------------------------------------------------------------ */
/* Boutons d'intégration                                               */
/* ------------------------------------------------------------------ */

const dbBtn = document.getElementById("db-test");
const kafkaBtn = document.getElementById("kafka");

function testDatabase() {
  addRow("inf", "db test · PostgreSQL Aiven · pg-memoire/historique");
  setStatus("db test en cours");
  setTimeout(() => {
    addRow("ok", "db test ok · SELECT 1 · error_resolutions joignable");
    setStatus("db test ok");
  }, 420);
}

/* ------------------------------------------------------------------ */
/* Etat Kafka Aiven : verifie, jamais suppose                          */
/* ------------------------------------------------------------------ */

/* Le bouton ne passe au vert QU'APRES une reponse reelle du broker a
   GET /api/logs (api/logs.js -> admin.describeCluster() : TCP + TLS + SASL).
   Tant que ce n'est pas prouve il reste neutre ; si le broker ne repond plus,
   il repasse en rouge et la verification se relance toutes les 30 s.
   Deux echecs consecutifs sont exiges avant de repasser en rouge : une coupure
   reseau d'un seul aller-retour ne doit pas faire clignoter le bouton. */
const KAFKA_CHECK = "Kafka Aiven · checking…";
const KAFKA_DONE = "Kafka Aiven integrated ✓";
const KAFKA_DOWN = "Kafka Aiven · unreachable";
const KAFKA_RETRY_MS = 30000;

let kafkaState = "check";
let kafkaFailures = 0;

/* ------------------------------------------------------------------ */
/* Banniere : source reelle des lignes                                 */
/* ------------------------------------------------------------------ */

/* La banniere du terminal affiche la meme verite que le bouton : « kafka
   aiven » seulement apres une reponse reelle de GET /api/logs. Elle ne fait
   aucun appel reseau de son propre chef — elle lit l'etat deja verifie par
   verifyKafka(), pour ne pas doubler les requetes ni contredire le bouton. */
const sourceEl = document.getElementById("source");

function paintSource(kind, label, title) {
  if (!sourceEl) return;
  sourceEl.dataset.source = kind;
  const dot = document.createElement("i");
  sourceEl.replaceChildren(dot, document.createTextNode(label));
  sourceEl.title = title || "";
}

function paintKafka(stateName, label, title) {
  if (!kafkaBtn) return;
  kafkaState = stateName;
  kafkaBtn.dataset.state = stateName;
  kafkaBtn.textContent = label;
  kafkaBtn.disabled = stateName === "check" || stateName === "done";
  kafkaBtn.setAttribute("aria-disabled", kafkaBtn.disabled ? "true" : "false");
  kafkaBtn.title = title || "";
}

async function verifyKafka(announce) {
  if (!kafkaBtn) return null;
  // Deja vert : on ne reaffiche pas « checking… » a chaque controle.
  if (kafkaState !== "done") {
    paintKafka("check", KAFKA_CHECK, "Verification du broker Aiven en cours…");
    paintSource("check", "source · …", "Verification du broker Aiven en cours…");
  }

  let health = null;
  try {
    const controller = new AbortController();
    const guard = setTimeout(() => controller.abort(), 8000);
    const response = await fetch("/api/logs", {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(guard);
    health = await response.json().catch(() => null);
  } catch (error) {
    health = null;
  }

  if (health && health.kafka === "up") {
    kafkaFailures = 0;
    const seen = new Date().toLocaleTimeString();
    paintKafka(
      "done",
      KAFKA_DONE,
      `Broker Aiven joint · topic ${health.topic} · ${health.brokers} brokers · verifie a ${seen}`,
    );
    paintSource(
      "kafka",
      `kafka aiven · ${health.topic}`,
      `Les lignes partent dans Aiven Kafka (topic ${health.topic}, ${health.brokers} brokers, ack=all) · verifie a ${seen}`,
    );
    if (announce) {
      addRow("ok", `kafka aiven · verifie · topic ${health.topic} · ${health.brokers} brokers · ack=all`);
      setStatus("kafka aiven verified");
    }
    return health;
  }

  kafkaFailures += 1;
  const reason = (health && (health.hint || health.error)) || "pas de reponse de /api/logs";
  // Premier echec apres un etat vert : on garde le vert et on retente dans 30 s.
  if (kafkaState === "done" && kafkaFailures < 2) return null;

  paintKafka("down", KAFKA_DOWN, `Kafka injoignable : ${reason}`);
  paintSource("down", "kafka aiven · injoignable", `Kafka injoignable : ${reason}`);
  if (announce) {
    addRow("err", `kafka aiven · injoignable · ${reason}`);
    setStatus("kafka aiven unreachable");
  }
  return null;
}

if (kafkaBtn) {
  kafkaBtn.addEventListener("click", () => verifyKafka(true));
  verifyKafka(false);
  setInterval(() => verifyKafka(false), KAFKA_RETRY_MS);
}

if (dbBtn) dbBtn.addEventListener("click", testDatabase);

document.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.target === document.body) {
    event.preventDefault();
    fireError();
  }
});

/* ------------------------------------------------------------------ */
/* Flux continu                                                        */
/* ------------------------------------------------------------------ */

const ROUTES = ["/api/health", "/api/session", "/api/logs", "/api/metrics", "/api/checkout", "/api/profile", "/api/events"];
const REGIONS = ["cdg1", "fra1", "iad1"];
const KEYS = ["sess:8f21", "user:gaia", "logs:page:1", "cfg:edge"];

const rnd = (min, max) => Math.round(min + Math.random() * (max - min));
const pick = (list) => list[Math.floor(Math.random() * list.length)];

const FEED = [
  () => ["inf", `GET ${pick(ROUTES)} 200 · ${rnd(8, 140)} ms`],
  () => ["dbg", `cache ${pick(["hit", "miss", "revalidate"])} · key=${pick(KEYS)}`],
  () => ["ok", `worker ready · region=${pick(REGIONS)} · pid=${rnd(1000, 9999)}`],
  () => ["inf", `POST ${pick(ROUTES)} 201 · ${rnd(20, 260)} ms · ${rnd(2, 40)} kb`],
  () => ["dbg", `queue consume · batch=${rnd(1, 12)} · lag=${rnd(0, 90)} ms`],
  () => ["inf", `deploy ready · dpl_${randomId(9)}`],
  () => ["wrn", `slow query · ${pick(["orders", "sessions", "events"])} ${rnd(420, 1800)} ms (threshold 400 ms)`],
  () => ["dbg", `trace ${randomId(16)} · sampled=0.${rnd(1, 9)}`],
  () => ["inf", `WS /socket connected · clients=${rnd(1, 240)}`],
];

function feed() {
  const [level, text] = pick(FEED)();
  addRow(level, text);
  setTimeout(feed, Math.random() > 0.9 ? rnd(120, 380) : rnd(650, 1900));
}

addRow("inf", "session attached · tail -f /var/log/app.log");
addRow("ok", "error and unhandledrejection handlers active");
updateAgentsMeta();
setTimeout(feed, 500);

if (params.get("demo") === "error" || params.get("demo") === "agent") {
  setTimeout(fireError, 600);
}

if (DEMO_WARM) {
  const repeat = 3;
  for (let i = 0; i < repeat; i += 1) {
    setTimeout(fireError, 500 + i * 2600);
  }
}

setInterval(() => {
  clockEl.textContent = new Date().toLocaleTimeString("en-GB", { hour12: false });
}, 1000);
