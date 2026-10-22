const fs = require("fs");
for (const line of fs.readFileSync(".env.aiven.local", "utf8").split(/\r?\n/)) {
  const i = line.indexOf("=");
  if (i > 0 && !process.env[line.slice(0, i)]) process.env[line.slice(0, i)] = line.slice(i + 1);
}
const pg = require("pg");
(async () => {
  const c = new pg.Client({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT),
    user: "avnadmin",
    password: process.env.PGADMIN_PASSWORD,
    database: process.env.PGDATABASE,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  for (const name of ["logs", "agent_runs", "error_resolutions", "kafka_cursors", "historique"]) {
    const cols = await c.query(
      `select column_name, data_type from information_schema.columns
        where table_schema='public' and table_name=$1 order by ordinal_position`,
      [name],
    );
    const count = await c.query(`select count(*)::int as n from "${name}"`);
    console.log(`\n== ${name} (${count.rows[0].n} lignes)`);
    console.log(cols.rows.map((r) => `  ${r.column_name} ${r.data_type}`).join("\n"));
  }
  await c.end();
})().catch((e) => console.log("FAIL", e.message));
