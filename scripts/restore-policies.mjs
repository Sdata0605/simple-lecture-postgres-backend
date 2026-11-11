// Restores RLS policies that the Supabase dump contains but the target database does not have.
// Usage:
//   node scripts/restore-policies.mjs <dump.sql>            (dry run: lists what is missing)
//   node scripts/restore-policies.mjs <dump.sql> --apply    (creates the missing public.* policies)
//   Add --server and set SERVER_DATABASE_URL to target the server database instead of the test database.
// The dump SQL is produced with: pg_restore -f <dump.sql> <supabase-dump.dump>
// Only public.* policies are applied (storage.objects policies are not used: storage is on local disk).
// Refuses to run against any database except simplelecture_test unless --server is given.
import "dotenv/config";
import fs from "node:fs";
import pg from "pg";

const file = process.argv[2];
const apply = process.argv.includes("--apply");
if (!file) throw new Error("usage: restore-policies.mjs <dump.sql> [--apply]");
// Target: the test database by default. The server database only with --server and SERVER_DATABASE_URL set.
const toServer = process.argv.includes("--server");
const url = toServer ? process.env.SERVER_DATABASE_URL || "" : process.env.DATABASE_URL || "";
if (toServer && !url) throw new Error("--server needs SERVER_DATABASE_URL in the environment");
if (!toServer && !/simplelecture_test/.test(url)) throw new Error("refusing: DATABASE_URL must point at simplelecture_test (use --server for the server)");

// CREATE POLICY [ "name" | name ] ON schema.table ...
const HEAD = /^CREATE POLICY (?:"((?:[^"]|"")+)"|(\w+)) ON (\w+)\.("?)(\w+)\4/;

// Statements can span several lines; a statement ends at the first line that ends with ';'.
const statements = [];
{
  let current = null;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (current === null && line.startsWith("CREATE POLICY")) current = "";
    if (current === null) continue;
    current += (current ? "\n" : "") + line;
    if (line.trimEnd().endsWith(";")) {
      statements.push(current);
      current = null;
    }
  }
}

const client = new pg.Client({ connectionString: url });
await client.connect();
const existing = new Set(
  (await client.query("select schemaname, tablename, policyname from pg_policies")).rows.map(
    (r) => `${r.schemaname}.${r.tablename}|${r.policyname}`
  )
);

const missing = [];
let unparsed = 0;
for (const sql of statements) {
  const m = HEAD.exec(sql);
  if (!m) {
    unparsed++;
    continue;
  }
  const name = (m[1] ?? m[2]).replace(/""/g, '"');
  const schema = m[3];
  const table = m[5];
  if (schema !== "public") continue;
  if (!existing.has(`${schema}.${table}|${name}`)) missing.push({ schema, table, name, sql });
}

console.log(`dump policies: ${statements.length}, already present: ${existing.size}, public missing: ${missing.length}, unparsed: ${unparsed}`);
const tables = {};
for (const m of missing) tables[m.table] = (tables[m.table] || 0) + 1;
console.log(tables);

if (!apply) {
  console.log("dry run: nothing changed. Re-run with --apply to create them.");
  await client.end();
  process.exit(0);
}

let created = 0;
const failed = [];
for (const m of missing) {
  try {
    await client.query("BEGIN");
    await client.query(m.sql);
    await client.query("COMMIT");
    created++;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    failed.push({ table: m.table, name: m.name, error: err.message });
  }
}
console.log(`created: ${created}, failed: ${failed.length}`);
for (const f of failed) console.log(`  FAILED ${f.table} | ${f.name}: ${f.error}`);
await client.end();
