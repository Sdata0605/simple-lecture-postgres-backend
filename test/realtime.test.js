import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import WebSocket from "ws";
import { startServer, stopServer, makeUser, q, base } from "./helpers.js";

const APIKEY = "anon-placeholder";
let wsBase;

function connect(apikey = APIKEY) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}/realtime/v1/websocket?apikey=${apikey}&vsn=2.0.0`);
    const inbox = [];
    const waiters = [];
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      inbox.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pred(msg)) {
          waiters[i].resolve(msg);
          waiters.splice(i, 1);
        }
      }
    });
    ws.inbox = inbox;
    ws.next = (pred, ms = 3000) =>
      new Promise((res, rej) => {
        const hit = inbox.find(pred);
        if (hit) return res(hit);
        const t = setTimeout(() => rej(new Error("timed out waiting for realtime message")), ms);
        waiters.push({ pred, resolve: (m) => { clearTimeout(t); res(m); } });
      });
    ws.expectNone = async (pred, ms = 800) => {
      await new Promise((r) => setTimeout(r, ms));
      return !inbox.some(pred);
    };
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

let refSeq = 0;
function push(ws, topic, event, payload, joinRef = null) {
  const ref = String(++refSeq);
  ws.send(JSON.stringify([joinRef, ref, topic, event, payload]));
  return ref;
}

async function join(ws, topic, config, accessToken) {
  const ref = push(ws, topic, "phx_join", { config, ...(accessToken ? { access_token: accessToken } : {}) }, "1");
  const reply = await ws.next((m) => m[1] === ref && m[2] === topic && m[3] === "phx_reply");
  return reply[4];
}

function noteConfig(studentId) {
  return {
    broadcast: {},
    presence: { enabled: false },
    private: false,
    postgres_changes: [
      { event: "INSERT", schema: "public", table: "student_lecture_notes", filter: `student_id=eq.${studentId}` },
    ],
  };
}

async function insertNote(studentId) {
  const jobId = "rt-" + crypto.randomBytes(6).toString("hex");
  const [row] = await q("INSERT INTO public.student_lecture_notes (student_id, job_id) VALUES ($1, $2) RETURNING id", [studentId, jobId]);
  return row.id;
}

describe("realtime websocket", () => {
  before(async () => {
    await startServer();
    wsBase = base.replace("http://", "ws://");
  });
  after(stopServer);

  it("refuses a connection without an apikey", async () => {
    await assert.rejects(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`${wsBase}/realtime/v1/websocket?vsn=2.0.0`);
        ws.once("open", () => { ws.close(); resolve("opened"); });
        ws.once("error", reject);
        ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      }),
      /HTTP 401/
    );
  });

  it("answers heartbeats", async () => {
    const ws = await connect();
    const ref = push(ws, "phoenix", "heartbeat", {});
    const reply = await ws.next((m) => m[1] === ref && m[2] === "phoenix" && m[3] === "phx_reply");
    assert.equal(reply[4].status, "ok");
    ws.close();
  });

  it("acknowledges a join and reports the postgres_changes binding ids", async () => {
    const user = await makeUser();
    const ws = await connect();
    const res = await join(ws, "realtime:join-ack", noteConfig(user.id), user.access);
    assert.equal(res.status, "ok");
    assert.equal(res.response.postgres_changes.length, 1);
    assert.equal(res.response.postgres_changes[0].table, "student_lecture_notes");
    ws.close();
  });

  it("delivers an INSERT to the signed-in owner, with the row", async () => {
    const user = await makeUser();
    const ws = await connect();
    await join(ws, "realtime:owner-insert", noteConfig(user.id), user.access);
    const id = await insertNote(user.id);
    const msg = await ws.next((m) => m[3] === "postgres_changes");
    assert.equal(msg[4].data.type, "INSERT");
    assert.equal(msg[4].data.table, "student_lecture_notes");
    assert.equal(msg[4].data.record.id, id);
    assert.equal(msg[4].data.record.student_id, user.id);
    assert.equal(msg[4].ids.length, 1);
    ws.close();
  });

  it("does not deliver another student's row (RLS applies to subscribers)", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const ws = await connect();
    await join(ws, "realtime:rls-other", noteConfig(owner.id), other.access);
    await insertNote(owner.id);
    assert.equal(await ws.expectNone((m) => m[3] === "postgres_changes"), true);
    ws.close();
  });

  it("does not deliver to an anonymous subscriber when RLS hides the row", async () => {
    const owner = await makeUser();
    const ws = await connect();
    await join(ws, "realtime:anon", noteConfig(owner.id), null);
    await insertNote(owner.id);
    assert.equal(await ws.expectNone((m) => m[3] === "postgres_changes"), true);
    ws.close();
  });

  it("rejects a join on a table that is not enabled for realtime", async () => {
    const ws = await connect();
    const res = await join(ws, "realtime:bad-table", {
      postgres_changes: [{ event: "*", schema: "public", table: "profiles" }],
    }, null);
    assert.equal(res.status, "error");
    assert.match(res.response.reason, /not enabled/);
    ws.close();
  });

  it("filters by column: only rows matching the filter are sent", async () => {
    const a = await makeUser();
    const ws = await connect();
    const config = {
      postgres_changes: [{ event: "INSERT", schema: "public", table: "student_lecture_notes", filter: `student_id=eq.${a.id}` }],
    };
    await join(ws, "realtime:filter", config, a.access);
    const before = ws.inbox.length;
    const b = await makeUser();
    await insertNote(b.id); // not a's row: should not arrive
    await insertNote(a.id); // a's row: should arrive
    await new Promise((r) => setTimeout(r, 800));
    const changes = ws.inbox.slice(before).filter((m) => m[3] === "postgres_changes");
    assert.equal(changes.length, 1);
    assert.equal(changes[0][4].data.record.student_id, a.id);
    ws.close();
  });

  it("presence: a tracked user is announced to the other subscriber", async () => {
    const a = await makeUser();
    const topic = "realtime:presence-" + crypto.randomBytes(4).toString("hex");
    const presenceConfig = { presence: { enabled: true, key: "key-a" }, postgres_changes: [] };
    const wsA = await connect();
    const wsB = await connect();
    await join(wsA, topic, presenceConfig, null);
    await join(wsB, topic, { presence: { enabled: true, key: "key-b" }, postgres_changes: [] }, null);
    push(wsA, topic, "presence", { event: "track", payload: { user_name: "Asha" } }, "1");
    const diff = await wsB.next((m) => m[3] === "presence_diff" && m[4].joins && m[4].joins["key-a"]);
    assert.equal(diff[4].joins["key-a"].metas[0].user_name, "Asha");
    wsA.close();
    wsB.close();
    void a;
  });

  it("rejects an unknown event on a channel with a clear error", async () => {
    const ws = await connect();
    const ref = push(ws, "realtime:x", "not_a_real_event", {});
    const reply = await ws.next((m) => m[1] === ref && m[3] === "phx_reply");
    assert.equal(reply[4].status, "error");
    ws.close();
  });
});
