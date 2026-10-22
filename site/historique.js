/* Historique : la base pg-memoire (Aiven PostgreSQL) affichée au format Observability. */
(function () {
  const ENDPOINT = "/api/pg-memoire";
  const DUMP_ENDPOINT = "/api/dump";
  const REFRESH_MS = 30000;

  const section = document.getElementById("observabilite");
  const body = section && section.querySelector(".obs-body");
  const toolbar = section && section.querySelector(".obs-toolbar");
  if (!section || !body || !toolbar) return;

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  // Ligne dans le terminal du site (app.js), si disponible.
  const log = (level, text) => {
    if (typeof addRow === "function") addRow(level, text);
  };

  /* Formats : les mêmes qu'observability.js ------------------------- */

  const num = (v) => (v == null || v === "" ? null : Number(v));

  const fmtMs = (ms) => {
    const v = num(ms);
    if (v == null) return "—";
    return v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(1)} s`;
  };

  const fmtTokens = (n) => {
    const v = num(n);
    if (v == null) return "—";
    return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v));
  };

  const fmtDate = (iso) => {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("fr-FR", {
      day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    });
  };

  const fmtFull = (iso) => new Date(iso).toLocaleString("fr-FR");
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  const parseJson = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

  const compactJson = (text) => {
    const value = parseJson(text);
    return value == null ? text : JSON.stringify(value);
  };

  /* Briques au format Observability --------------------------------- */

  function badge(mode, text) {
    const label = text || (mode === "warm" ? "warm · memo" : mode === "warm_degraded" ? "warm degraded" : "cold");
    const node = el("span", "obs-badge", label);
    node.dataset.mode = mode;
    return node;
  }

  // Déjà vu plus d'une fois : la résolution stockée a servi (warm), sinon première résolution (cold).
  const reuse = (n) => (num(n) > 1 ? "warm" : "cold");

  const severity = (level) => {
    const value = String(level || "").toLowerCase();
    const mode = /^(err|error|fatal|crit)/.test(value) ? "cold" : /^(wrn|warn)/.test(value) ? "warm_degraded" : "warm";
    return badge(mode, value || "—");
  };

  function kpi(label, value, sub, tone) {
    const card = el("div", "obs-kpi");
    if (tone) card.dataset.tone = tone;
    card.append(el("span", "obs-kpi-label", label), el("strong", "obs-kpi-value", value));
    if (sub) card.append(el("span", "obs-kpi-sub", sub));
    return card;
  }

  function main(title, code, tag) {
    const box = el("div", "obs-code");
    box.append(el("strong", null, title || "—"));
    if (code) box.append(el("code", null, code));
    if (tag) box.append(tag);
    return box;
  }

  function clamp(text) {
    const node = el("span", "obs-clamp", text == null || text === "" ? "—" : text);
    if (text) node.title = text;
    return node;
  }

  function cell(label, content, className) {
    const td = el("td", className);
    td.dataset.label = label;
    if (content instanceof Node) td.append(content);
    else td.textContent = content == null ? "—" : content;
    return td;
  }

  function steps(list) {
    const bar = el("div", "obs-steps");
    const total = list.reduce((sum, s) => sum + (num(s.duration_ms) || 0), 0) || 1;
    list.forEach((s) => {
      const seg = el("span");
      seg.style.flexGrow = String(Math.max(num(s.duration_ms) || 0, 1) / total);
      seg.title = `${s.name} · ${fmtMs(s.duration_ms)}`;
      seg.dataset.name = s.name;
      bar.append(seg);
    });
    return bar;
  }

  /* Guide pour le prochain agent ------------------------------------ */
  // La base n'a pas de colonne « guide » : il est reconstruit à partir des résolutions déjà stockées.

  const GUIDE_LABEL = "Guide (prochain agent)";
  const NO_MEMO = "Aucun mémo : diagnostic complet (cold)";
  const NO_GUIDE = "Aucun guide : à diagnostiquer";
  const MEMO_LABELS = { cause: "Cause", fix: "Correctif", files: "Fichiers", verification: "Vérification" };

  // Tableau texte PostgreSQL « {a,"b c"} » -> « a, b c ».
  function pgArray(text) {
    const source = String(text || "").trim();
    if (!source.startsWith("{") || !source.endsWith("}")) return source;
    const items = [];
    let current = "";
    let quoted = false;
    for (let i = 1; i < source.length - 1; i += 1) {
      const ch = source[i];
      if (quoted && ch === "\\") {
        i += 1;
        current += source[i] || "";
      } else if (ch === '"') {
        quoted = !quoted;
      } else if (ch === "," && !quoted) {
        items.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    items.push(current);
    return items.map((item) => item.trim()).filter((item) => item && item !== "NULL").join(", ");
  }

  // Lignes « Cause : … » d'un mémo error_resolutions ; les champs vides sont omis.
  function memoLines(memo, keys) {
    return keys
      .map((key) => {
        const value = key === "files" ? pgArray(memo[key]) : memo[key];
        return value ? `${MEMO_LABELS[key]} : ${value}` : null;
      })
      .filter(Boolean)
      .join("\n");
  }

  // Mémos de la même réponse API, indexés par empreinte et par code (le plus récent).
  let memoIndex = { data: null, byFingerprint: new Map(), byCode: new Map() };

  function memos() {
    if (memoIndex.data === state.data) return memoIndex;
    const byFingerprint = new Map();
    const byCode = new Map();
    const found = find("historique.error_resolutions");
    for (const memo of found ? rowsOf(found.table) : []) {
      if (memo.fingerprint) byFingerprint.set(memo.fingerprint, memo);
      const latest = byCode.get(memo.code);
      if (memo.code && (!latest || String(memo.updated_at) > String(latest.updated_at))) byCode.set(memo.code, memo);
    }
    memoIndex = { data: state.data, byFingerprint, byCode };
    return memoIndex;
  }

  // { text, from } : le guide et la ligne d'où il vient (null s'il n'y a rien à suivre).
  function guideFromMemo(memo, keys, fallback) {
    const text = memo ? memoLines(memo, keys) : "";
    if (!text) return { text: fallback, from: null };
    return { text, from: `error_resolutions ${String(memo.fingerprint || "").slice(0, 10)} · ${fmtDate(memo.updated_at)}` };
  }

  /* Colonnes par table ---------------------------------------------- */

  // sort : colonne SQL utilisée pour le tri ; type : num | date | text.
  // guide : la colonne affiche preset.guide(r) (texte tronqué + bouton plein écran) et se trie sur ce texte.
  const PRESETS = {
    "historique.historique": {
      title: (r) => r.nom,
      badge: (r) => badge(reuse(r.occurrences)),
      when: (r) => r.updated_at,
      guide: (r) => (r.resolution ? { text: r.resolution, from: `historique #${r.id}` } : { text: NO_GUIDE, from: null }),
      columns: [
        { label: "Problème", sort: "nom", main: true, value: (r) => main(r.nom, `#${r.id}`, badge(reuse(r.occurrences))) },
        { label: GUIDE_LABEL, sort: "resolution", guide: true },
        { label: "Occurrences", sort: "occurrences", type: "num", total: true, value: (r) => r.occurrences },
        { label: "Créé", sort: "created_at", type: "date", value: (r) => fmtDate(r.created_at) },
        { label: "Mis à jour", sort: "updated_at", type: "date", value: (r) => fmtDate(r.updated_at) },
      ],
    },
    "historique.error_resolutions": {
      title: (r) => r.code,
      badge: (r) => badge(reuse(r.runs)),
      when: (r) => r.updated_at,
      guide: (r) => guideFromMemo(r, ["cause", "fix", "files", "verification"], NO_GUIDE),
      columns: [
        { label: "Log d'erreur", sort: "code", main: true, value: (r) => main(r.code, String(r.fingerprint || "").slice(0, 10), badge(reuse(r.runs))) },
        { label: GUIDE_LABEL, sort: "cause", guide: true },
        { label: "Tokens", sort: "tokens_used", type: "num", total: true, value: (r) => fmtTokens(r.tokens_used) },
        { label: "Durée", sort: "duration_ms", type: "num", value: (r) => fmtMs(r.duration_ms) },
        { label: "Runs", sort: "runs", type: "num", value: (r) => r.runs },
        { label: "Agent", sort: "agent", value: (r) => r.agent },
        { label: "Mis à jour", sort: "updated_at", type: "date", value: (r) => fmtDate(r.updated_at) },
      ],
    },
    "historique.agent_runs": {
      title: (r) => r.code,
      badge: (r) => badge(r.mode),
      when: (r) => r.ended_at || r.started_at,
      // Le mémo de même empreinte : ce que le prochain agent rejoue au lieu d'un diagnostic complet.
      guide: (r) => guideFromMemo(memos().byFingerprint.get(r.fingerprint), ["fix", "verification"], NO_MEMO),
      columns: [
        { label: "Log d'erreur", sort: "code", main: true, value: (r) => main(r.code, r.run_id, badge(r.mode)) },
        { label: GUIDE_LABEL, sort: "fingerprint", guide: true },
        { label: "Statut", sort: "status", value: (r) => r.status },
        { label: "Durée", sort: "duration_ms", type: "num", value: (r) => fmtMs(r.duration_ms) },
        { label: "Temps agent", sort: "agent_ms", type: "num", value: (r) => fmtMs(r.agent_ms) },
        { label: "Tokens", sort: "tokens_total", type: "num", total: true, value: (r) => fmtTokens(r.tokens_total) },
        { label: "Memo", sort: "memo_hit", value: (r) => (r.memo_hit === "true" ? r.memo_path || "hit" : "no memo") },
        { label: "Agent", sort: "agent", value: (r) => r.agent },
        { label: "Démarré", sort: "started_at", type: "date", value: (r) => fmtDate(r.started_at) },
      ],
    },
    "historique.logs": {
      title: (r) => r.code,
      badge: (r) => severity(r.severity),
      when: (r) => r.received_at,
      // La résolution la plus récente pour le même code d'erreur.
      guide: (r) => guideFromMemo(memos().byCode.get(r.code), ["cause", "fix", "files", "verification"], NO_GUIDE),
      columns: [
        { label: "Log", sort: "code", main: true, value: (r) => main(r.code, r.id, severity(r.severity)) },
        { label: "Message", sort: "message", value: (r) => clamp(r.message) },
        { label: GUIDE_LABEL, sort: "code", guide: true },
        { label: "Kafka", sort: "kafka_offset", type: "num", value: (r) => `${r.topic} · p${r.partition} · #${r.kafka_offset}` },
        { label: "Payload", sort: "payload", value: (r) => clamp(r.payload == null ? null : compactJson(r.payload)) },
        { label: "Survenu", sort: "occurred_at", type: "date", value: (r) => fmtDate(r.occurred_at) },
        { label: "Reçu", sort: "received_at", type: "date", value: (r) => fmtDate(r.received_at) },
      ],
    },
  };

  // Tables sans préréglage : toutes les colonnes, la première en titre.
  function generic(table) {
    const time = table.columns.find((name, i) => table.types[i] === "timestamptz");
    return {
      title: (r) => r[table.columns[0]],
      when: (r) => (time ? r[time] : null),
      columns: table.columns.map((name, i) => {
        const type = table.types[i];
        const kind = /^(int|float|numeric)/.test(type) ? "num" : type === "timestamptz" ? "date" : "text";
        const show = (r) => {
          if (r[name] == null) return "—";
          if (kind === "date") return fmtDate(r[name]);
          if (type === "json" || type === "jsonb") return clamp(compactJson(r[name]));
          return kind === "num" ? r[name] : clamp(r[name]);
        };
        return i === 0
          ? { label: name, sort: name, type: kind, main: true, value: (r) => main(r[name] == null ? "—" : String(r[name])) }
          : { label: name, sort: name, type: kind, value: show };
      }),
    };
  }

  /* Squelette -------------------------------------------------------- */

  const toggle = el("button", "btn btn-ghost btn-sm obs-history-toggle", "Historique");
  toggle.type = "button";
  toggle.title = "Base pg-memoire (Aiven PostgreSQL) au format Observability";
  toggle.setAttribute("aria-pressed", "false");
  toggle.setAttribute("aria-controls", "obsHistory");
  toolbar.prepend(toggle);

  const refresh = el("button", "btn btn-ghost btn-sm obs-history-only", "Rafraîchir");
  refresh.type = "button";
  toolbar.append(refresh);

  let dump = null;
  if (DUMP_ENDPOINT) {
    dump = el("a", "btn btn-ghost btn-sm obs-history-only", "SQL dump");
    dump.setAttribute("download", "");
    toolbar.append(dump);
  }

  const titles = section.querySelector(".obs-titles");
  const heading = titles && titles.querySelector("h2");
  if (heading) heading.append(el("span", "obs-history-only", " · Historique"));
  if (titles) {
    titles.append(
      el("p", "obs-history-only obs-history-sub", "historique = contenu de la base pg-memoire (Aiven PostgreSQL) · lecture seule · secrets masqués"),
    );
  }

  const actions = section.querySelector(".obs-actions");
  if (actions) {
    const source = el("span", "obs-source obs-history-only", "source · pg-memoire");
    source.dataset.source = "postgres";
    actions.append(source);
  }

  const panel = el("div", "obs-history");
  panel.id = "obsHistory";

  const tabs = el("div", "obs-history-tables");
  tabs.setAttribute("role", "toolbar");
  tabs.setAttribute("aria-label", "Tables pg-memoire");

  const kpisEl = el("div", "obs-kpis");
  kpisEl.setAttribute("aria-live", "polite");

  const wrap = el("div", "obs-table-wrap");
  const tableEl = el("table", "obs-table");
  const caption = el("caption");
  const thead = el("thead");
  const tbody = el("tbody");
  tableEl.append(caption, thead, tbody);
  wrap.append(tableEl);

  const legend = el("p", "obs-legend");
  legend.append(
    badge("cold"),
    " première résolution · ",
    badge("warm"),
    " problème déjà vu, résolution réutilisée depuis la base · ",
    badge("warm_degraded", "wrn"),
    " avertissement · lecture seule, secrets masqués, cache 30 s",
  );

  panel.append(tabs, kpisEl, wrap, legend);
  body.append(panel);

  // Plein écran du guide : un seul <dialog>, réutilisé pour chaque ligne.
  const dialog = el("dialog", "obs-guide-dialog");
  dialog.setAttribute("aria-labelledby", "obsGuideTitle");

  const dialogHead = el("header", "obs-guide-head");
  const dialogTitles = el("div", "obs-guide-titles");
  const dialogTitle = el("h3", null, "Guide");
  dialogTitle.id = "obsGuideTitle";
  dialogTitles.append(el("span", "obs-guide-kicker", "Guide · prochain agent"), dialogTitle);
  const dialogBadge = el("span", "obs-guide-badge");
  dialogHead.append(dialogTitles, dialogBadge);

  const dialogBody = el("div", "obs-guide-body");
  const dialogText = el("pre", "obs-guide-text");
  const dialogMeta = el("dl", "obs-fields obs-guide-meta");
  dialogBody.append(dialogText, dialogMeta);

  const dialogFoot = el("footer", "obs-guide-foot");
  const dialogStatus = el("span", "obs-guide-status");
  dialogStatus.setAttribute("role", "status");
  const copyButton = el("button", "btn btn-primary btn-sm", "Copier le guide");
  copyButton.type = "button";
  const closeButton = el("button", "btn btn-ghost btn-sm", "Fermer");
  closeButton.type = "button";
  dialogFoot.append(dialogStatus, copyButton, closeButton);

  dialog.append(dialogHead, dialogBody, dialogFoot);
  document.body.append(dialog);

  const guideView = { entry: null, opener: null };

  const state = {
    data: null,
    current: "historique.historique",
    sort: { index: null, dir: -1 },
    expanded: new Set(),
    counts: null,
    down: new Set(),
    timer: null,
    busy: false,
    loadedAt: 0,
  };

  /* Données ---------------------------------------------------------- */

  const tables = () => (state.data ? state.data.databases.flatMap((db) => db.tables.map((table) => ({ db, table }))) : []);
  const find = (key) => tables().find(({ db, table }) => `${db.name}.${table.name}` === key) || null;
  const rowsOf = (table) => table.sample.map((values) => Object.fromEntries(table.columns.map((name, i) => [name, values[i]])));
  const rowId = (r, i) => String(r.run_id ?? r.fingerprint ?? r.id ?? r.seq ?? i);
  const sum = (rows, key) => rows.reduce((total, r) => total + (num(r[key]) || 0), 0);
  const sampled = (table) => (table.rows > table.sample.length ? ` · ${table.sample.length} derniers` : "");

  function sortRows(rows, column, dir, guide) {
    const value = (r) => {
      if (column.guide) return guide(r).text;
      return column.type === "num" ? num(r[column.sort]) : r[column.sort];
    };
    return [...rows].sort((a, b) => {
      const av = value(a.r);
      const bv = value(b.r);
      if (av == null) return 1;
      if (bv == null) return -1;
      if (column.type === "num") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }

  /* Rendu ------------------------------------------------------------ */

  function emptyRow(text, span) {
    const tr = el("tr");
    const td = el("td", "obs-empty", text);
    td.colSpan = span;
    tr.append(td);
    return tr;
  }

  function renderKpis() {
    const cards = [];
    const historique = find("historique.historique");
    const memos = find("historique.error_resolutions");
    const runs = find("historique.agent_runs");
    const logs = find("historique.logs");

    if (historique) {
      const rows = rowsOf(historique.table);
      cards.push(kpi("Problèmes connus", String(historique.table.rows), `${sum(rows, "occurrences")} occurrences${sampled(historique.table)}`));
    }

    if (memos) {
      const rows = rowsOf(memos.table);
      cards.push(kpi("Mémos de résolution", String(memos.table.rows), `${sum(rows, "runs")} runs · ${fmtTokens(sum(rows, "tokens_used"))} tokens${sampled(memos.table)}`));
    }

    if (runs) {
      const rows = rowsOf(runs.table);
      const count = (test) => rows.filter(test).length;
      const hits = count((r) => r.memo_hit === "true");
      cards.push(
        kpi("Runs d'agents", String(runs.table.rows), `${count((r) => r.mode === "cold")} cold · ${count((r) => r.mode === "warm")} warm · ${count((r) => r.status !== "resolved")} failed`),
        kpi("Memo hit rate", rows.length ? `${Math.round((hits / rows.length) * 100)} %` : "—", `${hits} / ${rows.length} runs`, hits ? "gain" : null),
        kpi("Tokens des runs", fmtTokens(sum(rows, "tokens_total")), `${fmtMs(sum(rows, "duration_ms"))} au total${sampled(runs.table)}`),
      );
    }

    if (logs) {
      const rows = rowsOf(logs.table);
      const last = rows.map((r) => r.received_at).filter(Boolean).sort().pop();
      cards.push(kpi("Logs reçus", String(logs.table.rows), last ? `dernier ${fmtDate(last)}` : "aucun"));
    }

    const all = tables();
    cards.push(
      kpi("Lignes", String(all.reduce((total, { table }) => total + table.rows, 0)), `${plural(all.length, "table")} · ${plural(state.data.databases.length, "base")}`),
      kpi("PostgreSQL", state.data.version || "—", state.data.databases.map((db) => `${db.name} ${db.size || "indisponible"}`).join(" · ")),
    );

    kpisEl.replaceChildren(...cards);
  }

  function renderTabs() {
    tabs.replaceChildren();

    for (const db of state.data.databases) {
      tabs.append(el("span", "obs-history-db", db.name));
      if (db.error) tabs.append(badge("cold", "indisponible"));

      for (const table of db.tables) {
        const key = `${db.name}.${table.name}`;
        const button = el("button", "btn btn-ghost btn-sm", `${table.name} · ${table.rows}`);
        button.type = "button";
        button.dataset.table = key;
        button.dataset.empty = String(table.rows === 0);
        button.setAttribute("aria-pressed", String(key === state.current));
        tabs.append(button);
      }
    }
  }

  function detailRow(preset, table, r, span) {
    const tr = el("tr", "obs-detail");
    const td = el("td");
    td.colSpan = span;

    const card = el("article", "obs-run");
    card.dataset.status = r.status === "failed" || r.status === "abandoned" ? "failed" : "resolved";

    const top = el("div", "obs-run-top");
    const title = el("div", "obs-run-title");
    title.append(el("strong", null, preset.title(r) == null ? "—" : String(preset.title(r))));
    if (preset.badge) title.append(preset.badge(r));
    top.append(title);
    const when = preset.when(r);
    if (when) top.append(el("time", null, fmtDate(when)));
    card.append(top);

    const list = r.steps ? parseJson(r.steps) : null;
    if (Array.isArray(list) && list.length) card.append(steps(list));

    const fields = el("dl", "obs-fields");
    if (preset.guide) {
      const info = preset.guide(r);
      fields.append(el("dt", null, "guide"), el("dd", "obs-guide-full", info.text));
      if (info.from) fields.append(el("dt", null, "source du guide"), el("dd", null, info.from));
    }
    table.columns.forEach((name, i) => {
      const type = table.types[i];
      let value = r[name];
      if (value == null) value = "null";
      else if (type === "timestamptz") value = fmtFull(value);
      else if (type === "json" || type === "jsonb") value = JSON.stringify(parseJson(value) ?? value, null, 2);
      fields.append(el("dt", null, name), el("dd", null, value));
    });
    if (table.hidden.length) fields.append(el("dt", null, "masqué"), el("dd", null, table.hidden.join(", ")));
    card.append(fields);

    td.append(card);
    tr.append(td);
    return tr;
  }

  // Cellule Guide : texte tronqué + bouton plein écran, qui ne déplie pas la ligne.
  function guideCell(preset, table, key, r, id) {
    const info = preset.guide(r);
    const title = preset.title(r) == null ? "—" : String(preset.title(r));
    const open = el("button", "btn btn-ghost btn-sm obs-guide-open", "Plein écran");
    open.type = "button";
    open.dataset.id = id;
    open.title = "Ouvrir le guide en plein écran";
    open.setAttribute("aria-label", `Ouvrir le guide en plein écran — ${title}`);
    open.setAttribute("aria-haspopup", "dialog");
    open.addEventListener("click", (event) => {
      event.stopPropagation();
      openGuide({ preset, table, key, r, id, info, title }, open);
    });
    // Entrée / Espace activent le bouton, pas le dépliage de la ligne.
    open.addEventListener("keydown", (event) => event.stopPropagation());

    const box = el("div", "obs-guide");
    box.append(clamp(info.text), open);
    return box;
  }

  const META_KEYS = [
    "id", "run_id", "fingerprint", "code", "mode", "status", "severity", "occurrences", "runs", "attempt",
    "agent", "topic", "created_at", "updated_at", "started_at", "ended_at", "occurred_at", "received_at",
  ];

  function openGuide(entry, opener) {
    guideView.entry = entry;
    guideView.opener = opener;
    dialogTitle.textContent = entry.title;
    dialogBadge.replaceChildren(...(entry.preset.badge ? [entry.preset.badge(entry.r)] : []));
    dialogText.textContent = entry.info.text;
    dialogStatus.textContent = "";

    const meta = [["table", entry.key]];
    if (entry.info.from) meta.push(["source du guide", entry.info.from]);
    META_KEYS.forEach((name) => {
      const i = entry.table.columns.indexOf(name);
      const value = entry.r[name];
      if (i === -1 || value == null || value === "") return;
      meta.push([name, entry.table.types[i] === "timestamptz" ? fmtFull(value) : value]);
    });
    dialogMeta.replaceChildren(...meta.flatMap(([name, value]) => [el("dt", null, name), el("dd", null, value)]));

    dialog.showModal();
    dialogBody.scrollTop = 0;
  }

  function renderTable() {
    const found = find(state.current);

    if (!found) {
      caption.textContent = "pg-memoire";
      thead.replaceChildren();
      tbody.replaceChildren(emptyRow("Aucune table lisible.", 1));
      return;
    }

    const { db, table } = found;
    const preset = PRESETS[`${db.name}.${table.name}`] || generic(table);
    const columns = preset.columns;

    const bits = [`${db.name}.${table.name}`, plural(table.rows, "ligne")];
    if (table.rows > table.sample.length) bits.push(`${table.sample.length} plus récentes`);
    if (table.orderBy) bits.push(`tri ${table.orderBy} ↓`);
    if (table.hidden.length) bits.push(`colonnes masquées : ${table.hidden.join(", ")}`);
    caption.textContent = `${bits.join(" · ")}. Cliquez une ligne pour le détail.`;

    const head = el("tr");
    columns.forEach((column, i) => {
      const th = el("th", null, column.label);
      th.scope = "col";
      th.dataset.index = String(i);
      if (state.sort.index === i) th.dataset.sorted = state.sort.dir < 0 ? "desc" : "asc";
      th.tabIndex = 0;
      th.setAttribute("role", "button");
      th.title = "Trier";
      head.append(th);
    });
    thead.replaceChildren(head);

    let rows = rowsOf(table).map((r, i) => ({ r, id: rowId(r, i) }));
    if (state.sort.index != null && columns[state.sort.index]) rows = sortRows(rows, columns[state.sort.index], state.sort.dir, preset.guide);

    tbody.replaceChildren();

    if (!rows.length) {
      tbody.append(emptyRow(`Table vide — ${plural(table.columns.length, "colonne")}, aucune ligne pour l'instant.`, columns.length));
      return;
    }

    rows.forEach(({ r, id }) => {
      const open = state.expanded.has(id);
      const tr = el("tr", "obs-row");
      tr.dataset.id = id;
      tr.tabIndex = 0;
      tr.setAttribute("aria-expanded", String(open));
      columns.forEach((column) => {
        if (column.guide) {
          tr.append(cell(column.label, guideCell(preset, table, `${db.name}.${table.name}`, r, id), "obs-cell-guide"));
          return;
        }
        tr.append(cell(column.label, column.value(r), column.main ? "obs-cell-main" : column.total ? "obs-cell-total" : null));
      });
      tbody.append(tr);
      if (open) tbody.append(detailRow(preset, table, r, columns.length));
    });
  }

  function renderStatus(text) {
    caption.textContent = "pg-memoire";
    thead.replaceChildren();
    kpisEl.replaceChildren();
    tbody.replaceChildren(emptyRow(text, 1));
  }

  function render() {
    renderTabs();
    renderKpis();
    renderTable();
    if (dump) {
      const database = state.current.split(".")[0];
      dump.href = `${DUMP_ENDPOINT}?db=${encodeURIComponent(database)}`;
      dump.title = `Télécharger ${database} en SQL`;
    }
  }

  /* Chargement ------------------------------------------------------- */

  function apply(data, reason, ms) {
    const counts = new Map();
    for (const db of data.databases) for (const table of db.tables) counts.set(`${db.name}.${table.name}`, table.rows);

    if (reason === "auto" && state.counts) {
      for (const [key, n] of counts) {
        const before = state.counts.get(key);
        if (before === undefined) log("inf", `pg-memoire · new table ${key}`);
        else if (before !== n) log(n > before ? "ok" : "wrn", `pg-memoire · ${key} ${before} → ${n} rows`);
      }
    } else {
      const rows = [...counts.values()].reduce((a, b) => a + b, 0);
      log("inf", `GET ${ENDPOINT} 200 · ${data.databases.length} db · ${counts.size} tables · ${rows} rows · ${ms} ms`);
    }

    // Une base indisponible n'est signalée qu'au moment où elle tombe.
    const down = new Set(data.databases.filter((db) => db.error).map((db) => db.name));
    for (const name of down) if (!state.down.has(name)) log("wrn", `pg-memoire · database ${name} unavailable`);
    state.down = down;

    state.data = data;
    state.counts = counts;
    if (!find(state.current)) {
      const first = tables().find(({ table }) => table.rows > 0) || tables()[0];
      state.current = first ? `${first.db.name}.${first.table.name}` : state.current;
    }
    render();
  }

  async function load(reason) {
    if (state.busy) return;
    state.busy = true;
    refresh.disabled = true;
    if (!state.data) renderStatus("Chargement de pg-memoire…");

    const started = performance.now();

    try {
      const response = await fetch(ENDPOINT, { headers: { Accept: "application/json" } });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || !Array.isArray(data.databases)) throw new Error(`HTTP ${response.status}`);
      apply(data, reason, Math.round(performance.now() - started));
    } catch (error) {
      log("wrn", `GET ${ENDPOINT} failed · ${error.message}`);
      if (!state.data) renderStatus(`pg-memoire injoignable (${error.message}) — nouvel essai dans ${REFRESH_MS / 1000} s.`);
    } finally {
      state.busy = false;
      refresh.disabled = false;
      state.loadedAt = Date.now();
      schedule();
    }
  }

  // Rafraîchissement seulement quand l'historique est affiché et l'onglet visible.
  function schedule() {
    clearTimeout(state.timer);
    if (section.dataset.view !== "historique") return;
    state.timer = setTimeout(() => {
      if (document.visibilityState === "visible") load("auto");
      else schedule();
    }, REFRESH_MS);
  }

  function setView(on) {
    if (on) section.dataset.view = "historique";
    else delete section.dataset.view;
    toggle.setAttribute("aria-pressed", String(on));
    try {
      history.replaceState(null, "", on ? "#historique" : "#observabilite");
    } catch {
      /* URL non modifiable (file://) : sans importance */
    }
    if (on && (!state.data || Date.now() - state.loadedAt > REFRESH_MS)) load("open");
    else schedule();
  }

  /* Interactions ----------------------------------------------------- */

  function focusRow(id) {
    const row = [...tbody.querySelectorAll("tr.obs-row")].find((tr) => tr.dataset.id === id);
    if (row) row.focus();
  }

  function toggleRow(id) {
    if (state.expanded.has(id)) state.expanded.delete(id);
    else state.expanded.add(id);
    renderTable();
    focusRow(id);
  }

  toggle.addEventListener("click", () => setView(section.dataset.view !== "historique"));
  refresh.addEventListener("click", () => load("manual"));

  // Échap ferme nativement le <dialog> ; Fermer et un clic sur le fond aussi.
  closeButton.addEventListener("click", () => dialog.close());

  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    const inside =
      event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
    if (!inside) dialog.close();
  });

  // Le focus revient au bouton d'origine, même si le tableau a été re-rendu entre-temps.
  dialog.addEventListener("close", () => {
    const { entry, opener } = guideView;
    const target =
      opener && opener.isConnected
        ? opener
        : [...tbody.querySelectorAll(".obs-guide-open")].find((button) => entry && button.dataset.id === entry.id);
    if (target) target.focus();
    guideView.entry = null;
    guideView.opener = null;
  });

  copyButton.addEventListener("click", async () => {
    const { entry } = guideView;
    if (!entry) return;
    try {
      await navigator.clipboard.writeText(entry.info.text);
      dialogStatus.textContent = "Guide copié";
      log("ok", `guide copié · ${entry.key} · ${entry.title}`);
    } catch {
      // Presse-papiers refusé : le texte est sélectionné pour une copie manuelle.
      const range = document.createRange();
      range.selectNodeContents(dialogText);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      dialogStatus.textContent = "Copie bloquée par le navigateur — texte sélectionné, faites Ctrl+C";
    }
  });

  tabs.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-table]");
    if (!button) return;
    state.current = button.dataset.table;
    state.sort = { index: null, dir: -1 };
    state.expanded.clear();
    render();
  });

  tbody.addEventListener("click", (event) => {
    const tr = event.target.closest("tr.obs-row");
    if (tr) toggleRow(tr.dataset.id);
  });

  tbody.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const tr = event.target.closest("tr.obs-row");
    if (!tr) return;
    event.preventDefault();
    toggleRow(tr.dataset.id);
  });

  thead.addEventListener("click", (event) => {
    const th = event.target.closest("th[data-index]");
    if (!th) return;
    const index = Number(th.dataset.index);
    if (state.sort.index === index) state.sort.dir *= -1;
    else state.sort = { index, dir: -1 };
    renderTable();
  });

  thead.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const th = event.target.closest("th[data-index]");
    if (!th) return;
    event.preventDefault();
    th.click();
  });

  if (dump) {
    // Le fichier est récupéré puis remis au navigateur : une erreur reste dans le terminal.
    dump.addEventListener("click", async (event) => {
      event.preventDefault();
      const url = dump.getAttribute("href");
      dump.setAttribute("aria-busy", "true");
      try {
        const response = await fetch(url, { headers: { Accept: "application/sql" } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        const name =
          (response.headers.get("Content-Disposition") || "").match(/filename="([^"]+)"/)?.[1] || "pg-memoire.sql";
        const href = URL.createObjectURL(blob);
        const link = el("a");
        link.href = href;
        link.download = name;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(href), 10000);
        log("ok", `GET ${url} 200 · ${Math.max(1, Math.round(blob.size / 1024))} kb · ${name}`);
      } catch (error) {
        log("err", `GET ${url} failed · ${error.message}`);
      } finally {
        dump.removeAttribute("aria-busy");
      }
    });
  }

  load("initial");

  if (window.location.hash === "#historique") {
    setView(true);
    section.scrollIntoView();
  }
})();
