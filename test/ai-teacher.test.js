import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { makeUser, q, startServer, stopServer } from "./helpers.js";
import { router } from "../functions/ai-teacher/index.js";
import { mountRouter } from "./_group00-harness.js";

// Covers auth, plan, validation and the switched-off path. No Gemini call is made: the config is
// switched off for the tests, and any token or model call would need a configured key.
let app;
let savedConfig;
let hadConfig;
const ask = (body, token) => app.post("/", body, token ? { Authorization: `Bearer ${token}` } : {});

async function setConfig(value) {
  const updated = await q("UPDATE public.ai_settings SET setting_value = $1 WHERE setting_key = 'ai_teacher_1to1_config' RETURNING id", [value]);
  if (updated.length === 0) await q("INSERT INTO public.ai_settings (setting_key, setting_value) VALUES ('ai_teacher_1to1_config', $1)", [value]);
}

describe("ai-teacher", () => {
  before(async () => {
    await startServer(); // makeUser() signs up through the app
    app = await mountRouter("/", router);
    const rows = await q("SELECT setting_value FROM public.ai_settings WHERE setting_key = 'ai_teacher_1to1_config'");
    hadConfig = rows.length > 0;
    savedConfig = hadConfig ? rows[0].setting_value : null;
    await setConfig({ enabled: false });
  });
  after(async () => {
    if (hadConfig) {
      await q("UPDATE public.ai_settings SET setting_value = $1 WHERE setting_key = 'ai_teacher_1to1_config'", [savedConfig]);
    } else {
      await q("DELETE FROM public.ai_settings WHERE setting_key = 'ai_teacher_1to1_config'");
    }
    await q("DELETE FROM public.sales_leads WHERE name = $1", ["AI Teacher Test"]);
    await app.close();
    await stopServer();
  });

  it("rejects an unknown action", async () => {
    const r = await ask({ action: "nope" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "Unknown action");
  });

  it("outline needs a valid subjectId", async () => {
    const r = await ask({ action: "outline", subjectId: "x" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "Valid subjectId required");
  });

  it("rejects a malformed topicId", async () => {
    const r = await ask({ action: "search", subjectId: crypto.randomUUID(), query: "x", topicId: "bad" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "Invalid topicId");
  });

  it("subjects works without sign-in and returns an empty list for anonymous callers", async () => {
    const r = await ask({ action: "subjects" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { subjects: [] });
  });

  it("session and chat need sign-in", async () => {
    assert.equal((await ask({ action: "session", subjectId: crypto.randomUUID() })).body.code, "UNAUTHORIZED");
    const chat = await ask({ action: "chat", subjectId: crypto.randomUUID(), question: "What is a cell?" });
    assert.equal(chat.status, 401);
    assert.equal(chat.body.code, "UNAUTHORIZED");
  });

  it("session and chat need the Plus plan", async () => {
    const u = await makeUser();
    const r = await ask({ action: "session", subjectId: crypto.randomUUID() }, u.access);
    assert.equal(r.status, 402);
    assert.equal(r.body.code, "PLAN_REQUIRED");
  });

  it("with the Plus plan but the feature switched off, session is a 503", async () => {
    const u = await makeUser();
    await q("INSERT INTO public.sales_leads (name, email, lead_status) VALUES ('AI Teacher Test', $1, 'converted_plan_500')", [u.email]);
    const r = await ask({ action: "session", subjectId: crypto.randomUUID() }, u.access);
    assert.equal(r.status, 503);
    assert.match(r.body.error, /switched off/);
  });

  it("with the Plus plan but no Gemini key, chat is a 409 NO_KEYS", async () => {
    const u = await makeUser();
    await q("INSERT INTO public.sales_leads (name, email, lead_status) VALUES ('AI Teacher Test', $1, 'converted_plan_500')", [u.email]);
    await setConfig({ enabled: true, google_api_key: "" });
    const r = await ask({ action: "chat", subjectId: crypto.randomUUID(), question: "What is a cell?" }, u.access);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "NO_KEYS");
    await setConfig({ enabled: false });
  });

  it("test is for admins only", async () => {
    assert.equal((await ask({ action: "test" })).status, 401);
    const u = await makeUser();
    const r = await ask({ action: "test", apiKey: "x" }, u.access);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "Admins only");
  });

  it("search needs a query or topicId", async () => {
    const r = await ask({ action: "search", subjectId: crypto.randomUUID() });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "query or topicId required");
  });

  it("search by an unknown topic returns not found, with no notes", async () => {
    const r = await ask({ action: "search", subjectId: crypto.randomUUID(), topicId: crypto.randomUUID() });
    assert.equal(r.status, 200);
    assert.equal(r.body.found, false);
    assert.deepEqual(r.body.references, []);
  });
});
