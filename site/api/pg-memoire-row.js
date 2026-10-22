// Vercel Function : une ligne entiere d'une table de la base Aiven « pg-memoire »,
// en lecture seule.
//
// Pourquoi cette route existe : /api/pg-memoire tronque chaque cellule a 320
// caracteres, ce qui suffit a remplir un tableau mais pas a lire la resolution
// d'un bug. Le panneau (db.js) ouvre donc une popup qui demande ici la ligne
// complete, une seule a la fois.
//
// Variables d'environnement (les memes que /api/pg-memoire) :
//   PG_MEMOIRE_URL        postgres://hote:port/base  (utilisateur + mot de passe inclus dans l URL)
//   PG_MEMOIRE_CA         certificat CA du projet Aiven (PEM, ou PEM encode en base64)
//   PG_MEMOIRE_DATABASES  bases interrogeables (defaut : historique)
//   PG_MEMOIRE_TIMEOUT_MS delai max de connexion / requete (defaut : 8000)
//
// GET /api/pg-memoire-row?db=historique&table=historique&id=42

const { Client } = require("pg");
const { PRIVATE_NAME, PRIVATE_COLUMN, redact } = require("./_redact");

// Seule la base « historique » est interrogeable : « defaultdb » (demo pgvector
// du hackathon, jamais alimentee) est retiree du site.
const DATABASES = (process.env.PG_MEMOIRE_DATABASES || "historique")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

// Volontairement large : une resolution peut faire plusieurs paragraphes.
const CELL_CHARS = 20000;
const TIMEOUT_MS = Number(process.env.PG_MEMOIRE_TIMEOUT_MS) || 8000;
const CACHE_OK = "public, max-age=0, s-maxage=30, stale-while-revalidate=300";
const CACHE_ERROR = "public, max-age=0, s-maxage=10";

const KINDS = { r: "table", p: "table", v: "view", m: "view" };

// Colonnes illisibles ou volumineuses : signalees, jamais renvoyees.
const HIDDEN_TYPES = new Set(["tsvector", "tsquery", "vector", "halfvec", "sparsevec", "bytea"]);

// Identifiant de table : jamais de SQL construit avec autre chose que ce motif.
const TABLE_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
// Cle de ligne : entier, uuid ou texte simple. Tout le reste est refuse.
const KEY_RE = /^[A-Za-z0-9_.:-]{1,200}$/;

// Une cellule complete, masquee puis bornee. Renvoie [texte, tronque].
function cell(value) {
  if (value === null || value === undefined) return [null, false];
  const text = redact(String(value));
  if (text.length <= CELL_CHARS) return [text, false];
  return [`${text.slice(0, CELL_CHARS - 1)}…`, true];
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
    application_name: "log-site/pg-memoire-row",
    connectionTimeoutMillis: TIMEOUT_MS,
    query_timeout: TIMEOUT_MS,
  };
}

const RELATION_SQL = `
  SELECT c.oid AS oid, c.relname AS name, c.relkind AS kind
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = $1
    AND c.relkind IN ('r', 'p', 'v', 'm')
    AND NOT c.relispartition
    AND has_table_privilege(c.oid, 'SELECT')`;

const COLUMNS_SQL = `
  SELECT a.attname AS name,
         t.typname AS type,
         COALESCE(i.indisprimary, false) AS primary
  FROM pg_attribute a
  JOIN pg_type t ON t.oid = a.atttypid
  LEFT JOIN pg_index i
         ON i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY (i.indkey)
  WHERE a.attrelid = $1
    AND a.attnum > 0
    AND NOT a.attisdropped
  ORDER BY a.attnum`;

