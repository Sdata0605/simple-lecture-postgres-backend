// Schema whitelist for the /rest/v1 layer. Every table, column, relation and function name used in a
// request is checked against this catalog before it is placed in SQL, so names never come from raw input.
import { query } from "../db.js";
import { RestError } from "./errors.js";

const TTL_MS = 60_000;
let cached = null;
let loadedAt = 0;
let loading = null;

export const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function getCatalog() {
  if (cached && Date.now() - loadedAt < TTL_MS) return cached;
  if (!loading) {
    loading = load().then(
      (c) => {
        cached = c;
        loadedAt = Date.now();
        loading = null;
        return c;
      },
      (e) => {
        loading = null;
        throw e;
      }
    );
  }
  return loading;
}

async function load() {
  const [cols, fks, pks, uniques] = await Promise.all([
    query(`SELECT table_name, column_name, data_type, udt_name
             FROM information_schema.columns
            WHERE table_schema = 'public'
            ORDER BY table_name, ordinal_position`),
    query(`SELECT DISTINCT tc.table_name AS tbl, kcu.column_name AS col, tc.constraint_name AS con,
                  ccu.table_name AS ftbl, ccu.column_name AS fcol
             FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu
               ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
             JOIN information_schema.constraint_column_usage ccu
               ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
            WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`),
    query(`SELECT tc.table_name AS tbl, kcu.column_name AS col
             FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu
               ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
            WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'
            ORDER BY tc.table_name, kcu.ordinal_position`),
    // Single-column UNIQUE constraints: an embed through such a column is one row, not a list (as in PostgREST).
    query(`SELECT tc.table_name AS tbl, kcu.column_name AS col
             FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu
               ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
            WHERE tc.constraint_type = 'UNIQUE' AND tc.table_schema = 'public'
              AND (SELECT count(*) FROM information_schema.key_column_usage k2
                    WHERE k2.constraint_name = tc.constraint_name AND k2.table_schema = tc.table_schema) = 1`),
  ]);

  const tables = new Map();
  for (const r of cols.rows) {
    let t = tables.get(r.table_name);
    if (!t) tables.set(r.table_name, (t = { name: r.table_name, columns: new Map(), pk: [] }));
    // Array columns report data_type ARRAY; their udt_name is "_elem", so the cast is "elem[]".
    const cast = r.data_type === "ARRAY" ? `${r.udt_name.replace(/^_/, "")}[]` : r.udt_name;
    t.columns.set(r.column_name, { type: r.data_type, udt: r.udt_name, cast });
  }
  for (const r of pks.rows) tables.get(r.tbl)?.pk.push(r.col);
  for (const r of uniques.rows) {
    const t = tables.get(r.tbl);
    if (t) (t.unique ??= new Set()).add(r.col);
  }
  const fkList = fks.rows.map((r) => ({ tbl: r.tbl, col: r.col, con: r.con, ftbl: r.ftbl, fcol: r.fcol }));
  return { tables, fkList, loadedAt: Date.now() };
}

export function getTable(cat, name) {
  const t = IDENT.test(name) ? cat.tables.get(name) : undefined;
  if (!t) throw new RestError(404, `relation "public.${name}" does not exist`, { code: "42P01" });
  return t;
}

export function getColumn(cat, table, name) {
  const col = IDENT.test(name) ? getTable(cat, table).columns.get(name) : undefined;
  if (!col) throw new RestError(400, `column ${table}.${name} does not exist`, { code: "42703" });
  return col;
}

// Finds the foreign key linking base and target. "m2o" means base holds the key (courses(name) from cart_items);
// "o2m" means target holds the key (an array result). hint is an optional FK column name for disambiguation.
export function findRelation(cat, base, target, hint) {
  if (!IDENT.test(target) || !cat.tables.has(target)) {
    throw new RestError(400, `could not find a relationship between ${base} and ${target}`, { code: "PGRST200" });
  }
  const m2o = cat.fkList
    .filter((f) => f.tbl === base && f.ftbl === target)
    .map((f) => ({ kind: "m2o", baseCol: f.col, targetCol: f.fcol, hintCol: f.col, hintCon: f.con }));
  const o2m = cat.fkList
    .filter((f) => f.tbl === target && f.ftbl === base)
    .map((f) => ({
      kind: "o2m",
      baseCol: f.fcol,
      targetCol: f.col,
      hintCol: f.col,
      hintCon: f.con,
      toOne: !!cat.tables.get(target)?.unique?.has(f.col),
    }));
  let found = [...m2o, ...o2m];
  // PostgREST hints name either the foreign-key constraint or the column that holds it.
  if (hint) found = found.filter((r) => r.hintCon === hint || r.hintCol === hint);
  if (found.length !== 1) {
    throw new RestError(400, `could not embed ${target} in ${base}: ${found.length} matching relationships`, {
      code: "PGRST200",
      hint: "Use !column to choose the relationship.",
    });
  }
  return { ...found[0], target };
}

// Looks up the IN parameters of a public function. Overloads are rejected because named arguments must be unambiguous.
// definer: SECURITY DEFINER (runs past RLS). guarded: its body checks auth.uid()/auth.role()/auth.jwt()/has_role().
// Both are used by access.js authorizeRpc. query defaults to the pool, but the request passes its own transaction.
export async function getFunctionMeta(name, run = query) {
  const { rows } = await run(
    `SELECT p.proretset, format_type(p.prorettype, NULL) AS rettype,
            p.proargnames AS argnames, p.proargmodes::text[] AS argmodes,
            p.prosecdef AS definer,
            pg_get_functiondef(p.oid) ~ 'auth\\.(uid|role|jwt|email)\\(|has_role\\(' AS guarded,
            ARRAY(SELECT format_type(u.x, NULL)
                    FROM unnest(COALESCE(p.proallargtypes, p.proargtypes::oid[])) WITH ORDINALITY AS u(x, o)
                   ORDER BY u.o) AS argtypes
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = $1`,
    [name]
  );
  if (rows.length === 0) {
    throw new RestError(404, `Could not find the function public.${name}`, { code: "PGRST202" });
  }
  if (rows.length > 1) {
    throw new RestError(400, `function public.${name} is overloaded`, { code: "PGRST203" });
  }
  const r = rows[0];
  const names = r.argnames || [];
  const modes = r.argmodes;
  const inNames = [];
  const inTypes = [];
  const outNames = [];
  r.argtypes.forEach((type, i) => {
    const mode = modes ? modes[i] : "i";
    if (["i", "b", "v"].includes(mode) && names[i]) {
      inNames.push(names[i]);
      inTypes.push(type);
    }
    if (mode === "t" && names[i]) outNames.push(names[i]);
  });
  return {
    name,
    isSet: r.proretset,
    rettype: r.rettype,
    outNames,
    inNames,
    inTypes,
    definer: r.definer === true,
    guarded: r.guarded === true,
  };
}
