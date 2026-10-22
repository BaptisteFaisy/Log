#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

const ssl = process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false };
const adminUrl = process.env.DATABASE_URL_ADMIN || process.env.PGADMIN_URL;
const config = adminUrl
  ? { connectionString: adminUrl.replace(/([?&])sslmode=[^&]*&?/, "$1").replace(/[?&]$/, ""), ssl }
  : {
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT || 5432),
      database: process.env.PGDATABASE || "historique",
      user: process.env.PGADMIN_USER || process.env.PGUSER,
      password: process.env.PGADMIN_PASSWORD || process.env.PGPASSWORD,
      ssl,
    };

const sql = readFileSync(join(root, "db", "schema.sql"), "utf8");

async function apply(clientConfig) {
  const client = new pg.Client(clientConfig);
  await client.connect();
  try {
    await client.query(sql);
    const tables = await client.query(
      "select table_name from information_schema.tables where table_schema='public' order by 1",
    );
    console.log("schema ok:", tables.rows.map((row) => row.table_name).join(", "));
  } finally {
    await client.end();
  }
}

try {
  await apply(config);
} catch (error) {
  if (error.code !== "28P01" || !process.env.PGUSER) throw error;
  console.warn("role admin refuse (mot de passe) : reprise avec", process.env.PGUSER);
  await apply({ ...config, user: process.env.PGUSER, password: process.env.PGPASSWORD });
}
