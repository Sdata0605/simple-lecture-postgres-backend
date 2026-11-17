// Insert-only catch-up: copies rows that exist in the live Supabase project but are
// missing on the server database (NEW_DATABASE_URL, container simplelecture-pg17).
//
// - Never updates or deletes anything on the server. Existing rows are left as they are.
// - Rows are matched by primary key; inserts use ON CONFLICT (pk) DO NOTHING, so re-runs are safe.
// - Reads Supabase in batches (keyset on the primary key); no full dump file is created.
// - Dry run is the default. Pass --apply to write.
// - Supabase is only ever read. Source connections run in READ ONLY transactions.
//
// Usage (from backend/):  node scripts/copy-supabase-missing.mjs            (dry run)
//                         node scripts/copy-supabase-missing.mjs --apply    (write)
import "dotenv/config";
import pg from "pg";
import fs from "node:fs";
import path from "node:path";

const APPLY = process.argv.includes("--apply");
const BATCH = 1000;
const SCHEMAS = ["public", "auth", "storage"];
const SUPABASE_REF = "oxwhqvsoelqqsblmqkxx";
const SUPABASE_HOST = process.env.SUPABASE_POOLER_HOST || "aws-1-ap-south-1.pooler.supabase.com";

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
fs.mkdirSync("logs", { recursive: true });
const logFile = path.resolve("logs", `copy-supabase-${APPLY ? "apply" : "dry-run"}-${stamp}.log`);
function log(msg) {
  console.log(msg);
  fs.appendFileSync(logFile, msg + "\n");
}

