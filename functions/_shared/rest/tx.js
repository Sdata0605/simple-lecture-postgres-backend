// Runs one /rest/v1 request in its own transaction under the caller's Postgres role, so RLS applies.
// BEGIN, resolve the caller and switch role, run the work, COMMIT. On error ROLLBACK. RESET ROLE before release.
import { pool } from "../db.js";
import { resolveCaller, applyCaller } from "./access.js";

export async function withRestDb(req, ctx, fn) {
  const client = await pool.connect();
  const query = (text, params = []) => client.query(text, params);
  let releaseError;
  try {
    await query("BEGIN");
    const caller = await resolveCaller(req, query);
    ctx.caller = caller;
    await applyCaller(query, caller);
    const result = await fn({ query, caller });
    await query("COMMIT");
    return result;
  } catch (err) {
    await query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await query("RESET ROLE").catch((e) => {
      releaseError = e;
    });
    client.release(releaseError);
  }
}
