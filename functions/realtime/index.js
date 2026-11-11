// Port of the Supabase Realtime websocket (protocol 2.0.0, used by @supabase/realtime-js 2.x).
// Serves /realtime/v1/websocket on the same HTTP server as the REST API.
//
// Supported: phx_join / phx_leave, heartbeat, access_token refresh, Postgres changes (INSERT / UPDATE / DELETE with
// Supabase filters), and presence (track / untrack). Broadcast messages are acknowledged but not delivered (the UI
// does not use them).
//
// Postgres changes come from the sl_realtime_notify trigger (migrations/realtime-notify.sql) on LISTEN sl_realtime.
// Before anything is sent for an INSERT or UPDATE, the row is read again as the subscriber (anon, or the signed-in
// user from the join's access_token), so Postgres RLS decides who sees it. DELETE events carry only the id, as in
// Supabase, so no row contents leak to subscribers who could not have read them.
import crypto from "node:crypto";
import pg from "pg";
import { WebSocketServer } from "ws";
import { pool } from "../_shared/db.js";
import { resolveCaller, applyCaller } from "../_shared/rest/access.js";
import { log } from "../_shared/log.js";
import { REALTIME_TABLES, parseFilter, matchesFilter } from "./filter.js";

const PATH = "/realtime/v1/websocket";
const OPEN = 1;
const EVENT_TYPES = new Set(["INSERT", "UPDATE", "DELETE", "*"]);

const sockets = new Set(); // { ws, apikey, channels: Map<topic, channel> }
const presence = new Map(); // topic -> Map<key, { metas: [...] }>
let bindingSeq = 0;
let listener = null;
let listenerStarting = null;
let listenerRetry = null;

// Builds the caller the way /rest/v1 does: apikey alone is anon, a bearer JWT is the signed-in user.
async function resolveFor(apikey, token) {
  const req = {
    get(name) {
      const h = name.toLowerCase();
      if (h === "apikey") return apikey || "";
      if (h === "authorization") return token ? `Bearer ${token}` : "";
      return "";
    },
  };
  const client = await pool.connect();
  try {
    return await resolveCaller(req, (text, params = []) => client.query(text, params));
  } finally {
    client.release();
  }
}