const q = (id) => '"' + String(id).replace(/"/g, '""') + '"';
const tbl = (s, t) => `${q(s)}.${q(t)}`;

if (!process.env.SUPABASE_DB_PASSWORD) throw new Error("SUPABASE_DB_PASSWORD not set");
if (!process.env.NEW_DATABASE_URL) throw new Error("NEW_DATABASE_URL not set");

const src = new pg.Client({
  host: SUPABASE_HOST,
  port: 5432,
  user: `postgres.${SUPABASE_REF}`,
  password: process.env.SUPABASE_DB_PASSWORD,
  database: "postgres",
  ssl: { rejectUnauthorized: false },
  statement_timeout: 0,
});
const dst = new pg.Client({
  connectionString: process.env.NEW_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function readOnly(client, fn) {
  await client.query("BEGIN READ ONLY");
  try {
    return await fn();
  } finally {
    await client.query("ROLLBACK");
  }
}

async function loadMeta(client) {
  const tables = (
    await client.query(
      `select n.nspname as s, c.relname as t
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind = 'r' and n.nspname = any($1)
        order by 1, 2`,
      [SCHEMAS]
    )
  ).rows;

  const pks = (
    await client.query(
      `select n.nspname as s, c.relname as t,
              array(select a.attname::text
                      from unnest(i.indkey) with ordinality k(attnum, ord)
                      join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
                     order by k.ord) as pk
         from pg_index i
         join pg_class c on c.oid = i.indrelid
         join pg_namespace n on n.oid = c.relnamespace
        where i.indisprimary and n.nspname = any($1)`,
      [SCHEMAS]
    )
  ).rows;
  const pkMap = new Map(pks.map((r) => [`${r.s}.${r.t}`, r.pk]));

  const fks = (
    await client.query(
      `select ns.nspname as s, cs.relname as t, nf.nspname as fs, cf.relname as ft
         from pg_constraint k
         join pg_class cs on cs.oid = k.conrelid join pg_namespace ns on ns.oid = cs.relnamespace
         join pg_class cf on cf.oid = k.confrelid join pg_namespace nf on nf.oid = cf.relnamespace
        where k.contype = 'f'`
    )
  ).rows;

  const cols = (
    await client.query(
      `select table_schema as s, table_name as t, column_name as c, is_generated, identity_generation
         from information_schema.columns
        where table_schema = any($1)
        order by table_schema, table_name, ordinal_position`,
      [SCHEMAS]
    )
  ).rows;
  const colMap = new Map();
  for (const r of cols) {
    const key = `${r.s}.${r.t}`;
    if (!colMap.has(key)) colMap.set(key, []);
    colMap.get(key).push(r);
  }
  return { tables, pkMap, fks, colMap };
}

// Parent tables first (FK order). Cycles and self-references are appended in name order.
function orderTables(list, fks) {
  const keys = list.map((t) => `${t.s}.${t.t}`);
  const inScope = new Set(keys);
  const deps = new Map(keys.map((k) => [k, new Set()]));
  for (const f of fks) {
    const child = `${f.s}.${f.t}`;
    const parent = `${f.fs}.${f.ft}`;
    if (child !== parent && inScope.has(child) && inScope.has(parent)) deps.get(child).add(parent);
  }
  const done = new Set();
  const out = [];
  let progress = true;
  while (out.length < keys.length && progress) {
    progress = false;
    for (const k of keys) {
      if (done.has(k)) continue;
      if ([...deps.get(k)].every((p) => done.has(p))) {
        done.add(k);
        out.push(k);
        progress = true;
      }
    }
  }
  for (const k of keys) if (!done.has(k)) out.push(k); // cycles: retried later
  return out;
}

async function copyTable(key, meta, srcCols, dstCols) {
  const [s, t] = key.split(".");
  const pk = meta.pkMap.get(key);
  const copyCols = srcCols.filter((c) => dstCols.has(c));
  const pkList = pk.map(q).join(",");
  const colList = copyCols.map(q).join(",");
  const result = { key, srcRows: 0, missing: 0, inserted: 0, dstBefore: 0, dstAfter: 0, error: null };

  result.srcRows = Number(
    (await readOnly(src, () => src.query(`select count(*)::bigint as n from ${tbl(s, t)}`))).rows[0].n
  );
  result.dstBefore = Number(
    (await readOnly(dst, () => dst.query(`select count(*)::bigint as n from ${tbl(s, t)}`))).rows[0].n
  );

  let last = null;
  for (;;) {
    const where = last ? `where (${pkList}) > (${pk.map((_, i) => `$${i + 1}`).join(",")})` : "";
    const params = last ? pk.map((c) => last[c]) : [];
    const batch = await readOnly(src, async () =>
      (
        await src.query(
          `select coalesce(json_agg(r), '[]'::json) as j from (
             select ${colList} from ${tbl(s, t)} ${where} order by ${pkList} limit ${BATCH}) r`,
          params
        )
      ).rows[0].j
    );
    if (!batch.length) break;
    last = batch[batch.length - 1];

    const pkJoin = pk.map((c) => `x.${q(c)} = r.${q(c)}`).join(" and ");
    if (!APPLY) {
      const miss = await readOnly(dst, async () =>
        Number(
          (
            await dst.query(
              `select count(*)::bigint as n from json_populate_recordset(null::${tbl(s, t)}, $1::json) r
                where not exists (select 1 from ${tbl(s, t)} x where ${pkJoin})`,
              [JSON.stringify(batch)]
            )
          ).rows[0].n
        )
      );
      result.missing += miss;
    } else {
      await dst.query("BEGIN");
      try {
        const ins = await dst.query(
          `insert into ${tbl(s, t)} (${colList})
             select ${colList} from json_populate_recordset(null::${tbl(s, t)}, $1::json)
             on conflict do nothing`,
          [JSON.stringify(batch)]
        );
        await dst.query("COMMIT");
        result.inserted += ins.rowCount;
      } catch (e) {
        await dst.query("ROLLBACK");
        throw e;
      }
    }
    if (batch.length < BATCH) break;
  }

  result.dstAfter = Number(
    (await readOnly(dst, () => dst.query(`select count(*)::bigint as n from ${tbl(s, t)}`))).rows[0].n
  );
  return result;
}

async function main() {
  log(`mode: ${APPLY ? "APPLY (writes to server DB, inserts missing rows only)" : "DRY RUN (no writes)"}`);
  log(`log file: ${logFile}`);
  await src.connect();
  log("connected: supabase (read only use)");
  await dst.connect();
  log("connected: server database");

  const meta = await readOnly(src, () => loadMeta(src));
  const noPk = meta.tables.filter((t) => !meta.pkMap.has(`${t.s}.${t.t}`));
  const withPk = meta.tables.filter((t) => meta.pkMap.has(`${t.s}.${t.t}`));
  log(`tables in scope: ${meta.tables.length}, with primary key: ${withPk.length}, skipped (no pk): ${noPk.length}`);
  for (const t of noPk) log(`  skipped no-pk: ${t.s}.${t.t}`);

  const dstMeta = await readOnly(dst, () => loadMeta(dst));
  const order = orderTables(withPk, meta.fks);

  const results = [];
  const failed = [];
  for (const key of order) {
    const [s, t] = key.split(".");
    if (!dstMeta.tables.some((x) => x.s === s && x.t === t)) {
      log(`  ${key}: MISSING on server, skipped`);
      results.push({ key, error: "table missing on server" });
      continue;
    }
    const srcCols = (meta.colMap.get(key) || [])
      .filter((c) => c.is_generated === "NEVER" && c.identity_generation !== "ALWAYS")
      .map((c) => c.c);
    const dstCols = new Set(
      (dstMeta.colMap.get(key) || [])
        .filter((c) => c.is_generated === "NEVER" && c.identity_generation !== "ALWAYS")
        .map((c) => c.c)
    );
    const extra = srcCols.filter((c) => !dstCols.has(c));
    try {
      const r = await copyTable(key, { pkMap: meta.pkMap }, srcCols, dstCols);
      results.push(r);
      log(
        `  ${key}: supabase=${r.srcRows} server_before=${r.dstBefore}` +
          (APPLY ? ` inserted=${r.inserted}` : ` missing=${r.missing}`) +
          ` server_after=${r.dstAfter}` +
          (extra.length ? ` (columns not on server, not copied: ${extra.join(", ")})` : "")
      );
    } catch (e) {
      failed.push(key);
      log(`  ${key}: ERROR ${e.message}`);
    }
  }

  if (failed.length) {
    log(`retrying ${failed.length} failed table(s) once (parents may have been missing)`);
    for (const key of failed.splice(0)) {
      try {
        const srcCols = (meta.colMap.get(key) || [])
          .filter((c) => c.is_generated === "NEVER" && c.identity_generation !== "ALWAYS")
          .map((c) => c.c);
        const dstCols = new Set(
          (dstMeta.colMap.get(key) || [])
            .filter((c) => c.is_generated === "NEVER" && c.identity_generation !== "ALWAYS")
            .map((c) => c.c)
        );
        const r = await copyTable(key, { pkMap: meta.pkMap }, srcCols, dstCols);
        log(`  ${key}: retry ok, supabase=${r.srcRows} server_after=${r.dstAfter}`);
      } catch (e) {
        log(`  ${key}: STILL FAILING ${e.message}`);
      }
    }
  }

  const totalMissing = results.reduce((a, r) => a + (r.missing || 0), 0);
  const totalInserted = results.reduce((a, r) => a + (r.inserted || 0), 0);
  log(APPLY ? `done. rows inserted: ${totalInserted}` : `dry run done. rows missing on server: ${totalMissing}`);
}

try {
  await main();
} finally {
  await src.end().catch(() => {});
  await dst.end().catch(() => {});
}
