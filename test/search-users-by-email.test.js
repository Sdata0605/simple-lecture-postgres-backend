import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { startServer, stopServer, makeUser } from "./helpers.js";
import { router } from "../functions/search-users-by-email/index.js";

let fnServer;
let fnBase;

async function search(body, headers = {}) {
  const res = await fetch(`${fnBase}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe("search-users-by-email", () => {
  before(async () => {
    await startServer();
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use("/", router);
    fnServer = app.listen(0, "127.0.0.1");
    await once(fnServer, "listening");
    fnBase = `http://127.0.0.1:${fnServer.address().port}`;
  });

  after(async () => {
    await new Promise((r) => fnServer.close(r));
    await stopServer();
  });

  it("401 without an Authorization header", async () => {
    const r = await search({ query: "ab" });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "Unauthorized");
  });

  it("401 for a forged token", async () => {
    const r = await search({ query: "ab" }, { Authorization: "Bearer not.a.token" });
    assert.equal(r.status, 401);
  });

  it("returns no users for a query shorter than two characters", async () => {
    const u = await makeUser();
    const r = await search({ query: "a" }, { Authorization: `Bearer ${u.access}` });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { users: [] });
  });

  it("finds an account by its full email, with name from the profile", async () => {
    const caller = await makeUser();
    const target = await makeUser({ name: "Searchable Person" });
    const r = await search({ query: target.email }, { Authorization: `Bearer ${caller.access}` });
    assert.equal(r.status, 200);
    const hit = r.body.users.find((x) => x.id === target.id);
    assert.ok(hit, "target account is in the results");
    assert.equal(hit.email, target.email);
    assert.equal(hit.full_name, "Searchable Person");
    assert.equal(hit.avatar_url, null);
  });

  it("matches case-insensitively", async () => {
    const caller = await makeUser();
    const target = await makeUser();
    const r = await search({ query: target.email.toUpperCase() }, { Authorization: `Bearer ${caller.access}` });
    assert.ok(r.body.users.some((x) => x.id === target.id));
  });

  it("treats % and _ in the query literally, not as wildcards", async () => {
    const caller = await makeUser();
    const r = await search({ query: "%%" }, { Authorization: `Bearer ${caller.access}` });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.users, []);
  });

  it("returns at most ten users", async () => {
    const caller = await makeUser();
    const r = await search({ query: "example.test" }, { Authorization: `Bearer ${caller.access}` });
    assert.ok(r.body.users.length <= 10);
  });
});
