// Vercel Function : export SQL (dump) d'une base PostgreSQL Aiven « pg-memoire ».
//
//   GET /api/dump               -> telecharge la 1re base configuree (historique)
//   GET /api/dump?db=historique -> telecharge cette base
//   GET /api/dump?db=historique&inline=1 -> affiche le SQL dans le navigateur
//
// Le fichier produit est un .sql rejouable tel quel :
//   psql "$URL" -f pg-memoire-historique.sql
//
// Variables d'environnement : les memes que /api/pg-memoire, aucune de plus.
//   PG_MEMOIRE_URL        postgres://hote:port/base  (utilisateur + mot de passe inclus dans l URL)
//   PG_MEMOIRE_CA         certificat CA du projet Aiven (PEM, ou PEM encode en base64)
//   PG_MEMOIRE_DATABASES  bases exportables (defaut : historique)
//
// Regles de surete, alignees sur /api/pg-memoire (le site est public) :
//   - transaction READ ONLY : aucune ecriture possible ;
//   - tables et colonnes ressemblant a des secrets jamais exportees ;
//   - schema « public » uniquement ;
//   - volume plafonne par DUMP_MAX_ROWS (defaut 20000 lignes par table).

const dns = require("dns");
const { Client } = require("pg");
const { PRIVATE_NAME, PRIVATE_COLUMN } = require("./_redact");

// Aiven publie l'hote en A + AAAA (NAT64) : Node 17+ prefere l'IPv6, injoignable
// depuis les fonctions. On force l'IPv4.
dns.setDefaultResultOrder("ipv4first");

// Seule la base « historique » est exportable : « defaultdb » (demo pgvector du
// hackathon, jamais alimentee) est retiree du site.
const DATABASES = (process.env.PG_MEMOIRE_DATABASES || "historique")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

const SCHEMA = process.env.DUMP_SCHEMA || "public";
const BATCH = 100;
const MAX_ROWS = Number(process.env.DUMP_MAX_ROWS) || 20000;
const TIMEOUT_MS = Number(process.env.PG_MEMOIRE_TIMEOUT_MS) || 8000;

// Tables et colonnes jamais exportees : regles partagees avec /api/pg-memoire
// (api/_redact.js), pour que l'export ne divulgue jamais ce que le panneau masque.

// Types binaires ou opaques : exportes en hexadecimal plutot qu'en texte brut.
const HIDDEN_TYPES = new Set(["tsvector", "tsquery", "vector", "halfvec", "sparsevec"]);

function readCa() {
  const raw = (process.env.PG_MEMOIRE_CA || "").trim();
  if (!raw) return undefined;
  return raw.includes("BEGIN CERTIFICATE") ? raw.replace(/\\n/g, "\n") : Buffer.from(raw, "base64").toString("utf8");
}

function connectionFor(database) {
  const url = new URL(process.env.PG_MEMOIRE_URL);
  // « sslmode=disable » n'est la que pour les tests locaux (PostgreSQL sans TLS).
  // Par defaut : verification complete du certificat, sans PG_MEMOIRE_CA la
  // connexion echoue (fail closed).
  const ssl =
    url.searchParams.get("sslmode") === "disable"
      ? false
      : { ca: readCa(), servername: url.hostname, rejectUnauthorized: true };

  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    ssl,
    application_name: "log-site/dump",
    connectionTimeoutMillis: TIMEOUT_MS,
    query_timeout: TIMEOUT_MS,
  };
}

const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;

// « vector(1536) » ou « text[] » -> « vector », « text ».
const baseType = (type) =>
  String(type)
    .replace(/\[\]$/, "")
    .replace(/\(.*\)$/, "")
    .trim();

/* ------------------------------------------------------------------ */
/* Litteraux SQL                                                       */
/* ------------------------------------------------------------------ */

