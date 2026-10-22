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
const AGENT_STEPS = ["analyze", "patch", "verify", "ready"];
const STEP_NAMES = {
  analyze: "diagnose",
  patch: "patch",
  verify: "verify",
  ready: "write_memo",
};

const params = new URLSearchParams(window.location.search);
const metrics = window.LogMetrics;
const DEMO_WARM = params.get("demo") === "warm";
const SPEED = DEMO_WARM ? 0.35 : 1;
const PINNED = params.get("scenario");
const FAIL = params.get("fail") === "1";

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

function createAgent(code, trace, error) {
  const slug = agentSlug(code);
  const label = `agent/fix-${slug}`;
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

  const entry = { node: card, state: "run", timers: [], run, modeEl, code, label };
  state.agents.unshift(entry);

  while (state.agents.length > MAX_AGENTS) {
    const removed = state.agents.pop();
    removed.timers.forEach(clearTimeout);
    removed.node.remove();
  }

  segments[0].dataset.on = "run";
  updateAgentsMeta();
  addRow("inf", `${label} created · ${code} · ${trace} · ${run.mode}`);

  let step = 0;

  const nextDelay = () =>
    (run.mode === "warm" ? 320 + Math.random() * 260 : 900 + Math.random() * 700) * SPEED;

  const fail = () => {
    entry.state = "done";
    card.dataset.state = "done";
    card.dataset.outcome = "failed";
    stateEl.textContent = "failed";
    logTag.textContent = "err";
    logText.textContent = `patch rejected · tests 6/12 · ${code}`;
    addRow("err", `patch rejected · ${code} · tests 6/12`);
    setStatus("resolution failed");
    metrics.addTokens(run.run_id, { ...simulatedTokens(run.fingerprint, run.mode), estimated: true });
    metrics.endRun(run.run_id, { status: "failed" });
    updateAgentsMeta();
  };

  const advance = () => {
    metrics.step(run.run_id, STEP_NAMES[AGENT_STEPS[step]]);
    segments[step].dataset.on = "true";
    step += 1;

    if (FAIL && step === 3) {
      fail();
      return;
    }

    if (step >= AGENT_STEPS.length) {
      entry.timers.push(setTimeout(finish, 300 * SPEED));
      return;
    }

    segments[step].dataset.on = "run";
    stateEl.textContent = AGENT_STEPS[step];
    entry.timers.push(setTimeout(advance, nextDelay()));
  };

  const finish = () => {
    entry.state = "done";
    card.dataset.state = "done";
    stateEl.textContent = "ready";
    logTag.textContent = "ok";
    logText.textContent = `patch applied · tests 12/12 · ${code}`;
    addRow("ok", `patch applied · ${code} · tests 12/12`);
    setStatus("fix ready");

    const tokens = simulatedTokens(run.fingerprint, run.mode);
    metrics.addTokens(run.run_id, { ...tokens, estimated: true });
    metrics.endRun(run.run_id, { status: "resolved" });
    updateAgentsMeta();
  };

  entry.timers.push(setTimeout(advance, (run.mode === "warm" ? 320 : 900) * SPEED));
  setStatus("agent running");
}

/* ------------------------------------------------------------------ */
/* Simulated tokens - deterministic per fingerprint                     */
/* ------------------------------------------------------------------ */

function seededRandom(text) {
  let seed = 2166136261;
  for (let i = 0; i < text.length; i += 1) seed = Math.imul(seed ^ text.charCodeAt(i), 16777619);
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function simulatedTokens(fingerprint, mode) {
  const rand = seededRandom(`${fingerprint}|${mode}`);
  const between = (min, max) => Math.round((min + rand() * (max - min)) / 10) * 10;
  if (mode === "warm") return { input: between(2000, 6000), output: between(400, 1200) };
  return { input: between(18000, 42000), output: between(2000, 6000) };
}

/* ------------------------------------------------------------------ */
/* Erreur                                                              */
/* ------------------------------------------------------------------ */

function addErrorCard(error, code) {
  const trace = randomId();
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

  setTimeout(() => createAgent(code, trace, error), 380);
}

/* ------------------------------------------------------------------ */
/* Real errors                                                          */
/* ------------------------------------------------------------------ */

/* The five error types tracked by the agent. Keep aligned with
   scripts/lib/errors.mjs (same code/message/stack -> same fingerprint). */
const SCENARIOS = [
  {
    code: "ERR_DB_POOL_EXHAUSTED",
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

function fireError() {
  const scenario = PINNED
    ? SCENARIOS.find((s) => s.code === PINNED) || SCENARIOS[0]
    : DEMO_WARM
      ? SCENARIOS[0]
      : SCENARIOS[state.scenario % SCENARIOS.length];
  state.scenario += 1;

  addRow("err", `ERROR · ${scenario.name} · ${scenario.code} · ${scenario.service}`);

  try {
    const error = new Error(scenario.message);
    error.name = scenario.name;
    error.stack = scenario.stack;
    throw error;
  } catch (error) {
    addErrorCard(error, scenario.code);
    console.error(`[${scenario.code}]`, error);
  }
}

window.addEventListener("error", (event) => {
  const error = event.error instanceof Error ? event.error : new Error(event.message || "Unknown error");
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

function integrateKafka() {
  addRow("inf", "kafka aiven · bootstrap agent-kafka · topic otel.logs");
  setStatus("kafka aiven en cours");
  setTimeout(() => {
    addRow("ok", "kafka aiven · producteur connecté · ack=all");
    setStatus("kafka aiven connecté");
  }, 520);
}

if (dbBtn) dbBtn.addEventListener("click", testDatabase);
if (kafkaBtn) kafkaBtn.addEventListener("click", integrateKafka);

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
