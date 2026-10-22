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
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  const r = await c.query(`
    select current_user,
           has_database_privilege(current_user, current_database(), 'CREATE') as db_create,
           has_schema_privilege(current_user, 'public', 'CREATE') as pub_create,
           (select pg_get_userbyid(nspowner) from pg_namespace where nspname = 'public') as pub_owner
  `);
  console.log(r.rows[0]);
  await c.end();
})().catch((e) => console.log("FAIL", e.message));
