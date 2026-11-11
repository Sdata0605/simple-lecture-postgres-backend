// Port of supabase/functions/ai-teacher-keys. Each signed-in student keeps their own Gemini API
// keys here (up to 10). Same actions, errors and reply shape as the original.
//
// POST /functions/v1/ai-teacher-keys   Authorization: Bearer <user access token>
// body: { action, ... }
//   get | savePrefs {prefs} | addKey {label, apiKey} | updateKey {id, label?, apiKey?}
//   deleteKey {id} | reorder {ids} | setActive {id} | testKey {id} | reportFailure {id, error}
// Errors: { error, code }. Codes: UNAUTHORIZED 401, BAD_REQUEST 400, INVALID_KEY 400, KEY_LIMIT 400,
//         DUPLICATE_KEY 409, NOT_FOUND 404, PLAN_REQUIRED 402, INTERNAL 500.
import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../_shared/db.js";
import {
  classifyGeminiError,
  decryptKey,
  encryptKey,
  isUsableKey,
  markKey,
  maskKey,
  setActiveKey,
  sha256Hex,
} from "../_shared/studentKeys.js";
import { hasPlusPlan } from "../_shared/plusPlan.js";

const MAX_KEYS = 10;
const TEST_TIMEOUT_MS = 10_000;
const DEFAULT_TEACHER_NAME = "AI Teacher";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Must match the lists in ai-teacher (PRESETS, LANGUAGES, VOICES).
const PRESETS = ["friendly", "strict", "fun", "calm", "storyteller", "coach"];
const LANGUAGES = ["auto", "en", "hi", "kn", "mr"];
const VOICES = ["Kore", "Puck", "Charon", "Aoede", "Fenrir", "Leda", "Orus", "Zephyr"];

// The Google check. Tests replace it with a stub, so no real key is sent during tests.
let googleCheck = realGoogleCheck;
export function setGoogleCheck(fn) {
  googleCheck = fn ?? realGoogleCheck;
}

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const fail = (status, code, message) => new ApiError(status, code, message);
const isUniqueViolation = (e) => e?.code === "23505";

function cleanText(v, max) {
  return String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
function cleanApiKey(v) {
  const k = typeof v === "string" ? v.trim() : "";
  if (!/^[\x21-\x7e]{20,200}$/.test(k)) throw fail(400, "BAD_REQUEST", "Paste the full Gemini API key.");
  return k;
}
function requireId(v) {
  if (typeof v !== "string" || !UUID_RE.test(v)) throw fail(400, "BAD_REQUEST", "A valid key id is required.");
  return v;
}

const toPublicKey = (r) => ({
  id: r.id,
  label: r.label ?? "",
  masked: maskKey(r.key_last4),
  position: r.position,
  status: r.status,
  lastError: r.last_error ?? null,
  lastErrorAt: r.last_error_at ?? null,
  lastUsedAt: r.last_used_at ?? null,
});

async function requirePlus(userId) {
  if (!(await hasPlusPlan(userId))) throw fail(402, "PLAN_REQUIRED", "Buy the Plus plan (Rs 500) to add your keys.");
}

async function settingsFor(userId) {
  const [keys, prefs, plus] = await Promise.all([
    query(
      `SELECT id, label, key_last4, position, status, last_error, last_error_at, last_used_at
         FROM public.ai_teacher_user_keys WHERE user_id = $1 ORDER BY position ASC`,
      [userId]
    ),
    query(
      "SELECT teacher_name, preset, custom, voice, language, active_key_id FROM public.ai_teacher_user_prefs WHERE user_id = $1",
      [userId]
    ),
    hasPlusPlan(userId),
  ]);
  const p = prefs.rows[0] ?? {};
  return {
    plan: { active: plus, planName: plus ? "plus" : null },
    prefs: {
      teacherName: p.teacher_name || DEFAULT_TEACHER_NAME,
      preset: p.preset || "friendly",
      custom: p.custom ?? "",
      voice: p.voice ?? "Kore",
      language: p.language || "auto",
    },
    keys: keys.rows.map(toPublicKey),
    activeKeyId: p.active_key_id ?? null,
    maxKeys: MAX_KEYS,
  };
}

async function keyRows(userId) {
  const { rows } = await query(
    "SELECT id, key_hash, position, status, last_error_at FROM public.ai_teacher_user_keys WHERE user_id = $1 ORDER BY position ASC",
    [userId]
  );
  return rows;
}
async function ownKey(userId, id) {
  const { rows } = await query("SELECT * FROM public.ai_teacher_user_keys WHERE id = $1 AND user_id = $2", [id, userId]);
  if (!rows[0]) throw fail(404, "NOT_FOUND", "That key was not found.");
  return rows[0];
}
async function activeKeyIdOf(userId) {
  const { rows } = await query("SELECT active_key_id FROM public.ai_teacher_user_prefs WHERE user_id = $1", [userId]);
  return rows[0]?.active_key_id ?? null;
}
async function nextUsableKeyId(userId, excludeId) {
  const now = Date.now();
  const row = (await keyRows(userId)).find((r) => r.id !== excludeId && isUsableKey(r.status, r.last_error_at, now));
  return row?.id ?? null;
}

// Lists models with the key. The response body is never read or logged.
async function realGoogleCheck(apiKey) {
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
      { signal: AbortSignal.timeout(TEST_TIMEOUT_MS) }
    );
    if (r.ok) return { status: "active", error: null };
    await r.body?.cancel();
    if (r.status === 429) return { status: "rate_limited", error: "Google is rate-limiting this key right now. It will be retried later." };
    if (r.status === 400 || r.status === 401 || r.status === 403) {
      return { status: "invalid", error: `Google rejected this key (HTTP ${r.status}).` };
    }
    return { status: "untested", error: `Google did not confirm this key (HTTP ${r.status}).` };
  } catch {
    return { status: "untested", error: "Could not reach Google to check this key." };
  }
}

