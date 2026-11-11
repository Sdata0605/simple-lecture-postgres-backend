import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser } from "./helpers.js";
import { mountRouter, request, bearer, stubFetch } from "./group02-harness.js";
import { router } from "../functions/extract-answer-from-image/index.js";
import { hooks as aiHooks } from "../functions/_shared/extract-dpp-helper.js";

// Sends image downloads to one stub and the vision call to another, so no real service is used.
function imageAndAiStub(aiStatus, aiPayload) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith("http://img.test/")) {
      return new Response(Buffer.from([1, 2, 3]), { status: 200, headers: { "Content-Type": "image/png; charset=binary" } });
    }
    return new Response(JSON.stringify(aiPayload), { status: aiStatus, headers: { "Content-Type": "application/json" } });
  };
  fn.calls = calls;
  return fn;
}

const FAKE_ENDPOINT = { apiUrl: "http://ai.test/v1/chat/completions", apiKey: "stub-key", model: "stub-model", provider: "openai" };

describe("extract-answer-from-image", () => {
  let app;
  let user;
  before(async () => {
    await startServer();
    app = await mountRouter("/functions/v1/extract-answer-from-image", router);
    user = await makeUser();
  });
  after(async () => {
    aiHooks.fetch = null;
    aiHooks.endpoint = undefined;
    await app.close();
    await stopServer();
  });

  it("requires a signed-in user", async () => {
    const r = await request(app.base, { body: { image_url: "data:image/png;base64,AAAA" } });
    assert.equal(r.status, 401);
  });

  it("requires image_url", async () => {
    const r = await request(app.base, { body: {}, headers: bearer(user.access) });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "image_url is required");
  });

  it("returns 503 when no AI provider is configured", async () => {
    aiHooks.endpoint = null;
    const r = await request(app.base, { body: { image_url: "data:image/png;base64,AAAA" }, headers: bearer(user.access) });
    assert.equal(r.status, 503);
  });

  it("rejects remote image URLs that are not http(s)", async () => {
    aiHooks.endpoint = FAKE_ENDPOINT;
    aiHooks.fetch = imageAndAiStub(200, {});
    const r = await request(app.base, { body: { image_url: "file:///etc/passwd" }, headers: bearer(user.access) });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "Invalid image_url");
  });

  it("downloads a remote image, sends it to the model and rates a short answer as high confidence", async () => {
    aiHooks.endpoint = FAKE_ENDPOINT;
    aiHooks.fetch = imageAndAiStub(200, { choices: [{ message: { content: "  x^2 + 1  " } }] });
    const r = await request(app.base, {
      body: { image_url: "http://img.test/answer.png", question_context: "Find f(x)" },
      headers: bearer(user.access),
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.extracted_text, "x^2 + 1");
    assert.equal(r.body.confidence, "high");
    const ai = aiHooks.fetch.calls.find((c) => c.url === FAKE_ENDPOINT.apiUrl);
    const sent = JSON.parse(ai.init.body);
    assert.equal(sent.model, "stub-model");
    assert.match(sent.messages[1].content[1].image_url.url, /^data:image\/png;base64,/);
    assert.equal(ai.init.headers.Authorization, "Bearer stub-key");
  });

  it("reports UNREADABLE as low confidence", async () => {
    aiHooks.endpoint = FAKE_ENDPOINT;
    aiHooks.fetch = imageAndAiStub(200, { choices: [{ message: { content: "UNREADABLE" } }] });
    const r = await request(app.base, { body: { image_url: "data:image/png;base64,AAAA" }, headers: bearer(user.access) });
    assert.equal(r.status, 200);
    assert.equal(r.body.confidence, "low");
  });

  it("maps an invalid model key to 403 and a rate limit to 429", async () => {
    aiHooks.endpoint = FAKE_ENDPOINT;
    aiHooks.fetch = imageAndAiStub(403, { error: "nope" });
    const forbidden = await request(app.base, { body: { image_url: "data:image/png;base64,AAAA" }, headers: bearer(user.access) });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error, "Invalid or unauthorized API key.");

    aiHooks.fetch = imageAndAiStub(429, { error: "slow down" });
    const limited = await request(app.base, { body: { image_url: "data:image/png;base64,AAAA" }, headers: bearer(user.access) });
    assert.equal(limited.status, 429);
  });
});
