/* ------------------------------------------------------------------ */
/* Base pg-memoire (Aiven PostgreSQL) — panneau en bas de page        */
/* ------------------------------------------------------------------ */

(() => {
  const ENDPOINT = "/api/pg-memoire";
  // Ligne complete : /api/pg-memoire tronque les cellules, la popup a besoin du texte entier.
  const ROW_ENDPOINT = "/api/pg-memoire-row";
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

  /* Popup : une ligne entiere ------------------------------------------ */

  // Un seul <dialog> reutilise pour chaque ligne : le panneau reste en place,
  // et Échap, le bouton Fermer ou un clic sur le fond le referment.
  const dialog = el("dialog", "db-dialog");
  dialog.setAttribute("aria-labelledby", "dbDialogTitle");

  const dialogHead = el("header", "db-dialog-head");
  const dialogTitles = el("div", "db-dialog-titles");
  const dialogTitle = el("h3", "", "row");
  dialogTitle.id = "dbDialogTitle";
  dialogTitles.append(el("span", "db-dialog-kicker", "pg-memoire · full row"), dialogTitle);
  const dialogBadge = el("span", "db-dialog-badge", "");
  dialogHead.append(dialogTitles, dialogBadge);

  const dialogBody = el("div", "db-dialog-body");

  const dialogFoot = el("footer", "db-dialog-foot");
  const dialogStatus = el("span", "db-dialog-status", "");
  dialogStatus.setAttribute("role", "status");
  const copyButton = el("button", "btn btn-sm btn-ghost", "Copy text");
  copyButton.type = "button";
  const closeButton = el("button", "btn btn-sm btn-ghost", "Close");
  closeButton.type = "button";
  dialogFoot.append(dialogStatus, copyButton, closeButton);

  dialog.append(dialogHead, dialogBody, dialogFoot);
  document.body.append(dialog);

  // Texte mis dans le presse-papiers : la colonne qui porte la resolution si
  // elle existe (« resolution » dans historique, « fix » dans error_resolutions),
  // sinon la valeur la plus longue de la ligne.
  let copyText = "";

  const TEXT_COLUMNS = ["resolution", "fix", "cause", "message", "text"];
  const textLength = (value) => (value === null || value === undefined ? 0 : String(value).length);

  function renderRow(row) {
    dialogBadge.textContent = row.kind || "row";
    dialogTitle.textContent = `${row.table} · ${row.primaryKey} ${row.key}`;

    const fields = row.columns.map((column, i) => ({ name: column.name, type: column.type, value: row.values[i] }));
    const guide = TEXT_COLUMNS.map((name) => fields.find((field) => field.name === name)).find(Boolean);
    const longest = fields.reduce((best, field) => (textLength(field.value) > textLength(best.value) ? field : best), fields[0]);
    copyText = String((guide || longest || {}).value || "");

    const blocks = fields.map((field) => {
      const block = el("div", "db-field");

      const fieldHead = el("div", "db-field-head");
      fieldHead.append(el("strong", "", field.name), el("small", "", field.type));

      const value = el("pre", "db-field-value");
      if (field.value === null || field.value === undefined) value.append(el("span", "db-null", "null"));
      else value.textContent = field.value;

      block.append(fieldHead, value);
      return block;
    });

    dialogBody.replaceChildren(...blocks);
    dialogBody.scrollTop = 0;

    const bits = [plural(fields.length, "column")];
    if (row.hidden && row.hidden.length) bits.push(`hidden: ${row.hidden.join(", ")}`);
    if (row.truncated) bits.push(`text cut at ${row.cellLimit} characters`);
    dialogStatus.textContent = bits.join(" · ");
  }

  function renderRowError(message, detail) {
    dialogBadge.textContent = "error";
    dialogStatus.textContent = message;
    copyText = "";

    const empty = el("div", "db-empty");
    const orb = el("span", "agents-empty-orb");
    orb.setAttribute("aria-hidden", "true");
    empty.append(orb, el("p", "", message), el("span", "", detail));
    dialogBody.replaceChildren(empty);
  }

  async function openRow(database, table, key, keyColumn) {
    dialogBadge.textContent = "loading";
    dialogTitle.textContent = `${table} · ${keyColumn || "id"} ${key}`;
    dialogStatus.textContent = "fetching the full row";
    copyText = "";

    const loading = el("div", "db-empty");
    const orb = el("span", "agents-empty-orb");
    orb.setAttribute("aria-hidden", "true");
    loading.append(orb, el("p", "", "loading row"), el("span", "", `${database}.${table} · ${key}`));
    dialogBody.replaceChildren(loading);

    if (!dialog.open) dialog.showModal();

    const params = [
      `db=${encodeURIComponent(database)}`,
      `table=${encodeURIComponent(table)}`,
      `id=${encodeURIComponent(key)}`,
    ];
    if (keyColumn) params.push(`key=${encodeURIComponent(keyColumn)}`);
    const query = params.join("&");
    const started = performance.now();

    try {
      const response = await fetch(`${ROW_ENDPOINT}?${query}`, { headers: { Accept: "application/json" } });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || !Array.isArray(data.columns)) {
        throw new Error((data && data.error) || `HTTP ${response.status}`);
      }
      renderRow(data);
      log("inf", `GET ${ROW_ENDPOINT}?${query} 200 · ${plural(data.columns.length, "column")} · ${Math.round(performance.now() - started)} ms`);
    } catch (error) {
      renderRowError("row unavailable", `${ROW_ENDPOINT} · ${error.message}`);
      log("wrn", `GET ${ROW_ENDPOINT} failed · ${error.message}`);
    }
  }

  closeButton.addEventListener("click", () => dialog.close());

  // Clic sur le fond assombri : ferme la popup.
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    const inside =
      event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
    if (!inside) dialog.close();
  });

  copyButton.addEventListener("click", async () => {
    if (!copyText) {
      dialogStatus.textContent = "nothing to copy";
      return;
    }

    try {
      await navigator.clipboard.writeText(copyText);
      dialogStatus.textContent = "copied";
    } catch {
      // Presse-papiers refuse (contexte non securise) : on selectionne le texte.
      const range = document.createRange();
      range.selectNodeContents(dialogBody);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      dialogStatus.textContent = "press Ctrl+C to copy the selection";
    }
  });

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

  // Colonne qui identifie une ligne : annoncée par /api/pg-memoire (`table.key`).
  // Sans elle, les lignes ne sont pas cliquables.
  function keyIndex(table) {
    if (!table.key) return -1;
    const i = table.columns.indexOf(table.key);
    return i;
  }

  function renderTable() {
    const found = findTable(state.current);

    if (!found) {
      info.textContent = "no readable table";
      renderEmpty("no table", "pg-memoire · public schema");
      return;
    }

    const { db, table } = found;
    const idIndex = keyIndex(table);
    const bits = [`${db.name}.${table.name}`, plural(table.rows, "row")];
    if (table.rows > table.sample.length) bits.push(`latest ${table.sample.length}`);
    if (table.orderBy) bits.push(`order by ${table.orderBy} desc`);
    if (idIndex >= 0) bits.push(`click a row for the full text`);
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

      // Ligne cliquable : ouvre la popup avec le texte complet de la ligne.
      const key = idIndex >= 0 ? row[idIndex] : null;
      if (key !== null && key !== undefined && key !== "") {
        const label = `${table.columns[idIndex]} ${key}`;
        tr.dataset.key = String(key);
        tr.tabIndex = 0;
        tr.setAttribute("role", "button");
        tr.setAttribute("aria-label", `Open the full row ${db.name}.${table.name} ${label}`);
        tr.title = `Open ${db.name}.${table.name} ${label}`;
        const open = () => openRow(db.name, table.name, String(key), table.key);
        tr.addEventListener("click", open);
        tr.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          open();
        });
      }

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
