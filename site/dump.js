/* ------------------------------------------------------------------ */
/* Bouton « SQL dump » — export .sql de la base pg-memoire            */
/*                                                                    */
/* S'ajoute dans l'en-tete du panneau db (db.js). Aucune dependance :  */
/* si le panneau est absent, le bouton se place dans la barre du haut. */
/* ------------------------------------------------------------------ */

(() => {
  const ENDPOINT = "/api/dump";
  const DEFAULT_DB = "historique";

  const log = (level, text) => {
    if (typeof addRow === "function") addRow(level, text);
  };

  const clock = () => new Date().toLocaleTimeString("en-GB", { hour12: false });

  /* Cible : en-tete du panneau db, sinon barre du haut ----------------- */

  const head = document.querySelector(".db-head");
  const host = head || document.querySelector(".topbar-actions");
  if (!host) return;

  /* Base affichee par le panneau -------------------------------------- */

  const activeDatabase = () => {
    const tab = document.querySelector('.db-tabs .db-tab[aria-pressed="true"]');
    const group = tab && tab.closest(".db-group");
    const name = group && group.querySelector(".db-group-name");
    return (name && name.textContent.trim()) || DEFAULT_DB;
  };

  /* Bouton ------------------------------------------------------------ */

  const button = document.createElement("a");
  button.id = "dumpSql";
  button.className = head ? "btn btn-sm btn-ghost" : "btn btn-ghost btn-sql";
  button.download = "";
  button.setAttribute("aria-label", "Download the pg-memoire database as a .sql file");

  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M11 3h2v9h3.5L12 17.5 7.5 12H11V3ZM5 19h14v2H5v-2Z");
  icon.append(path);

  const label = document.createElement("span");
  label.className = "btn-sql-label";
  label.textContent = "SQL dump";

  const short = document.createElement("span");
  short.className = "btn-sql-short";
  short.textContent = "SQL";

  button.append(icon, label, short);
  host.append(button);

  /* Synchronisation avec la base ouverte ------------------------------ */

  function sync() {
    const database = activeDatabase();
    button.href = `${ENDPOINT}?db=${encodeURIComponent(database)}`;
    button.dataset.db = database;
    button.title = `Download ${database} as SQL (schema + data)`;
  }

  sync();

  // Le panneau change de base sans rechargement : on suit ses onglets.
  const tabs = document.querySelector(".db-tabs");
  if (tabs) tabs.addEventListener("click", () => setTimeout(sync, 0));

  /* Telechargement ---------------------------------------------------- */

  button.addEventListener("click", async (event) => {
    const url = button.getAttribute("href");
    const database = activeDatabase();

    event.preventDefault();
    button.setAttribute("aria-busy", "true");

    try {
      // Un seul appel reseau : le fichier est recupere en memoire puis remis
      // au navigateur. En cas d'erreur, on reste sur la page (pas de
      // navigation vers une reponse JSON d'erreur).
      const response = await fetch(url, { headers: { Accept: "application/sql" } });

      if (!response.ok) {
        // 503 : PG_MEMOIRE_URL absent cote Vercel. 502 : base injoignable.
        const reason = response.status === 503 ? "not configured" : `HTTP ${response.status}`;
        throw new Error(reason);
      }

      const blob = await response.blob();
      const name =
        (response.headers.get("Content-Disposition") || "").match(/filename="([^"]+)"/)?.[1] ||
        `pg-memoire-${database}.sql`;

      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = name;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(href), 10000);

      const kb = Math.max(1, Math.round(blob.size / 1024));
      log("ok", `GET ${ENDPOINT}?db=${database} 200 · ${kb} kb · ${name}`);
      if (typeof setStatus === "function") setStatus("dump ready");
    } catch (error) {
      log("err", `GET ${ENDPOINT}?db=${database} failed · ${error.message} · dump SQL indisponible`);
      if (typeof setStatus === "function") setStatus("dump unavailable");
    } finally {
      button.removeAttribute("aria-busy");
    }
  });
})();
