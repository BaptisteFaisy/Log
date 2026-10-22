// Vercel Function : contenu de la base PostgreSQL Aiven « pg-memoire », en lecture seule.
//
// Variables d'environnement (Vercel > Settings > Environment Variables, jamais dans le depot) :
//   PG_MEMOIRE_URL        postgres://hote:port/base  (utilisateur + mot de passe inclus dans l URL)
//   PG_MEMOIRE_CA         certificat CA du projet Aiven (PEM, ou PEM encode en base64)
//   PG_MEMOIRE_DATABASES  bases affichees (defaut : historique)
//   PG_MEMOIRE_TIMEOUT_MS delai max de connexion / requete (defaut : 8000)

const { Client } = require("pg");
const { PRIVATE_NAME, PRIVATE_COLUMN, redact } = require("./_redact");

// Seule la base « historique » est publiee : « defaultdb » (demo pgvector du
// hackathon, jamais alimentee) n'apportait que 4 tables vides a l'ecran.
const DATABASES = (process.env.PG_MEMOIRE_DATABASES || "historique")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

const SAMPLE_ROWS = 25;
const CELL_CHARS = 320;
const TIMEOUT_MS = Number(process.env.PG_MEMOIRE_TIMEOUT_MS) || 8000;
const CACHE_OK = "public, max-age=0, s-maxage=30, stale-while-revalidate=300";
const CACHE_ERROR = "public, max-age=0, s-maxage=10";

const KINDS = { r: "table", p: "table", v: "view", m: "view" };

// Colonnes illisibles ou volumineuses : signalees, jamais renvoyees.
const HIDDEN_TYPES = new Set(["tsvector", "tsquery", "vector", "halfvec", "sparsevec", "bytea"]);

// Colonne de tri : la plus recente d'abord.
const ORDER_HINTS = ["updated_at", "received_at", "inserted_at", "started_at", "occurred_at", "created_at", "last_seen_at", "seq", "id"];

function cell(value) {
  if (value === null || value === undefined) return null;
  const text = redact(String(value));
  return text.length > CELL_CHARS ? `${text.slice(0, CELL_CHARS - 1)}…` : text;
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function typeName(column) {
  return column.type.startsWith("_") ? `${column.type.slice(1)}[]` : column.type;
}

function readCa() {
  const raw = (process.env.PG_MEMOIRE_CA || "").trim();
  if (!raw) return undefined;
  return raw.includes("BEGIN CERTIFICATE") ? raw.replace(/\\n/g, "\n") : Buffer.from(raw, "base64").toString("utf8");
}

function connectionFor(database) {
  const url = new URL(process.env.PG_MEMOIRE_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    // Verification complete du certificat : sans PG_MEMOIRE_CA la connexion echoue (fail closed).
    ssl: { ca: readCa(), servername: url.hostname, rejectUnauthorized: true },
    application_name: "log-site/pg-memoire",
    connectionTimeoutMillis: TIMEOUT_MS,
    query_timeout: TIMEOUT_MS,
  };
}

// Tables et colonnes lisibles du schema public, en une seule requete.
const CATALOG_SQL = `
  SELECT c.relname AS name,
         c.relkind AS kind,
         json_agg(json_build_object('name', a.attname, 'type', t.typname) ORDER BY a.attnum) AS columns
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  JOIN pg_type t ON t.oid = a.atttypid
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p', 'v', 'm')
    AND NOT c.relispartition
    AND has_table_privilege(c.oid, 'SELECT')
  GROUP BY c.oid, c.relname, c.relkind
  ORDER BY c.relname`;

function selectExpression(column) {
  const id = quoteIdent(column.name);
  if (column.type === "timestamptz") return `to_char(${id} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
  return `left(${id}::text, 2000)`;
}

async function readDatabase(database) {
  const client = new Client(connectionFor(database));
  // Une coupure en cours de lecture ne doit pas faire planter la fonction.
  client.on("error", (error) => console.error(`pg-memoire/${database} : ${error.message}`));
  await client.connect();

  try {
    // Transaction en lecture seule : aucune ecriture possible, meme si le compte en a le droit.
    await client.query("BEGIN READ ONLY; SET LOCAL statement_timeout = '4s'; SET LOCAL lock_timeout = '1s'");

    const {
      rows: [meta],
    } = await client.query(
      "SELECT current_setting('server_version') AS version, pg_size_pretty(pg_database_size(current_database())) AS size",
    );

    const { rows: catalog } = await client.query(CATALOG_SQL);
    const relations = catalog.filter((relation) => !PRIVATE_NAME.test(relation.name));

    let counts = {};
    if (relations.length) {
      const list = relations.map((relation, i) => `(SELECT count(*)::int FROM ${quoteIdent(relation.name)}) AS c${i}`);
      ({
        rows: [counts],
      } = await client.query(`SELECT ${list.join(", ")}`));
    }

    const tables = [];

    for (const [i, relation] of relations.entries()) {
      const isHidden = (column) => HIDDEN_TYPES.has(column.type) || PRIVATE_COLUMN.test(column.name);
      const shown = relation.columns.filter((column) => !isHidden(column));
      const hidden = relation.columns.filter(isHidden).map((column) => column.name);
      const orderBy = ORDER_HINTS.find((hint) => shown.some((column) => column.name === hint)) || null;
      const total = counts[`c${i}`];

      let sample = [];

      if (shown.length && total > 0) {
        const order = orderBy ? ` ORDER BY ${quoteIdent(orderBy)} DESC NULLS LAST` : "";
        const { rows } = await client.query({
          text: `SELECT ${shown.map(selectExpression).join(", ")} FROM ${quoteIdent(relation.name)}${order} LIMIT ${SAMPLE_ROWS}`,
          rowMode: "array",
        });
        sample = rows.map((row) => row.map(cell));
      }

      tables.push({
        name: relation.name,
        kind: KINDS[relation.kind],
        rows: total,
        orderBy,
        columns: shown.map((column) => column.name),
        types: shown.map(typeName),
        hidden,
        sample,
      });
    }

    // La fermeture de la connexion termine la transaction (rien a valider).
    return { name: database, version: meta.version, size: meta.size, tables };
  } finally {
    await client.end().catch(() => {});
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    res.end();
    return;
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (!process.env.PG_MEMOIRE_URL) {
    res.statusCode = 503;
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ error: "not_configured" }));
    return;
  }

  const started = Date.now();
  const results = await Promise.allSettled(DATABASES.map(readDatabase));

  const databases = results.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    // Le detail reste dans les logs Vercel : jamais renvoye au navigateur.
    console.error(`pg-memoire/${DATABASES[index]} : ${result.reason && result.reason.message}`);
    return { name: DATABASES[index], error: "unavailable", tables: [] };
  });

  const live = databases.find((database) => !database.error);

  res.statusCode = live ? 200 : 502;
  res.setHeader("Cache-Control", live ? CACHE_OK : CACHE_ERROR);
  res.end(
    JSON.stringify({
      service: "pg-memoire",
      provider: "Aiven for PostgreSQL",
      version: live ? live.version : null,
      readOnly: true,
      generatedAt: new Date().toISOString(),
      tookMs: Date.now() - started,
      databases,
    }),
  );
};
