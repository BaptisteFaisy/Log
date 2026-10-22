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
  const t = await c.query(`
    select schemaname, tablename, tableowner
      from pg_tables
     where schemaname not in ('pg_catalog','information_schema')
     order by 1,2`);
  console.log("TABLES", JSON.stringify(t.rows, null, 2));
  const s = await c.query(`select nspname, pg_get_userbyid(nspowner) as owner from pg_namespace where nspname not like 'pg_%'`);
  console.log("SCHEMAS", JSON.stringify(s.rows, null, 2));
  await c.end();
})().catch((e) => console.log("FAIL", e.message));
