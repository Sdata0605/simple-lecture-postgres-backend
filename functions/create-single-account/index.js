// Port of supabase/functions/create-single-account. Bootstrap tool, service-role only: it creates
// (or resets the password of) one student account and enrols it in one course for 365 days.
//
// The original hard-coded a person's email, password and course id. Those are now request fields.
// POST /  with header x-service-key = INTERNAL_SERVICE_KEY and body { email, password, full_name, courseId }.
import express from "express";
import {
  serviceKeyOk,
  findAuthUserIdByEmail,
  createConfirmedUser,
  setPasswordAndConfirm,
  upsertProfile,
  ensureRole,
  grantCourseFor365Days,
} from "../_shared/cdn-presentation-refresh-start-helper.js";

export const router = express.Router();

const sendJson = (res, status, body) => res.status(status).type("application/json").send(JSON.stringify(body));

router.post("/", async (req, res) => {
  if (!serviceKeyOk(req)) return sendJson(res, 401, { error: "Unauthorized" });

  const { email, password, courseId } = req.body || {};
  const fullName = req.body?.full_name || "";
  if (!email || !password || !courseId) {
    return sendJson(res, 400, { error: "email, password and courseId are required" });
  }

  try {
    let userId = await findAuthUserIdByEmail(email);
    let createdNow = false;
    if (userId) {
      await setPasswordAndConfirm(userId, password);
    } else {
      userId = await createConfirmedUser({ email, password, fullName });
      createdNow = true;
    }

    await upsertProfile(userId, fullName, email);
    await ensureRole(userId, "student");
    await grantCourseFor365Days(userId, courseId);

    return sendJson(res, 200, {
      success: true,
      user_id: userId,
      email,
      status: createdNow ? "created" : "updated",
    });
  } catch (err) {
    console.error("[create-single-account]", err.message);
    return sendJson(res, 500, { error: err?.message || String(err) });
  }
});
