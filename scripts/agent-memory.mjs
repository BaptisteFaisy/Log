#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { ERROR_TYPES, entryFor, fingerprint } from "./lib/errors.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const memoDir = join(root, "docs", "error-memos");

function loadEnv() {
  for (const name of [".env.aiven.local", ".env"]) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!match || process.env[match[1]]) continue;
      let value = match[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[match[1]] = value;
    }
  }
}

function args() {
  const out = { _: [] };
  const rest = process.argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const item = rest[i];
    if (item.startsWith("--")) {
      const key = item.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(item);
    }
  }
  return out;
}

function pool() {
  const ssl = process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false };
  if (process.env.DATABASE_URL || process.env.PGURL) {
    return new pg.Pool({ connectionString: process.env.DATABASE_URL || process.env.PGURL, max: 2, ssl });
  }
  return new pg.Pool({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || "historique",
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    max: 2,
    ssl,
  });
}

function memoPath(fp) {
  return join(memoDir, `${fp}.md`);
}

function writeMemo(row) {
  mkdirSync(memoDir, { recursive: true });
  const files = Array.isArray(row.files) ? row.files : [];
  const body = [
    "---",
    `fingerprint: ${row.fingerprint}`,
    `code: ${row.code}`,
    `cause: ${row.cause || ""}`,
    `fix: ${(row.fix || "").replace(/\n/g, " ")}`,
    `files: [${files.join(", ")}]`,
    `verification: ${row.verification || ""}`,
    `tokens_used: ${row.tokens_used || 0}`,
    `duration_ms: ${row.duration_ms || 0}`,
    `agent: ${row.agent || ""}`,
    `updated_at: ${row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at}`,
    `runs: ${row.runs || 1}`,
    "---",
    row.fix || "",
    "",
  ].join("\n");
  const path = memoPath(row.fingerprint);
  writeFileSync(path, body, "utf8");
  return path;
}

async function lookup(db, options) {
  const query = options._.slice(1).join(" ").trim();
  const entry = entryFor({
    code: options.code,
    name: options.name || query,
    message: options.message || query,
  });

  if (!entry && !options.message && !query) {
    console.error("usage: agent-memory.mjs lookup --code ERR_... | \"message d'erreur\"");
    process.exit(2);
  }

  const code = options.code || (entry ? entry.code : "ERR_UNKNOWN");
  const message = options.message || (entry ? entry.message : query);
  const stack = options.stack || (entry ? entry.stack.join("\n") : "");
  const fp = fingerprint(code, message, stack);

  const search = entry ? entry.name : options.name || query;
  const exact = await db.query("select * from public.error_resolutions where fingerprint = $1", [fp]);
  const fuzzy = await db.query(
    `select *,
            similarity(coalesce(fix, ''), $3) as score_fix,
            similarity(coalesce(cause, ''), $3) as score_cause
       from public.error_resolutions
      where code = $1
         or fix ilike $2
         or cause ilike $2
         or similarity(coalesce(fix, ''), $3) > 0.3
         or similarity(coalesce(cause, ''), $3) > 0.3
      order by greatest(similarity(coalesce(fix, ''), $3), similarity(coalesce(cause, ''), $3)) desc,
               updated_at desc
      limit 5`,
    [code, `%${message.slice(0, 120)}%`, search || message],
  );

  let legacy = [];
  if (search) {
    try {
      const found = await db.query(
        "select nom::text, resolution, occurrences, updated_at from public.historique_trouver($1)",
        [search],
      );
      legacy = found.rows;
    } catch {
      /* table historique non accessible pour ce rôle : la mémoire courante suffit */
    }
  }

  const hits = exact.rows.length ? exact.rows : fuzzy.rows;
  let memoFile = null;
  if (hits[0]) {
    memoFile = writeMemo(hits[0]);
  } else if (legacy[0]) {
    memoFile = writeMemo({
      fingerprint: fp,
      code,
      cause: "mémoire historique (table historique)",
      fix: legacy[0].resolution,
      files: [],
      verification: null,
      tokens_used: 0,
      duration_ms: 0,
      agent: "agent/opencode",
      runs: legacy[0].occurrences,
      updated_at: legacy[0].updated_at,
    });
  }

  const result = {
    fingerprint: fp,
    code,
    type: entry ? entry.name : null,
    hit: hits.length > 0 || legacy.length > 0,
    memo: hits[0] || null,
    memo_path: memoFile,
    legacy,
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!result.hit) {
    console.log(`MISS ${fp} · ${code} · aucun problème similaire résolu en base`);
  } else {
    console.log(`HIT ${fp} · ${code}${entry ? ` · ${entry.name}` : ""}`);
    for (const row of hits) {
      console.log(`  base   : ${row.fix || "(sans fix)"}`);
      if (row.cause) console.log(`  cause  : ${row.cause}`);
      if (row.verification) console.log(`  vérif  : ${row.verification}`);
      console.log(`  runs   : ${row.runs} · maj ${new Date(row.updated_at).toISOString()}`);
    }
    for (const row of legacy) {
      console.log(`  legacy : ${row.nom} (${row.occurrences}×) · ${String(row.resolution).split("\n")[0]}`);
    }
    if (memoFile) console.log(`  memo   : ${memoFile}`);
  }

  return result.hit;
}