// Runs fn inside a transaction as the given caller, so RLS applies. The role and claims end with the transaction.
async function withCaller(caller, fn) {
  const client = await pool.connect();
  const q = (text, params = []) => client.query(text, params);
  try {
    await q("BEGIN");
    await applyCaller(q, caller);
    const result = await fn(q);
    await q("COMMIT");
    return result;
  } catch (err) {
    await q("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// The row as this caller can read it, or null when RLS hides it (or it no longer exists).
async function visibleRow(caller, table, id) {
  if (!REALTIME_TABLES.has(table)) return null;
  return withCaller(caller, async (q) => {
    const { rows } = await q(`SELECT row_to_json(t) AS r FROM public."${table}" t WHERE t.id = $1`, [id]);
    return rows[0]?.r ?? null;
  });
}

function send(ws, joinRef, ref, topic, event, payload) {
  if (ws.readyState !== OPEN) return;
  ws.send(JSON.stringify([joinRef ?? null, ref ?? null, topic, event, payload]));
}

function reply(s, joinRef, ref, topic, status, response = {}) {
  send(s.ws, joinRef, ref, topic, "phx_reply", { status, response });
}

// Listener on the notify channel. Started on the first join, restarted if its connection drops.
async function ensureListener() {
  if (listener) return;
  if (!listenerStarting) {
    listenerStarting = (async () => {
      const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
      client.on("notification", (msg) => {
        handleNotification(msg.payload).catch((err) => log.error("realtime.dispatch_failed", { error: err }));
      });
      const drop = (err) => {
        if (listener !== client) return;
        log.error("realtime.listener_lost", { error: err });
        listener = null;
        client.end().catch(() => {});
        listenerRetry = setTimeout(() => {
          listenerRetry = null;
          ensureListener().catch(() => {});
        }, 2000);
        listenerRetry.unref();
      };
      client.on("error", drop);
      client.on("end", () => drop(null));
      await client.connect();
      await client.query("LISTEN sl_realtime");
      listener = client;
      log.info("realtime.listening", { channel: "sl_realtime" });
    })().finally(() => {
      listenerStarting = null;
    });
  }
  return listenerStarting;
}

// Sends one notification to every channel whose bindings match it and whose subscriber can see the row.
async function handleNotification(payload) {
  let ev;
  try {
    ev = JSON.parse(payload);
  } catch {
    return;
  }
  if (ev.schema !== "public" || !REALTIME_TABLES.has(ev.table)) return;

  for (const s of sockets) {
    for (const [topic, channel] of s.channels) {
      const candidates = channel.bindings.filter(
        (b) => b.table === ev.table && b.schema === ev.schema && (b.event === "*" || b.event === ev.type)
      );
      if (candidates.length === 0) continue;

      let row;
      if (ev.type === "DELETE") {
        // Filters can only be checked on the row when the trigger sent it, and it is never sent to the client.
        if (!ev.row) continue;
        row = ev.row;
      } else {
        try {
          row = await visibleRow(channel.caller, ev.table, ev.id);
        } catch (err) {
          log.error("realtime.visibility_check_failed", { table: ev.table, error: err });
          continue;
        }
        if (!row) continue;
      }

      const ids = candidates.filter((b) => matchesFilter(row, b.parsedFilter)).map((b) => b.id);
      if (ids.length === 0) continue;

      const isDelete = ev.type === "DELETE";
      send(s.ws, channel.joinRef, null, topic, "postgres_changes", {
        ids,
        data: {
          schema: ev.schema,
          table: ev.table,
          commit_timestamp: new Date().toISOString(),
          eventType: ev.type,
          type: ev.type,
          columns: [],
          errors: null,
          record: isDelete ? {} : row,
          old_record: isDelete ? { id: row.id } : {},
        },
      });
    }
  }
}

function presenceState(topic) {
  return Object.fromEntries(presence.get(topic) || []);
}

function broadcastPresenceDiff(topic, diff) {
  for (const s of sockets) {
    const ch = s.channels.get(topic);
    if (ch) send(s.ws, ch.joinRef, null, topic, "presence_diff", diff);
  }
}

function removePresence(topic, channel) {
  if (!channel.presenceKey) return;
  const map = presence.get(topic);
  const prev = map?.get(channel.presenceKey);
  if (!prev) return;
  map.delete(channel.presenceKey);
  if (map.size === 0) presence.delete(topic);
  broadcastPresenceDiff(topic, { joins: {}, leaves: { [channel.presenceKey]: prev } });
}

function leaveChannel(s, topic) {
  const channel = s.channels.get(topic);
  if (!channel) return;
  s.channels.delete(topic);
  removePresence(topic, channel);
}

function parseBindings(list) {
  return list.map((p) => {
    const schema = p.schema || "public";
    const table = p.table;
    if (schema !== "public" || !REALTIME_TABLES.has(table)) {
      throw new Error(`realtime is not enabled for ${schema}.${table}`);
    }
    const event = p.event === "*" ? "*" : String(p.event || "").toUpperCase();
    if (!EVENT_TYPES.has(event)) throw new Error(`unsupported event: ${p.event}`);
    return {
      id: ++bindingSeq,
      event,
      schema,
      table,
      filter: p.filter,
      parsedFilter: parseFilter(p.filter),
    };
  });
}

async function join(s, joinRef, ref, topic, payload) {
  const cfg = payload.config || {};
  let caller;
  try {
    caller = await resolveFor(s.apikey, payload.access_token || null);
  } catch (err) {
    return reply(s, joinRef, ref, topic, "error", { reason: "unauthorized" });
  }

  let bindings;
  try {
    bindings = parseBindings(Array.isArray(cfg.postgres_changes) ? cfg.postgres_changes : []);
  } catch (err) {
    return reply(s, joinRef, ref, topic, "error", { reason: err.message });
  }

  try {
    await ensureListener();
  } catch (err) {
    log.error("realtime.listen_failed", { error: err });
    return reply(s, joinRef, ref, topic, "error", { reason: "realtime unavailable" });
  }

  // Rejoining a topic replaces the old channel.
  leaveChannel(s, topic);

  const channel = { joinRef, caller, bindings, presenceKey: null };
  s.channels.set(topic, channel);

  const response = {
    postgres_changes: bindings.map((b) => ({ id: b.id, event: b.event, schema: b.schema, table: b.table, filter: b.filter })),
  };
  reply(s, joinRef, ref, topic, "ok", response);

  if (cfg.presence?.enabled) {
    channel.presenceKey = cfg.presence.key || crypto.randomUUID();
    send(s.ws, joinRef, null, topic, "presence_state", presenceState(topic));
  }
  log.info("realtime.joined", { topic, bindings: bindings.length, signed_in: caller.role === "authenticated" });
}

function presenceEvent(s, topic, ref, payload) {
  const channel = s.channels.get(topic);
  if (!channel || !channel.presenceKey) return reply(s, null, ref, topic, "error", { reason: "presence not enabled" });
  const key = channel.presenceKey;
  let map = presence.get(topic);
  if (!map) {
    map = new Map();
    presence.set(topic, map);
  }
  if (payload?.event === "track") {
    const meta = { phx_ref: crypto.randomUUID(), ...(payload.payload || {}) };
    const entry = { metas: [meta] };
    map.set(key, entry);
    broadcastPresenceDiff(topic, { joins: { [key]: entry }, leaves: {} });
  } else if (payload?.event === "untrack") {
    const prev = map.get(key);
    if (prev) {
      map.delete(key);
      broadcastPresenceDiff(topic, { joins: {}, leaves: { [key]: prev } });
    }
  }
  if (map.size === 0) presence.delete(topic);
  reply(s, channel.joinRef, ref, topic, "ok", {});
}

async function handleMessage(s, raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (!Array.isArray(msg) || msg.length !== 5) return;
  const [joinRef, ref, topic, event, payload] = msg;

  if (topic === "phoenix" && event === "heartbeat") {
    return send(s.ws, null, ref, "phoenix", "phx_reply", { status: "ok", response: {} });
  }
  switch (event) {
    case "phx_join":
      return join(s, joinRef, ref, topic, payload || {});
    case "phx_leave":
      leaveChannel(s, topic);
      return reply(s, joinRef, ref, topic, "ok", {});
    case "presence":
      return presenceEvent(s, topic, ref, payload);
    case "access_token": {
      const channel = s.channels.get(topic);
      if (channel && payload?.access_token) {
        try {
          channel.caller = await resolveFor(s.apikey, payload.access_token);
        } catch {
          // Keep the previous caller; the client will see the join error on its next join.
        }
      }
      return reply(s, joinRef, ref, topic, "ok", {});
    }
    case "broadcast":
      return reply(s, joinRef, ref, topic, "ok", {});
    default:
      return reply(s, joinRef, ref, topic, "error", { reason: `unknown event: ${event}` });
  }
}

function onConnection(ws, apikey) {
  const s = { ws, apikey, channels: new Map() };
  sockets.add(s);
  ws.on("message", (raw) => {
    handleMessage(s, raw).catch((err) => log.error("realtime.message_failed", { error: err }));
  });
  ws.on("close", () => {
    for (const topic of [...s.channels.keys()]) leaveChannel(s, topic);
    sockets.delete(s);
  });
  ws.on("error", (err) => log.error("realtime.socket_error", { error: err }));
}

// Attaches the websocket endpoint to an HTTP server. Call once per server.
export function attachRealtime(server) {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== PATH) return socket.destroy();
    const apikey = url.searchParams.get("apikey") || "";
    if (!apikey) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, apikey));
  });
  return wss;
}

// Closes every socket and the notify listener. Used by the test suite so the process can exit.
export async function stopRealtime() {
  for (const s of sockets) s.ws.terminate();
  sockets.clear();
  presence.clear();
  if (listenerRetry) clearTimeout(listenerRetry);
  listenerRetry = null;
  const current = listener;
  listener = null;
  if (current) await current.end().catch(() => {});
}
