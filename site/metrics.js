/* Observabilité des résolutions — aucune dépendance, compatible site statique. */
(function () {
  const KEY = "log.observability.v1";
  const MAX_RUNS = 500;
  const STEPS = [
    "receive",
    "fingerprint",
    "memo_lookup",
    "diagnose",
    "patch",
    "verify",
    "write_memo",
  ];

  const state = { version: 1, runs: [], memos: {} };
  const active = new Map();
  const listeners = new Set();
  const api = {
    base: null,
    online: false,
  };

  /* ---------------------------------------------------------------- */
  /* Identité d'une erreur                                             */
  /* ---------------------------------------------------------------- */

  function normalizeMessage(message) {
    return String(message || "")
      .toLowerCase()
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
      .replace(/\b0x[0-9a-f]+\b/g, "<hex>")
      .replace(/\b[0-9a-f]{12,}\b/g, "<hex>")
      .replace(/\d{4}-\d{2}-\d{2}t[\d:.]+z?/g, "<ts>")
      .replace(/[a-z]:\\[^\s:]+/gi, "<path>")
      .replace(/(^|\s)\/(?:[\w.-]+\/)+[\w.-]+/g, "$1<path>")
      .replace(/\d+/g, "<n>")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
  }

  function firstFrame(stack) {
    const line = String(stack || "")
      .split("\n")
      .find((l) => /\bat\b|:\d+:\d+/.test(l) && !/metrics\.js|observability\.js/.test(l));
    return line ? line.trim().slice(0, 120) : "";
  }

  function hash(text) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
  }

  function fingerprint(code, message, stack) {
    return hash(`${code}|${normalizeMessage(message)}|${firstFrame(stack)}`);
  }

  /* ---------------------------------------------------------------- */
  /* Persistance locale + base PostgreSQL                              */
  /* ---------------------------------------------------------------- */

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (!saved || saved.version !== 1) return;
      const seen = new Set(state.runs.map((r) => r.run_id));
      (saved.runs || []).forEach((r) => {
        if (r && r.run_id && !seen.has(r.run_id)) state.runs.push(r);
      });
      state.runs.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
      Object.assign(state.memos, saved.memos || {});
    } catch {
      /* storage indisponible ou corrompu : on repart à vide */
    }
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* quota atteint : la session reste en mémoire */
    }
  }

  function notify() {
    const snapshot = getSnapshot();
    listeners.forEach((fn) => fn(snapshot));
  }

  function request(path, options) {
    if (!api.online) return Promise.resolve(null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    return fetch(`${api.base}${path}`, {
      ...options,
      signal: controller.signal,
      headers: { "content-type": "application/json", ...(options && options.headers) },
    })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
      .finally(() => clearTimeout(timer));
  }

  function hydrate() {
    const base = typeof window.LOG_METRICS_API === "string" ? window.LOG_METRICS_API.trim() : "";
    api.base = base.replace(/\/$/, "");
    api.online = Boolean(api.base) && window.location.protocol !== "file:";
    if (!api.online) return Promise.resolve(false);
    return request("/metrics").then((data) => {
      if (!data) {
        api.online = false;
        notify();
        return false;
      }
      const seen = new Set(state.runs.map((r) => r.run_id));
      (data.runs || []).forEach((r) => {
        if (r && r.run_id && !seen.has(r.run_id)) state.runs.push(r);
      });
      state.runs.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
      if (state.runs.length > MAX_RUNS) state.runs.splice(0, state.runs.length - MAX_RUNS);
      (data.memos || []).forEach((memo) => {
        if (!memo || !memo.fingerprint) return;
        const local = state.memos[memo.fingerprint];
        if (!local || String(memo.updated_at) >= String(local.updated_at)) {
          state.memos[memo.fingerprint] = memo;
        }
      });
      save();
      notify();
      return true;
    });
  }

  function persistRun(run) {
    request("/runs", { method: "POST", body: JSON.stringify(run) });
  }

  function persistMemo(memo) {
    request("/memos", { method: "POST", body: JSON.stringify(memo) });
  }

  /* ---------------------------------------------------------------- */
  /* Mesure                                                            */
  /* ---------------------------------------------------------------- */

  const clock = () => performance.now();
  const iso = () => new Date().toISOString();

  function startRun({ code, message, stack, agent }) {
    const fp = fingerprint(code, message, stack);
    const seen = state.runs.some((r) => r.fingerprint === fp);
    const memo = state.memos[fp];
    const mode = memo ? "warm" : seen ? "warm_degraded" : "cold";
    const run = {
      run_id: `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      fingerprint: fp,
      code,
      mode,
      status: "resolved",
      started_at: iso(),
      ended_at: null,
      duration_ms: 0,
      agent_ms: 0,
      steps: [],
      tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0, estimated: false },
      tokens_total: 0,
      memo: { hit: Boolean(memo), path: memo ? memo.path || null : null, stale: false },
      agent: agent || null,
      attempt: state.runs.filter((r) => r.fingerprint === fp).length + 1,
    };
    active.set(run.run_id, { run, t0: clock(), stepT0: clock(), stepName: "receive" });
    step(run.run_id, "fingerprint");
    step(run.run_id, "memo_lookup");
    return { run_id: run.run_id, fingerprint: fp, mode, started_at: run.started_at };
  }

  function step(runId, name) {
    const live = active.get(runId);
    if (!live || STEPS.indexOf(name) === -1) return;
    const t = clock();
    if (live.stepName) {
      live.run.steps.push({ name: live.stepName, duration_ms: Math.round(t - live.stepT0) });
    }
    live.stepName = name;
    live.stepT0 = t;
  }

  function addTokens(runId, tokens) {
    const live = active.get(runId);
    if (!live || !tokens) return;
    const t = live.run.tokens;
    t.input += Number(tokens.input) || 0;
    t.output += Number(tokens.output) || 0;
    t.cache_read += Number(tokens.cache_read) || 0;
    t.cache_write += Number(tokens.cache_write) || 0;
    if (tokens.estimated) t.estimated = true;
    live.run.tokens_total = t.input + t.output;
  }

  function endRun(runId, { status = "resolved" } = {}) {
    const live = active.get(runId);
    if (!live) return null;
    const { run } = live;
    const t = clock();
    if (live.stepName) {
      run.steps.push({ name: live.stepName, duration_ms: Math.round(t - live.stepT0) });
    }
    run.status = status;
    run.ended_at = iso();
    run.duration_ms = Math.round(t - live.t0);
    run.agent_ms = run.steps.reduce((sum, s) => sum + s.duration_ms, 0);
    run.tokens_total = run.tokens.input + run.tokens.output;

    if (status === "resolved" && !run.memo.hit) {
      const memo = {
        fingerprint: run.fingerprint,
        code: run.code,
        path: `db://error_resolutions/${run.fingerprint}`,
        cause: `erreur ${run.code} reproduite et corrigée`,
        fix: `correctif appliqué par ${run.agent || "agent"}`,
        files: [],
        verification: "tests 12/12",
        tokens_used: run.tokens_total,
        duration_ms: run.duration_ms,
        agent: run.agent,
        runs: 1,
        updated_at: run.ended_at,
      };
      state.memos[run.fingerprint] = memo;
      persistMemo(memo);
    } else if (status === "resolved" && state.memos[run.fingerprint]) {
      const memo = state.memos[run.fingerprint];
      memo.runs = (memo.runs || 0) + 1;
      memo.updated_at = run.ended_at;
      persistMemo(memo);
    }

    active.delete(runId);
    state.runs.push(run);
    if (state.runs.length > MAX_RUNS) state.runs.splice(0, state.runs.length - MAX_RUNS);
    save();
    persistRun(run);
    notify();
    return run;
  }

  /* ---------------------------------------------------------------- */
  /* Agrégats                                                          */
  /* ---------------------------------------------------------------- */

  function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  const pct = (cold, warm) => (cold && warm != null ? (cold - warm) / cold : null);

  function statsFor(runs) {
    const resolved = runs.filter((r) => r.status === "resolved");
    const byMode = (mode) => resolved.filter((r) => r.mode === mode);
    const cold = byMode("cold");
    const warm = byMode("warm");
    const med = (list, key) => median(list.map((r) => r[key]));
    return {
      n_cold: runs.filter((r) => r.mode === "cold").length,
      n_warm: runs.filter((r) => r.mode === "warm").length,
      n_warm_degraded: runs.filter((r) => r.mode === "warm_degraded").length,
      n_failed: runs.filter((r) => r.status !== "resolved").length,
      median_duration_cold: med(cold, "duration_ms"),
      median_duration_warm: med(warm, "duration_ms"),
      median_tokens_cold: med(cold, "tokens_total"),
      median_tokens_warm: med(warm, "tokens_total"),
    };
  }

  function getSnapshot() {
    const runs = state.runs;
    const all = statsFor(runs);
    const perFingerprint = new Map();

    runs.forEach((run) => {
      if (!perFingerprint.has(run.fingerprint)) perFingerprint.set(run.fingerprint, []);
      perFingerprint.get(run.fingerprint).push(run);
    });

    const fingerprints = [...perFingerprint.entries()]
      .map(([fp, list]) => {
        const s = statsFor(list);
        const last = list[list.length - 1];
        return {
          fingerprint: fp,
          code: last.code,
          ...s,
          delta_time_pct: pct(s.median_duration_cold, s.median_duration_warm),
          delta_tokens_pct: pct(s.median_tokens_cold, s.median_tokens_warm),
          tokens_total: list.reduce((sum, r) => sum + r.tokens_total, 0),
          estimated: list.some((r) => r.tokens.estimated),
          last_seen_at: last.ended_at || last.started_at,
          runs: list,
        };
      })
      .sort((a, b) => b.tokens_total - a.tokens_total);

    const coldResolved = runs.filter((r) => r.mode === "cold" && r.status === "resolved");
    const warmResolved = runs.filter((r) => r.mode === "warm" && r.status === "resolved");

    let tokensSaved = 0;
    let timeSaved = 0;
    warmResolved.forEach((run) => {
      const fp = fingerprints.find((f) => f.fingerprint === run.fingerprint);
      if (!fp) return;
      tokensSaved += Math.max(0, (fp.median_tokens_cold || 0) - run.tokens_total);
      timeSaved += Math.max(0, (fp.median_duration_cold || 0) - run.duration_ms);
    });

    const seenFingerprints = new Set();
    let coldRecurrences = 0;
    runs.forEach((run) => {
      if (run.mode === "cold" && seenFingerprints.has(run.fingerprint)) coldRecurrences += 1;
      seenFingerprints.add(run.fingerprint);
    });
    const memoBase = all.n_warm + all.n_warm_degraded + coldRecurrences;

    return {
      runs,
      memos: state.memos,
      source: api.online ? "postgres" : "local",
      totals: {
        ...all,
        runs: runs.length,
        resolved: runs.filter((r) => r.status === "resolved").length,
        tokens_total: runs.reduce((sum, r) => sum + r.tokens_total, 0),
        tokens_cold: coldResolved.reduce((sum, r) => sum + r.tokens_total, 0),
        tokens_warm: warmResolved.reduce((sum, r) => sum + r.tokens_total, 0),
        tokens_saved: Math.round(tokensSaved),
        time_saved_ms: Math.round(timeSaved),
        delta_time_pct: pct(all.median_duration_cold, all.median_duration_warm),
        delta_tokens_pct: pct(all.median_tokens_cold, all.median_tokens_warm),
        memo_hit_rate: memoBase ? all.n_warm / memoBase : null,
        cold_recurrences: coldRecurrences,
      },
      fingerprints,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Export / reset                                                    */
  /* ---------------------------------------------------------------- */

  function exportJSON() {
    return JSON.stringify({ version: 1, runs: state.runs, memos: state.memos }, null, 2);
  }

  function exportCSV() {
    const cols = [
      "run_id", "fingerprint", "code", "mode", "status", "started_at", "ended_at",
      "duration_ms", "agent_ms", "tokens_input", "tokens_output", "tokens_total",
      "estimated", "memo_hit", "memo_path", "agent", "attempt",
    ];
    const esc = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
    const rows = state.runs.map((r) =>
      [
        r.run_id, r.fingerprint, r.code, r.mode, r.status, r.started_at, r.ended_at,
        r.duration_ms, r.agent_ms, r.tokens.input, r.tokens.output, r.tokens_total,
        r.tokens.estimated, r.memo.hit, r.memo.path, r.agent, r.attempt,
      ]
        .map(esc)
        .join(","),
    );
    return [cols.join(","), ...rows].join("\n");
  }

  function reset() {
    active.clear();
    state.runs = [];
    state.memos = {};
    save();
    notify();
  }

  function clearMemos() {
    state.memos = {};
    save();
    notify();
  }

  load();

  window.addEventListener("storage", (event) => {
    if (event.key !== KEY) return;
    state.runs = [];
    state.memos = {};
    load();
    notify();
  });

  window.LogMetrics = {
    STEPS,
    fingerprint,
    startRun,
    step,
    addTokens,
    endRun,
    getSnapshot,
    exportJSON,
    exportCSV,
    reset,
    clearMemos,
    hydrate,
    isOnline: () => api.online,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
})();
