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

function stamp(iso) {
  const d = iso ? new Date(iso) : new Date();
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

function addRow(level, text, iso) {
  const row = document.createElement("div");
  row.className = "row";
  row.dataset.level = level;

  const time = document.createElement("time");
  time.textContent = stamp(iso);

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

  const diag = diagnosticFor(code, error);

  const actions = document.createElement("div");
  actions.className = "agent-actions";
  actions.hidden = true;

  const diagBtn = document.createElement("button");
  diagBtn.type = "button";
  diagBtn.className = "agent-act agent-act-diag";
  diagBtn.textContent = "diagnostic";

  const yesBtn = document.createElement("button");
  yesBtn.type = "button";
  yesBtn.className = "agent-act agent-act-yes";
  yesBtn.textContent = "OUI";

  const noBtn = document.createElement("button");
  noBtn.type = "button";
  noBtn.className = "agent-act agent-act-no";
  noBtn.textContent = "NON";

  const decisionEl = document.createElement("span");
  decisionEl.className = "agent-decision";
  decisionEl.hidden = true;

  actions.append(diagBtn, yesBtn, noBtn, decisionEl);

  card.append(top, bars, log, actions);
  agentList.prepend(card);

  const entry = {
    node: card,
    state: "run",
    timers: [],
    run,
    modeEl,
    code,
    label,
    trace,
    diag,
    decision: null,
  };
  state.agents.unshift(entry);

  const decide = (decision) => {
    if (entry.decision) return;
    entry.decision = decision;
    const accepted = decision === "accept";
    card.dataset.decision = accepted ? "accepted" : "rejected";
    diagBtn.disabled = true;
    yesBtn.disabled = true;
    noBtn.disabled = true;
    decisionEl.hidden = false;
    decisionEl.dataset.decision = card.dataset.decision;
    decisionEl.textContent = accepted ? "patch accepté" : "patch refusé";
    addRow(accepted ? "ok" : "wrn", `patch ${accepted ? "accepté" : "refusé"} · ${code} · ${trace}`);
    setStatus(accepted ? "patch accepté" : "patch refusé");
    document.dispatchEvent(
      new CustomEvent("log:agent-decision", {
        detail: { code, trace, runId: run.run_id, decision, patch: diag.patch },
      }),
    );
    closeDiagnostic();
  };

  entry.decide = decide;

  diagBtn.addEventListener("click", () => openDiagnostic(entry));
  yesBtn.addEventListener("click", () => decide("accept"));
  noBtn.addEventListener("click", () => decide("reject"));

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

    if (step === 1) {
      actions.hidden = false;
      addRow("inf", `diagnostic ready · ${code} · ${trace}`);
    }

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
/* Tracked errors: single source = lib/catalog.json (BaptisteFaisy/Log).
   The site only names the error_type; the API builds the message and stack. */
const ERROR_TYPES = [
  "db_pool_exhausted",
  "db_connection_timeout",
  "kafka_broker_unreachable",
  "oom",
  "disk_full",
];

const TYPE_BY_CODE = {
  ERR_DB_POOL_EXHAUSTED: "db_pool_exhausted",
  ERR_PG_TIMEOUT_5432: "db_connection_timeout",
  ERR_KAFKA_UNREACHABLE: "kafka_broker_unreachable",
  ERR_OOM_HEAP: "oom",
  ERR_DISK_FULL: "disk_full",
};

const DIAGNOSTICS = {
  ERR_DB_POOL_EXHAUSTED: {
    confidence: 0.92,
    cause:
      "Le pool Hikari est saturé : 20/20 connexions actives, 17 requêtes en attente depuis plus de 30 s. OrderRepository.find ouvre une connexion sans la fermer quand la requête échoue, d'où la fuite progressive.",
    evidence: [
      "hikari · total=20 active=20 idle=0 waiting=17",
      "OrderRepository.java:88 · getConnection() hors try-with-resources",
      "checkout p99 · 30 000 ms (timeout du pool)",
    ],
    patch: {
      title: "order-repository · try-with-resources + pool 20 → 40",
      lines: [
        "- Connection c = dataSource.getConnection();",
        "+ try (Connection c = dataSource.getConnection();",
        "+      PreparedStatement ps = c.prepareStatement(SQL)) {",
        "hikari.maximum-pool-size: 40",
        "hikari.connection-timeout: 10000",
      ],
    },
  },
  ERR_PG_TIMEOUT_5432: {
    confidence: 0.88,
    cause:
      "Le port 5432 ne répond plus depuis orders-api : les paquets SYN partent sans réponse jusqu'au timeout. La règle entrante du security group a disparu après le dernier apply Terraform.",
    evidence: [
      "orders-api → 10.0.0.12:5432 · timeout après 30 s",
      "security group · aucune règle 5432/tcp depuis le subnet applicatif",
      "dernier apply Terraform · 11:42, règle absente du plan",
    ],
    patch: {
      title: "security-group · réouvrir 5432/tcp + healthcheck",
      lines: [
        "+ ingress 5432/tcp from 10.0.0.0/16",
        "+ healthcheck: pg_isready -h db.internal -p 5432",
        "+ retry backoff 3 × 500 ms sur la connexion",
        "terraform plan · vérifier l'absence de dérive",
      ],
    },
  },
  ERR_KAFKA_UNREACHABLE: {
    confidence: 0.9,
    cause:
      "Aucun broker joignable : le DNS résout kafka vers 10.0.0.31, mais la connexion sur 9092 est refusée. advertised.listeners annonce localhost, donc le producer reçoit une adresse inutilisable.",
    evidence: [
      "producer → kafka:9092 · connexion refusée",
      "advertised.listeners=PLAINTEXT://localhost:9092",
      "metadata indisponible après 60 000 ms · topic orders.created",
    ],
    patch: {
      title: "broker kafka-1687d005 · advertised.listeners + restart",
      lines: [
        "- advertised.listeners=PLAINTEXT://localhost:9092",
        "+ advertised.listeners=PLAINTEXT://kafka-1687d005:9092",
        "+ restart broker · vérifier le listener 9092",
        "+ test producer ack=all sur otel.logs",
      ],
    },
  },
  ERR_OOM_HEAP: {
    confidence: 0.86,
    cause:
      "Le heap est saturé : CsvExporter.export charge le rapport complet en mémoire avant écriture (ArrayList de 1,2 M lignes) alors que la JVM est limitée à 512 Mo.",
    evidence: [
      "java.lang.OutOfMemoryError: Java heap space",
      "CsvExporter.java:74 · Arrays.copyOf pendant la croissance de la liste",
      "heap 512 Mo · occupation 99 % avant le crash",
    ],
    patch: {
      title: "csv-exporter · écriture en flux par lots",
      lines: [
        "- List<Row> rows = repository.findAll();",
        "+ repository.streamAll().forEach(this::writeRow);",
        "+ flush tous les 5 000 lignes",
        "-XX:MaxRAMPercentage=70",
        "alerte heap > 85 %",
      ],
    },
  },
  ERR_DISK_FULL: {
    confidence: 0.94,
    cause:
      "Le volume de données est plein : 38 Go de WAL non archivés car l'archive_command échoue depuis 6 h, ce qui bloque aussi les checkpoints.",
    evidence: [
      "No space left on device · /var/lib/app/telemetry-buffer",
      "pg_wal · 38 Go non archivés",
      "archive_command en échec depuis 6 h",
    ],
    patch: {
      title: "postgres · purger pg_wal + réparer l'archivage",
      lines: [
        "+ archiver les WAL en attente puis purger pg_wal",
        "+ réparer archive_command (cible injoignable)",
        "+ alerte disque > 80 %",
        "+ vérifier autovacuum et la rétention des logs",
      ],
    },
  },
};

function diagnosticFor(code, error) {
  if (DIAGNOSTICS[code]) return DIAGNOSTICS[code];
  return {
    confidence: 0.55,
    cause: `Signature non répertoriée (${code}). L'agent a isolé l'événement, mais aucune méthode de résolution vérifiée n'est en mémoire pour ce fingerprint.`,
    evidence: [
      error && error.message ? error.message : "message indisponible",
      "aucune résolution enregistrée dans error_resolutions",
    ],
    patch: { title: "diagnostic seul · aucun patch automatique", lines: ["# intervention humaine requise"] },
  };
}

let diagModal = null;
let diagReturnFocus = null;

function ensureDiagnosticModal() {
  if (diagModal) return diagModal;

  const overlay = document.createElement("div");
  overlay.className = "diag-overlay";
  overlay.hidden = true;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "diagTitle");

  const panel = document.createElement("div");
  panel.className = "diag-panel";

  const head = document.createElement("header");
  head.className = "diag-head";

  const titles = document.createElement("div");
  titles.className = "diag-titles";

  const kicker = document.createElement("span");
  kicker.className = "diag-kicker";
  kicker.textContent = "agent diagnostic";

  const title = document.createElement("h2");
  title.className = "diag-title";
  title.id = "diagTitle";

  titles.append(kicker, title);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "diag-close";
  closeBtn.setAttribute("aria-label", "fermer le diagnostic");
  closeBtn.textContent = "×";

  head.append(titles, closeBtn);

  const body = document.createElement("div");
  body.className = "diag-body";

  const meta = document.createElement("dl");
  meta.className = "diag-meta";

  const causeBlock = document.createElement("section");
  causeBlock.className = "diag-block";
  const causeTitle = document.createElement("h3");
  causeTitle.textContent = "cause racine";
  const cause = document.createElement("p");
  cause.className = "diag-cause";
  causeBlock.append(causeTitle, cause);

  const proofBlock = document.createElement("section");
  proofBlock.className = "diag-block";
  const proofTitle = document.createElement("h3");
  proofTitle.textContent = "preuves";
  const proofs = document.createElement("ul");
  proofs.className = "diag-proofs";
  proofBlock.append(proofTitle, proofs);

  const patchBlock = document.createElement("section");
  patchBlock.className = "diag-block";
  const patchTitle = document.createElement("h3");
  patchTitle.textContent = "patch proposé";
  const patchName = document.createElement("p");
  patchName.className = "diag-patch-name";
  const patchCode = document.createElement("pre");
  patchCode.className = "diag-patch";
  patchBlock.append(patchTitle, patchName, patchCode);

  body.append(meta, causeBlock, proofBlock, patchBlock);

  const foot = document.createElement("footer");
  foot.className = "diag-foot";

  const hint = document.createElement("span");
  hint.className = "diag-hint";
  hint.textContent = "appliquer le patch proposé ?";

  const footActions = document.createElement("div");
  footActions.className = "diag-foot-actions";

  const yes = document.createElement("button");
  yes.type = "button";
  yes.className = "diag-btn diag-btn-yes";
  yes.textContent = "OUI";

  const no = document.createElement("button");
  no.type = "button";
  no.className = "diag-btn diag-btn-no";
  no.textContent = "NON";

  footActions.append(yes, no);
  foot.append(hint, footActions);

  panel.append(head, body, foot);
  overlay.append(panel);
  document.body.append(overlay);

  closeBtn.addEventListener("click", closeDiagnostic);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeDiagnostic();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && diagModal && !diagModal.overlay.hidden) closeDiagnostic();
  });

  diagModal = { overlay, title, meta, cause, proofs, patchName, patchCode, yes, no, closeBtn, current: null };
  return diagModal;
}

