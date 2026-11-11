// Port of supabase/functions/create-test-admin. Bootstrap tool, service-role only: creates (or resets
// the password of) an admin account. POST / with header x-service-key = INTERNAL_SERVICE_KEY and
// body { email, password, full_name }.
import express from "express";
import {
  serviceKeyOk,
  findAuthUserIdByEmail,
  createConfirmedUser,
  setPasswordAndConfirm,
  upsertProfile,
  ensureRole,
} from "../_shared/cdn-presentation-refresh-start-helper.js";

export const router = express.Router();

const sendJson = (res, status, body) => res.status(status).type("application/json").send(JSON.stringify(body));

router.post("/", async (req, res) => {
  if (!serviceKeyOk(req)) return sendJson(res, 401, { error: "Unauthorized" });

  const { email, password } = req.body || {};
  const fullName = req.body?.full_name || "Test Admin";
  if (!email || !password) return sendJson(res, 400, { error: "email and password required" });

  try {
    let userId = await findAuthUserIdByEmail(email);
    if (userId) {
      await setPasswordAndConfirm(userId, password);
    } else {
      userId = await createConfirmedUser({ email, password, fullName });
    }
    await upsertProfile(userId, fullName, email);
    await ensureRole(userId, "admin");
    return sendJson(res, 200, { success: true, user_id: userId, email });
  } catch (err) {
    return sendJson(res, 500, { error: err?.message || String(err) });
  }
});
