// Port of supabase/functions/search-users-by-email.
// Finds accounts whose email contains the query (case-insensitive), with name and avatar from profiles.
// Any signed-in user may search, as in the original.
//
// Deliberate difference: the original only filtered the first 20 accounts returned by the auth admin
// list, so most users could never be found. This port searches all of auth.users, returning up to 10.
import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../_shared/db.js";

export const router = express.Router();

async function userIdFromToken(authHeader) {
  const token = String(authHeader || "").replace(/^Bearer\s+/i, "").trim();
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (!payload.sub) return null;
    const { rows } = await query("SELECT id FROM auth.users WHERE id = $1", [payload.sub]);
    return rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

router.all("/", async (req, res) => {
  if (req.method === "OPTIONS") return res.status(200).end();
  const json = (status, body) => res.status(status).json(body);

  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return json(401, { error: "Unauthorized" });
    const callerId = await userIdFromToken(authHeader);
    if (!callerId) return json(401, { error: "Unauthorized" });

    const search = req.body?.query;
    if (!search || String(search).length < 2) return json(200, { users: [] });
    console.log("Searching for users with query:", search);

    // strpos is a literal substring test, so % and _ in the query are not wildcards.
    const { rows } = await query(
      `SELECT u.id, u.email, p.full_name, p.avatar_url
         FROM auth.users u
         LEFT JOIN public.profiles p ON p.id = u.id
        WHERE u.email IS NOT NULL AND strpos(lower(u.email), lower($1)) > 0
        ORDER BY u.email
        LIMIT 10`,
      [String(search)]
    );

    console.log(`Found ${rows.length} users matching query`);
    return json(200, {
      users: rows.map((u) => ({
        id: u.id,
        email: u.email,
        full_name: u.full_name || null,
        avatar_url: u.avatar_url || null,
      })),
    });
  } catch (error) {
    console.error("Error in search-users-by-email:", error?.message);
    return json(500, { error: error instanceof Error ? error.message : "Unknown error" });
  }
});

export default router;