function literal(value, type) {
  if (value === null || value === undefined) return "NULL";

  // Les valeurs arrivent en texte (::text) : le format source est preserve
  // a la microseconde pres (timestamptz) et a l'exact decimal pres (numeric).
  const text = String(value);
  const t = String(type || "");

  if (t === "bytea") return `'\\x${Buffer.from(text, "utf8").toString("hex")}'::bytea`;
  if (/^(smallint|integer|bigint|int2|int4|int8|oid|numeric|decimal|real|double precision|boolean|bool)$/.test(t)) {
    return /^[-+0-9.eE]+$/.test(text) || text === "true" || text === "false" ? text : quote(text);
  }
  if (t === "json" || t === "jsonb") return `${quote(text)}::${t}`;
  if (t === "uuid") return `${quote(text)}::uuid`;
  if (t === "date") return `${quote(text)}::date`;
  if (t.startsWith("time")) return `${quote(text)}::${t}`;
  if (t.includes("timestamp")) return `${quote(text)}::timestamptz`;
  if (t.endsWith("[]")) return `${quote(text)}::${t}`;
  return quote(text);
}

const quote = (text) => `'${String(text).replace(/'/g, "''")}'`;

/* ------------------------------------------------------------------ */
/* Catalogue                                                           */
/* ------------------------------------------------------------------ */

async function collect(client) {
  const meta = {};

  meta.relations = (
    await client.query(
      `SELECT c.relname AS name, c.relkind AS kind
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1
          AND c.relkind IN ('r', 'p', 'v', 'm')
          AND NOT c.relispartition
          AND has_table_privilege(c.oid, 'SELECT')
        ORDER BY c.relname`,
      [SCHEMA],
    )
  ).rows;

  meta.columns = (
    await client.query(
      `SELECT c.relname AS table_name,
              a.attname AS column_name,
              format_type(a.atttypid, a.atttypmod) AS data_type,
              a.attnotnull AS not_null,
              a.attidentity AS identity,
              a.attgenerated AS generated,
              pg_get_expr(d.adbin, d.adrelid) AS column_default
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
         LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
        WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
        ORDER BY c.relname, a.attnum`,
      [SCHEMA],
    )
  ).rows;

  meta.constraints = (
    await client.query(
      `SELECT c.relname AS table_name, con.conname AS name, pg_get_constraintdef(con.oid) AS def
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND con.contype IN ('p', 'u', 'f', 'c')
        ORDER BY c.relname, con.contype, con.conname`,
      [SCHEMA],
    )
  ).rows;

  meta.indexes = (
    await client.query(
      `SELECT tablename AS table_name, indexname AS name, indexdef AS def
         FROM pg_indexes
        WHERE schemaname = $1
          AND indexname NOT IN (
                SELECT con.conname FROM pg_constraint con
                  JOIN pg_class c ON c.oid = con.conrelid
                  JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = $1)
        ORDER BY tablename, indexname`,
      [SCHEMA],
    )
  ).rows;

  meta.views = (
    await client.query(
      `SELECT viewname AS name, definition AS def
         FROM pg_views
        WHERE schemaname = $1
        ORDER BY viewname`,
      [SCHEMA],
    )
  ).rows;

  meta.sequences = (
    await client.query(
      // Les sequences internes des colonnes IDENTITY (deptype 'i') sont creees
      // par le CREATE TABLE ... GENERATED AS IDENTITY : les exclure evite un
      // conflit de nom a la restauration.
      `SELECT s.sequencename AS name, s.start_value, s.min_value, s.max_value,
              s.increment_by, s.cycle, s.cache_size
         FROM pg_sequences s
        WHERE s.schemaname = $1
          AND NOT EXISTS (
                SELECT 1
                  FROM pg_class c
                  JOIN pg_namespace n ON n.oid = c.relnamespace
                  JOIN pg_depend d ON d.objid = c.oid
                                  AND d.classid = 'pg_class'::regclass
                                  AND d.deptype = 'i'
                 WHERE c.relname = s.sequencename AND n.nspname = $1)
        ORDER BY s.sequencename`,
      [SCHEMA],
    )
  ).rows;

  meta.comments = (
    await client.query(
      `SELECT c.relname AS obj, a.attname AS col, d.description AS text
         FROM pg_description d
         JOIN pg_class c ON c.oid = d.objoid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.objsubid
        WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
        ORDER BY c.relname, d.objsubid`,
      [SCHEMA],
    )
  ).rows;

  return meta;
}

