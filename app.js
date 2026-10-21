const body = document.querySelector(".terminal-body");
const stream = document.getElementById("stream");
const pinned = document.getElementById("pinned");
const pinnedList = document.getElementById("pinnedList");
const pinCount = document.getElementById("pinCount");
const unpinBtn = document.getElementById("unpin");
const countEl = document.getElementById("count");
const lastEl = document.getElementById("last");
const clockEl = document.getElementById("clock");
const fireBtn = document.getElementById("fire");

const MAX_LINES = 400;
const MAX_PINNED = 20;

const state = {
  lines: 0,
  pinned: 0,
  seq: 0,
  scenario: 0,
};

const GLYPHS = {
  debug: "·",
  info: "›",
  success: "✓",
  warn: "!",
  error: "✕",
  system: "❯",
};

const pad = (n, size = 2) => String(n).padStart(size, "0");

function stamp() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function atBottom() {
  return body.scrollHeight - body.scrollTop - body.clientHeight < 90;
}

function scrollDown(force) {
  if (force || atBottom()) {
    body.scrollTop = body.scrollHeight;
  }
}

function makeLine(level, text, stack, tag) {
  const row = document.createElement("div");
  row.className = `line ${level}`;

  const ts = document.createElement("span");
  ts.className = "ts";
  ts.textContent = stamp();

  const glyph = document.createElement("span");
  glyph.className = "glyph";
  glyph.textContent = GLYPHS[level] || "›";

  const main = document.createElement("span");
  main.className = "text";
  main.textContent = text;

  if (tag) {
    const badge = document.createElement("span");
    badge.className = "pin-tag";
    badge.textContent = tag;
    main.append(badge);
  }

  row.append(ts, glyph, main);

  if (stack) {
    const pre = document.createElement("pre");
    pre.className = "stack";
    pre.textContent = stack;
    main.append(pre);
  }

  return row;
}

function updateFoot() {
  countEl.textContent = `${state.lines} ligne${state.lines > 1 ? "s" : ""}`;
  lastEl.textContent = state.lastEvent || "en attente";
  clockEl.textContent = new Date().toLocaleTimeString("fr-FR", { hour12: false });
}

function push(level, text, options = {}) {
  const { stack = null, pin = false, tag = null } = options;
  state.lines += 1;
  state.lastEvent = `${level} · ${stamp()}`;

  const line = makeLine(level, text, stack, tag);

  if (pin) {
    state.pinned += 1;
    pinned.hidden = false;
    pinCount.textContent = state.pinned;
    pinnedList.prepend(line);
    while (pinnedList.children.length > MAX_PINNED) {
      pinnedList.lastElementChild.remove();
    }
    if (typeof line.animate === "function") {
      line.animate(
        [
          { background: "rgba(255, 107, 107, 0.32)" },
          { background: "rgba(255, 107, 107, 0.07)" },
        ],
        { duration: 900, easing: "ease-out" }
      );
    }
    stream.append(makeLine(level, text, null, "épinglé"));
  } else {
    stream.append(line);
  }

  while (stream.children.length > MAX_LINES) {
    stream.firstElementChild.remove();
  }

  scrollDown(pin);
  updateFoot();
}

/* ------------------------------------------------------------------ */
/* Flux de logs simulé                                                 */
/* ------------------------------------------------------------------ */

const ms = (min, max) => Math.round(min + Math.random() * (max - min));

const ROUTES = [
  "/api/health",
  "/api/session",
  "/api/logs",
  "/api/metrics",
  "/api/checkout",
  "/api/profile",
  "/api/events",
];

