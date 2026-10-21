const list = document.getElementById("list");
const empty = document.getElementById("empty");
const countEl = document.getElementById("count");
const lastEl = document.getElementById("last");
const clockEl = document.getElementById("clock");
const fireBtn = document.getElementById("fire");
const copyBtn = document.getElementById("copy");
const clearBtn = document.getElementById("clear");

const state = {
  entries: [],
  seq: 0,
};

const SCENARIOS = [
  {
    code: "ERR_PAYLOAD_INVALID",
    label: "Lecture d'une propriété sur une valeur nulle",
    meta: "POST /api/checkout · status 500",
    run() {
      const payload = { orderId: null };
      return payload.order.items.length;
    },
  },
  {
    code: "ERR_UNDEFINED_CALL",
    label: "Appel d'une fonction inexistante",
    meta: "GET /api/session · status 502",
    run() {
      const session = {};
      return session.refreshToken();
    },
  },
  {
    code: "ERR_PARSE_FAILED",
    label: "JSON invalide reçu du serveur",
    meta: "GET /api/profile · status 200",
    run() {
      return JSON.parse('{"user": "gaia", }');
    },
  },
  {
    code: "ERR_RANGE_OVERFLOW",
    label: "Indice hors limites dans le tableau de logs",
    meta: "POST /api/logs/batch · status 500",
    run() {
      const buffer = [1, 2, 3];
      return buffer[12].toString();
    },
  },
];

const now = () =>
  new Date().toLocaleTimeString("fr-FR", { hour12: false });

const pad = (n) => String(n).padStart(3, "0");

function render() {
  countEl.textContent = state.entries.length;
  lastEl.textContent = state.entries.length
    ? state.entries[state.entries.length - 1].time
    : "—";
  empty.hidden = state.entries.length > 0;
}

function addEntry(level, message, meta, stack) {
  const entry = {
    id: `${Date.now()}-${state.entries.length}`,
    level,
    message,
    meta,
    stack,
    time: now(),
  };
  state.entries.push(entry);
  clockEl.textContent = entry.time;

  const row = document.createElement("article");
  row.className = `entry ${level}`;
  row.dataset.id = entry.id;

  const time = document.createElement("span");
  time.className = "time";
  time.textContent = entry.time;

  const main = document.createElement("div");
  main.className = "entry-main";

  const top = document.createElement("div");
  top.className = "entry-top";

  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = level === "error" ? "error" : level;

  const msg = document.createElement("span");
  msg.className = "msg";
  msg.textContent = entry.message;

  top.append(badge, msg);
  main.append(top);

  if (meta) {
    const metaEl = document.createElement("div");
    metaEl.className = "meta";
    metaEl.textContent = meta;
    main.append(metaEl);
  }

  if (stack) {
    const pre = document.createElement("pre");
    pre.className = "stack";
    pre.textContent = stack;
    main.append(pre);
  }

  row.append(time, main);
  list.prepend(row);
  render();
}

function fireError() {
  const index = state.seq % SCENARIOS.length;
  const scenario = SCENARIOS[index];
  const id = pad(++state.seq);
  const unhandled = state.seq % 3 === 0;

  if (unhandled) {
    addEntry(
      "warn",
      `ERR_${id} — promesse rejetée non gérée (${scenario.code})`,
      scenario.meta,
      `UnhandledPromiseRejection\n    at flushQueue (queue.js:41:9)\n    at tick (scheduler.js:18:5)\n    at app.js:${120 + index}`
    );
    Promise.reject(
      new Error(`${scenario.code} — ${scenario.label}`)
    );
    return;
  }

  try {
    scenario.run();
    addEntry("info", `ERR_${id} — aucune erreur levée`, scenario.meta);
  } catch (error) {
    addEntry(
      "error",
      `ERR_${id} — ${scenario.code} · ${error.message}`,
      `${scenario.meta} · ${error.name}`,
      error.stack
    );
    console.error(`[${scenario.code}]`, error);
  }
}

window.addEventListener("error", (event) => {
  addEntry(
    "error",
    `ERR_UNCAUGHT — ${event.message || "Erreur inconnue"}`,
    `${event.filename || location.pathname}:${event.lineno || 0}:${event.colno || 0}`,
    event.error && event.error.stack ? event.error.stack : null
  );
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  addEntry(
    "error",
    `ERR_UNHANDLED_REJECTION — ${reason && reason.message ? reason.message : reason}`,
    "promesse rejetée · handler global",
    reason && reason.stack ? reason.stack : null
  );
});

fireBtn.addEventListener("click", fireError);

copyBtn.addEventListener("click", async () => {
  if (!state.entries.length) return;
  const text = state.entries
    .map(
      (e) =>
        `[${e.time}] ${e.level.toUpperCase()} ${e.message}${
          e.meta ? ` (${e.meta})` : ""
        }${e.stack ? `\n${e.stack}` : ""}`
    )
    .join("\n\n");
  try {
    await navigator.clipboard.writeText(text);
    copyBtn.textContent = "Copié";
    setTimeout(() => (copyBtn.textContent = "Copier"), 1400);
  } catch {
    copyBtn.textContent = "Copie refusée";
    setTimeout(() => (copyBtn.textContent = "Copier"), 1400);
  }
});

clearBtn.addEventListener("click", () => {
  state.entries = [];
  state.seq = 0;
  list.querySelectorAll(".entry").forEach((node) => node.remove());
  clockEl.textContent = "--:--:--";
  render();
});

setInterval(() => {
  if (!state.entries.length) clockEl.textContent = now();
}, 1000);

addEntry(
  "info",
  "Session initialisée · handlers error et unhandledrejection actifs",
  `runtime navigateur · ${navigator.platform || "web"}`
);

const brandLogo = document.getElementById("brandLogo");
if (brandLogo) {
  const markEmpty = () => brandLogo.parentElement.classList.add("is-empty");
  brandLogo.addEventListener("error", markEmpty);
  if (brandLogo.complete && brandLogo.naturalWidth === 0) markEmpty();
}

const spotlight = document.querySelector(".spotlight");
if (spotlight && window.matchMedia("(pointer: fine)").matches) {
  let targetX = window.innerWidth * 0.5;
  let targetY = window.innerHeight * 0.22;
  let currentX = targetX;
  let currentY = targetY;
  let raf = null;

  const paint = () => {
    spotlight.style.setProperty("--mx", `${currentX}px`);
    spotlight.style.setProperty("--my", `${currentY}px`);
    currentX += (targetX - currentX) * 0.18;
    currentY += (targetY - currentY) * 0.18;
    if (Math.abs(targetX - currentX) > 0.5 || Math.abs(targetY - currentY) > 0.5) {
      raf = requestAnimationFrame(paint);
    } else {
      raf = null;
    }
  };

  window.addEventListener(
    "pointermove",
    (event) => {
      targetX = event.clientX;
      targetY = event.clientY;
      if (raf === null) raf = requestAnimationFrame(paint);
    },
    { passive: true }
  );

  document.documentElement.addEventListener("mouseleave", () => {
    targetX = window.innerWidth * 0.5;
    targetY = window.innerHeight * 0.22;
    if (raf === null) raf = requestAnimationFrame(paint);
  });
}
