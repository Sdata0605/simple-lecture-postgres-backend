// Parses PostgREST query syntax (select, filters, or/and groups, order, in-lists) into plain objects.
// Parsing only checks shape. Names are checked against the catalog later, and values are always bound as parameters.
import { RestError } from "./errors.js";
import { IDENT } from "./catalog.js";

export const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);
const OPS = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "is", "in", "cs", "cd", "ov"]);

export function bad(message, code = "PGRST100") {
  return new RestError(400, message, { code });
}

export function validateIdent(name) {
  if (typeof name !== "string" || !IDENT.test(name)) throw bad(`invalid identifier "${String(name).slice(0, 60)}"`);
  return name;
}

// Splits on commas that are not inside parentheses or double quotes. Quote characters are kept for later unquoting.
export function splitTop(s) {
  const out = [];
  let depth = 0;
  let inQuote = false;
  let cur = "";
  for (const ch of s) {
    if (ch === '"') inQuote = !inQuote;
    else if (!inQuote && ch === "(") depth++;
    else if (!inQuote && ch === ")") depth--;
    if (depth < 0) throw bad("unbalanced parentheses");
    if (ch === "," && depth === 0 && !inQuote) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (depth !== 0 || inQuote) throw bad("unbalanced parentheses or quotes");
  out.push(cur);
  return out.map((x) => x.trim()).filter((x) => x !== "");
}

const unquote = (s) => (s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s);

// select=*,id,title:name,courses!fk(name,*),alias:table(cols)
export function parseSelect(input) {
  const items = [];
  for (const part of splitTop(input || "*")) {
    if (part === "*") {
      items.push({ star: true });
      continue;
    }
    const m = /^(?:([A-Za-z_][A-Za-z0-9_]*):)?([A-Za-z_][A-Za-z0-9_]*)(?:!([A-Za-z_][A-Za-z0-9_]*))?(?:\((.*)\))?$/s.exec(part);
    if (!m) throw bad(`invalid select item "${part.slice(0, 80)}"`);
    const [, alias, name, hintRaw, inner] = m;
    if (inner !== undefined) {
      const hint = hintRaw === "inner" || hintRaw === "left" ? undefined : hintRaw;
      items.push({ embed: validateIdent(name), alias, hint, inner: hintRaw === "inner", children: parseSelect(inner) });
    } else {
      if (hintRaw) throw bad(`invalid select item "${part.slice(0, 80)}"`);
      items.push({ column: validateIdent(name), alias: alias ? validateIdent(alias) : undefined });
    }
  }
  return items;
}

// order=col.desc.nullslast,other.asc
export function parseOrder(input) {
  if (!input) return [];
  return splitTop(input).map((part) => {
    const [column, ...bits] = part.split(".");
    validateIdent(column);
    let dir = "asc";
    let nulls = null;
    for (const b of bits) {
      if (b === "asc" || b === "desc") dir = b;
      else if (b === "nullsfirst" || b === "nullslast") nulls = b === "nullsfirst" ? "first" : "last";
      else throw bad(`invalid order term "${part.slice(0, 80)}"`);
    }
    return { column, dir, nulls };
  });
}

// "eq.5", "not.is.null", "in.(a,b)", "ilike.*foo*". Returns { op, val, negate }.
export function parseCondition(raw) {
  if (typeof raw !== "string") throw bad("filter value must be a string");
  let s = raw;
  let negate = false;
  if (s.startsWith("not.")) {
    negate = true;
    s = s.slice(4);
  }
  const dot = s.indexOf(".");
  if (dot < 0) throw bad(`invalid filter "${raw.slice(0, 80)}"`);
  const op = s.slice(0, dot);
  if (!OPS.has(op)) throw bad(`unsupported operator "${op}"`);
  let val = s.slice(dot + 1);
  if (op !== "in") val = unquote(val);
  return { op, val, negate };
}

// or=(a.eq.1,and(b.is.null,c.gt.2)) and the and= form. Returns { logic, items }.
export function parseGroup(logic, raw) {
  if (typeof raw !== "string" || !raw.startsWith("(") || !raw.endsWith(")")) {
    throw bad(`${logic} must look like ${logic}=(...)`);
  }
  return { logic, items: splitTop(raw.slice(1, -1)).map(parseGroupItem) };
}

function parseGroupItem(item) {
  const m = /^(and|or)\((.*)\)$/s.exec(item);
  if (m) return { logic: m[1], items: splitTop(m[2]).map(parseGroupItem) };
  const dot = item.indexOf(".");
  if (dot <= 0) throw bad(`invalid group condition "${item.slice(0, 80)}"`);
  const column = validateIdent(item.slice(0, dot));
  return { column, ...parseCondition(item.slice(dot + 1)) };
}

// All filter keys in a query string (everything that is not a reserved parameter).
// "relation.column=op.value" filters an embedded resource (PostgREST form); the node carries "embed".
export function parseFilters(query) {
  const out = [];
  for (const [key, raw] of Object.entries(query)) {
    if (RESERVED.has(key)) continue;
    for (const value of [].concat(raw)) {
      if (key === "or" || key === "and") out.push(parseGroup(key, value));
      else if (key.includes(".")) {
        const dot = key.indexOf(".");
        out.push({ embed: validateIdent(key.slice(0, dot)), column: validateIdent(key.slice(dot + 1)), ...parseCondition(value) });
      } else out.push({ column: validateIdent(key), ...parseCondition(value) });
    }
  }
  return out;
}

// in.(a,"b,c") -> ["a", "b,c"]
export function parseInList(val) {
  if (!val.startsWith("(") || !val.endsWith(")")) throw bad("in operator needs a list like in.(a,b)");
  const inner = val.slice(1, -1);
  if (inner === "") return [];
  return splitTop(inner).map(unquote);
}

export function intParam(value, name) {
  if (value === undefined) return null;
  const s = Array.isArray(value) ? value[0] : value;
  if (!/^\d{1,9}$/.test(String(s))) throw bad(`${name} must be a non-negative integer`);
  return Number(s);
}

export function first(v) {
  return Array.isArray(v) ? v[0] : v;
}

// Prefer: return=representation, count=exact, resolution=merge-duplicates (comma-separated tokens).
export function parsePrefer(header) {
  const out = {};
  for (const part of String(header || "").split(",")) {
    const [k, v] = part.trim().split("=");
    if (k) out[k.toLowerCase()] = (v ?? "").toLowerCase();
  }
  return out;
}

export function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