function openDiagnostic(entry) {
  const modal = ensureDiagnosticModal();
  modal.current = entry;
  diagReturnFocus = document.activeElement;

  modal.title.textContent = entry.label.replace(/^agent\//, "");

  const rows = [
    ["agent", entry.label],
    ["code", entry.code],
    ["trace", entry.trace],
    ["mode", entry.run.mode],
    ["confiance", `${Math.round(entry.diag.confidence * 100)} %`],
  ];

  modal.meta.replaceChildren(
    ...rows.flatMap(([key, value]) => {
      const dt = document.createElement("dt");
      dt.textContent = key;
      const dd = document.createElement("dd");
      dd.textContent = value;
      return [dt, dd];
    }),
  );

  modal.cause.textContent = entry.diag.cause;

  modal.proofs.replaceChildren(
    ...entry.diag.evidence.map((line) => {
      const li = document.createElement("li");
      li.textContent = line;
      return li;
    }),
  );

  modal.patchName.textContent = entry.diag.patch.title;
  modal.patchCode.textContent = entry.diag.patch.lines.join("\n");

  modal.yes.disabled = Boolean(entry.decision);
  modal.no.disabled = Boolean(entry.decision);
  modal.yes.onclick = () => entry.decide("accept");
  modal.no.onclick = () => entry.decide("reject");

  modal.overlay.hidden = false;
  document.body.classList.add("diag-open");
  modal.yes.focus();
}

function closeDiagnostic() {
  if (!diagModal || diagModal.overlay.hidden) return;
  diagModal.overlay.hidden = true;
  diagModal.current = null;
  document.body.classList.remove("diag-open");
  if (diagReturnFocus && typeof diagReturnFocus.focus === "function") diagReturnFocus.focus();
  diagReturnFocus = null;
}

function nextScenario() {
  if (PINNED) return TYPE_BY_CODE[PINNED] || PINNED;
  if (DEMO_WARM) return ERROR_TYPES[0];
  return ERROR_TYPES[state.scenario % ERROR_TYPES.length];
}

/* ------------------------------------------------------------------ */
/* Kafka -> PostgreSQL -> site                                         */
/* ------------------------------------------------------------------ */


const API = "/api";
const POLL_MS = 2000;
const MAX_BATCH = 200;
const INITIAL_ROWS = 20;

let cursor = 0;
let firstPoll = true;
const seen = new Set();

async function fireError() {
  if (fireBtn.disabled) return;
  fireBtn.disabled = true;

  const errorType = nextScenario();
  state.scenario += 1;
  setStatus("publishing to kafka");

  try {
    const response = await fetch(`${API}/logs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error_type: errorType, severity: "err" }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    setStatus("published to kafka");
    setTimeout(pollLogs, 300);
  } catch (error) {
    setStatus(`publish failed: ${error.message}`);
  } finally {
    fireBtn.disabled = false;
  }
}

function errorFromLog(log) {
  const payload = log.payload || {};
  const error = new Error(log.message);
  error.name = payload.name || log.code;
  error.stack = payload.stack || "";
  return error;
}

function showLog(log, live) {
  const service = log.payload && log.payload.service ? `${log.payload.service} · ` : "";
  addRow(log.severity, `${service}${log.code} · ${log.message}`, log.occurred_at);
  if (live && log.severity === "err") addErrorCard(errorFromLog(log), log.code);
}

async function pollLogs() {
  const query = firstPoll
    ? `tail=1&limit=${INITIAL_ROWS}`
    : `after=${cursor}&limit=${MAX_BATCH}`;

  try {
    const response = await fetch(`${API}/logs?${query}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();

    if (firstPoll) {
      data.logs.forEach((log) => {
        seen.add(log.id);
        showLog(log, false);
      });
      cursor = data.cursor || 0;
      firstPoll = false;
      addRow("ok", `connected - ${data.total} log(s) - topic ${data.topic}`, new Date().toISOString());
    } else {
      data.logs.forEach((log) => {
        if (seen.has(log.id)) return;
        seen.add(log.id);
        showLog(log, true);
      });
      if (data.cursor > cursor) cursor = data.cursor;
    }

    setStatus("kafka -> postgres -> site");
  } catch (error) {
    setStatus(`api offline: ${error.message}`);
  }
  setTimeout(pollLogs, POLL_MS);
}
fireBtn.addEventListener("click", fireError);

document.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.target === document.body) {
    event.preventDefault();
    fireError();
  }
});

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

(async () => {
  await (metrics && metrics.hydrate ? metrics.hydrate().catch(() => false) : false);
  updateAgentsMeta();
  addRow("inf", "session attached · tail -f kafka/otel.logs");
  pollLogs();

  if (params.get("demo") === "error" || params.get("demo") === "agent") {
    setTimeout(fireError, 800);
  }

  if (DEMO_WARM) {
    for (let i = 0; i < 3; i += 1) setTimeout(fireError, 800 + i * 2600);
  }

  setInterval(() => {
    clockEl.textContent = new Date().toLocaleTimeString("en-GB", { hour12: false });
  }, 1000);
})();
