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
const AGENT_STEPS = ["analyse", "correctif", "vérification", "prêt"];

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
  clockEl.textContent = new Date().toLocaleTimeString("fr-FR", { hour12: false });
}

function refreshCount() {
  const n = stream.childElementCount;
  countEl.textContent = `${n} ligne${n > 1 ? "s" : ""}`;
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
/* Panneau agents                                                      */
/* ------------------------------------------------------------------ */

function updateAgentsMeta() {
  const running = state.agents.filter((a) => a.state !== "done").length;
  agentCount.textContent = `${running} actif${running > 1 ? "s" : ""}`;
  agentCount.dataset.busy = running > 0 ? "true" : "false";
  agentsEmpty.hidden = state.agents.length > 0;
  agentFoot.textContent = `veille active · ${state.errors} erreur${state.errors > 1 ? "s" : ""}`;
}

function agentSlug(code) {
  return code.toLowerCase().replace(/^err_/, "").replace(/_/g, "-");
}

function createAgent(code, trace, error) {
  const slug = agentSlug(code);
  const card = document.createElement("article");
  card.className = "agent-card";
  card.dataset.state = "run";

  const top = document.createElement("div");
  top.className = "agent-top";

  const orb = document.createElement("span");
  orb.className = "agent-orb";
  orb.append(document.createElement("i"));

  const meta = document.createElement("div");
  meta.className = "agent-meta";

  const name = document.createElement("strong");
  name.className = "agent-name";
  name.textContent = `agent/fix-${slug}`;

  const sub = document.createElement("span");
  sub.className = "agent-code";
  sub.textContent = `${code} · ${trace}`;

  meta.append(name, sub);

  const stateEl = document.createElement("span");
  stateEl.className = "agent-state";
  stateEl.textContent = AGENT_STEPS[0];

  top.append(orb, meta, stateEl);

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

  const entry = { node: card, state: "run", timers: [] };
  state.agents.unshift(entry);

  while (state.agents.length > MAX_AGENTS) {
    const removed = state.agents.pop();
    removed.timers.forEach(clearTimeout);
    removed.node.remove();
  }

  segments[0].dataset.on = "run";
  updateAgentsMeta();
  addRow("inf", `agent/fix-${slug} créé · ${code} · ${trace}`);

  let step = 0;

  const advance = () => {
    segments[step].dataset.on = "true";
    step += 1;

    if (step >= AGENT_STEPS.length) {
      finish();
      return;
    }

    segments[step].dataset.on = "run";
    stateEl.textContent = AGENT_STEPS[step];
    entry.timers.push(setTimeout(advance, 900 + Math.random() * 700));
  };

  const finish = () => {
    entry.state = "done";
    card.dataset.state = "done";
    stateEl.textContent = "prêt";
    logTag.textContent = "ok";
    logText.textContent = `patch appliqué · tests 12/12 · ${code}`;
    addRow("ok", `patch appliqué · ${code} · tests 12/12`);
    setStatus("correctif prêt");
    updateAgentsMeta();
  };

  entry.timers.push(setTimeout(advance, 900));
  setStatus("agent en cours");
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
  copyBtn.textContent = "Copier la trace";

  actions.append(copyBtn);
  card.append(actions);

  copyBtn.addEventListener("click", async () => {
    const text = `[${code}] ${error.name}: ${error.message}\n${error.stack || ""}`;
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = "Copié";
    } catch {
      copyBtn.textContent = "Copie refusée";
    }
    setTimeout(() => (copyBtn.textContent = "Copier la trace"), 1500);
  });

  stream.append(card);
  scrollDown(true);
  refreshCount();
  setStatus("erreur détectée");
  updateAgentsMeta();

  setTimeout(() => {
    card.dataset.fresh = "false";
  }, 2000);

  setTimeout(() => createAgent(code, trace, error), 380);
}

/* ------------------------------------------------------------------ */
/* Erreurs réelles                                                     */
/* ------------------------------------------------------------------ */

const SCENARIOS = [
  {
    code: "ERR_PAYLOAD_INVALID",
    run() {
      const payload = { orderId: null };
      return payload.order.items.length;
    },
  },
  {
    code: "ERR_UNDEFINED_CALL",
    run() {
      const session = {};
      return session.refreshToken();
    },
  },
  {
    code: "ERR_PARSE_FAILED",
    run() {
      return JSON.parse('{"user": "gaia", }');
    },
  },
  {
    code: "ERR_RANGE_OVERFLOW",
    run() {
      const buffer = [1, 2, 3];
      return buffer[12].toString();
    },
  },
];

function fireError() {
  const scenario = SCENARIOS[state.scenario % SCENARIOS.length];
  state.scenario += 1;

  addRow("err", `POST /api/checkout → 500 · ${scenario.code}`);

  try {
    scenario.run();
    addRow("ok", `${scenario.code} · aucune exception`);
  } catch (error) {
    addErrorCard(error, scenario.code);
    console.error(`[${scenario.code}]`, error);
  }
}

window.addEventListener("error", (event) => {
  const error = event.error instanceof Error ? event.error : new Error(event.message || "Erreur inconnue");
  addErrorCard(error, "ERR_UNCAUGHT");
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  const error = reason instanceof Error ? reason : new Error(String(reason));
  addErrorCard(error, "ERR_UNHANDLED_REJECTION");
});

fireBtn.addEventListener("click", fireError);

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
  () => ["wrn", `slow query · ${pick(["orders", "sessions", "events"])} ${rnd(420, 1800)} ms (seuil 400 ms)`],
  () => ["dbg", `trace ${randomId(16)} · sampled=0.${rnd(1, 9)}`],
  () => ["inf", `WS /socket connected · clients=${rnd(1, 240)}`],
];

function feed() {
  const [level, text] = pick(FEED)();
  addRow(level, text);
  setTimeout(feed, Math.random() > 0.9 ? rnd(120, 380) : rnd(650, 1900));
}

addRow("inf", "session attachée · tail -f /var/log/app.log");
addRow("ok", "handlers error et unhandledrejection actifs");
updateAgentsMeta();
setTimeout(feed, 500);

const params = new URLSearchParams(window.location.search);
if (params.get("demo") === "error" || params.get("demo") === "agent") {
  setTimeout(fireError, 600);
}

setInterval(() => {
  clockEl.textContent = new Date().toLocaleTimeString("fr-FR", { hour12: false });
}, 1000);
