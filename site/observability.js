/* Observability dashboard rendering. */
(function () {
  const M = window.LogMetrics;
  const section = document.getElementById("observabilite");
  if (!M || !section) return;

  const kpisEl = document.getElementById("obsKpis");
  const tableEl = document.getElementById("obsTable");
  const bodyEl = document.getElementById("obsTableBody");
  const sourceEl = document.getElementById("obsSource");
  const sortState = { key: "tokens_total", dir: -1 };
  const expanded = new Set();

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  const fmtMs = (ms) => {
    if (ms == null) return "—";
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
  };

  const fmtTokens = (n) => {
    if (n == null) return "—";
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
  };

  const fmtDelta = (p) => {
    if (p == null) return "—";
    const v = Math.round(p * 100);
    if (v === 0) return "0 %";
    return v > 0 ? `−${v} %` : `+${Math.abs(v)} %`;
  };

  const fmtDate = (iso) => {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("fr-FR", {
      day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    });
  };

  const weak = (n) => (n != null && n < 3 ? " · small sample" : "");

  function kpi(label, value, sub, tone) {
    const card = el("div", "obs-kpi");
    if (tone) card.dataset.tone = tone;
    card.append(el("span", "obs-kpi-label", label), el("strong", "obs-kpi-value", value));
    if (sub) card.append(el("span", "obs-kpi-sub", sub));
    return card;
  }

  function renderSource(snap) {
    if (!sourceEl) return;
    const remote = snap.source === "postgres";
    sourceEl.dataset.source = remote ? "postgres" : "local";
    sourceEl.textContent = remote ? "source · PostgreSQL" : "source · localStorage";
  }

  function renderKpis(snap) {
    const t = snap.totals;
    const approx = snap.runs.some((r) => r.tokens.estimated) ? "≈" : "";
    const tok = (n) => (n == null ? "—" : `${approx}${fmtTokens(n)}`);
    kpisEl.replaceChildren(
      kpi("Median time before", fmtMs(t.median_duration_cold), `cold · n=${t.n_cold}${weak(t.n_cold)}`),
      kpi("Median time after", fmtMs(t.median_duration_warm), `warm · n=${t.n_warm}${weak(t.n_warm)}`),
      kpi("Time saved", fmtDelta(t.delta_time_pct), `${fmtMs(t.time_saved_ms)} saved`, "gain"),
      kpi("Median tokens before", tok(t.median_tokens_cold), `cold · n=${t.n_cold}${weak(t.n_cold)}`),
      kpi("Median tokens after", tok(t.median_tokens_warm), `warm · n=${t.n_warm}${weak(t.n_warm)}`),
      kpi("Tokens saved", fmtDelta(t.delta_tokens_pct), `${fmtTokens(t.tokens_saved)} saved`, "gain"),
      kpi("Tokens used", tok(t.tokens_total), `${fmtTokens(t.tokens_cold)} cold · ${fmtTokens(t.tokens_warm)} warm`),
      kpi("Memo hit rate", t.memo_hit_rate == null ? "—" : `${Math.round(t.memo_hit_rate * 100)} %`, `${t.n_warm} warm · ${t.n_warm_degraded} degraded`),
      kpi("Resolutions", `${t.resolved} / ${t.runs}`, `${t.n_cold} cold · ${t.n_warm} warm · ${t.n_failed} failed`),
    );
  }

  const COLUMNS = [
    { key: "code", label: "Log d'erreur" },
    { key: "n_cold", label: "Cold / warm" },
    { key: "median_duration_cold", label: "Temps cold → warm" },
    { key: "delta_time_pct", label: "Δ temps" },
    { key: "median_tokens_cold", label: "Tokens cold → warm" },
    { key: "delta_tokens_pct", label: "Δ tokens" },
    { key: "tokens_total", label: "Tokens total" },
    { key: "last_seen_at", label: "Last seen" },
  ];

  function renderHead() {
    const head = tableEl.tHead || tableEl.createTHead();
    const row = el("tr");
    COLUMNS.forEach((col) => {
      const th = el("th", null, col.label);
      th.scope = "col";
      th.dataset.key = col.key;
      if (col.key === sortState.key) th.dataset.sorted = sortState.dir < 0 ? "desc" : "asc";
      th.tabIndex = 0;
      th.setAttribute("role", "button");
      th.title = "Trier";
      row.append(th);
    });
    head.replaceChildren(row);
  }

  function sortRows(rows) {
    return [...rows].sort((a, b) => {
      const av = a[sortState.key];
      const bv = b[sortState.key];
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "string") return av.localeCompare(bv) * sortState.dir;
      return (av - bv) * sortState.dir;
    });
  }

  function cell(label, content, className) {
    const td = el("td", className);
    td.dataset.label = label;
    if (content instanceof Node) td.append(content);
    else td.textContent = content;
    return td;
  }

  function badge(mode) {
    const text = mode === "warm" ? "warm · memo" : mode === "warm_degraded" ? "warm degraded" : "cold";
    const b = el("span", "obs-badge", text);
    b.dataset.mode = mode;
    return b;
  }

  function runCard(run) {
    const tokens = run.tokens || { input: 0, output: 0 };
    const memo = run.memo || {};
    const card = el("article", "obs-run");
    card.dataset.status = run.status;

    const top = el("div", "obs-run-top");
    const title = el("div", "obs-run-title");
    title.append(el("strong", null, run.code), badge(run.mode));
    top.append(title, el("time", null, fmtDate(run.ended_at)), el("span", "obs-run-status", run.status === "resolved" ? "resolved" : "failed"));
    card.append(top);

    const steps = el("div", "obs-steps");
    const total = run.agent_ms || 1;
    (run.steps || []).forEach((s) => {
      const seg = el("span");
      seg.style.flexGrow = String(Math.max(s.duration_ms, 1) / total);
      seg.title = `${s.name} · ${fmtMs(s.duration_ms)}`;
      seg.dataset.name = s.name;
      steps.append(seg);
    });
    card.append(steps);

    const meta = el("div", "obs-run-meta");
    meta.append(
      el("span", null, `duration ${fmtMs(run.duration_ms)}`),
      el("span", null, `agent ${fmtMs(run.agent_ms)}`),
      el("span", null, `${fmtTokens(run.tokens_total)} tokens (${fmtTokens(tokens.input)} in / ${fmtTokens(tokens.output)} out)${tokens.estimated ? " ≈" : ""}`),
      el("span", null, memo.hit ? `memo ${memo.path}` : "no memo"),
    );
    card.append(meta);
    return card;
  }

  function detailRow(fingerprint, snap) {
    const tr = el("tr", "obs-detail");
    const td = el("td");
    td.colSpan = COLUMNS.length;
    const list = el("div", "obs-detail-list");
    const runs = snap.runs.filter((r) => r.fingerprint === fingerprint).slice(-3).reverse();
    runs.forEach((run) => list.append(runCard(run)));
    td.append(list);
    tr.append(td);
    return tr;
  }

  function renderTable(snap) {
    const rows = sortRows(snap.fingerprints);
    bodyEl.replaceChildren();

    if (!rows.length) {
      const tr = el("tr");
      const td = el("td", "obs-empty", "Aucune mesure — lancez un log d'erreur.");
      td.colSpan = COLUMNS.length;
      tr.append(td);
      bodyEl.append(tr);
      return;
    }

    rows.forEach((f) => {
      const open = expanded.has(f.fingerprint);
      const tr = el("tr", "obs-row");
      tr.dataset.fp = f.fingerprint;
      tr.tabIndex = 0;
      tr.setAttribute("aria-expanded", String(open));

      const code = el("div", "obs-code");
      code.append(el("strong", null, f.code), el("code", null, f.fingerprint.slice(0, 10)));
      code.append(badge(f.n_warm > 0 ? "warm" : f.n_warm_degraded > 0 ? "warm_degraded" : "cold"));
      tr.append(cell("Log d'erreur", code, "obs-cell-main"));
      tr.append(cell("Cold / warm", `${f.n_cold} / ${f.n_warm}${f.n_warm_degraded ? ` (+${f.n_warm_degraded} deg.)` : ""}`));
      tr.append(cell("Temps cold → warm", `${fmtMs(f.median_duration_cold)} → ${fmtMs(f.median_duration_warm)}`));
      const dTime = el("span", "obs-delta", fmtDelta(f.delta_time_pct));
      if (f.delta_time_pct != null) dTime.dataset.tone = f.delta_time_pct >= 0 ? "gain" : "loss";
      tr.append(cell("Δ temps", dTime));
      const approx = f.estimated ? "≈" : "";
      const tok = (n) => (n == null ? "—" : `${approx}${fmtTokens(n)}`);
      tr.append(cell("Tokens cold → warm", `${tok(f.median_tokens_cold)} → ${tok(f.median_tokens_warm)}`));
      const dTok = el("span", "obs-delta", fmtDelta(f.delta_tokens_pct));
      if (f.delta_tokens_pct != null) dTok.dataset.tone = f.delta_tokens_pct >= 0 ? "gain" : "loss";
      tr.append(cell("Δ tokens", dTok));
      tr.append(cell("Tokens total", tok(f.tokens_total), "obs-cell-total"));
      tr.append(cell("Last seen", fmtDate(f.last_seen_at)));

      bodyEl.append(tr);
      if (open) bodyEl.append(detailRow(f.fingerprint, snap));
    });
  }

  function render(snap) {
    renderSource(snap);
    renderKpis(snap);
    renderTable(snap);
  }

  function download(name, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = el("a");
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  section.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action) return;
    if (action === "json") download("log-metrics.json", M.exportJSON(), "application/json");
    if (action === "csv") download("log-metrics.csv", M.exportCSV(), "text/csv");
    if (action === "memos") M.clearMemos();
    if (action === "reset" && window.confirm("Reset all metrics and memos?")) {
      expanded.clear();
      M.reset();
    }
  });

  function toggleRow(tr) {
    const fp = tr.dataset.fp;
    if (!fp) return;
    if (expanded.has(fp)) expanded.delete(fp);
    else expanded.add(fp);
    render(M.getSnapshot());
  }

  bodyEl.addEventListener("click", (event) => {
    const tr = event.target.closest("tr.obs-row");
    if (tr) toggleRow(tr);
  });

  bodyEl.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const tr = event.target.closest("tr.obs-row");
    if (!tr) return;
    event.preventDefault();
    toggleRow(tr);
  });

  tableEl.tHead.addEventListener("click", (event) => {
    const th = event.target.closest("th[data-key]");
    if (!th) return;
    if (sortState.key === th.dataset.key) sortState.dir *= -1;
    else {
      sortState.key = th.dataset.key;
      sortState.dir = th.dataset.key === "code" || th.dataset.key === "last_seen_at" ? 1 : -1;
    }
    renderHead();
    render(M.getSnapshot());
  });

  tableEl.tHead.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const th = event.target.closest("th[data-key]");
    if (!th) return;
    event.preventDefault();
    th.click();
  });

  renderHead();
  render(M.getSnapshot());
  M.onChange(render);
  M.hydrate();
})();
