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
  await c.query("grant create, usage on schema public to logsite");
  await c.query("alter default privileges in schema public grant all on tables to logsite");
  await c.query("alter default privileges in schema public grant all on sequences to logsite");
  await c.query("grant all privileges on all tables in schema public to logsite");
  await c.query("grant all privileges on all sequences in schema public to logsite");
  console.log("grants ok");
  await c.end();
})().catch((e) => {
  console.log("FAIL", e.message);
  process.exit(1);
});
