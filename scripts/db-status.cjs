const { getPool } = require("../lib/db.cjs");

(async () => {
  const pool = getPool();
  const tables = await pool.query(
    "select table_name from information_schema.tables where table_schema = 'public' order by 1",
  );
  const counts = await pool.query(
    "select (select count(*) from logs) as logs, (select count(*) from error_resolutions) as memos, (select count(*) from agent_runs) as runs, (select count(*) from agent_reports) as reports",
  );
  console.log("tables:", tables.rows.map((row) => row.table_name).join(", "));
  console.log("counts:", JSON.stringify(counts.rows[0]));
  await pool.end();
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
