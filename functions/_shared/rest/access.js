// Caller identity for /rest/v1. Row access is decided by Supabase's own row-level security policies in Postgres:
// each request runs inside a transaction under the anon or authenticated role, with the JWT claims set so that
// auth.uid(), auth.role(), auth.jwt() and auth.email() return the caller. This file only decides who the caller is,
// and which RPC functions run under a caller that has no row policy of its own (SECURITY DEFINER functions).
import jwt from "jsonwebtoken";
import { RestError } from "./errors.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ANON = Object.freeze({ role: "anon", userId: null, service: false });
const SERVICE = Object.freeze({ role: "service_role", userId: null, service: true });

// SECURITY DEFINER functions that are meant for anyone (public catalogue reads).
const PUBLIC_DEFINER = new Set([
  "get_category_descendants",
  "get_course_detail",
  "get_published_lecture_stats",
  "get_topic_lecture_durations",
]);
// Argument names that carry the caller's own id. A SECURITY DEFINER function with one of these must be called for
// yourself (or by an admin), because RLS does not apply inside a SECURITY DEFINER function.
const IDENTITY_ARGS = ["p_student_id", "p_user_id", "student_id", "user_id"];
// Worker and internal functions: only the service key may call them.
const INTERNAL_PREFIX = /^(claim|scan)_/;

// Works out who is calling. Runs inside the request transaction, before the role is switched.
// Returns anon, service, or an authenticated user whose sub exists in auth.users.
export async function resolveCaller(req, query) {
  const apikey = String(req.get("apikey") || "").trim();
  const bearer = String(req.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!apikey && !bearer) {
    throw new RestError(401, "No API key found in request", { code: "PGRST301" });
  }
  const serviceKey = process.env.SERVICE_KEY || "";
  if (bearer && serviceKey && bearer === serviceKey) return SERVICE;
  if (!bearer || bearer === apikey) return ANON;

  let payload;
  try {
    payload = jwt.verify(bearer, process.env.JWT_SECRET);
  } catch {
    throw new RestError(401, "JWT invalid", { code: "PGRST301" });
  }
  if (!payload.sub || payload.role === "anon") return ANON;
  const userId = String(payload.sub).toLowerCase();
  if (!UUID.test(userId)) throw new RestError(401, "JWT invalid", { code: "PGRST301" });

  const { rows } = await query("SELECT email FROM auth.users WHERE id = $1", [userId]);
  if (rows.length === 0) throw new RestError(401, "user not found", { code: "PGRST301" });
  return {
    role: "authenticated",
    userId,
    service: false,
    email: rows[0].email ?? null,
    exp: payload.exp,
  };
}

// Sets the role and the JWT claims for the rest of this transaction (set_config(..., true) is transaction-local).
// Service callers keep the session role: sl_test cannot SET ROLE service_role, and it owns every public table
// (none is FORCE RLS), so the service path bypasses RLS as the table owner.
export async function applyCaller(query, caller) {
  if (caller.service) {
    await query("SELECT set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.role', 'service_role', true)", [
      JSON.stringify({ role: "service_role" }),
    ]);
    return;
  }
  if (caller.role === "anon") {
    await query(
      "SELECT set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.role', 'anon', true), set_config('request.jwt.claim.sub', '', true)",
      [JSON.stringify({ role: "anon" })]
    );
    await query("SET LOCAL ROLE anon");
    return;
  }
  const claims = { sub: caller.userId, role: "authenticated", email: caller.email, exp: caller.exp };
  await query(
    "SELECT set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true), set_config('request.jwt.claim.role', 'authenticated', true), set_config('request.jwt.claim.email', $3, true)",
    [JSON.stringify(claims), caller.userId, caller.email ?? ""]
  );
  await query("SET LOCAL ROLE authenticated");
}

function denied(caller, what) {
  if (caller.role === "anon") return new RestError(401, `permission denied for ${what}`, { code: "42501" });
  return new RestError(403, `permission denied for ${what}`, { code: "42501" });
}

// Decides whether this caller may call an RPC function, and fills in the caller's own id where the function takes one.
// Invoker functions run as the caller, so their own RLS applies. SECURITY DEFINER functions bypass RLS, so they are
// gated here: functions with their own auth check run as is, identity functions need the caller's own id (or admin),
// and the rest need admin (has_role, the same check the policies use). Worker functions are service-only.
export async function authorizeRpc(meta, body, caller, query) {
  if (caller.service) return body;
  // Worker functions (claim_*) have no role check of their own, so only the service key may call them. A scan_* admin
  // function checks has_role() inside its body (it is "guarded"), so it is callable by admins.
  if (INTERNAL_PREFIX.test(meta.name) && !meta.guarded) throw denied(caller, `function public.${meta.name}`);
  if (!meta.definer || PUBLIC_DEFINER.has(meta.name)) return body;

  // A definer function that takes the caller's own id is checked against the JWT even when its body also checks
  // auth or roles, so a caller cannot name someone else's id just because the body mentions auth.uid().
  const identityArg = IDENTITY_ARGS.find((a) => meta.inNames.includes(a));
  if (meta.guarded && !identityArg) return body;
  if (identityArg) {
    if (!caller.userId) throw new RestError(401, "JWT required", { code: "PGRST301" });
    if (body[identityArg] === undefined || body[identityArg] === null) body[identityArg] = caller.userId;
    else if (String(body[identityArg]).toLowerCase() !== caller.userId) {
      const isAdmin = await isAdminCaller(caller, query);
      if (!isAdmin) throw denied(caller, `function public.${meta.name}`);
    }
    return body;
  }
  if (!(await isAdminCaller(caller, query))) throw denied(caller, `function public.${meta.name}`);
  return body;
}

async function isAdminCaller(caller, query) {
  if (!caller.userId) return false;
  const { rows } = await query("SELECT public.has_role(auth.uid(), 'admin'::app_role) AS ok");
  return rows[0]?.ok === true;
}
