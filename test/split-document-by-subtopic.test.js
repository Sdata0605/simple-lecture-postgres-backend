import "./helpers.js"; // loads .env and guards the test database
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { q, uniqueEmail } from "./helpers.js";
import { pool } from "../functions/_shared/db.js";
import { createAuthUser } from "../functions/_shared/accounts.js";
import { issueSession } from "../functions/_shared/session.js";
import { router, regexSplit } from "../functions/split-document-by-subtopic/index.js";

const SERVICE = "test-split-service-key-not-real";
const tag = `sp5${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
let server;
let base;
let subjectId;
let categoryId;
let docWithContent;
let docEmpty;
let student;

const post = async (body, token) => {
  const r = await fetch(`${base}/functions/v1/split-document-by-subtopic`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

describe("split-document-by-subtopic", () => {
  before(async () => {
    process.env.SERVICE_ROLE_KEY = SERVICE;
    delete process.env.LOVABLE_API_KEY; // the AI fallback is never reached without a key
    const app = express();
    app.use(express.json());
    app.use("/functions/v1/split-document-by-subtopic", router);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;

    student = await createAuthUser({ email: uniqueEmail("sp"), password: "Pass!word1", fullName: "Split Test" });
    [{ id: categoryId }] = await q("INSERT INTO public.categories (name, slug, level) VALUES ($1, $2, 1) RETURNING id", [tag, tag]);
    [{ id: subjectId }] = await q("INSERT INTO public.popular_subjects (name, slug, category_id) VALUES ($1, $2, $3) RETURNING id", [`Sp ${tag}`, tag, categoryId]);
    [{ id: docWithContent }] = await q(
      `INSERT INTO public.ai_assistant_documents (subject_id, source_type, display_name, file_name, full_content)
       VALUES ($1, 'docx', $2, $3, $4::jsonb) RETURNING id`,
      [subjectId, `Doc ${tag}`, `${tag}.docx`, JSON.stringify({ markdown: "## 1.1 Intro\nHello\n1.2 Next\nMore text" })]
    );
    [{ id: docEmpty }] = await q(
      `INSERT INTO public.ai_assistant_documents (subject_id, source_type, display_name, file_name)
       VALUES ($1, 'docx', $2, $3) RETURNING id`,
      [subjectId, `Empty ${tag}`, `${tag}-empty.docx`]
    );
  });

  after(async () => {
    await q("DELETE FROM public.ai_assistant_documents WHERE id = ANY($1)", [[docWithContent, docEmpty]]);
    await q("DELETE FROM public.popular_subjects WHERE id = $1", [subjectId]);
    await q("DELETE FROM public.categories WHERE id = $1", [categoryId]);
    await q("DELETE FROM public.profiles WHERE id = $1", [student.id]);
    await q("DELETE FROM auth.users WHERE id = $1", [student.id]);
    await new Promise((r) => server.close(r));
    await pool.end();
  });

  it("splits numbered headings into sections", () => {
    const sections = regexSplit("intro line\n1.1 First\nbody a\n1.2 Second\nbody b");
    assert.deepEqual(sections.map((s) => s.title), ["1.1 First", "1.2 Second"]);
    assert.equal(sections[0].content_markdown, "1.1 First\nbody a");
  });

  it("requires documentId", async () => {
    const r = await post({}, SERVICE);
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error: "documentId required" });
  });

  it("refuses a non-admin", async () => {
    const session = await issueSession(student);
    const r = await post({ documentId: docWithContent }, session.access_token);
    assert.equal(r.status, 401);
  });

  it("returns 404 for an unknown document", async () => {
    const r = await post({ documentId: "00000000-0000-4000-8000-0000000000ee" }, SERVICE);
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { error: "Document not found" });
  });

  it("returns 422 when the document has no markdown", async () => {
    const r = await post({ documentId: docEmpty }, SERVICE);
    assert.equal(r.status, 422);
  });

  it("returns the sections of a document with headings", async () => {
    const r = await post({ documentId: docWithContent }, SERVICE);
    assert.equal(r.status, 200);
    assert.equal(r.body.source, "ok");
    assert.deepEqual(r.body.sections.map((s) => s.title), ["1.1 Intro", "1.2 Next"]);
  });
});
