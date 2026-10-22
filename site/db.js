/* ------------------------------------------------------------------ */
/* Base pg-memoire (Aiven PostgreSQL) — panneau en bas de page        */
/* ------------------------------------------------------------------ */

(() => {
  const ENDPOINT = "/api/pg-memoire";
  const REFRESH_MS = 30000;

  // Tout en bas de la page : après la section Observability si elle existe.
  const anchor = document.getElementById("observabilite") || document.querySelector(".workspace");
  if (!anchor) return;

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // Ligne dans le terminal du site (app.js), si disponible.
  const log = (level, text) => {
    if (typeof addRow === "function") addRow(level, text);
  };

  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const clock = () => new Date().toLocaleTimeString("en-GB", { hour12: false });

  // Valeurs courtes : jamais coupées sur deux lignes.
  const NOWRAP = /^(int[248]|float[48]|numeric|oid|bool|uuid|timestamptz|timestamp|date)$/;

  /* Squelette ---------------------------------------------------------- */

  const section = el("section", "db-section");
  section.id = "pg-memoire";
  section.setAttribute("aria-label", "pg-memoire database");

  const panel = el("div", "db");
  panel.dataset.state = "loading";

  const head = el("header", "db-head");
  const titles = el("div", "db-titles");
  titles.append(el("strong", "", "pg-memoire"), el("span", "", "aiven · postgresql · read-only"));
  const badge = el("span", "db-count", "connecting");
  const refresh = el("button", "btn btn-sm btn-ghost", "Refresh");
  refresh.type = "button";
  head.append(titles, badge, refresh);

  const tabs = el("nav", "db-tabs");
  tabs.setAttribute("aria-label", "pg-memoire tables");

  const info = el("div", "db-info", "connecting to pg-memoire…");
  const view = el("div", "db-scroll");

  const foot = el("footer", "db-foot");
  const dot = el("span", "dotline");
  dot.setAttribute("aria-hidden", "true");
  const footText = el("span", "", "waiting");
  const stamp = el("span", "", "--:--:--");
  const right = el("span", "foot-right");
  right.append(el("span", "", "cache 30 s"), el("span", "sep", "·"), stamp);
  foot.append(dot, footText, right);

  panel.append(head, tabs, info, view, foot);
  section.append(panel);
  anchor.after(section);

  const state = { data: null, current: null, counts: null, down: new Set(), timer: null, busy: false };

  /* Rendu -------------------------------------------------------------- */

  const findTable = (key) => {
    if (!state.data || !key) return null;
    for (const db of state.data.databases) {
      for (const table of db.tables) {
        if (`${db.name}.${table.name}` === key) return { db, table };
      }
    }
    return null;
  };

  // Table ouverte par défaut : celle qui porte le nom de sa base, sinon la première non vide.
  const defaultKey = (data) => {
    const all = data.databases.flatMap((db) => db.tables.map((table) => ({ db, table })));
    const pick =
      all.find(({ db, table }) => table.name === db.name && table.rows > 0) ||
      all.find(({ table }) => table.rows > 0) ||
      all[0];
    return pick ? `${pick.db.name}.${pick.table.name}` : null;
  };

  const formatValue = (value, type) => {
    if (type === "timestamptz") {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) return date.toLocaleString("en-GB", { hour12: false });
    }
    return value;
  };

  function renderTabs() {
    tabs.replaceChildren();

    for (const db of state.data.databases) {
      const group = el("div", "db-group");
      group.append(el("span", "db-group-name", db.name));

      if (db.error) group.append(el("span", "db-group-err", "unavailable"));

      for (const table of db.tables) {
        const key = `${db.name}.${table.name}`;
        const tab = el("button", "db-tab");
        tab.type = "button";
        tab.dataset.empty = String(table.rows === 0);
        tab.setAttribute("aria-pressed", String(key === state.current));
        tab.append(document.createTextNode(table.name), el("b", "", String(table.rows)));
        tab.addEventListener("click", () => {
          state.current = key;
          renderTabs();
          renderTable();
        });
        group.append(tab);
      }

      tabs.append(group);
    }
  }

  function renderEmpty(title, detail) {
    const empty = el("div", "db-empty");
    const orb = el("span", "agents-empty-orb");
    orb.setAttribute("aria-hidden", "true");
    empty.append(orb, el("p", "", title), el("span", "", detail));
    view.replaceChildren(empty);
  }

  function renderTable() {
    const found = findTable(state.current);

    if (!found) {
      info.textContent = "no readable table";
      renderEmpty("no table", "pg-memoire · public schema");
      return;
    }

    const { db, table } = found;
    const bits = [`${db.name}.${table.name}`, plural(table.rows, "row")];
    if (table.rows > table.sample.length) bits.push(`latest ${table.sample.length}`);
    if (table.orderBy) bits.push(`order by ${table.orderBy} desc`);
    if (table.hidden.length) bits.push(`hidden: ${table.hidden.join(", ")}`);
    info.textContent = bits.join(" · ");

    if (!table.sample.length) {
      renderEmpty("empty table", `${plural(table.columns.length, "column")} · 0 rows`);
      return;
    }

    const grid = el("table", "db-table");
    const thead = el("thead");
    const headRow = el("tr");

    table.columns.forEach((name, i) => {
      const th = el("th");
      th.scope = "col";
      if (NOWRAP.test(table.types[i])) th.className = "db-nowrap";
      th.append(document.createTextNode(name), el("small", "", table.types[i]));
      headRow.append(th);
    });

    thead.append(headRow);

    const tbody = el("tbody");

    for (const row of table.sample) {
      const tr = el("tr");

      row.forEach((value, i) => {
        const td = el("td");
        if (NOWRAP.test(table.types[i])) td.className = "db-nowrap";
        if (value === null) {
          td.append(el("span", "db-null", "null"));
        } else {
          const text = el("div", "db-cell", formatValue(value, table.types[i]));
          text.title = value;
          td.append(text);
        }
        tr.append(td);
      });

      tbody.append(tr);
    }

    grid.append(thead, tbody);
    view.replaceChildren(grid);
  }

  /* Chargement --------------------------------------------------------- */

  function apply(data, reason, ms) {
    const counts = new Map();
    let tables = 0;
    let rows = 0;

    for (const db of data.databases) {
      for (const table of db.tables) {
        counts.set(`${db.name}.${table.name}`, table.rows);
        tables += 1;
        rows += table.rows;
      }
    }

    if (reason === "auto" && state.counts) {
      for (const [key, n] of counts) {
        const before = state.counts.get(key);
        if (before === undefined) log("inf", `pg-memoire · new table ${key}`);
        else if (before !== n) log(n > before ? "ok" : "wrn", `pg-memoire · ${key} ${before} → ${n} rows`);
      }
    } else {
      log("inf", `GET ${ENDPOINT} 200 · ${data.databases.length} db · ${tables} tables · ${rows} rows · ${ms} ms`);
    }

    // Une base indisponible n'est signalée qu'au moment où elle tombe.
    const down = new Set(data.databases.filter((db) => db.error).map((db) => db.name));
    for (const name of down) if (!state.down.has(name)) log("wrn", `pg-memoire · database ${name} unavailable`);
    state.down = down;

    state.data = data;
    state.counts = counts;
    if (!findTable(state.current)) state.current = defaultKey(data);

    panel.dataset.state = down.size ? "error" : "live";
    badge.textContent = plural(rows, "row");
    footText.textContent = [
      plural(data.databases.length, "database"),
      plural(tables, "table"),
      data.version ? `postgresql ${data.version}` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    renderTabs();
    renderTable();
  }

  async function load(reason) {
    if (state.busy) return;
    state.busy = true;
    refresh.disabled = true;
    if (!state.data) panel.dataset.state = "loading";

    const started = performance.now();

    try {
      const response = await fetch(ENDPOINT, { headers: { Accept: "application/json" } });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || !Array.isArray(data.databases)) throw new Error(`HTTP ${response.status}`);
      apply(data, reason, Math.round(performance.now() - started));
    } catch (error) {
      panel.dataset.state = "error";
      badge.textContent = "offline";
      footText.textContent = `pg-memoire unreachable · retry in ${REFRESH_MS / 1000} s`;
      if (!state.data) {
        info.textContent = "pg-memoire unreachable";
        renderEmpty("database unreachable", `GET ${ENDPOINT} · ${error.message}`);
      }
      log("wrn", `GET ${ENDPOINT} failed · ${error.message}`);
    } finally {
      state.busy = false;
      refresh.disabled = false;
      stamp.textContent = clock();
      schedule();
    }
  }

  function schedule() {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      if (document.visibilityState === "visible") load("auto");
      else schedule();
    }, REFRESH_MS);
  }

  refresh.addEventListener("click", () => load("manual"));

  load("initial");
})();