// La valeur demandee est comparee en texte : aucune conversion de type a deviner,
// et un id errone ne peut pas faire echouer la requete.
function selectExpression(column) {
  const id = quoteIdent(column.name);
  if (column.type === "timestamptz") return `to_char(${id} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
  return `left(${id}::text, ${CELL_CHARS})`;
}

// Colonne qui identifie une ligne. Doit rester alignee sur keyColumn() de
// /api/pg-memoire : le panneau envoie cette colonne en parametre.
function keyColumn(columns, wanted) {
  const shown = columns.filter((column) => !HIDDEN_TYPES.has(column.type) && !PRIVATE_COLUMN.test(column.name));
  const names = shown.map((column) => column.name);
  if (wanted && names.includes(wanted)) return shown.find((column) => column.name === wanted);
  const primary = columns.find((column) => column.primary);
  if (primary && names.includes(primary.name)) return shown.find((column) => column.name === primary.name);
  const id = shown.find((column) => column.name === "id");
  return id || null;
}

async function readRow(database, table, key, wanted) {
  const client = new Client(connectionFor(database));
  client.on("error", (error) => console.error(`pg-memoire-row/${database} : ${error.message}`));
  await client.connect();

  try {
    // Transaction en lecture seule : aucune ecriture possible, meme si le compte en a le droit.
    await client.query("BEGIN READ ONLY; SET LOCAL statement_timeout = '4s'; SET LOCAL lock_timeout = '1s'");

    const {
      rows: [relation],
    } = await client.query(RELATION_SQL, [table]);
    if (!relation) return { error: "unknown_table" };

    const { rows: columns } = await client.query(COLUMNS_SQL, [relation.oid]);
    if (!columns.length) return { error: "unknown_table" };

    const shown = columns.filter((column) => !HIDDEN_TYPES.has(column.type) && !PRIVATE_COLUMN.test(column.name));
    const hidden = columns.filter((column) => !shown.includes(column)).map((column) => column.name);
    if (!shown.length) return { error: "unknown_table" };

    // Colonne cle : celle annoncee par le panneau, sinon la cle primaire, sinon « id ».
    const primary = keyColumn(columns, wanted);
    if (!primary) return { error: "no_primary_key" };

    const { rows } = await client.query({
      text: `SELECT ${shown.map(selectExpression).join(", ")}
               FROM ${quoteIdent(relation.name)}
              WHERE ${quoteIdent(primary.name)}::text = $1
              LIMIT 1`,
      values: [key],
      rowMode: "array",
    });

    if (!rows.length) return { error: "row_not_found" };

    let truncated = false;
    const values = rows[0].map((value) => {
      const [text, cut] = cell(value);
      if (cut) truncated = true;
      return text;
    });

    return {
      row: {
        database,
        table: relation.name,
        kind: KINDS[relation.kind],
        primaryKey: primary.name,
        key,
        columns: shown.map((column) => ({ name: column.name, type: typeName(column) })),
        values,
        hidden,
        truncated,
        cellLimit: CELL_CHARS,
      },
    };
  } finally {
    // La fermeture de la connexion termine la transaction (rien a valider).
    await client.end().catch(() => {});
  }
}

function send(res, status, body, cache) {
  res.statusCode = status;
  res.setHeader("Cache-Control", cache || "no-store");
  res.end(JSON.stringify(body));
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
    send(res, 503, { error: "not_configured" });
    return;
  }

  // Vercel fournit req.query ; l'URL brute sert aux tests locaux.
  const query =
    req.query && Object.keys(req.query).length
      ? req.query
      : Object.fromEntries(new URL(req.url, "http://localhost").searchParams);

  const database = String(query.db || "");
  const table = String(query.table || "");
  const key = String(query.id || "");
  // Colonne cle : facultative, validee plus bas contre les colonnes reelles.
  const wanted = String(query.key || "");

  if (!DATABASES.includes(database)) {
    send(res, 404, { error: "unknown_database" });
    return;
  }

  if (!TABLE_RE.test(table) || PRIVATE_NAME.test(table)) {
    send(res, 404, { error: "unknown_table" });
    return;
  }

  if (!KEY_RE.test(key)) {
    send(res, 400, { error: "invalid_id" });
    return;
  }

  if (wanted && !TABLE_RE.test(wanted)) {
    send(res, 400, { error: "invalid_key_column" });
    return;
  }

  const started = Date.now();

  try {
    const result = await readRow(database, table, key, wanted);

    if (result.error) {
      send(res, result.error === "row_not_found" ? 404 : 400, { error: result.error, database, table, id: key });
      return;
    }

    send(
      res,
      200,
      {
        service: "pg-memoire",
        provider: "Aiven for PostgreSQL",
        readOnly: true,
        generatedAt: new Date().toISOString(),
        tookMs: Date.now() - started,
        ...result.row,
      },
      CACHE_OK,
    );
  } catch (error) {
    // Le detail reste dans les logs Vercel : jamais renvoye au navigateur.
    console.error(`pg-memoire-row/${database}/${table} : ${error && error.message}`);
    send(res, 502, { error: "unavailable", database, table }, CACHE_ERROR);
  }
};
