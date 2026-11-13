// Read-only schema comparison between the production server Postgres (SERVER_DATABASE_URL)
// and the local test database (DATABASE_URL). Prints tables, columns, extensions and approx
// row counts for both sides and the differences. Never writes anything — every connection
// is forced into a READ ONLY transaction before any query runs.
import "dotenv/config";
import pg from "pg";

const serverUrl = process.env.SERVER_DATABASE_URL;
const localUrl = process.env.DATABASE_URL;
if (!serverUrl) throw new Error("SERVER_DATABASE_URL not set");
if (!localUrl) throw new Error("DATABASE_URL not set");

async function introspect(connectionString, label) {
  const pool = new pg.Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");

    const tables = (
      await client.query(
        `select table_name from information_schema.tables
         where table_schema = 'public' and table_type = 'BASE TABLE'
         order by table_name`
      )
    ).rows.map((r) => r.table_name);

    const columnsRes = await client.query(
      `select table_name, column_name, data_type, is_nullable, ordinal_position
       from information_schema.columns
       where table_schema = 'public'
       order by table_name, ordinal_position`
    );
    const columns = new Map();
    for (const row of columnsRes.rows) {
      if (!columns.has(row.table_name)) columns.set(row.table_name, []);
      columns.get(row.table_name).push(row);
    }

    const extensions = (
      await client.query(`select extname, extversion from pg_extension order by extname`)
    ).rows;

    const counts = (
      await client.query(
        `select c.relname as table_name, c.reltuples::bigint as approx_rows
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r'
         order by c.relname`
      )
    ).rows;
    const countMap = new Map(counts.map((r) => [r.table_name, r.approx_rows]));

    await client.query("ROLLBACK");
    console.log(`[${label}] connected ok, ${tables.length} tables`);
    return { tables: new Set(tables), columns, extensions, countMap };
  } finally {
    client.release();
    await pool.end();
  }
}

const [server, local] = await Promise.all([
  introspect(serverUrl, "server 116.202.230.124"),
  introspect(localUrl, "local simplelecture_test"),
]);

console.log("\n=== EXTENSIONS ===");
console.log("server:", server.extensions.map((e) => `${e.extname}@${e.extversion}`).join(", ") || "(none)");
console.log("local :", local.extensions.map((e) => `${e.extname}@${e.extversion}`).join(", ") || "(none)");
const hasVectorServer = server.extensions.some((e) => e.extname === "vector");
const hasVectorLocal = local.extensions.some((e) => e.extname === "vector");
console.log(`pgvector extension -> server: ${hasVectorServer ? "YES" : "NO"}, local: ${hasVectorLocal ? "YES" : "NO"}`);

console.log("\n=== TABLE COUNTS ===");
console.log(`server tables: ${server.tables.size}, local tables: ${local.tables.size}`);

const allTables = new Set([...server.tables, ...local.tables]);
const onlyServer = [...server.tables].filter((t) => !local.tables.has(t)).sort();
const onlyLocal = [...local.tables].filter((t) => !server.tables.has(t)).sort();

console.log(`\ntables ONLY on server (${onlyServer.length}):`, onlyServer);
console.log(`\ntables ONLY in local (${onlyLocal.length}):`, onlyLocal);

console.log("\n=== VECTOR / AI TABLES ===");
for (const name of ["knowledge_chunks", "topic_routing_cards"]) {
  const s = server.countMap.has(name) ? server.countMap.get(name) : "MISSING";
  const l = local.countMap.has(name) ? local.countMap.get(name) : "MISSING";
  console.log(`${name}: server=${s} local=${l}`);
}

console.log("\n=== PER-TABLE COLUMN DIFFS (shared tables only) ===");
const shared = [...allTables].filter((t) => server.tables.has(t) && local.tables.has(t)).sort();
let columnDiffCount = 0;
for (const t of shared) {
  const sCols = server.columns.get(t) || [];
  const lCols = local.columns.get(t) || [];
  const sNames = new Set(sCols.map((c) => c.column_name));
  const lNames = new Set(lCols.map((c) => c.column_name));
  const onlyS = sCols.filter((c) => !lNames.has(c.column_name)).map((c) => `${c.column_name} ${c.data_type}`);
  const onlyL = lCols.filter((c) => !sNames.has(c.column_name)).map((c) => `${c.column_name} ${c.data_type}`);
  const typeMismatch = sCols
    .filter((c) => lNames.has(c.column_name))
    .map((c) => {
      const match = lCols.find((lc) => lc.column_name === c.column_name);
      return match && match.data_type !== c.data_type
        ? `${c.column_name} (server=${c.data_type} local=${match.data_type})`
        : null;
    })
    .filter(Boolean);
  if (onlyS.length || onlyL.length || typeMismatch.length) {
    columnDiffCount++;
    console.log(`\n-- ${t} --`);
    if (onlyS.length) console.log("  columns only on server:", onlyS);
    if (onlyL.length) console.log("  columns only in local :", onlyL);
    if (typeMismatch.length) console.log("  type mismatches:", typeMismatch);
  }
}
console.log(`\n${columnDiffCount} of ${shared.length} shared tables have column differences.`);

console.log("\n=== APPROX ROW COUNTS (shared tables) ===");
for (const t of shared.sort()) {
  const s = server.countMap.get(t) ?? 0;
  const l = local.countMap.get(t) ?? 0;
  console.log(`${t}: server=${s} local=${l}`);
}
