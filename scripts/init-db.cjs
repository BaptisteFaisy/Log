const fs = require("fs");
const path = require("path");
const { getPool, loadEnv, ROOT } = require("../lib/db.cjs");

async function main() {
  loadEnv();
  // Le DDL (index sur des tables existantes) exige le propriétaire : avnadmin.
  if (process.env.PGADMIN_USER) process.env.PGUSER = process.env.PGADMIN_USER;
  if (process.env.PGADMIN_PASSWORD) process.env.PGPASSWORD = process.env.PGADMIN_PASSWORD;
  const sql = fs.readFileSync(path.join(ROOT, "db", "schema.sql"), "utf8");
  const pool = getPool();
  await pool.query(sql);
  const { rows } = await pool.query(
    `select table_name from information_schema.tables
      where table_schema = 'public' order by table_name`,
  );
  console.log("schéma appliqué:", rows.map((r) => r.table_name).join(", "));
  await pool.end();
}

main().catch((error) => {
  console.error("échec:", error.message);
  process.exit(1);
});
