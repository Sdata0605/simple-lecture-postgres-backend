// PostgREST-compatible /rest/v1 layer, so supabase-js works against this backend with only a base-URL change.
// Every request runs in its own transaction under the caller's Postgres role (anon, authenticated, or the
// service key's session role), so Supabase's row-level security policies decide what is read and written.
// Caller rules are in _shared/rest/access.js and the transaction wrapper is in _shared/rest/tx.js.
import express from "express";
import { log } from "../_shared/log.js";
import { toRestError } from "../_shared/rest/errors.js";
import { getCatalog, getTable, getFunctionMeta } from "../_shared/rest/catalog.js";
import { authorizeRpc } from "../_shared/rest/access.js";
import { withRestDb } from "../_shared/rest/tx.js";
import {
  parseSelect,
  parseOrder,
  parseFilters,
  parsePrefer,
  intParam,
  first,
  isPlainObject,
  bad,
} from "../_shared/rest/parse.js";
import {
  MAX_ROWS,
  readSql,
  countSql,
  insertSql,
  updateSql,
  deleteSql,
  returningList,
  rpcSql,
} from "../_shared/rest/sql.js";

export const router = express.Router();

// A route returns { status, headers?, json? }. json undefined means no body. It is sent only after COMMIT.
const sendReply = (res, reply) => {
  for (const [k, v] of Object.entries(reply.headers || {})) res.set(k, v);
  if (reply.json === undefined) return res.status(reply.status).end();
  return res.status(reply.status).json(reply.json);
};

const handle = (fn) => async (req, res) => {
  const ctx = { caller: null };
  try {
    // The catalog is loaded on the pool before a request takes its own client, so a cold cache cannot starve the pool.
    await getCatalog();
    const reply = await withRestDb(req, ctx, ({ query, caller }) => fn(req, { query, caller }));
    return sendReply(res, reply);
  } catch (err) {
    const e = toRestError(err, ctx.caller);
    if (e) return res.status(e.status).json({ code: e.code, details: e.details, hint: e.hint, message: e.message });
    log.error("rest.error", { method: req.method, path: req.path, message: err?.message });
    return res.status(500).json({ code: "PGRST000", details: null, hint: null, message: "internal error" });
  }
};

// GET (and HEAD, which Express routes here too). Supports select, filters, order, limit/offset, Range, count, single.
async function readRoute(req, db) {
  const table = req.params.table;
  const cat = await getCatalog();
  getTable(cat, table);

  const filters = parseFilters(req.query);
  const select = parseSelect(first(req.query.select) ?? "*");
  const order = parseOrder(first(req.query.order));
  let limit = intParam(req.query.limit, "limit");
  let offset = intParam(req.query.offset, "offset") ?? 0;
  const range = /^(\d+)-(\d*)$/.exec(req.get("Range") || "");
  if (range) {
    offset = Number(range[1]);
    if (range[2] !== "") limit = Number(range[2]) - offset + 1;
  }
  const prefer = parsePrefer(req.get("Prefer"));
  const isHead = req.method === "HEAD";
  const single = /application\/vnd\.pgrst\.object\+json/.test(req.get("Accept") || "");

  let total = null;
  if (isHead || prefer.count) {
    const c = countSql(cat, table, filters, select);
    total = (await db.query(c.sql, c.params)).rows[0].n;
  }

  let rows = [];
  if (!isHead) {
    // Without an explicit limit, results are capped at MAX_ROWS (matches Supabase's default max rows).
    const fetchLimit = single ? 2 : Math.min(limit ?? MAX_ROWS, MAX_ROWS);
    const r = readSql(cat, table, { select, filters, order, limit: fetchLimit, offset });
    rows = (await db.query(r.sql, r.params)).rows[0].data ?? [];
  }

  const headers = {
    "Access-Control-Expose-Headers": "Content-Range",
    "Content-Range": `${rows.length ? `${offset}-${offset + rows.length - 1}` : "*"}/${total ?? "*"}`,
  };
  if (isHead) return { status: 200, headers };
  if (single) {
    if (rows.length !== 1) {
      return {
        status: 406,
        headers,
        json: {
          code: "PGRST116",
          details: rows.length === 0 ? "The result contains 0 rows" : `The result contains ${rows.length} rows`,
          hint: null,
          message: "JSON object requested, multiple (or no) rows returned",
        },
      };
    }
    return { status: 200, headers, json: rows[0] };
  }
  return { status: 200, headers, json: rows };
}

