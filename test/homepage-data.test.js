import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser } from "./helpers.js";
import { serveRouter, hitAt } from "./route-harness.js";
import { router } from "../functions/homepage-data/index.js";

describe("homepage-data", () => {
  let r;
  let user;
  before(async () => {
    await startServer();
    r = await serveRouter("/functions/v1/homepage-data", router);
    user = await makeUser();
  });
  after(async () => {
    await r.close();
    await stopServer();
  });

  it("answers the ping warm-up without touching the database", async () => {
    const res = await hitAt(r.base, "GET", "/functions/v1/homepage-data?ping=true");
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "ok");
    assert.equal(typeof res.body.timestamp, "number");
  });

  it("returns the homepage shape for an anonymous GET", async () => {
    const res = await hitAt(r.base, "GET", "/functions/v1/homepage-data");
    assert.equal(res.status, 200);
    for (const k of ["categories", "courses", "bestsellers", "topCourses", "mostPopular", "exploreGoals"]) {
      assert.ok(Array.isArray(res.body[k]), `${k} should be an array`);
    }
    assert.equal(typeof res.body.heroVideoSettings, "object");
    assert.equal(res.headers.get("cache-control"), "private, no-store");
  });

  it("accepts POST too, and the signed-in form", async () => {
    const res = await hitAt(r.base, "POST", "/functions/v1/homepage-data", {
      headers: { Authorization: `Bearer ${user.access}` },
      body: {},
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.categories));
  });

  it("rejects other methods with 405", async () => {
    const res = await hitAt(r.base, "PUT", "/functions/v1/homepage-data", { body: {} });
    assert.equal(res.status, 405);
  });
});