const STREAM = [
  () => ({
    level: "info",
    text: `GET ${pick(ROUTES)} 200 ${ms(8, 140)}ms`,
  }),
  () => ({
    level: "debug",
    text: `cache ${pick(["hit", "miss", "revalidate"])} · key=${pick(["sess:8f21", "user:gaia", "logs:page:1", "cfg:edge"])}`,
  }),
  () => ({
    level: "success",
    text: `worker ready · region=${pick(["cdg1", "fra1", "iad1"])} · pid=${ms(1000, 9999)}`,
  }),
  () => ({
    level: "info",
    text: `POST ${pick(ROUTES)} 201 ${ms(20, 260)}ms · ${ms(2, 40)}kb`,
  }),
  () => ({
    level: "debug",
    text: `queue consume batch=${ms(1, 12)} lag=${ms(0, 90)}ms`,
  }),
  () => ({
    level: "system",
    text: `deploy ${pick(["ready", "promoted", "aliased"])} · dpl_${randomId(9)}`,
  }),
  () => ({
    level: "warn",
    text: `slow query · ${pick(["orders", "sessions", "events"])} ${ms(420, 1800)}ms (threshold 400ms)`,
  }),
  () => ({
    level: "info",
    text: `heartbeat ok · uptime=${ms(120, 9999)}s · rss=${ms(48, 180)}mb`,
  }),
  () => ({
    level: "debug",
    text: `trace ${randomId(16)} sampled=0.${ms(1, 9)}`,
  }),
  () => ({
    level: "info",
    text: `WS /socket connected · clients=${ms(1, 240)}`,
  }),
];

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function randomId(len) {
  const chars = "abcdef0123456789";
  let out = "";
  for (let i = 0; i < len; i += 1) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

let timer = null;

function scheduleNext(delay) {
  timer = setTimeout(tick, delay);
}

function tick() {
  if (document.hidden) {
    scheduleNext(1600);
    return;
  }

  const factory = pick(STREAM);
  const entry = factory();
  push(entry.level, entry.text);

  const roll = Math.random();
  const delay = roll > 0.9 ? ms(120, 380) : ms(650, 1900);
  scheduleNext(delay);
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
    log: "POST /api/checkout 500 · cannot read properties of null (reading 'items')",
  },
  {
    code: "ERR_UNDEFINED_CALL",
    run() {
      const session = {};
      return session.refreshToken();
    },
    log: "GET /api/session 502 · session.refreshToken is not a function",
  },
  {
    code: "ERR_PARSE_FAILED",
    run() {
      return JSON.parse('{"user": "gaia", }');
    },
    log: "GET /api/profile 200 · unexpected token '}' in JSON at position 18",
  },
  {
    code: "ERR_RANGE_OVERFLOW",
    run() {
      const buffer = [1, 2, 3];
      return buffer[12].toString();
    },
    log: "POST /api/logs/batch 500 · cannot read properties of undefined (reading 'toString')",
  },
];

function fireError() {
  const scenario = SCENARIOS[state.scenario % SCENARIOS.length];
  state.scenario += 1;
  state.seq += 1;

  try {
    scenario.run();
    push("info", `${scenario.code} · aucune exception levée`);
  } catch (error) {
    push("error", `[${scenario.code}] ${error.message}`, { stack: error.stack, pin: true, tag: "épinglé" });
    push("error", scenario.log, { pin: false });
    console.error(`[${scenario.code}]`, error);
  }
}

window.addEventListener("error", (event) => {
  push("error", `[UNCAUGHT] ${event.message || "erreur inconnue"}`, {
    stack: event.error && event.error.stack ? event.error.stack : null,
    pin: true,
    tag: "épinglé",
  });
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  push("error", `[UNHANDLED_REJECTION] ${reason && reason.message ? reason.message : reason}`, {
    stack: reason && reason.stack ? reason.stack : null,
    pin: true,
    tag: "épinglé",
  });
});

unpinBtn.addEventListener("click", () => {
  pinnedList.textContent = "";
  state.pinned = 0;
  pinCount.textContent = "0";
  pinned.hidden = true;
});

fireBtn.addEventListener("click", fireError);

document.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.target === document.body) {
    event.preventDefault();
    fireError();
  }
});

/* ------------------------------------------------------------------ */
/* Halo lumineux au curseur                                            */
/* ------------------------------------------------------------------ */

const spotlight = document.querySelector(".spotlight");
if (spotlight && window.matchMedia("(pointer: fine)").matches) {
  let targetX = window.innerWidth * 0.5;
  let targetY = window.innerHeight * 0.18;
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
    targetY = window.innerHeight * 0.18;
    if (raf === null) raf = requestAnimationFrame(paint);
  });
}

/* ------------------------------------------------------------------ */

push("system", "session attachée · tail -f /var/log/app.log");
push("info", "handlers error et unhandledrejection actifs");
setInterval(updateFoot, 1000);
updateFoot();
scheduleNext(400);
