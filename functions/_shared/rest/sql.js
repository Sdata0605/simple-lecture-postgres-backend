// Builds parameterised SQL for /rest/v1. Table, column and function names come only from the catalog,
// values only ever go in as $n parameters. JSON results are built in Postgres so timestamps keep PostgREST's format.
// No row rules are added here: Postgres row-level security (Supabase's policies) filters every read and write.
import { RestError } from "./errors.js";
import { getColumn, getTable, findRelation } from "./catalog.js";
import { parseInList } from "./parse.js";

export const MAX_ROWS = 1000;

class Ctx {
  constructor(cat) {
    this.cat = cat;
    this.params = [];
    this.aliasCount = 0;
  }
  p(value) {
    this.params.push(value);
    return `$${this.params.length}`;
  }
}

// Converts a JSON body value into a bound parameter. Objects go in as JSON text; arrays stay arrays for array columns.
function normalize(value, info) {
  if (value === undefined || value === null) return value ?? null;
  if (Array.isArray(value)) return info && info.type === "ARRAY" ? value : JSON.stringify(value);
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

function selectList(ctx, table, alias, items) {
  const parts = [];
  for (const it of items) {
    if (it.star) parts.push(`${alias}.*`);
    else if (it.column) {
      getColumn(ctx.cat, table, it.column);
      parts.push(it.alias ? `${alias}."${it.column}" AS "${it.alias}"` : `${alias}."${it.column}"`);
    } else parts.push(embedSql(ctx, table, alias, it));
  }
  return parts.length ? parts.join(", ") : `${alias}.*`;
}

// Embedded rows are subqueries correlated to the parent row. They run under the same role, so the target table's
// row policies apply to them too.
function embedSql(ctx, table, parent, item) {
  const rel = findRelation(ctx.cat, table, item.embed, item.hint);
  const alias = nextAlias(ctx);
  const cols = selectList(ctx, rel.target, alias, item.children);
  let where = `${alias}."${rel.targetCol}" = ${parent}."${rel.baseCol}"`;
  const own = ctx.embedFilters?.get(item);
  if (own && own.length) where += ` AND ${own.map((f) => filterSql(ctx, rel.target, alias, f)).join(" AND ")}`;
  const inner = `SELECT ${cols} FROM "${rel.target}" ${alias} WHERE ${where}`;
  const key = item.alias || item.embed;
  // One related row (many-to-one, or one-to-many through a UNIQUE column): an object or null, as PostgREST returns.
  if (rel.kind === "m2o" || rel.toOne) {
    return `(SELECT row_to_json(${alias}_r) FROM (${inner} LIMIT 1) ${alias}_r) AS "${key}"`;
  }
  return `(SELECT COALESCE(json_agg(${alias}_r), '[]'::json) FROM (${inner}) ${alias}_r) AS "${key}"`;
}

function nextAlias(ctx) {
  ctx.aliasCount += 1;
  return `x${ctx.aliasCount}`;
}

function condSql(ctx, expr, info, op, val) {
  switch (op) {
    case "eq":
      return `${expr} = ${ctx.p(val)}`;
    case "neq":
      return `${expr} <> ${ctx.p(val)}`;
    case "gt":
      return `${expr} > ${ctx.p(val)}`;
    case "gte":
      return `${expr} >= ${ctx.p(val)}`;
    case "lt":
      return `${expr} < ${ctx.p(val)}`;
    case "lte":
      return `${expr} <= ${ctx.p(val)}`;
    case "like":
      return `${expr}::text LIKE ${ctx.p(val.replaceAll("*", "%"))}`;
    case "ilike":
      return `${expr}::text ILIKE ${ctx.p(val.replaceAll("*", "%"))}`;
    case "is": {
      const v = val.toLowerCase();
      if (v === "null") return `${expr} IS NULL`;
      if (v === "true") return `${expr} IS TRUE`;
      if (v === "false") return `${expr} IS FALSE`;
      if (v === "unknown") return `${expr} IS UNKNOWN`;
      throw new RestError(400, "is operator takes null, true, false or unknown", { code: "PGRST100" });
    }
    case "in": {
      const list = parseInList(val);
      if (list.length === 0) return "FALSE";
      return `${expr} IN (${list.map((v) => ctx.p(v)).join(", ")})`;
    }
    case "cs":
    case "cd":
    case "ov": {
      const operator = { cs: "@>", cd: "<@", ov: "&&" }[op];
      const cast = info.udt === "jsonb" || info.udt === "json" ? "jsonb" : info.cast;
      if (info.type !== "ARRAY" && cast !== "jsonb") {
        throw new RestError(400, `operator ${op} needs an array or json column`, { code: "PGRST100" });
      }
      return `${expr} ${operator} ${ctx.p(val)}::${cast}`;
    }
    default:
      throw new RestError(400, `unsupported operator "${op}"`, { code: "PGRST100" });
  }
}

function filterSql(ctx, table, alias, node) {
  if (node.logic) {
    if (node.items.length === 0) throw new RestError(400, "empty logical group", { code: "PGRST100" });
    const joiner = node.logic === "and" ? " AND " : " OR ";
    return `(${node.items.map((i) => filterSql(ctx, table, alias, i)).join(joiner)})`;
  }
  const info = getColumn(ctx.cat, table, node.column);
  const sql = condSql(ctx, `${alias}."${node.column}"`, info, node.op, node.val);
  return node.negate ? `NOT (${sql})` : sql;
}

function whereSql(ctx, table, alias, filters) {
  return filters.map((f) => filterSql(ctx, table, alias, f)).join(" AND ");
}

function orderSql(cat, table, alias, orders) {
  return orders
    .map((o) => {
      getColumn(cat, table, o.column);
      return `${alias}."${o.column}" ${o.dir.toUpperCase()}${o.nulls ? ` NULLS ${o.nulls.toUpperCase()}` : ""}`;
    })
    .join(", ");
}

// Splits filters into the table's own filters and filters on embedded resources (by name or alias).
// Each embedded filter is applied to its embedded rows; for an !inner embed the parent rows must also have a match.
function prepareEmbedFilters(ctx, table, select, filters) {
  const own = filters.filter((f) => !f.embed);
  const byName = new Map();
  for (const f of filters.filter((x) => x.embed)) {
    if (!byName.has(f.embed)) byName.set(f.embed, []);
    byName.get(f.embed).push(f);
  }
  const extra = [];
  for (const [name, nodes] of byName) {
    const item = select.find((it) => it.embed && (it.alias || it.embed) === name);
    if (!item) throw new RestError(400, `embedded resource "${name}" must be in select`, { code: "PGRST100" });
    ctx.embedFilters.set(item, nodes);
    if (item.inner) {
      const rel = findRelation(ctx.cat, table, item.embed, item.hint);
      extra.push({ exists: { rel, nodes } });
    }
  }
  return { own, extra };
}

function existsSql(ctx, table, alias, ex) {
  const inner = nextAlias(ctx);
  const conds = ex.nodes.map((f) => filterSql(ctx, ex.rel.target, inner, f)).join(" AND ");
  return `EXISTS (SELECT 1 FROM "${ex.rel.target}" ${inner} WHERE ${inner}."${ex.rel.targetCol}" = ${alias}."${ex.rel.baseCol}" AND ${conds})`;
}

function whereWithEmbeds(ctx, table, alias, own, extra) {
  const parts = [whereSql(ctx, table, alias, own), ...extra.map((e) => existsSql(ctx, table, alias, e.exists))].filter(Boolean);
  return parts.join(" AND ");
}

// Select for a read. Returns { sql, params } where data is a JSON array in column "data".
export function readSql(cat, table, { select, filters, order, limit, offset }) {
  const ctx = new Ctx(cat);
  ctx.embedFilters = new Map();
  const { own, extra } = prepareEmbedFilters(ctx, table, select, filters);
  const where = whereWithEmbeds(ctx, table, "base", own, extra);
  const cols = selectList(ctx, table, "base", select);
  let sql = `SELECT ${cols} FROM "${table}" base`;
  if (where) sql += ` WHERE ${where}`;
  if (order.length) sql += ` ORDER BY ${orderSql(cat, table, "base", order)}`;
  if (limit !== null && limit !== undefined) sql += ` LIMIT ${Number(limit)}`;
  if (offset) sql += ` OFFSET ${Number(offset)}`;
  return { sql: `SELECT COALESCE(json_agg(r), '[]'::json) AS data FROM (${sql}) r`, params: ctx.params };
}

export function countSql(cat, table, filters, select = []) {
  const ctx = new Ctx(cat);
  ctx.embedFilters = new Map();
  const { own, extra } = prepareEmbedFilters(ctx, table, select, filters);
  const where = whereWithEmbeds(ctx, table, "base", own, extra);
  return {
    sql: `SELECT count(*)::int AS n FROM "${table}" base${where ? ` WHERE ${where}` : ""}`,
    params: ctx.params,
  };
}

// Columns for RETURNING. Embedded resources are not supported on write responses.
export function returningList(cat, table, select) {
  const parts = [];
  for (const it of select) {
    if (it.star) parts.push("*");
    else if (it.column) {
      getColumn(cat, table, it.column);
      parts.push(it.alias ? `"${it.column}" AS "${it.alias}"` : `"${it.column}"`);
    } else {
      throw new RestError(400, "embedded resources are not supported in write responses", { code: "PGRST100" });
    }
  }
  return parts.length ? parts.join(", ") : "*";
}

const wrapReturning = (dml, returning) =>
  `WITH r AS (${dml} RETURNING ${returning}) SELECT COALESCE(json_agg(r), '[]'::json) AS data FROM r`;

// INSERT ... VALUES, with optional ON CONFLICT for upserts. The INSERT and UPDATE row policies decide what is allowed.
export function insertSql(cat, table, inputRows, { onConflict, resolution, returning }) {
  const tbl = getTable(cat, table);
  const rows = inputRows.map((r) => ({ ...r }));
  for (const row of rows) for (const k of Object.keys(row)) getColumn(cat, table, k);
  if (rows.length === 0) return null;
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  if (cols.length === 0) throw new RestError(400, "no columns to insert", { code: "PGRST100" });

  const ctx = new Ctx(cat);
  const values = rows
    .map((row) => `(${cols.map((c) => (row[c] === undefined ? "DEFAULT" : ctx.p(normalize(row[c], getColumn(cat, table, c))))).join(", ")})`)
    .join(", ");
  let sql = `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES ${values}`;

  if (resolution) {
    const target = onConflict && onConflict.length ? onConflict : tbl.pk;
    if (target.length === 0) {
      throw new RestError(400, "on_conflict is needed for an upsert on a table without a primary key", { code: "PGRST100" });
    }
    target.forEach((c) => getColumn(cat, table, c));
    const targetSql = target.map((c) => `"${c}"`).join(", ");
    const updates = cols.filter((c) => !target.includes(c));
    if (resolution === "ignore-duplicates" || updates.length === 0) {
      sql += ` ON CONFLICT (${targetSql}) DO NOTHING`;
    } else {
      sql += ` ON CONFLICT (${targetSql}) DO UPDATE SET ${updates.map((c) => `"${c}" = EXCLUDED."${c}"`).join(", ")}`;
    }
  }
  if (returning) sql = wrapReturning(sql, returning);
  return { sql, params: ctx.params };
}

// UPDATE with the request filters. The UPDATE policy decides which rows change.
export function updateSql(cat, table, values, filters, { returning }) {
  const keys = Object.keys(values);
  if (keys.length === 0) throw new RestError(400, "no columns to update", { code: "PGRST100" });
  for (const k of keys) getColumn(cat, table, k);
  const ctx = new Ctx(cat);
  const set = keys.map((k) => `"${k}" = ${ctx.p(normalize(values[k], getColumn(cat, table, k)))}`).join(", ");
  const where = whereSql(ctx, table, "base", filters);
  let sql = `UPDATE "${table}" AS base SET ${set}${where ? ` WHERE ${where}` : ""}`;
  if (returning) sql = wrapReturning(sql, returning);
  return { sql, params: ctx.params };
}

export function deleteSql(cat, table, filters, { returning }) {
  const ctx = new Ctx(cat);
  const where = whereSql(ctx, table, "base", filters);
  let sql = `DELETE FROM "${table}" AS base${where ? ` WHERE ${where}` : ""}`;
  if (returning) sql = wrapReturning(sql, returning);
  return { sql, params: ctx.params };
}

// Calls a public function with named arguments taken from the JSON body. Values are bound, types come from pg_proc.
export function rpcSql(meta, body) {
  const ctx = new Ctx(null);
  const named = [];
  for (const [k, v] of Object.entries(body)) {
    const idx = meta.inNames.indexOf(k);
    if (idx < 0) {
      throw new RestError(400, `function public.${meta.name} has no argument named "${k}"`, { code: "PGRST202" });
    }
    const type = meta.inTypes[idx];
    let value = v ?? null;
    if (value !== null && typeof value === "object" && !(Array.isArray(value) && type.endsWith("[]"))) {
      value = JSON.stringify(value);
    }
    named.push(`"${k.replaceAll('"', '""')}" => ${ctx.p(value)}`);
  }
  const call = `public."${meta.name}"(${named.join(", ")})`;
  let sql;
  if (meta.rettype === "void") sql = `SELECT ${call}`;
  else if (meta.isSet && meta.outNames && meta.outNames.length === 1) {
    // RETURNS TABLE(col ...) with one column: name the column so each row is an object {"col": value}.
    const col = meta.outNames[0];
    const key = col.replaceAll('"', '""');
    const lit = col.replaceAll("'", "''");
    sql = `SELECT COALESCE(json_agg(json_build_object('${lit}', t."v")), '[]'::json) AS data FROM ${call} AS t("v")`;
  } else if (meta.isSet) sql = `SELECT COALESCE(json_agg(r), '[]'::json) AS data FROM ${call} r`;
  else sql = `SELECT to_json(${call}) AS data`;
  return { sql, params: ctx.params };
}