// Extensions PostgreSQL necessaires au dump.
//
// Deux sources de dependance, et non une seule :
//   - les types de colonnes (citext, pgcrypto...) ;
//   - les objets references par le DDL : un index GIN sur gin_trgm_ops exige
//     pg_trgm, sans qu'aucun type de colonne ne le trahisse.
// Une extension n'est emise que si l'un de ses objets apparait dans le DDL
// genere : inutile d'imposer pgvector quand aucune colonne vector n'est exportee.
async function extensionsFor(client, ddl) {
  const { rows } = await client.query(
    `SELECT e.extname AS ext, t.typname AS member
       FROM pg_extension e
       JOIN pg_depend d ON d.refclassid = 'pg_extension'::regclass AND d.refobjid = e.oid AND d.deptype = 'e'
       JOIN pg_type t ON d.classid = 'pg_type'::regclass AND d.objid = t.oid
     UNION
     SELECT e.extname, p.proname
       FROM pg_extension e
       JOIN pg_depend d ON d.refclassid = 'pg_extension'::regclass AND d.refobjid = e.oid AND d.deptype = 'e'
       JOIN pg_proc p ON d.classid = 'pg_proc'::regclass AND d.objid = p.oid
     UNION
     SELECT e.extname, c.opcname
       FROM pg_extension e
       JOIN pg_depend d ON d.refclassid = 'pg_extension'::regclass AND d.refobjid = e.oid AND d.deptype = 'e'
       JOIN pg_opclass c ON d.classid = 'pg_opclass'::regclass AND d.objid = c.oid`,
  );

  const found = new Map();
  for (const { ext, member } of rows) {
    if (!member || String(member).length < 3) continue;
    const rx = new RegExp(`(^|[^a-z0-9_])${String(member).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9_]|$)`, "i");
    if (rx.test(ddl)) found.set(ext, true);
  }

  // plpgsql est toujours present : l'emettre n'apporte rien.
  found.delete("plpgsql");

  return [...found.keys()].sort();
}

/* ------------------------------------------------------------------ */
/* Generation du dump                                                  */
/* ------------------------------------------------------------------ */

