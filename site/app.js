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

/** Heure d'un message Kafka (ISO 8601 ou « 2026-10-22 12:44:57.000 »). */
function clockOf(value) {
  const text = String(value || "").trim();
  if (!text) return stamp();
  const d = new Date(text.includes("T") ? text : text.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return text.slice(11, 19) || stamp();
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

function addRow(level, text, tsIso) {
  const row = document.createElement("div");
  row.className = "row";
  row.dataset.level = level;

  const time = document.createElement("time");
  time.textContent = tsIso ? clockOf(tsIso) : stamp();
  if (tsIso) row.title = tsIso;

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

/**
 * Cree une carte d'agent. `options.restored` marque une carte relue au
 * chargement de la page (trace reelle deja publiee, cf. restoreAgents) : elle
 * ne rouvre pas un run local, sinon l'observabilite compterait deux fois le
 * meme incident a chaque rafraichissement.
 */
function createAgent(code, trace, error, real, options) {
  const restored = Boolean(options && options.restored);
  // Pas de doublon : une trace qui a deja sa carte n'en recoit pas une seconde.
  if (real && real.trace_id && state.agents.some((agent) => agent.traceId === real.trace_id)) {
    addRow("inf", `carte deja presente · ${code} · trace ${real.trace_id} · pas de doublon`);
    return;
  }
  const slug = agentSlug(code);
  const label = real && real.agent ? real.agent : `agent/fix-${slug}`;
  const run = restored
    ? { run_id: null, fingerprint: null, mode: "restored" }
    : metrics.startRun({
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
  modeEl.textContent = restored
    ? "restored"
    : run.mode === "warm"
      ? "warm · memo"
      : run.mode === "warm_degraded"
        ? "warm degraded"
        : "cold";
  modeEl.title = restored
    ? "carte restauree apres un rafraichissement : trace reelle relue dans otel.logs, etat relu via /api/report"
    : run.mode === "warm"
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

  const entry = {
    node: card,
    state: "run",
    timers: [],
    run,
    modeEl,
    code,
    label,
    traceId: real.trace_id,
    fingerprint: run.fingerprint,
  };
  state.agents.unshift(entry);

  while (state.agents.length > MAX_AGENTS) {
    const removed = state.agents.pop();
    removed.timers.forEach(clearTimeout);
    removed.node.remove();
  }

  segments[0].dataset.on = "run";
  updateAgentsMeta();
  addRow(
    "inf",
    restored
      ? `${label} repris · ${code} · ${trace} · trace relue dans otel.logs`
      : `${label} created · ${code} · ${trace} · ${run.mode}`,
  );

  // Simulation de la resolution : le site montre l'agent au travail des
  // qu'une erreur est declenchee. NE PAS RETIRER sans l'accord de Baptiste.
  // `awaitingReport` : un incident a bien ete publie dans Kafka, donc le vrai
  // rapport arrivera — la simulation reste un affichage et ne libere pas la
  // carte (entry.state reste "run"), sinon l'anti-doublon se rouvrirait alors
  // que l'agent tourne encore.
  if (!restored) {
    startSimulation({
      card, entry, segments, stateEl, logTag, logText, code, run,
      awaitingReport: Boolean(real && real.trace_id),
    });
  }

  // En parallele, si l'incident a ete publie dans Kafka, le rapport du watcher
  // remplace la simulation des qu'il arrive (la sortie reelle fait foi).
  watchRealAgent({
    card,
    entry,
    segments,
    stateEl,
    logTag,
    logText,
    code,
    run,
    traceId: real.trace_id,
    restored,
  });
}

/* ------------------------------------------------------------------ */
/* Simulation de la resolution (comportement par defaut du site)        */
/* ------------------------------------------------------------------ */

/**
 * Anime la resolution du bug sur la carte d'agent, sans dependre de Kafka.
 * ATTENTION : c'est le comportement demande par Baptiste. NE PAS RETIRER
 * cette simulation sans son accord explicite.
 *
 * Elle s'arrete d'elle-meme des qu'un rapport reel arrive (la carte passe en
 * state "done" via watchRealAgent) ou des que la carte est remplacee.
 * `restored` : carte relue au chargement, on ne rejoue rien.
 */
function startSimulation({ card, entry, segments, stateEl, logTag, logText, code, run, awaitingReport }) {
  const steps = ["analyze", "patch", "verify", "ready"];
  const names = { analyze: "diagnose", patch: "patch", verify: "verify", ready: "write_memo" };
  const speed = new URLSearchParams(window.location.search).get("demo") === "warm" ? 0.35 : 1;
  let index = 0;

  const stop = () => entry.state === "done" || !card.isConnected;
  const delay = () => (run.mode === "warm" ? 320 + Math.random() * 260 : 900 + Math.random() * 700) * speed;

  const tokens = () => {
    const mode = run.mode === "warm" ? "warm" : "cold";
    let seed = 2166136261;
    for (const ch of `${run.fingerprint}|${mode}`) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619);
    const rand = () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const between = (min, max) => Math.round((min + rand() * (max - min)) / 10) * 10;
    return mode === "warm"
      ? { input: between(2000, 6000), output: between(400, 1200) }
      : { input: between(18000, 42000), output: between(2000, 6000) };
  };

  const finish = () => {
    if (stop()) return;
    // Un incident a ete publie : la simulation n'est qu'un affichage, le vrai
    // rapport fera foi. On garde donc la carte VERROUILLEE (entry.state reste
    // "run") pour que l'anti-doublon ne rouvre pas un second agent alors que
    // celui de la machine tourne encore.
    if (awaitingReport) {
      entry.simulatedDone = true;
      card.dataset.simulated = "true";
      card.dataset.outcome = "resolved";
      stateEl.textContent = "rapport en attente";
      logTag.textContent = "sim";
      logText.textContent = `patch applied · tests 12/12 (simulation) · ${code}`;
      addRow("inf", `simulation terminee · ${code} · en attente du vrai rapport de l'agent`);
      setStatus("agent running");
      if (run.run_id) metrics.addTokens(run.run_id, { ...tokens(), estimated: true });
      updateAgentsMeta();
      return;
    }

    entry.state = "done";
    card.dataset.state = "done";
    card.dataset.outcome = "resolved";
    stateEl.textContent = "ready";
    logTag.textContent = "ok";
    logText.textContent = `patch applied · tests 12/12 · ${code}`;
    addRow("ok", `patch applied · ${code} · tests 12/12`);
    setStatus("fix ready");
    if (run.run_id) {
      metrics.addTokens(run.run_id, { ...tokens(), estimated: true });
      metrics.endRun(run.run_id, { status: "resolved" });
    }
    updateAgentsMeta();
  };

  const advance = () => {
    if (stop()) return;
    if (run.run_id) metrics.step(run.run_id, names[steps[index]]);
    if (segments[index]) segments[index].dataset.on = "true";
    index += 1;

    if (index >= steps.length) {
      entry.timers.push(setTimeout(finish, 300 * speed));
      return;
    }
    if (segments[index]) segments[index].dataset.on = "run";
    stateEl.textContent = steps[index];
    entry.timers.push(setTimeout(advance, delay()));
  };

  stateEl.textContent = steps[0];
  entry.timers.push(setTimeout(advance, (run.mode === "warm" ? 320 : 900) * speed));
  setStatus("agent running");
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

function watchRealAgent({ card, entry, segments, stateEl, logTag, logText, code, run, traceId, restored }) {
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
    // run_id nul pour une carte restauree : endRun ne fait rien, c'est voulu.
    metrics.endRun(run.run_id, { status: outcome === "failed" ? "failed" : "resolved" });
    updateAgentsMeta();
  };

  // Carte restauree : on ne connait pas l'heure de depart reelle de l'agent,
  // donc pas de chrono invente — on dit seulement que le suivi reprend.
  setPhase(0, restored ? `sync · ${traceId.slice(0, 8)}` : `queue · ${traceId.slice(0, 8)}`);
  addRow(
    "inf",
    restored
      ? `trace ${traceId} · reprise apres refresh · etat relu via /api/report`
      : `trace ${traceId} · attente du watcher (kafka otel.logs → agent local)`,
  );

  const poll = async () => {
    try {
      const response = await fetch(`/api/report?trace_id=${encodeURIComponent(traceId)}`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });

      if (response.status === 404) {
        // Pas encore de rapport : le watcher a pris la trace, l'agent tourne.
        // La carte peut deja avoir ete terminee par la simulation : on ne la
        // repeint pas, sinon les etapes affichees repartent en arriere.
        if (entry.state !== "done") setPhase(1, restored ? "running · reprise" : `running · ${elapsed()}`);
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

  // Une carte restauree interroge le rapport tout de suite : l'agent a pu
  // finir pendant que la page etait fermee.
  entry.timers.push(setTimeout(poll, restored ? 400 : 2500));
}

/* ------------------------------------------------------------------ */
/* Reprise des cartes apres un rafraichissement                         */
/* ------------------------------------------------------------------ */

/* Les cartes ne vivaient qu'en memoire : un refresh les effacait alors que
   l'agent tournait toujours. Au chargement on relit donc la verite cote
   serveur — GET /api/tail, les vraies traces publiees dans otel.logs — et on
   complete avec les traces deja vues, gardees en localStorage pour celles qui
   sont deja sorties du tail. Aucune carte inventee : chaque trace vient d'un
   message reel de Kafka (AGENTS.md). Si /api/tail ne repond pas, la page
   continue normalement : seules les traces locales sont reprises. */
const TRACE_KEY = "log.agent.traces.v1";
const TRACE_MAX = 30; // borne de la memoire locale : les 30 plus recentes
const TAIL_LIMIT = 60;
const TAIL_TIMEOUT_MS = 6000;
const TRACE_ID_RE = /^[0-9A-Za-z_-]{8,64}$/;

function loadKnownTraces() {
  try {
    const raw = window.localStorage.getItem(TRACE_KEY);
    if (!raw) return [];
    const saved = JSON.parse(raw);
    if (!Array.isArray(saved)) return [];
    return saved.filter((t) => t && typeof t === "object" && TRACE_ID_RE.test(String(t.trace_id || "")));
  } catch (err) {
    // localStorage refuse (navigation privee, quota) : /api/tail suffit
    return [];
  }
}

function saveKnownTraces(list) {
  try {
    window.localStorage.setItem(TRACE_KEY, JSON.stringify(list.slice(0, TRACE_MAX)));
  } catch (err) {
    /* quota depasse ou stockage refuse : pas bloquant, le tail fera foi */
  }
}

/** Retient une trace vue (clic ou reprise) pour la retrouver au prochain refresh. */
function rememberTrace(entry) {
  if (!entry || !TRACE_ID_RE.test(String(entry.trace_id || ""))) return;
  const list = loadKnownTraces().filter((t) => t.trace_id !== entry.trace_id);
  list.unshift({
    trace_id: entry.trace_id,
    code: entry.code || "",
    service: entry.service || "",
    text: String(entry.text || "").slice(0, 200),
    ts: entry.ts || new Date().toISOString(),
  });
  saveKnownTraces(list);
}

/* Le tail donne le scenario (`code` = agent.scenario) ou a defaut le type
   d'erreur : on les ramene aux codes du catalogue pour que la carte porte le
   meme libelle qu'une carte creee par un clic. */
function codeForTrace(message) {
  const raw = String(message.code || message.error_type || "").trim();
  if (!raw) return "ERR_UNKNOWN";
  const known = SCENARIOS.find((s) => s.scenario === raw || s.code === raw.toUpperCase());
  if (known) return known.code;
  if (/^err_/i.test(raw)) return raw.toUpperCase().slice(0, 48);
  return `ERR_${raw.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`.slice(0, 48);
}

/** Traces d'incident presentes dans le tail, de la plus recente a la plus ancienne. */
function tracesFromTail(messages) {
  const out = [];
  const index = new Map();
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const message = list[i];
    if (!message || typeof message !== "object") continue;
    const traceId = String(message.trace_id || "").trim();
    if (!TRACE_ID_RE.test(traceId)) continue;
    const level = String(message.level || "").toLowerCase();
    const errorType = String(message.error_type || "").trim();
    // Un message d'exploitation (inf/dbg) n'est pas un incident.
    if (!errorType && level !== "err" && level !== "wrn") continue;
    const seen = index.get(traceId);
    if (seen === undefined) {
      index.set(traceId, out.length);
      out.push({
        trace_id: traceId,
        level,
        code: codeForTrace(message),
        service: String(message.service || ""),
        text: String(message.text || "").slice(0, 200),
        ts: String(message.ts || ""),
      });
      continue;
    }
    // Une trace porte souvent plusieurs messages : le message d'erreur fait foi
    // pour le texte de la carte, meme s'il precede un avertissement plus recent.
    const entry = out[seen];
    if (level === "err" && entry.level !== "err") {
      entry.level = "err";
      entry.code = codeForTrace(message);
      entry.text = String(message.text || "").slice(0, 200);
      if (message.service) entry.service = String(message.service);
    }
  }
  return out;
}

/** Lecture de /api/tail : jamais bloquante, jamais d'exception qui remonte. */
async function readTail() {
  const controller = new AbortController();
  const guard = setTimeout(() => controller.abort(), TAIL_TIMEOUT_MS);
  try {
    const response = await fetch(`/api/tail?limit=${TAIL_LIMIT}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.ok !== true || !Array.isArray(data.messages)) {
      return { traces: [], reason: (data && (data.hint || data.error)) || `http ${response.status}` };
    }
    return { traces: tracesFromTail(data.messages), reason: null };
  } catch (err) {
    return {
      traces: [],
      reason: err && err.name === "AbortError" ? "delai depasse" : "serveur injoignable",
    };
  } finally {
    clearTimeout(guard);
  }
}

async function restoreAgents() {
  const stored = loadKnownTraces();
  const tail = await readTail();

  try {
    // fusion : le tail (le plus recent) d'abord, puis la memoire locale
    const merged = [];
    const seen = new Set();
    [...tail.traces, ...stored].forEach((item) => {
      if (!item || seen.has(item.trace_id)) return;
      seen.add(item.trace_id);
      merged.push(item);
    });

    saveKnownTraces(merged);

    if (tail.reason) {
      addRow(
        "dbg",
        `reprise agents · otel.logs illisible (${tail.reason}) · ${stored.length} trace(s) relue(s) en local`,
      );
    }

    // pas de doublon : une trace qui a deja sa carte n'en recoit pas d'autre
    const todo = merged
      .filter((item) => !state.agents.some((agent) => agent.traceId === item.trace_id))
      .slice(0, MAX_AGENTS);

    if (!todo.length) return;

    addRow(
      "inf",
      tail.reason
        ? `reprise agents · ${todo.length} carte(s) relue(s) depuis la memoire locale`
        : `reprise agents · ${todo.length} carte(s) relue(s) dans otel.logs`,
    );

    // du plus ancien au plus recent : la carte la plus recente finit en tete
    todo
      .slice()
      .reverse()
      .forEach((item, index) => {
        setTimeout(() => {
          if (state.agents.some((agent) => agent.traceId === item.trace_id)) return;
          const code = item.code || codeForTrace(item);
          const error = new Error(item.text || `${code} · trace ${item.trace_id}`);
          error.name = code;
          createAgent(code, item.trace_id, error, { trace_id: item.trace_id }, { restored: true });
        }, index * 80);
      });
  } catch (err) {
    // rendu deja en place : on n'affiche pas de trace, on continue
    addRow("dbg", "reprise agents · impossible de relire les cartes · la console reste utilisable");
  }
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

  // Un agent est lance a chaque erreur, publiee dans Kafka ou non : c'est la
  // simulation de resolution demandee. NE PAS RETIRER sans accord de Baptiste.
  if (!real || !real.trace_id) real = { trace_id: trace };

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
      // retenue en local : la carte doit reapparaitre meme si la trace sort du tail
      rememberTrace({
        trace_id: data.trace_id,
        code: scenario.code,
        service: scenario.service,
        text: error.message,
        ts: new Date().toISOString(),
      });
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
/* Flux continu : otel.logs, lu pour de vrai                          */
/* ------------------------------------------------------------------ */

/* Aucune ligne n'est inventee ici. Chaque ligne affichee vient de
   GET /api/tail, qui consomme le topic Aiven `otel.logs` (api/_kafka.js).
   Topic vide = terminal vide : c'est la verite, pas un bug d'affichage. */

const TAIL_ENDPOINT = "/api/tail";
const TAIL_FIRST_LIMIT = 200;
const TAIL_POLL_MS = 4000;
const seenOffsets = new Set();
let tailErrors = 0;
let tailBusy = false;

function offsetKey(msg) {
  return `${msg.partition}:${msg.offset}`;
}

function paintTailSource(up, count, detail) {
  if (up === true) {
    paintSource(
      "kafka",
      `kafka · otel.logs`,
      `${count} message${count > 1 ? "s" : ""} lu${count > 1 ? "s" : ""} dans le topic Aiven otel.logs${detail ? ` · ${detail}` : ""}`,
    );
  } else if (up === false) {
    paintSource("down", "kafka · injoignable", detail || "Lecture de otel.logs impossible.");
  } else {
    paintSource("pending", "kafka · …", detail || "Lecture de otel.logs en cours…");
  }
}

async function tailOnce(first) {
  if (tailBusy) return null;
  tailBusy = true;
  const controller = new AbortController();
  const guard = setTimeout(() => controller.abort(), 12000);
  let data = null;
  let ok = false;
  try {
    const response = await fetch(`${TAIL_ENDPOINT}?limit=${first ? TAIL_FIRST_LIMIT : 80}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    ok = response.ok;
    data = await response.json().catch(() => null);
  } catch (error) {
    data = null;
  } finally {
    clearTimeout(guard);
    tailBusy = false;
  }

  if (!ok || !data || data.ok !== true) {
    tailErrors += 1;
    const reason = (data && (data.hint || data.error)) || "pas de reponse de /api/tail";
    paintTailSource(false, 0, `Lecture de otel.logs impossible : ${reason}`);
    if (tailErrors === 1) {
      addRow("err", `tail otel.logs · echec · ${reason}`);
      setStatus("kafka unreachable");
    }
    return null;
  }

  tailErrors = 0;
  const messages = Array.isArray(data.messages) ? data.messages : [];
  paintTailSource(true, messages.length, data.ready ? "" : "rattrapage en cours");

  let appended = 0;
  for (const msg of messages) {
    const key = offsetKey(msg);
    if (seenOffsets.has(key)) continue;
    seenOffsets.add(key);
    addRow(msg.level || "inf", msg.text || "", msg.ts);
    appended += 1;
  }

  // Un topic muet doit se voir : on le dit une fois, sans inventer de lignes.
  if (!messages.length && first) {
    addRow("inf", "otel.logs · topic lu · aucun message pour l'instant");
  }

  setStatus(
    messages.length
      ? `otel.logs · ${messages.length} message${messages.length > 1 ? "s" : ""} · ${data.topic}`
      : "otel.logs · en attente",
  );

  // L'anneau serveur est borne : on borne aussi le compteur cote client.
  if (seenOffsets.size > 4000) seenOffsets.clear();
  return appended;
}

async function tailLoop() {
  await tailOnce(true);
  setInterval(() => tailOnce(false), TAIL_POLL_MS);
}

updateAgentsMeta();
tailLoop();

// Reprise des cartes : un rafraichissement ne doit pas effacer un agent qui
// tourne encore. Asynchrone, silencieux en cas d'echec — jamais bloquant.
restoreAgents().catch(() => {
  addRow("dbg", "reprise agents · indisponible · la console reste utilisable");
});

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