async function record(db, options) {
  const query = options._.slice(1).join(" ").trim();
  const entry = entryFor({ code: options.code, name: options.name || query, message: options.message || query });
  if (!entry && !options.code) {
    console.error("usage: agent-memory.mjs record --code ERR_... --fix \"méthode de résolution\"");
    process.exit(2);
  }

  const code = options.code || entry.code;
  const message = options.message || (entry ? entry.message : "");
  const stack = options.stack || (entry ? entry.stack.join("\n") : "");
  const fp = fingerprint(code, message, stack);
  const fix = String(options.fix || query || "").trim();
  if (!fix) {
    console.error("--fix est requis");
    process.exit(2);
  }

  const files = options.files ? String(options.files).split(",").map((item) => item.trim()).filter(Boolean) : [];
  const memo = writeMemo({
    fingerprint: fp,
    code,
    cause: options.cause || null,
    fix,
    files,
    verification: options.verification || null,
    tokens_used: Number(options.tokens || 0),
    duration_ms: Number(options.duration || 0),
    agent: options.agent || "agent/opencode",
    runs: 1,
    updated_at: new Date(),
  });

  const existing = await db.query("select runs from public.error_resolutions where fingerprint = $1", [fp]);
  const mode = existing.rows.length ? "warm" : "cold";

  await db.query(
    `insert into public.error_resolutions
       (fingerprint, code, cause, fix, files, verification, tokens_used, duration_ms, agent, runs, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,now())
     on conflict (fingerprint) do update set
       code = excluded.code,
       cause = coalesce(excluded.cause, public.error_resolutions.cause),
       fix = excluded.fix,
       files = case when cardinality(excluded.files) > 0 then excluded.files else public.error_resolutions.files end,
       verification = coalesce(excluded.verification, public.error_resolutions.verification),
       tokens_used = excluded.tokens_used,
       duration_ms = excluded.duration_ms,
       agent = excluded.agent,
       runs = public.error_resolutions.runs + 1,
       updated_at = now()
     returning *`,
    [
      fp,
      code,
      options.cause || null,
      fix,
      files,
      options.verification || null,
      Number(options.tokens || 0),
      Number(options.duration || 0),
      options.agent || "agent/opencode",
    ],
  );

  const now = new Date().toISOString();
  const runId = `run_cli_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  await db.query(
    `insert into public.agent_runs
       (run_id, fingerprint, code, mode, status, started_at, ended_at, duration_ms, tokens_total,
        memo_hit, memo_path, agent, attempt)
     values ($1,$2,$3,$4,'resolved',$5,$5,$6,$7,$8,$9,$10,$11)
     on conflict (run_id) do nothing`,
    [
      runId,
      fp,
      code,
      mode,
      now,
      Number(options.duration || 0),
      Number(options.tokens || 0),
      mode === "warm",
      `docs/error-memos/${fp}.md`,
      options.agent || "agent/opencode",
      (existing.rows[0]?.runs || 0) + 1,
    ],
  );

  console.log(`OK ${fp} · ${code} · ${mode}`);
  console.log(`memo ${memo}`);
}

async function list(db, options) {
  const limit = Math.min(Math.max(Number(options.limit || 20), 1), 500);
  const { rows } = await db.query(
    "select fingerprint, code, runs, updated_at, left(fix, 100) as fix from public.error_resolutions order by updated_at desc limit $1",
    [limit],
  );
  for (const row of rows) {
    console.log(`${row.fingerprint} · ${row.code} · ${row.runs}× · ${new Date(row.updated_at).toISOString()} · ${row.fix || ""}`);
  }
  if (!rows.length) console.log("(aucune résolution enregistrée)");
}

async function runs(db, options) {
  const limit = Math.min(Math.max(Number(options.limit || 20), 1), 500);
  const { rows } = await db.query(
    "select run_id, code, mode, status, started_at, duration_ms, tokens_total from public.agent_runs order by started_at desc limit $1",
    [limit],
  );
  for (const row of rows) {
    console.log(
      `${new Date(row.started_at).toISOString()} · ${row.code} · ${row.mode} · ${row.status} · ${row.duration_ms}ms · ${row.tokens_total} tokens · ${row.run_id}`,
    );
  }
  if (!rows.length) console.log("(aucun run enregistré)");
}

async function memo(db, options) {
  const fp = options._[1] || options.fingerprint;
  if (!fp) {
    console.error("usage: agent-memory.mjs memo <fingerprint>");
    process.exit(2);
  }
  const { rows } = await db.query("select * from public.error_resolutions where fingerprint = $1", [fp]);
  if (!rows.length) {
    console.error(`fingerprint inconnu: ${fp}`);
    process.exit(1);
  }
  console.log(writeMemo(rows[0]));
}

async function main() {
  loadEnv();
  const options = args();
  const command = options._[0] || "lookup";
  const db = pool();
  try {
    if (command === "lookup") {
      const hit = await lookup(db, options);
      process.exitCode = hit ? 0 : 1;
    } else if (command === "record") {
      await record(db, options);
    } else if (command === "list") {
      await list(db, options);
    } else if (command === "runs") {
      await runs(db, options);
    } else if (command === "memo") {
      await memo(db, options);
    } else if (command === "types") {
      for (const entry of ERROR_TYPES) console.log(`${entry.code} · ${entry.name}`);
    } else {
      console.error("commandes: lookup | record | list | runs | memo | types");
      process.exitCode = 2;
    }
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error("ERREUR", error.message);
  process.exit(1);
});
