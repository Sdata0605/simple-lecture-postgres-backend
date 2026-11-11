import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, post, makeUser, q } from "./helpers.js";
import { setGoogleCheck } from "../functions/ai-teacher-keys/index.js";

const fakeKey = () => "AIzaTest" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2, 12);
const act = (u, body) => post("/functions/v1/ai-teacher-keys", body, { Authorization: `Bearer ${u.access}` });

// Gives a user the Plus plan by adding a converted sales lead with their email.
async function givePlus(u) {
  await q("INSERT INTO public.sales_leads (name, email, lead_status) VALUES ('Test Lead', $1, 'converted_plan_500')", [u.email]);
}

describe("ai-teacher-keys", () => {
  before(async () => {
    await startServer();
    // Stub the Google check so no real key is ever sent during tests.
    setGoogleCheck(async (key) =>
      key.startsWith("AIzaBad") ? { status: "invalid", error: "Google rejected this key" } : { status: "active", error: null }
    );
  });
  after(async () => {
    setGoogleCheck(null);
    await stopServer();
  });

  it("requires a signed-in user", async () => {
    assert.equal((await post("/functions/v1/ai-teacher-keys", { action: "get" })).status, 401);
  });

  it("get works without the Plus plan and reports plan inactive", async () => {
    const u = await makeUser();
    const r = await act(u, { action: "get" });
    assert.equal(r.status, 200);
    assert.equal(r.body.plan.active, false);
    assert.deepEqual(r.body.keys, []);
    assert.equal(r.body.maxKeys, 10);
  });

  it("adding a key without the Plus plan returns 402 PLAN_REQUIRED", async () => {
    const u = await makeUser();
    const r = await act(u, { action: "addKey", label: "x", apiKey: fakeKey() });
    assert.equal(r.status, 402);
    assert.equal(r.body.code, "PLAN_REQUIRED");
  });

  it("with Plus: adds a key, makes it active, and never returns the full key", async () => {
    const u = await makeUser();
    await givePlus(u);
    const key = fakeKey();
    const r = await act(u, { action: "addKey", label: "My key", apiKey: key });
    assert.equal(r.status, 200);
    assert.equal(r.body.plan.active, true);
    assert.equal(r.body.keys.length, 1);
    assert.equal(r.body.keys[0].masked, "AIza…" + key.slice(-4));
    assert.equal(r.body.activeKeyId, r.body.keys[0].id);
    assert.ok(!JSON.stringify(r.body).includes(key), "full key must never be returned");
  });

  it("a key Google rejects is refused with INVALID_KEY; a duplicate is refused with DUPLICATE_KEY", async () => {
    const u = await makeUser();
    await givePlus(u);
    const bad = await act(u, { action: "addKey", apiKey: "AIzaBad" + "x".repeat(20) });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, "INVALID_KEY");
    const key = fakeKey();
    await act(u, { action: "addKey", apiKey: key });
    const dup = await act(u, { action: "addKey", apiKey: key });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.code, "DUPLICATE_KEY");
  });

  it("a short or malformed key is refused with BAD_REQUEST", async () => {
    const u = await makeUser();
    await givePlus(u);
    assert.equal((await act(u, { action: "addKey", apiKey: "short" })).body.code, "BAD_REQUEST");
    assert.equal((await act(u, { action: "addKey", apiKey: "has space in it and is long enough" })).body.code, "BAD_REQUEST");
  });

  it("no more than 10 keys", async () => {
    const u = await makeUser();
    await givePlus(u);
    for (let i = 0; i < 10; i++) assert.equal((await act(u, { action: "addKey", apiKey: fakeKey() })).status, 200);
    const r = await act(u, { action: "addKey", apiKey: fakeKey() });
    assert.equal(r.body.code, "KEY_LIMIT");
  });

  it("deleting the active key moves the active key to another usable key", async () => {
    const u = await makeUser();
    await givePlus(u);
    const a = await act(u, { action: "addKey", apiKey: fakeKey() });
    const b = await act(u, { action: "addKey", apiKey: fakeKey() });
    const first = a.body.keys[0].id;
    const second = b.body.keys[1].id;
    const r = await act(u, { action: "deleteKey", id: first });
    assert.equal(r.status, 200);
    assert.equal(r.body.activeKeyId, second);
    assert.equal(r.body.keys.length, 1);
  });

  it("another user's key id gives 404", async () => {
    const owner = await makeUser();
    await givePlus(owner);
    const k = await act(owner, { action: "addKey", apiKey: fakeKey() });
    const other = await makeUser();
    const r = await act(other, { action: "deleteKey", id: k.body.keys[0].id });
    assert.equal(r.status, 404);
    assert.equal(r.body.code, "NOT_FOUND");
  });

  it("savePrefs validates and saves", async () => {
    const u = await makeUser();
    assert.equal((await act(u, { action: "savePrefs", prefs: { preset: "evil", language: "en" } })).body.code, "BAD_REQUEST");
    const ok = await act(u, { action: "savePrefs", prefs: { teacherName: "Asha <b>", preset: "strict", language: "hi", voice: "Puck", custom: "be brief" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.prefs.preset, "strict");
    assert.equal(ok.body.prefs.teacherName, "Asha b");
  });

  it("reorder must list every key exactly once", async () => {
    const u = await makeUser();
    await givePlus(u);
    const a = await act(u, { action: "addKey", apiKey: fakeKey() });
    const b = await act(u, { action: "addKey", apiKey: fakeKey() });
    const [k1, k2] = [a.body.keys[0].id, b.body.keys[1].id];
    assert.equal((await act(u, { action: "reorder", ids: [k1] })).body.code, "BAD_REQUEST");
    const ok = await act(u, { action: "reorder", ids: [k2, k1] });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.keys.map((k) => k.id), [k2, k1]);
  });

  it("reportFailure with a 429 marks the key rate-limited and fails over to another key", async () => {
    const u = await makeUser();
    await givePlus(u);
    const a = await act(u, { action: "addKey", apiKey: fakeKey() });
    const b = await act(u, { action: "addKey", apiKey: fakeKey() });
    const active = a.body.activeKeyId;
    const other = b.body.keys.find((k) => k.id !== active).id;
    const r = await act(u, { action: "reportFailure", id: active, error: "HTTP 429 RESOURCE_EXHAUSTED" });
    assert.equal(r.status, 200);
    assert.equal(r.body.keys.find((k) => k.id === active).status, "rate_limited");
    assert.equal(r.body.activeKeyId, other);
  });

  it("reportFailure for a non-key error changes nothing", async () => {
    const u = await makeUser();
    await givePlus(u);
    const a = await act(u, { action: "addKey", apiKey: fakeKey() });
    const r = await act(u, { action: "reportFailure", id: a.body.keys[0].id, error: "model overloaded 503" });
    assert.equal(r.body.keys[0].status, "active");
  });

  it("testKey re-checks a saved key and stores the result", async () => {
    const u = await makeUser();
    await givePlus(u);
    const a = await act(u, { action: "addKey", apiKey: fakeKey() });
    const id = a.body.keys[0].id;
    await q("UPDATE public.ai_teacher_user_keys SET key_ciphertext = 'AIzaBad' || repeat('x', 20) WHERE id = $1", [id]);
    const r = await act(u, { action: "testKey", id });
    assert.equal(r.body.keys[0].status, "invalid");
  });

  it("unknown action is refused", async () => {
    const u = await makeUser();
    assert.equal((await act(u, { action: "nuke" })).body.code, "BAD_REQUEST");
  });
  it("reorder works with all 10 slots full and a cycle (reverse order)", async () => {
    const u = await makeUser();
    await givePlus(u);
    let r;
    for (let i = 0; i < 10; i++) r = await act(u, { action: "addKey", apiKey: fakeKey() });
    const ids = r.body.keys.map((k) => k.id);
    const reversed = [...ids].reverse();
    const ok = await act(u, { action: "reorder", ids: reversed });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.keys.map((k) => k.id), reversed);
    const dbOrder = await q("SELECT id FROM public.ai_teacher_user_keys WHERE user_id = $1 ORDER BY position", [u.id]);
    assert.deepEqual(dbOrder.map((x) => x.id), reversed);
  });
});
