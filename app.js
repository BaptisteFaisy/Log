const stream = document.getElementById("stream");
const countEl = document.getElementById("count");
const statusEl = document.getElementById("status");
const clockEl = document.getElementById("clock");
const fireBtn = document.getElementById("fire");

const MAX_ROWS = 160;

const state = {
  rows: 0,
  scenario: 0,
  trace: 0,
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

  state.rows += 1;
  stream.append(row);

  while (stream.childElementCount > MAX_ROWS) {
    stream.firstElementChild.remove();
  }

  scrollDown(false);
  refreshCount();
  setStatus(level === "err" ? "erreur" : "flux actif");
  return row;
}

/* ------------------------------------------------------------------ */
/* Erreur                                                              */
/* ------------------------------------------------------------------ */

function addErrorCard(error, code) {
  const trace = randomId();
  state.trace = trace;

  const card = document.createElement("article");
  card.className = "card card-error";

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

  const agentBtn = document.createElement("button");
  agentBtn.type = "button";
  agentBtn.className = "btn btn-sm btn-primary";
  agentBtn.textContent = "Créer un agent";

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "btn btn-sm btn-ghost";
  copyBtn.textContent = "Copier la trace";

  actions.append(agentBtn, copyBtn);
  card.append(actions);

  agentBtn.addEventListener("click", () => {
    agentBtn.remove();
    addAgentCard(trace, code);
  });

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
  state.rows += 1;
  scrollDown(true);
  refreshCount();
  setStatus("erreur · agent disponible");
}

/* ------------------------------------------------------------------ */
/* Agent                                                               */
/* ------------------------------------------------------------------ */

const STEPS = [
  "Lecture de la pile d'appels",
  "Reproduction en sandbox",
  "Génération du correctif",
  "Vérification des tests",
];

function addAgentCard(trace, code) {
  const card = document.createElement("article");
  card.className = "card card-agent";

  const head = document.createElement("div");
  head.className = "card-head";

  const orb = document.createElement("span");
  orb.className = "orb";

  const titles = document.createElement("div");
  titles.className = "card-titles";
  const name = document.createElement("strong");
  name.textContent = "agent/fix-null-payload";
  const sub = document.createElement("span");
  sub.className = "card-sub";
  sub.textContent = `créé en 0,4 s · ${code} · ${trace}`;
  titles.append(name, sub);

  const tag = document.createElement("span");
  tag.className = "tag";
  tag.dataset.state = "run";
  tag.textContent = "en cours";

  head.append(orb, titles, tag);

  const list = document.createElement("ol");
  list.className = "steps";

  const items = STEPS.map((label) => {
    const li = document.createElement("li");
    li.dataset.state = "wait";
    const bullet = document.createElement("span");
    bullet.className = "bullet";
    bullet.textContent = "✓";
    li.append(bullet, document.createTextNode(label));
    list.append(li);
    return li;
  });

  const diff = document.createElement("pre");
  diff.className = "diff";
  diff.hidden = true;
  diff.innerHTML =
    '<span class="del">- const total = payload.order.items.length;</span>\n' +
    '<span class="add">+ const total = payload.order?.items?.length ?? 0;</span>';

  const actions = document.createElement("div");
  actions.className = "card-actions";

  const viewBtn = document.createElement("button");
  viewBtn.type = "button";
  viewBtn.className = "btn btn-sm btn-primary";
  viewBtn.textContent = "Voir le correctif";
  viewBtn.disabled = true;

  const stopBtn = document.createElement("button");
  stopBtn.type = "button";
  stopBtn.className = "btn btn-sm btn-ghost";
  stopBtn.textContent = "Arrêter";

  actions.append(viewBtn, stopBtn);

  card.append(head, list, diff, actions);
  stream.append(card);
  state.rows += 1;
  scrollDown(true);
  refreshCount();
  setStatus("agent en cours");

  let index = 0;
  let timer = null;
  let stopped = false;

  const runStep = () => {
    if (stopped) return;

    if (index > 0) items[index - 1].dataset.state = "done";

    if (index >= items.length) {
      tag.dataset.state = "done";
      tag.textContent = "prêt";
      viewBtn.disabled = false;
      diff.hidden = false;
      setStatus("correctif prêt");
      scrollDown(true);
      return;
    }

    items[index].dataset.state = "run";
    scrollDown(false);
    index += 1;
    timer = setTimeout(runStep, 700 + Math.random() * 600);
  };

  stopBtn.addEventListener("click", () => {
    if (stopped) {
      card.remove();
      return;
    }
    stopped = true;
    clearTimeout(timer);
    tag.dataset.state = "wait";
    tag.textContent = "arrêté";
    items.forEach((li) => {
      if (li.dataset.state === "run") li.dataset.state = "wait";
    });
    stopBtn.textContent = "Fermer";
    setStatus("agent arrêté");
  });

  viewBtn.addEventListener("click", () => {
    viewBtn.textContent = "Correctif appliqué";
    viewBtn.disabled = true;
    addRow("ok", `patch appliqué · ${code} · tests 12/12`);
    setStatus("corrigé");
  });

  timer = setTimeout(runStep, 500);
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

let feedTimer = null;

function feed() {
  const [level, text] = pick(FEED)();
  addRow(level, text);
  feedTimer = setTimeout(feed, Math.random() > 0.9 ? rnd(120, 380) : rnd(650, 1900));
}

addRow("inf", "session attachée · tail -f /var/log/app.log");
addRow("ok", "handlers error et unhandledrejection actifs");
setTimeout(feed, 500);

const params = new URLSearchParams(window.location.search);
if (params.get("demo") === "error") {
  setTimeout(fireError, 700);
} else if (params.get("demo") === "agent") {
  setTimeout(() => {
    fireError();
    setTimeout(() => {
      const btn = stream.querySelector(".card-error .btn-primary");
      if (btn) btn.click();
    }, 500);
  }, 500);
}

setInterval(() => {
  clockEl.textContent = new Date().toLocaleTimeString("fr-FR", { hour12: false });
}, 1000);
