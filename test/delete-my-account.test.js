import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, post, call, makeUser, q } from "./helpers.js";

describe("delete-my-account", () => {
  before(startServer);
  after(stopServer);

  it("rejects requests without a token", async () => {
    assert.equal((await post("/functions/v1/delete-my-account", {})).status, 401);
  });

  it("rejects a forged token", async () => {
    const r = await post("/functions/v1/delete-my-account", {}, { Authorization: "Bearer not.a.token" });
    assert.equal(r.status, 401);
  });

  it("deletes the signed-in user's account, rows and login", async () => {
    const u = await makeUser();
    const r = await post("/functions/v1/delete-my-account", {}, { Authorization: `Bearer ${u.access}` });
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.equal((await q("SELECT count(*)::int n FROM auth.users WHERE id = $1", [u.id]))[0].n, 0);
    assert.equal((await q("SELECT count(*)::int n FROM public.profiles WHERE id = $1", [u.id]))[0].n, 0);
    assert.equal((await q("SELECT count(*)::int n FROM public.user_roles WHERE user_id = $1", [u.id]))[0].n, 0);
    assert.equal((await call("GET", "/auth/v1/user", { headers: { Authorization: `Bearer ${u.access}` } })).status, 401);
    assert.equal((await post("/auth/v1/token?grant_type=refresh_token", { refresh_token: u.refresh })).status, 400);
  });

  it("a second delete with the same token is refused", async () => {
    const u = await makeUser();
    await post("/functions/v1/delete-my-account", {}, { Authorization: `Bearer ${u.access}` });
    const again = await post("/functions/v1/delete-my-account", {}, { Authorization: `Bearer ${u.access}` });
    assert.equal(again.status, 401);
  });

  it("cannot delete another user: the id in the body is ignored", async () => {
    const victim = await makeUser();
    const attacker = await makeUser();
    await post("/functions/v1/delete-my-account", { user_id: victim.id }, { Authorization: `Bearer ${attacker.access}` });
    assert.equal((await q("SELECT count(*)::int n FROM auth.users WHERE id = $1", [victim.id]))[0].n, 1);
    assert.equal((await q("SELECT count(*)::int n FROM auth.users WHERE id = $1", [attacker.id]))[0].n, 0);
  });
});
