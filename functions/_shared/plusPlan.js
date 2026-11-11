// Plus plan check for the AI Teacher (Rs 500 Plus, or Rs 1000 Pro, which also counts as Plus).
// Entitlement comes from public.sales_leads: a row whose email matches the user's auth email
// (case-insensitive) with lead_status 'converted_plan_500' or 'converted_plan_1000'.
// Ported from supabase/functions/_shared/plusPlan.ts. Never log the email.
import { query } from "./db.js";

const PLUS_STATUSES = ["converted_plan_500", "converted_plan_1000"];

// True when the user has bought the Plus plan (Rs 500) or Pro (Rs 1000). False on any error.
export async function hasPlusPlan(userId) {
  try {
    const { rows: users } = await query("SELECT email FROM auth.users WHERE id = $1", [userId]);
    const email = String(users[0]?.email ?? "").trim();
    if (!email) return false;
    const { rows } = await query(
      `SELECT id FROM public.sales_leads
        WHERE lower(email) = lower($1) AND lead_status = ANY($2::text[]) LIMIT 1`,
      [email, PLUS_STATUSES]
    );
    return rows.length > 0;
  } catch {
    console.warn("[plusPlan] plan check failed");
    return false;
  }
}