async function dumpDatabase(client, database) {
  const meta = await collect(client);

  const { rows: [info] } = await client.query(
    "SELECT current_setting('server_version') AS version, pg_size_pretty(pg_database_size(current_database())) AS size",
  );

  const out = [];
  const skipped = [];

  out.push(`-- pg-memoire — export SQL de la base « ${database} » (schema ${SCHEMA})`);
  out.push("-- Aiven for PostgreSQL · lecture seule · genere par /api/dump");
  out.push(`-- Version ${info.version} · ${info.size} · ${new Date().toISOString()}`);
  out.push("--");
  out.push(`-- Restauration : psql "$URL" -f pg-memoire-${database}.sql`);
  out.push(`-- A rejouer dans une base VIDE (meme convention qu'un dump pg_dump).`);
  out.push(`-- Tables et colonnes ressemblant a des secrets exclues de l'export.`);
  out.push("");
  out.push("SET statement_timeout = 0;");
  out.push("SET client_encoding = 'UTF8';");
  out.push(`SET search_path = ${SCHEMA};`);
  out.push("");

  // Le schema « public » existe toujours ; un schema dedie doit etre cree.
  if (SCHEMA !== "public") out.push(`CREATE SCHEMA IF NOT EXISTS ${ident(SCHEMA)};`, "");

  // Tables (hors relations dont le nom trahit un secret)
  const tables = meta.relations.filter((r) => (r.kind === "r" || r.kind === "p") && !PRIVATE_NAME.test(r.name));
  for (const relation of meta.relations) {
    if ((relation.kind === "r" || relation.kind === "p") && PRIVATE_NAME.test(relation.name)) skipped.push(relation.name);
  }

  const byTable = new Map();
  for (const col of meta.columns) {
    if (!byTable.has(col.table_name)) byTable.set(col.table_name, []);
    byTable.get(col.table_name).push(col);
  }

  const exported = [];

  for (const table of tables) {
    const all = byTable.get(table.name) || [];
    const cols = all.filter((c) => !PRIVATE_COLUMN.test(c.column_name) && !HIDDEN_TYPES.has(baseType(c.data_type)));

    for (const c of all) {
      if (PRIVATE_COLUMN.test(c.column_name)) skipped.push(`${table.name}.${c.column_name}`);
      else if (HIDDEN_TYPES.has(baseType(c.data_type))) skipped.push(`${table.name}.${c.column_name} (${c.data_type})`);
    }

    if (!cols.length) {
      skipped.push(table.name);
      continue;
    }

    exported.push({ table: table.name, cols });
  }

  const exportedNames = new Set(exported.map((t) => t.table));

  // Extensions requises par le DDL exporte : sans elles le dump ne se rejoue
  // pas dans une base neuve. On interroge le DDL lui-meme, pas seulement les
  // types de colonnes : un index GIN sur gin_trgm_ops exige pg_trgm alors
  // qu'aucune colonne n'est de type pg_trgm.
  const ddlBlob = [
    ...exported.flatMap((e) => e.cols.map((c) => `${c.column_name} ${c.data_type} ${c.column_default || ""}`)),
    ...meta.constraints.filter((c) => exportedNames.has(c.table_name)).map((c) => c.def),
    ...meta.indexes.filter((i) => exportedNames.has(i.table_name)).map((i) => i.def),
    ...meta.views.map((v) => String(v.def)),
  ].join("\n");

  const extensions = await extensionsFor(client, ddlBlob);
  for (const name of extensions) out.push(`CREATE EXTENSION IF NOT EXISTS ${ident(name)};`);
  if (extensions.length) out.push("");

  // Séquences
  for (const seq of meta.sequences) {
    out.push(
      `CREATE SEQUENCE ${ident(seq.name)} ` +
        `INCREMENT BY ${seq.increment_by} MINVALUE ${seq.min_value} MAXVALUE ${seq.max_value} ` +
        `START WITH ${seq.start_value} CACHE ${seq.cache_size}${seq.cycle ? " CYCLE" : ""};`,
    );
    const { rows } = await client.query(`SELECT last_value, is_called FROM ${ident(seq.name)}`);
    if (rows.length) out.push(`SELECT setval('${seq.name}', ${rows[0].last_value}, ${rows[0].is_called});`);
  }
  if (meta.sequences.length) out.push("");

  // Tables
  for (const { table, cols } of exported) {
    const defs = cols.map((c) => {
      const parts = [`  ${ident(c.column_name)} ${c.data_type}`];

      // Colonne generee : l'expression remplace le DEFAULT.
      if (c.generated === "s") {
        parts.push(`GENERATED ALWAYS AS (${c.column_default}) STORED`);
        if (c.not_null) parts.push("NOT NULL");
        return parts.join(" ");
      }

      if (c.identity) parts.push(c.identity === "a" ? "GENERATED ALWAYS AS IDENTITY" : "GENERATED BY DEFAULT AS IDENTITY");
      else if (c.column_default) parts.push(`DEFAULT ${c.column_default}`);

      if (c.not_null) parts.push("NOT NULL");
      return parts.join(" ");
    });

    out.push(`CREATE TABLE ${ident(table)} (`);
    out.push(defs.join(",\n"));
    out.push(");");
    out.push("");
  }

  for (const c of meta.constraints) {
    if (!exportedNames.has(c.table_name)) continue;
    out.push(`ALTER TABLE ${ident(c.table_name)} ADD CONSTRAINT ${ident(c.name)} ${c.def};`);
  }
  if (meta.constraints.length) out.push("");

  for (const i of meta.indexes) {
    if (!exportedNames.has(i.table_name)) continue;
    out.push(`${i.def};`);
  }
  if (meta.indexes.length) out.push("");

  // pg_get_viewdef renvoie un point-virgule final : on evite le « ;; ».
  for (const v of meta.views) {
    out.push(`CREATE OR REPLACE VIEW ${ident(v.name)} AS ${String(v.def).trim().replace(/;+$/, "")};`);
  }
  if (meta.views.length) out.push("");

  for (const c of meta.comments) {
    if (!exportedNames.has(c.obj)) continue;
    const target = c.col ? `${ident(c.obj)}.${ident(c.col)}` : ident(c.obj);
    out.push(`COMMENT ON ${c.col ? "COLUMN" : "TABLE"} ${target} IS ${quote(c.text)};`);
  }
  if (meta.comments.length) out.push("");

  // Données
  for (const { table, cols } of exported) {
    // Les colonnes generees ne recoivent jamais de valeur.
    const insertable = cols.filter((c) => c.generated !== "s");
    if (!insertable.length) {
      out.push(`-- ${table} : aucune colonne inserable`);
      out.push("");
      continue;
    }

    const colList = insertable.map((c) => ident(c.column_name));
    const typeMap = new Map(cols.map((c) => [c.column_name, c.data_type]));
    // IDENTITY ALWAYS exige OVERRIDING SYSTEM VALUE pour rejouer les valeurs.
    const overriding = insertable.some((c) => c.identity === "a") ? " OVERRIDING SYSTEM VALUE" : "";

    // Rendu texte cote serveur : le pilote JS transformerait les timestamptz
    // en Date (precision milliseconde) et perdrait les microsecondes.
    const selectList = insertable
      .map((c) => `${ident(c.column_name)}::text AS ${ident(c.column_name)}`)
      .join(", ");
    const { rows } = await client.query(
      `SELECT ${selectList} FROM ${ident(table)} AS t ORDER BY t.${ident(cols[0].column_name)} LIMIT ${MAX_ROWS + 1}`,
    );

    const truncated = rows.length > MAX_ROWS;
    const kept = truncated ? rows.slice(0, MAX_ROWS) : rows;

    out.push(`-- ${table} : ${kept.length} ligne(s)${truncated ? ` sur ${MAX_ROWS}+ (export tronque)` : ""}`);
    if (!kept.length) {
      out.push("");
      continue;
    }

    out.push("BEGIN;");
    for (let i = 0; i < kept.length; i += BATCH) {
      const values = kept
        .slice(i, i + BATCH)
        .map((row) => "  (" + insertable.map((c) => literal(row[c.column_name], typeMap.get(c.column_name))).join(", ") + ")")
        .join(",\n");
      out.push(`INSERT INTO ${ident(table)} (${colList.join(", ")})${overriding} VALUES\n${values};`);
    }
    out.push("COMMIT;");
    out.push("");

    // Les INSERT ... OVERRIDING SYSTEM VALUE n'avancent pas la sequence
    // d'identite : on la recale sur le max insere.
    for (const c of insertable.filter((col) => col.identity)) {
      out.push(
        `SELECT setval(pg_get_serial_sequence('${table}', '${c.column_name}'), ` +
          `COALESCE((SELECT max(${ident(c.column_name)}) FROM ${ident(table)}), 1), true);`,
      );
    }
    if (insertable.some((c) => c.identity)) out.push("");
  }

  if (skipped.length) {
    out.push(`-- Non exporte (secret ou type non restaurable) : ${skipped.join(", ")}`);
  }

  return out.join("\n");
}

