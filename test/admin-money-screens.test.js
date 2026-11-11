// Contract tests for the admin ORDERS, PROMO CODES, ANALYTICS, REPORTS, VISITOR ANALYTICS, NOTIFICATIONS,
// SUPPORT and DASHBOARD screens. Each request mirrors the supabase-js call the website makes (see the hooks in
// src/hooks and the pages in src/pages/admin in the website folder). Rows created here are named QA-ADMIN-*.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, base, makeUser, q } from "./helpers.js";

const SSLC_COURSE_ID = "4c10bc8e-acbc-4b76-b7f5-54376c030cb0";

let admin;
let student;
const auth = (u) => ({ apikey: "anon-placeholder", Authorization: `Bearer ${u.access}` });

async function rest(method, path, { user = admin, body, prefer, single } = {}) {
  const headers = { ...auth(user) };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (prefer) headers.Prefer = prefer;
  if (single) headers.Accept = "application/vnd.pgrst.object+json";
  const r = await fetch(`${base}/rest/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, json, range: r.headers.get("content-range") };
}

const rpc = (fn, body, user = admin) => rest("POST", `/rpc/${fn}`, { user, body });

describe("admin money screens: REST contracts", () => {
  before(async () => {
    await startServer();
    admin = await makeUser({ name: "QA-ADMIN Admin" });
    student = await makeUser({ name: "QA-ADMIN Student" });
    await q("INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING", [admin.id]);
  });

  after(async () => {
    await q("DELETE FROM public.enrollments WHERE student_id = $1", [student.id]);
    await q("DELETE FROM public.user_roles WHERE user_id = $1 AND role = 'admin'", [admin.id]);
    await q("DELETE FROM public.discount_codes WHERE code LIKE 'QA-ADMIN%'");
    await q("DELETE FROM public.support_faqs WHERE question LIKE 'QA-ADMIN%'");
    await q("DELETE FROM public.support_articles WHERE slug LIKE 'qa-admin%'");
    await q("DELETE FROM public.auto_pipeline_reports WHERE subject_name = 'QA-ADMIN'");
    await stopServer();
  });

  describe("ORDERS (useAdminOrders)", () => {
    it("reads payments with order_items and courses embedded, newest first", async () => {
      const r = await rest("GET", "/payments?select=" + encodeURIComponent("id,order_id,user_id,amount_inr,discount_amount,final_amount,status,payment_gateway,gateway_order_id,gateway_payment_id,created_at,completed_at,metadata,order_items(id,course_id,price_inr,courses(id,name))") + "&order=created_at.desc");
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.ok(Array.isArray(r.json));
    });

    it("reads profiles for the order users with an in() filter", async () => {
      const r = await rest("GET", `/profiles?select=id,full_name,phone_number&id=in.(${student.id})`);
      assert.equal(r.status, 200);
      assert.equal(r.json.length, 1);
    });

    it("the SSLC bind writes: enrollment insert (array body) and a student-scoped payment update", async () => {
      const ins = await rest("POST", "/enrollments", { user: admin, body: [{ student_id: student.id, course_id: SSLC_COURSE_ID, is_active: true }] });
      assert.equal(ins.status, 201, JSON.stringify(ins.json));
      const dup = await rest("POST", "/enrollments", { user: admin, body: [{ student_id: student.id, course_id: SSLC_COURSE_ID, is_active: true }] });
      assert.equal(dup.status, 409, "a second bind for the same student is rejected as a duplicate");
      const upd = await rest("PATCH", `/payments?user_id=in.(${student.id})&status=eq.pending`, { user: admin, body: { status: "success", completed_at: new Date().toISOString() } });
      assert.equal(upd.status, 204, JSON.stringify(upd.json));
    });
  });

  describe("PROMO CODES (usePromoCodes, PromoCodeForm)", () => {
    it("creates, loads, edits and deletes a QA code", async () => {
      const code = { code: "QA-ADMIN-PROMO", description: null, discount_percent: 10, discount_amount: null, valid_from: null, valid_until: null, max_uses: null, is_active: true };
      const created = await rest("POST", "/discount_codes?select=*", { body: code, prefer: "return=representation", single: true });
      assert.equal(created.status, 201, JSON.stringify(created.json));
      const id = created.json.id;

      const loaded = await rest("GET", `/discount_codes?select=*&id=eq.${id}`, { single: true });
      assert.equal(loaded.status, 200);
      assert.equal(loaded.json.code, "QA-ADMIN-PROMO");

      const edited = await rest("PATCH", `/discount_codes?select=*&id=eq.${id}`, { body: { ...code, discount_percent: null, discount_amount: 50, max_uses: 5, is_active: false }, prefer: "return=representation", single: true });
      assert.equal(edited.status, 200, JSON.stringify(edited.json));
      assert.equal(edited.json.discount_amount, 50);

      const del = await rest("DELETE", `/discount_codes?id=eq.${id}`);
      assert.equal(del.status, 204);
      const gone = await rest("GET", `/discount_codes?select=id&id=eq.${id}`);
      assert.deepEqual(gone.json, []);
    });

    it("loading an unknown promo id with single() returns 406, as the edit page expects an error", async () => {
      const r = await rest("GET", "/discount_codes?select=*&id=eq.00000000-0000-4000-8000-000000000000", { single: true });
      assert.equal(r.status, 406);
    });
  });

  describe("ANALYTICS (get_admin_analytics RPC)", () => {
    it("admin gets the payload the page reads", async () => {
      for (const p_since of [null, new Date(Date.now() - 30 * 864e5).toISOString()]) {
        const r = await rpc("get_admin_analytics", { p_since });
        assert.equal(r.status, 200, JSON.stringify(r.json));
        for (const k of ["totalVisits", "uniqueVisitors", "signedInVisitors", "totalUsers", "sources", "pages", "recentSignups"]) {
          assert.ok(k in r.json, `missing ${k}`);
        }
        assert.ok(Array.isArray(r.json.sources) && Array.isArray(r.json.pages) && Array.isArray(r.json.recentSignups));
      }
    });

    it("a student is refused with the function's own forbidden error", async () => {
      const r = await rpc("get_admin_analytics", { p_since: null }, student);
      assert.notEqual(r.status, 200);
      assert.match(JSON.stringify(r.json), /forbidden/);
    });
  });

  describe("VISITOR ANALYTICS and DASHBOARD counts (page_visits)", () => {
    it("head-count, recent list, page and country projections, and 7-day window all respond", async () => {
      const c = await rest("GET", "/page_visits?select=*&limit=0", { user: admin, prefer: "count=exact" });
      assert.equal(c.status, 200);
      assert.match(c.range, /\/\d+$/);
      const recent = await rest("GET", "/page_visits?select=*&order=created_at.desc&limit=50");
      assert.equal(recent.status, 200);
      assert.ok(recent.json.length <= 50);
      const pages = await rest("GET", "/page_visits?select=page_path&order=created_at.desc&limit=1000");
      assert.equal(pages.status, 200);
      const countries = await rest("GET", "/page_visits?select=country&country=not.is.null&limit=1000");
      assert.equal(countries.status, 200);
      const week = await rest("GET", `/page_visits?select=created_at&created_at=gte.${encodeURIComponent(new Date(Date.now() - 7 * 864e5).toISOString())}&order=created_at.asc&limit=5000`);
      assert.equal(week.status, 200);
    });

    it("dashboard sums successful payments and counts today's visits from the start-of-day timestamp", async () => {
      const sums = await rest("GET", "/payments?select=final_amount&status=eq.success");
      assert.equal(sums.status, 200);
      const start = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).toISOString();
      const today = await rest("GET", `/page_visits?select=*&created_at=gte.${encodeURIComponent(start)}&limit=0`, { prefer: "count=exact" });
      assert.equal(today.status, 200);
    });
  });

  describe("REPORTS (useAutoPipelineReports)", () => {
    it("lists reports, counts bad ones, and deletes a QA report", async () => {
      const list = await rest("GET", "/auto_pipeline_reports?select=*&order=created_at.desc");
      assert.equal(list.status, 200);
      const bad = await rest("GET", "/auto_pipeline_reports?select=*&category=eq.bad&limit=0", { prefer: "count=exact" });
      assert.equal(bad.status, 200);
      const made = await rest("POST", "/auto_pipeline_reports?select=*", { body: { subject_name: "QA-ADMIN", category: "bad", status: "failed", retry_count: 0 }, prefer: "return=representation", single: true });
      assert.equal(made.status, 201, JSON.stringify(made.json));
      const del = await rest("DELETE", `/auto_pipeline_reports?id=eq.${made.json.id}`);
      assert.equal(del.status, 204);
    });
  });

  describe("NOTIFICATIONS (useVerificationNotifications)", () => {
    it("reads notifications with the document embed and marks all unread as read", async () => {
      const r = await rest("GET", "/verification_notifications?select=" + encodeURIComponent("*,uploaded_question_documents(id,questions_file_name,categories(name),popular_subjects(name))") + `&recipient_id=eq.${admin.id}&order=created_at.desc`);
      assert.equal(r.status, 200, JSON.stringify(r.json));
      const upd = await rest("PATCH", `/verification_notifications?recipient_id=eq.${admin.id}&is_read=eq.false`, { body: { is_read: true, read_at: new Date().toISOString() } });
      assert.equal(upd.status, 204);
    });
  });

  describe("SUPPORT (SupportDashboard, useAdminSupportArticles)", () => {
    it("reads tickets, the ticket's messages and FAQs ordered by category then display_order", async () => {
      const tickets = await rest("GET", "/support_tickets?select=*&order=created_at.desc");
      assert.equal(tickets.status, 200);
      const faqs = await rest("GET", "/support_faqs?select=*&order=category.asc&order=display_order.asc");
      assert.equal(faqs.status, 200, JSON.stringify(faqs.json));
      const profiles = await rest("GET", `/profiles?select=id,full_name,email,phone_number&id=in.(${student.id})`);
      assert.equal(profiles.status, 200);
    });

    it("FAQ create, update and delete", async () => {
      const ins = await rest("POST", "/support_faqs?select=id", { body: { category: "general", question: "QA-ADMIN q", answer: "QA a", display_order: 0 }, prefer: "return=representation", single: true });
      assert.equal(ins.status, 201, JSON.stringify(ins.json));
      const upd = await rest("PATCH", `/support_faqs?id=eq.${ins.json.id}`, { body: { category: "general", question: "QA-ADMIN q2", answer: "QA a2", display_order: 1 } });
      assert.equal(upd.status, 204);
      const del = await rest("DELETE", `/support_faqs?id=eq.${ins.json.id}`);
      assert.equal(del.status, 204);
    });

    it("ticket reply, status change and close", async () => {
      const t = await rest("POST", "/support_tickets?select=*", { body: { user_id: student.id, category: "other", subject: "QA-ADMIN ticket", status: "open" }, prefer: "return=representation", single: true });
      assert.equal(t.status, 201, JSON.stringify(t.json));
      const id = t.json.id;
      const msg = await rest("POST", "/support_messages", { body: { ticket_id: id, sender_type: "admin", content: "QA-ADMIN reply" } });
      assert.equal(msg.status, 201);
      const st = await rest("PATCH", `/support_tickets?id=eq.${id}`, { body: { status: "admin_responded" } });
      assert.equal(st.status, 204);
      const msgs = await rest("GET", `/support_messages?select=*&ticket_id=eq.${id}&order=created_at.asc`);
      assert.equal(msgs.json.length, 1);
      const close = await rest("PATCH", `/support_tickets?id=eq.${id}`, { body: { status: "closed_resolved", closed_at: new Date().toISOString() } });
      assert.equal(close.status, 204);
      await rest("DELETE", `/support_messages?ticket_id=eq.${id}`);
      await rest("DELETE", `/support_tickets?id=eq.${id}`);
    });

    it("article create, update and delete", async () => {
      const row = { slug: "qa-admin-article", title: "QA-ADMIN article", description: "d", content: "c", display_order: 0, is_active: true };
      const ins = await rest("POST", "/support_articles?select=*", { body: row, prefer: "return=representation", single: true });
      assert.equal(ins.status, 201, JSON.stringify(ins.json));
      const upd = await rest("PATCH", `/support_articles?id=eq.${ins.json.id}`, { body: { title: "QA-ADMIN article 2" } });
      assert.equal(upd.status, 204);
      const del = await rest("DELETE", `/support_articles?id=eq.${ins.json.id}`);
      assert.equal(del.status, 204);
    });
  });
});