async function savePrefs(userId, body) {
  const p = body.prefs;
  if (!p || typeof p !== "object") throw fail(400, "BAD_REQUEST", "prefs is required.");
  if (!PRESETS.includes(p.preset)) throw fail(400, "BAD_REQUEST", "Unknown teaching style.");
  if (!LANGUAGES.includes(p.language)) throw fail(400, "BAD_REQUEST", "Unknown language.");
  if (p.voice !== undefined && p.voice !== null && !VOICES.includes(p.voice)) throw fail(400, "BAD_REQUEST", "Unknown voice.");
  const teacherName = cleanText(p.teacherName, 30).replace(/[^\p{L}\p{N} .'-]/gu, "").trim() || DEFAULT_TEACHER_NAME;
  await query(
    `INSERT INTO public.ai_teacher_user_prefs (user_id, teacher_name, preset, custom, voice, language, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (user_id) DO UPDATE SET teacher_name = EXCLUDED.teacher_name, preset = EXCLUDED.preset,
       custom = EXCLUDED.custom, voice = EXCLUDED.voice, language = EXCLUDED.language, updated_at = now()`,
    [userId, teacherName, p.preset, cleanText(p.custom, 300), p.voice ?? null, p.language]
  );
}

async function addKey(userId, body) {
  await requirePlus(userId);
  const apiKey = cleanApiKey(body.apiKey);
  const rows = await keyRows(userId);
  if (rows.length >= MAX_KEYS) throw fail(400, "KEY_LIMIT", `You can save up to ${MAX_KEYS} keys. Delete one to add another.`);
  const hash = sha256Hex(apiKey);
  if (rows.some((r) => r.key_hash === hash)) throw fail(409, "DUPLICATE_KEY", "This key is already saved.");

  const test = await googleCheck(apiKey);
  if (test.status === "invalid") throw fail(400, "INVALID_KEY", "Google rejected this key. Copy it again from Google AI Studio.");

  const { cipher, iv } = await encryptKey(apiKey);
  const position = rows.length ? Math.max(...rows.map((r) => r.position)) + 1 : 0;
  let inserted;
  try {
    ({ rows: [inserted] } = await query(
      `INSERT INTO public.ai_teacher_user_keys
         (user_id, label, key_ciphertext, key_iv, key_last4, key_hash, position, status, last_error, last_error_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), now())
       RETURNING id`,
      [
        userId,
        cleanText(body.label, 40) || `Key ${rows.length + 1}`,
        cipher,
        iv,
        apiKey.slice(-4),
        hash,
        position,
        test.status,
        test.error,
        test.status === "rate_limited" ? new Date() : null,
      ]
    ));
  } catch (e) {
    if (isUniqueViolation(e)) throw fail(409, "DUPLICATE_KEY", "This key is already saved.");
    throw e;
  }
  // The first key (or any key when none is active) becomes the active one.
  if (!(await activeKeyIdOf(userId))) await setActiveKey(userId, inserted.id);
}

async function updateKey(userId, body) {
  const id = requireId(body.id);
  await ownKey(userId, id);
  const sets = ["updated_at = now()"];
  const vals = [id, userId];
  const add = (sql, v) => {
    vals.push(v);
    sets.push(sql.replace("?", `$${vals.length}`));
  };

  if (body.label !== undefined) {
    const label = cleanText(body.label, 40);
    if (label) add("label = ?", label);
  }

  if (body.apiKey !== undefined && body.apiKey !== null && body.apiKey !== "") {
    await requirePlus(userId);
    const apiKey = cleanApiKey(body.apiKey);
    const hash = sha256Hex(apiKey);
    const { rows: dup } = await query(
      "SELECT id FROM public.ai_teacher_user_keys WHERE user_id = $1 AND key_hash = $2 AND id <> $3 LIMIT 1",
      [userId, hash, id]
    );
    if (dup.length) throw fail(409, "DUPLICATE_KEY", "This key is already saved.");

    const test = await googleCheck(apiKey);
    if (test.status === "invalid") throw fail(400, "INVALID_KEY", "Google rejected this key. Copy it again from Google AI Studio.");

    const { cipher, iv } = await encryptKey(apiKey);
    add("key_ciphertext = ?", cipher);
    add("key_iv = ?", iv);
    add("key_last4 = ?", apiKey.slice(-4));
    add("key_hash = ?", hash);
    add("status = ?", test.status);
    add("last_error = ?", test.error);
    add("last_error_at = ?", test.status === "rate_limited" ? new Date() : null);
  }

  try {
    await query(`UPDATE public.ai_teacher_user_keys SET ${sets.join(", ")} WHERE id = $1 AND user_id = $2`, vals);
  } catch (e) {
    if (isUniqueViolation(e)) throw fail(409, "DUPLICATE_KEY", "This key is already saved.");
    throw e;
  }
}

async function deleteKey(userId, body) {
  const id = requireId(body.id);
  await ownKey(userId, id);
  // Read the active key BEFORE deleting: the prefs foreign key clears active_key_id on delete.
  const wasActive = (await activeKeyIdOf(userId)) === id;
  await query("DELETE FROM public.ai_teacher_user_keys WHERE id = $1 AND user_id = $2", [id, userId]);
  if (wasActive) await setActiveKey(userId, await nextUsableKeyId(userId, id));
}

async function reorder(userId, body) {
  if (!Array.isArray(body.ids)) throw fail(400, "BAD_REQUEST", "ids must be a list.");
  const ids = body.ids.map((v) => requireId(v));
  const rows = await keyRows(userId);
  const have = new Set(rows.map((r) => r.id));
  if (ids.length !== rows.length || new Set(ids).size !== ids.length || ids.some((id) => !have.has(id))) {
    throw fail(400, "BAD_REQUEST", "ids must list every saved key exactly once.");
  }
  await applyPositions(userId, ids);
}

// Moves keys to the target positions (ids[i] -> i) without ever breaking the unique
// (user_id, position) constraint mid-way. A key moves once its target slot is free; a cycle is
// broken by parking one key in a free slot. With all 10 slots full and a cycle, the constraint is
// dropped and re-added inside one transaction.
async function applyPositions(userId, ids) {
  const { rows } = await query("SELECT id, position FROM public.ai_teacher_user_keys WHERE user_id = $1", [userId]);
  const current = new Map(rows.map((r) => [r.id, r.position]));
  const target = new Map(ids.map((id, i) => [id, i]));
  const occupant = (slot) => [...current.entries()].find(([, pos]) => pos === slot)?.[0];
  const move = (id, pos) => query("UPDATE public.ai_teacher_user_keys SET position = $1 WHERE id = $2 AND user_id = $3", [pos, id, userId]).then(() => current.set(id, pos));

  let guard = 0;
  while ([...target].some(([id, t]) => current.get(id) !== t) && guard++ < 100) {
    const ready = ids.find((id) => current.get(id) !== target.get(id) && (occupant(target.get(id)) === undefined || occupant(target.get(id)) === id || current.get(occupant(target.get(id))) === target.get(occupant(target.get(id)))));
    if (ready) {
      await move(ready, target.get(ready));
      continue;
    }
    // Cycle: park one misplaced key in a free slot if there is one.
    const stuck = ids.find((id) => current.get(id) !== target.get(id));
    const used = new Set(current.values());
    const free = [...Array(10).keys()].find((p) => !used.has(p));
    if (free !== undefined) {
      await move(stuck, free);
      continue;
    }
    // All slots full in a cycle: drop and re-add the constraint in one transaction.
    await withConstraintDropped(async (tx) => {
      for (const id of ids) await tx("UPDATE public.ai_teacher_user_keys SET position = $1 WHERE id = $2 AND user_id = $3", [target.get(id), id, userId]);
    });
    return;
  }
}

async function withConstraintDropped(fn) {
  const client = await (await import("../_shared/db.js")).pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE public.ai_teacher_user_keys DROP CONSTRAINT IF EXISTS ai_teacher_user_keys_user_id_position_key");
    await fn((text, params) => client.query(text, params));
    await client.query("ALTER TABLE public.ai_teacher_user_keys ADD CONSTRAINT ai_teacher_user_keys_user_id_position_key UNIQUE (user_id, \"position\")");
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function setActive(userId, body) {
  await requirePlus(userId);
  const id = requireId(body.id);
  await ownKey(userId, id);
  await setActiveKey(userId, id);
}

async function testKey(userId, body) {
  await requirePlus(userId);
  const id = requireId(body.id);
  const row = await ownKey(userId, id);
  const apiKey = await decryptKey(row.key_ciphertext, row.key_iv);
  const test = await googleCheck(apiKey);
  await markKey(id, test.status, test.error);
}

async function reportFailure(userId, body) {
  const id = requireId(body.id);
  await ownKey(userId, id);
  const message = cleanText(body.error, 300);
  const m = message.match(/\b(400|401|403|429)\b/);
  const kind = classifyGeminiError(m ? Number(m[1]) : 0, message);
  if (!kind) return; // not a key problem (model, network, server): nothing to change
  await markKey(id, kind, message || `Google reported a ${kind} error.`);
  if ((await activeKeyIdOf(userId)) === id) await setActiveKey(userId, await nextUsableKeyId(userId, id));
}

export const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    let userId;
    try {
      if (!token) throw new Error("no token");
      userId = jwt.verify(token, process.env.JWT_SECRET).sub;
    } catch {
      throw fail(401, "UNAUTHORIZED", "Sign in to manage your AI Teacher keys.");
    }
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw fail(400, "BAD_REQUEST", "Request body must be an object.");
    }
    switch (String(body.action ?? "")) {
      case "get": break;
      case "savePrefs": await savePrefs(userId, body); break;
      case "addKey": await addKey(userId, body); break;
      case "updateKey": await updateKey(userId, body); break;
      case "deleteKey": await deleteKey(userId, body); break;
      case "reorder": await reorder(userId, body); break;
      case "setActive": await setActive(userId, body); break;
      case "testKey": await testKey(userId, body); break;
      case "reportFailure": await reportFailure(userId, body); break;
      default: throw fail(400, "BAD_REQUEST", "Unknown action.");
    }
    return res.json(await settingsFor(userId));
  } catch (e) {
    if (e instanceof ApiError) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[ai-teacher-keys] unhandled", String(e?.message ?? e).slice(0, 200));
    return res.status(500).json({ error: "Something went wrong. Please try again.", code: "INTERNAL" });
  }
});