/* ------------------------------------------------------------------ */
/* Handler Vercel                                                      */
/* ------------------------------------------------------------------ */

module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    res.end();
    return;
  }

  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");

  if (!process.env.PG_MEMOIRE_URL) {
    res.statusCode = 503;
    res.end(JSON.stringify({ error: "not_configured", hint: "Definir PG_MEMOIRE_URL dans les variables Vercel." }));
    return;
  }

  const requested = String((req.query && req.query.db) || DATABASES[0] || "");
  if (!DATABASES.includes(requested)) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "unknown_database", allowed: DATABASES }));
    return;
  }

  const client = new Client(connectionFor(requested));

  try {
    await client.connect();
    await client.query("BEGIN READ ONLY");

    const sql = await dumpDatabase(client, requested);
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `pg-memoire-${requested}-${stamp}.sql`;

    res.setHeader("Content-Type", "application/sql; charset=utf-8");
    res.setHeader("X-Dump-Bytes", String(Buffer.byteLength(sql)));

    if (req.query && req.query.inline === "1") {
      res.statusCode = 200;
      res.end(req.method === "HEAD" ? undefined : sql);
      return;
    }

    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.statusCode = 200;
    res.end(req.method === "HEAD" ? undefined : sql);
  } catch (error) {
    console.error(`dump/${requested} : ${error && error.message}`);
    res.statusCode = 502;
    res.end(JSON.stringify({ error: "dump_failed" }));
  } finally {
    await client.end().catch(() => {});
  }
};

module.exports.dumpDatabase = dumpDatabase;
