import "./helpers.js"; // loads .env and guards the test database
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import { q } from "./helpers.js";
import { pool } from "../functions/_shared/db.js";
import { router } from "../functions/split-document-to-docx/index.js";
import { buildDocx, zip } from "../functions/_shared/split-document-to-docx-helper.js";

const SERVICE = "test-docx-service-key-not-real";
const tag = `dx5${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const UPLOAD_ROOT = path.resolve(process.env.UPLOAD_DIR || path.join(process.cwd(), "storage-data"));
let server;
let base;
let categoryId;
let subjectId;
let chapterId;
let parentId;
const created = [];

const post = async (body, auth) => {
  const r = await fetch(`${base}/functions/v1/split-document-to-docx`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

describe("split-document-to-docx", () => {
  before(async () => {
    process.env.SERVICE_ROLE_KEY = SERVICE;
    const app = express();
    app.use(express.json());
    app.use("/functions/v1/split-document-to-docx", router);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;

    [{ id: categoryId }] = await q("INSERT INTO public.categories (name, slug, level) VALUES ($1, $2, 1) RETURNING id", [tag, tag]);
    [{ id: subjectId }] = await q("INSERT INTO public.popular_subjects (name, slug, category_id) VALUES ($1, $2, $3) RETURNING id", [`DX ${tag}`, tag, categoryId]);
    [{ id: chapterId }] = await q(
      "INSERT INTO public.subject_chapters (subject_id, title, chapter_number, sequence_order) VALUES ($1, $2, 1, 1) RETURNING id",
      [subjectId, `Chap ${tag}`]
    );
    [{ id: parentId }] = await q(
      `INSERT INTO public.ai_assistant_documents (subject_id, chapter_id, source_type, display_name, file_name, full_content)
       VALUES ($1, $2, 'docx', $3, $4, '{}'::jsonb) RETURNING id`,
      [subjectId, chapterId, `Parent ${tag}`, `${tag}-parent.docx`]
    );
  });

  after(async () => {
    const childIds = created.map((c) => c.id);
    if (childIds.length) await q("DELETE FROM public.ai_assistant_documents WHERE id = ANY($1)", [childIds]);
    await q("DELETE FROM public.ai_assistant_documents WHERE id = $1", [parentId]);
    await q("DELETE FROM public.subject_topics WHERE chapter_id = $1", [chapterId]);
    await q("DELETE FROM public.subject_chapters WHERE id = $1", [chapterId]);
    await q("DELETE FROM public.popular_subjects WHERE id = $1", [subjectId]);
    await q("DELETE FROM public.categories WHERE id = $1", [categoryId]);
    await fs.rm(path.join(UPLOAD_ROOT, "uploaded-question-documents", "reels", chapterId), { recursive: true, force: true });
    await new Promise((r) => server.close(r));
    await pool.end();
  });

  it("validates documentId and sections", async () => {
    const r = await post({ documentId: parentId, sections: [] }, SERVICE);
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error: "documentId and sections required" });
  });

  it("refuses callers without the service key or an admin token", async () => {
    const r = await post({ documentId: parentId, sections: [{ title: "x", content_markdown: "y" }] });
    assert.equal(r.status, 401);
  });

  it("returns 404 for an unknown parent", async () => {
    const r = await post({ documentId: "00000000-0000-4000-8000-0000000000ad", sections: [{ title: "x" }] }, SERVICE);
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { error: "Parent document not found" });
  });

  it("creates a topic and a child document for each included section", async () => {
    const r = await post(
      {
        documentId: parentId,
        sections: [
          { title: "1.1 Motion", content_markdown: "## Motion\nAn object moves.\n- speed\n- velocity" },
          { title: "1.2 Skipped", content_markdown: "not used", include: false },
        ],
      },
      SERVICE
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.created.length, 1);
    created.push(...r.body.created);
    assert.equal(r.body.created[0].title, "1.1 Motion");
    assert.match(r.body.created[0].source_url, /\/storage\/v1\/object\/sign\/uploaded-question-documents\//);

    const [child] = await q("SELECT split_status, parent_document_id, topic_id, source_type FROM public.ai_assistant_documents WHERE id = $1", [r.body.created[0].id]);
    assert.equal(child.split_status, "child");
    assert.equal(child.parent_document_id, parentId);
    assert.equal(child.source_type, "docx");
    assert.notEqual(child.topic_id, null);

    const [parent] = await q("SELECT split_status FROM public.ai_assistant_documents WHERE id = $1", [parentId]);
    assert.equal(parent.split_status, "parent_split");

    // The stored file is a real zip whose first entry is the content-types part.
    const files = await fs.readdir(path.join(UPLOAD_ROOT, "uploaded-question-documents", "reels", chapterId));
    assert.equal(files.length, 1);
    const bytes = await fs.readFile(path.join(UPLOAD_ROOT, "uploaded-question-documents", "reels", chapterId, files[0]));
    assert.equal(bytes.subarray(0, 4).toString("hex"), "504b0304");
    assert.ok(bytes.includes(Buffer.from("[Content_Types].xml")));
  });
});

describe("split-document-to-docx helper", () => {
  it("builds a zip-based docx with the document part", async () => {
    const docx = await buildDocx("Title & more", "# Heading\nText with **bold**\n- bullet", async () => null);
    assert.equal(docx.subarray(0, 4).toString("hex"), "504b0304");
    assert.ok(docx.length > 200);
  });

  it("packs entries into a zip with a central directory", () => {
    const z = zip([{ name: "a.txt", data: Buffer.from("hello") }]);
    assert.equal(z.subarray(z.length - 22, z.length - 18).toString("hex"), "504b0506");
  });
});
