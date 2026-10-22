const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const ROOT = path.join(__dirname, "..");

function loadEnv() {
  const file = path.join(ROOT, ".env.aiven.local");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    if (!process.env[key]) process.env[key] = line.slice(i + 1).trim();
  }
}

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const { PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD } = process.env;
  if (!PGHOST || !PGUSER || !PGPASSWORD) {
    throw new Error("Renseignez DATABASE_URL ou PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD");
  }
  const port = PGPORT || "5432";
  const db = PGDATABASE || "historique";
  return `postgres://${encodeURIComponent(PGUSER)}:${encodeURIComponent(PGPASSWORD)}@${PGHOST}:${port}/${db}`;
}

function sslConfig() {
  if (process.env.PGSSLMODE === "disable") return false;
  const caPath = process.env.PGCA_PATH || path.join(ROOT, ".certs", "ca.pem");
  if (fs.existsSync(caPath)) return { ca: fs.readFileSync(caPath, "utf8"), rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}

let pool = null;

function getPool() {
  if (!pool) {
    loadEnv();
    pool = new Pool({ connectionString: databaseUrl(), max: 4, ssl: sslConfig() });
  }
  return pool;
}

module.exports = { getPool, loadEnv, ROOT };