// Writes return an array by default. When the client asks for a single object (supabase-js .single() sends
// Accept: application/vnd.pgrst.object+json), return that one row, or 406 when the count is not exactly one (as GET does).
function singleOrArray(rows, single, headers) {
  if (!single) return { json: rows };
  if (rows.length !== 1) {
    return {
      status: 406,
      headers,
      json: {
        code: "PGRST116",
        details: rows.length === 0 ? "The result contains 0 rows" : `The result contains ${rows.length} rows`,
        hint: null,
        message: "JSON object requested, multiple (or no) rows returned",
      },
    };
  }
  return { json: rows[0] };
}
const wantsSingle = (req) => /application\/vnd\.pgrst\.object\+json/.test(req.get("Accept") || "");

// POST: insert one object or an array. Prefer: resolution=merge-duplicates (upsert) and on_conflict=col,... are supported.
async function insertRoute(req, db) {
  const table = req.params.table;
  const cat = await getCatalog();
  getTable(cat, table);

  const input = req.body;
  const rows = Array.isArray(input) ? input : [input];
  if (rows.length === 0 || !rows.every(isPlainObject)) {
    throw bad("request body must be a JSON object or an array of objects");
  }
  const prefer = parsePrefer(req.get("Prefer"));
  const returning = prefer.return === "representation";
  const onConflict = first(req.query.on_conflict)
    ? String(first(req.query.on_conflict)).split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  const resolution = ["merge-duplicates", "ignore-duplicates"].includes(prefer.resolution) ? prefer.resolution : null;
  const select = parseSelect(first(req.query.select) ?? "*");
  const built = insertSql(cat, table, rows, {
    onConflict,
    resolution,
    returning: returning ? returningList(cat, table, select) : null,
  });
  if (!built) return { status: 201, json: [] };
  const result = (await db.query(built.sql, built.params)).rows[0];
  if (!returning) return { status: 201 };
  const shaped = singleOrArray(result?.data ?? [], wantsSingle(req));
  return { status: shaped.status ?? 201, headers: shaped.headers, json: shaped.json };
}

// PATCH: update rows matching the filters. A filter is required so a request cannot touch the whole table by accident.
async function updateRoute(req, db) {
  const table = req.params.table;
  const cat = await getCatalog();
  getTable(cat, table);

  const values = req.body;
  if (!isPlainObject(values)) throw bad("request body must be a JSON object");
  const filters = parseFilters(req.query);
  if (filters.length === 0) throw bad("PATCH requires at least one filter");
  const prefer = parsePrefer(req.get("Prefer"));
  const returning = prefer.return === "representation";
  const select = parseSelect(first(req.query.select) ?? "*");
  const built = updateSql(cat, table, values, filters, {
    returning: returning ? returningList(cat, table, select) : null,
  });
  const result = (await db.query(built.sql, built.params)).rows[0];
  if (!returning) return { status: 204 };
  const shaped = singleOrArray(result?.data ?? [], wantsSingle(req));
  return { status: shaped.status ?? 200, headers: shaped.headers, json: shaped.json };
}

// DELETE: remove rows matching the filters. A filter is required, as for PATCH.
async function deleteRoute(req, db) {
  const table = req.params.table;
  const cat = await getCatalog();
  getTable(cat, table);

  const filters = parseFilters(req.query);
  if (filters.length === 0) throw bad("DELETE requires at least one filter");
  const prefer = parsePrefer(req.get("Prefer"));
  const returning = prefer.return === "representation";
  const select = parseSelect(first(req.query.select) ?? "*");
  const built = deleteSql(cat, table, filters, {
    returning: returning ? returningList(cat, table, select) : null,
  });
  const result = (await db.query(built.sql, built.params)).rows[0];
  if (!returning) return { status: 204 };
  const shaped = singleOrArray(result?.data ?? [], wantsSingle(req));
  return { status: shaped.status ?? 200, headers: shaped.headers, json: shaped.json };
}

// POST /rpc/<fn>: the function must exist in pg_proc in schema public. Arguments come from the JSON body by name.
// authorizeRpc decides who may call it (invoker functions use the caller's RLS; SECURITY DEFINER ones are gated).
async function rpcRoute(req, db) {
  const name = req.params.fn;
  const meta = await getFunctionMeta(name, db.query);
  const body = isPlainObject(req.body) ? { ...req.body } : {};
  await authorizeRpc(meta, body, db.caller, db.query);

  const built = rpcSql(meta, body);
  const result = (await db.query(built.sql, built.params)).rows[0];
  if (meta.rettype === "void") return { status: 204 };
  return { status: 200, json: result?.data ?? null };
}

router.post("/rpc/:fn", handle(rpcRoute));
router.get("/:table", handle(readRoute));
router.post("/:table", handle(insertRoute));
router.patch("/:table", handle(updateRoute));
router.delete("/:table", handle(deleteRoute));
