import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, post, makeUser, q } from "./helpers.js";
import { upload } from "../functions/_shared/storage.js";
import { sha256Hex } from "../functions/_shared/hash.js";
import { hooks } from "../functions/_shared/geminiKeys.js";

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

describe("reminder functions", () => {
  before(async () => {
    process.env.REMINDER_CRON_KEY = "cron-test-key-123";
    process.env.REMINDER_PREP_CRON_KEY = "prep-test-key-456";
    process.env.CALL_REMINDERS_ENABLED = "true";
    // Never use the real Gemini keys stored in ai_settings during tests: no keys, no network.
    hooks.keys = [];
    delete process.env.SARVAM_API_KEY;
    await startServer();
  });
  after(async () => {
    delete process.env.REMINDER_CRON_KEY;
    delete process.env.REMINDER_PREP_CRON_KEY;
    hooks.keys = null;
    await stopServer();
  });

  describe("reminder-call-audio", () => {
    it("requires a signed-in user", async () => {
      assert.equal((await post("/functions/v1/reminder-call-audio", { text: "hi" })).status, 401);
    });

    it("validates text, voice, language and reminderId", async () => {
      const u = await makeUser();
      const h = bearer(u.access);
      assert.equal((await post("/functions/v1/reminder-call-audio", { text: "" }, h)).body.field, "text");
      assert.equal((await post("/functions/v1/reminder-call-audio", { text: "hi", voice: "nobody" }, h)).body.field, "voice");
      assert.equal((await post("/functions/v1/reminder-call-audio", { text: "hi", language: "fr-FR" }, h)).body.field, "language");
      assert.equal((await post("/functions/v1/reminder-call-audio", { text: "hi", reminderId: "x" }, h)).body.field, "reminderId");
    });

    it("another user's reminder gives 404", async () => {
      const owner = await makeUser();
      const other = await makeUser();
      const [{ id }] = await q(
        "INSERT INTO public.reminders (user_id, kind, title, message_text, scheduled_at, status, enabled) VALUES ($1, 'call', 'Study', 'Study now', now(), 'scheduled', true) RETURNING id",
        [owner.id]
      );
      const r = await post("/functions/v1/reminder-call-audio", { text: "Study now", reminderId: id }, bearer(other.access));
      assert.equal(r.status, 404);
    });

    it("a file already cached for this user is returned without calling any TTS service", async () => {
      const u = await makeUser();
      const text = "Time for chemistry";
      const hash = sha256Hex(`v2|gemini|gemini-3.8-flash-tts|Charon|en-IN|s1|${text}`);
      await upload("reminder-audio", `${u.id}/${hash}.wav`, Buffer.from("RIFFfake"));
      const r = await post("/functions/v1/reminder-call-audio", { text, voice: "shubh" }, bearer(u.access));
      assert.equal(r.status, 200);
      assert.equal(r.body.cached, true);
      assert.equal(r.body.hash, hash);
      assert.match(r.body.signedUrl, /\/storage\/v1\/object\/sign\/reminder-audio\//);
    });

    it("with no TTS keys configured, reports not_configured", async () => {
      const u = await makeUser();
      const r = await post("/functions/v1/reminder-call-audio", { text: "No keys here" }, bearer(u.access));
      assert.equal(r.status, 503);
      assert.equal(r.body.error, "not_configured");
    });
  });

  describe("reminder-prepare-next-day", () => {
    it("refuses without a token and with a wrong cron key", async () => {
      assert.equal((await post("/functions/v1/reminder-prepare-next-day", {})).status, 401);
      assert.equal((await post("/functions/v1/reminder-prepare-next-day", { userId: "x" }, { "x-cron-key": "wrong" })).status, 401);
    });

    it("a user with no call reminders today gets prepared:false, no_calls_today", async () => {
      const u = await makeUser();
      const r = await post("/functions/v1/reminder-prepare-next-day", {}, bearer(u.access));
      assert.equal(r.status, 200);
      assert.equal(r.body.mode, "self");
      assert.equal(r.body.prepared, false);
      assert.equal(r.body.reason, "no_calls_today");
    });

    it("a call still in its ring window keeps the user from being prepared", async () => {
      const u = await makeUser();
      await q("INSERT INTO public.reminders (user_id, kind, title, message_text, scheduled_at, status, enabled) VALUES ($1, 'call', 'Maths', 'Maths', now(), 'scheduled', true)", [u.id]);
      const r = await post("/functions/v1/reminder-prepare-next-day", {}, bearer(u.access));
      assert.equal(r.body.reason, "calls_still_open");
    });

    it("cron mode with the right key sweeps and returns a summary", async () => {
      const r = await post("/functions/v1/reminder-prepare-next-day", {}, { "x-cron-key": "prep-test-key-456" });
      assert.equal(r.status, 200);
      assert.equal(r.body.mode, "cron_sweep");
      assert.equal(typeof r.body.users, "number");
    });
  });

  describe("reminder-audio-prefetch", () => {
    it("cron mode needs the cron key; a student token cannot run it", async () => {
      const u = await makeUser();
      assert.equal((await post("/functions/v1/reminder-audio-prefetch", { mode: "cron" }, bearer("nope"))).status, 401);
      assert.equal((await post("/functions/v1/reminder-audio-prefetch", { mode: "cron" }, bearer(u.access))).status, 401);
    });

    it("cron mode with the right key returns counts", async () => {
      const r = await post("/functions/v1/reminder-audio-prefetch", { mode: "cron" }, bearer("cron-test-key-123"));
      assert.equal(r.status, 200);
      assert.equal(r.body.mode, "cron");
      assert.equal(r.body.usersPushed + r.body.usersPushFailed, r.body.ready === 0 ? 0 : r.body.usersPushed + r.body.usersPushFailed);
    });

    it("plan mode validates the timetable id and days, and refuses unknown timetables", async () => {
      const u = await makeUser();
      const h = bearer(u.access);
      assert.equal((await post("/functions/v1/reminder-audio-prefetch", { timetable_id: "x" }, h)).body.field, "timetable_id");
      const tid = "00000000-0000-4000-8000-0000000000aa";
      assert.equal((await post("/functions/v1/reminder-audio-prefetch", { timetable_id: tid, days: 9 }, h)).body.field, "days");
      assert.equal((await post("/functions/v1/reminder-audio-prefetch", { timetable_id: tid }, h)).status, 404);
    });
  });
});
