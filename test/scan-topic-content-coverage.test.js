import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { startServer, stopServer, q } from "./helpers.js";
import { router } from "../functions/scan-topic-content-coverage/index.js";

// The AI gateway is replaced by a local stub (LOVABLE_API_URL). No real host is contacted.
let stub;
let stubReply = null;
let fnServer;
let fnBase;
const savedEnv = {};
const docIds = [];
const jobIds = [];
let topicA; // topic for the keyword checks
let topicB; // topic with no documents, for the AI checks

const MD = "## Photosynthesis Basics\n## Cellular Respiration\n## Plate Tectonics\n";

async function scan(body) {
  const res = await fetch(`${fnBase}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function makeDoc(topic, markdown = MD) {
  const id = randomUUID();
  docIds.push(id);
  await q(
    `INSERT INTO public.ai_assistant_documents (id, subject_id, topic_id, chapter_id, source_type, file_name, full_content)
     VALUES ($1, $2, $3, $4, 'upload', 'notes.md', $5::jsonb)`,
    [id, topic.subject_id, topic.topic_id, topic.chapter_id, JSON.stringify({ content_markdown: markdown })]
  );
  return id;
}

async function makeJob(docId, subjectId, presentation) {
  const id = "sc" + Math.random().toString(36).slice(2, 8);
  jobIds.push(id);
  await q(
    `INSERT INTO public.video_generation_jobs (id, subject_id, document_id, status, is_published, presentation_json)
     VALUES ($1, $2, $3, 'completed', true, $4::jsonb)`,
    [id, subjectId, docId, JSON.stringify(presentation)]
  );
  return id;
}

// Removes only the documents (and jobs) this test created for one topic, so a scan of that topic sees one.
async function clearDocsFor(topicId) {
  const ids = (await q("SELECT id FROM public.ai_assistant_documents WHERE topic_id = $1 AND id = ANY($2::uuid[])", [topicId, docIds])).map((r) => r.id);
  if (ids.length) {
    await q("DELETE FROM public.video_generation_jobs WHERE document_id = ANY($1)", [ids]);
    await q("DELETE FROM public.ai_assistant_documents WHERE id = ANY($1)", [ids]);
  }
}

const presentation = {
  sections: [
    { section_id: "s1", title: "Photosynthesis Basics", narration: { segments: [{ text: "Photosynthesis basics: plants make sugar from light." }] } },
    { section_id: "s2", title: "Overview", narration: { full_text: "Cellular respiration releases energy from food." } },
  ],
};

describe("scan-topic-content-coverage", () => {
  before(async () => {
    await startServer();
    for (const k of ["LOVABLE_API_KEY", "LOVABLE_API_URL"]) savedEnv[k] = process.env[k];

    // Two topics that have no documents of their own, so nothing real is read or changed by these tests.
    const picks = await q(
      `SELECT ch.id AS chapter_id, t.id AS topic_id, s.id AS subject_id
         FROM public.subject_topics t
         JOIN public.subject_chapters ch ON ch.id = t.chapter_id
         JOIN public.popular_subjects s ON s.id = ch.subject_id
        WHERE NOT EXISTS (SELECT 1 FROM public.ai_assistant_documents d WHERE d.topic_id = t.id)
        ORDER BY t.id LIMIT 2`
    );
    topicA = picks[0];
    topicB = picks[1];

    stub = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        if (stubReply === null) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          return res.end("gateway down");
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: stubReply } }] }));
      });
    });
    stub.listen(0, "127.0.0.1");
    await once(stub, "listening");
    process.env.LOVABLE_API_URL = `http://127.0.0.1:${stub.address().port}/v1/chat/completions`;
    delete process.env.LOVABLE_API_KEY;

    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use("/", router);
    fnServer = app.listen(0, "127.0.0.1");
    await once(fnServer, "listening");
    fnBase = `http://127.0.0.1:${fnServer.address().port}`;
  });

  after(async () => {
    try {
      if (jobIds.length) await q("DELETE FROM public.video_generation_jobs WHERE id = ANY($1)", [jobIds]);
      if (docIds.length) await q("DELETE FROM public.ai_assistant_documents WHERE id = ANY($1)", [docIds]);
    } finally {
      for (const k of Object.keys(savedEnv)) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
      await new Promise((r) => fnServer.close(r));
      await new Promise((r) => stub.close(r));
      await stopServer();
    }
  });

  it("answers OPTIONS", async () => {
    const r = await fetch(`${fnBase}/`, { method: "OPTIONS" });
    assert.equal(r.status, 200);
  });

  it("returns an empty summary for a topic with no documents", async () => {
    const r = await scan({ topic_id: randomUUID() });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { topics: [], summary: { total: 0 } });
  });

  it("a document with no published lecture has every heading missing", async () => {
    await clearDocsFor(topicA.topic_id);
    await makeDoc(topicA);
    const r = await scan({ topic_id: topicA.topic_id });
    assert.equal(r.body.topics.length, 1);
    const row = r.body.topics[0];
    assert.equal(row.has_published_lecture, false);
    assert.equal(row.headings_total, 3);
    assert.deepEqual(row.headings_missing, ["Photosynthesis Basics", "Cellular Respiration", "Plate Tectonics"]);
    assert.equal(row.coverage_pct, 0);
    assert.equal(r.body.summary.unpublished, 1);
  });

  it("classifies headings as covered, mentioned only, or missing", async () => {
    await clearDocsFor(topicA.topic_id);
    const docId = await makeDoc(topicA);
    await makeJob(docId, topicA.subject_id, presentation);
    const r = await scan({ topic_id: topicA.topic_id });
    assert.equal(r.body.topics.length, 1);
    const row = r.body.topics[0];
    assert.equal(row.has_published_lecture, true);
    assert.equal(row.section_count, 2);

    const [photo, cell, plate] = row.headings_detail;
    assert.equal(photo.status, "fully_covered");
    assert.equal(photo.in_section_title, true);
    assert.equal(photo.in_narration, true);
    assert.equal(cell.status, "mentioned_only");
    assert.equal(cell.in_section_title, false);
    assert.equal(cell.in_narration, true);
    assert.equal(plate.status, "missing");

    assert.equal(row.structural_coverage_pct, 33);
    assert.equal(row.narration_coverage_pct, 67);
    assert.deepEqual(row.headings_missing_slide, ["Cellular Respiration", "Plate Tectonics"]);
    assert.equal(row.presentation_sections.length, 2);
    assert.equal(r.body.summary.total_headings_mentioned_only, 1);
  });

  it("AI mode without a key records a configuration error and leaves the verdicts alone", async () => {
    await clearDocsFor(topicB.topic_id);
    const docId = await makeDoc(topicB);
    await makeJob(docId, topicB.subject_id, presentation);
    const r = await scan({ topic_id: topicB.topic_id, mode: "ai" });
    assert.deepEqual(r.body.topics[0].ai_feedback, { error: "LOVABLE_API_KEY not configured" });
    assert.equal(r.body.topics[0].headings_detail[2].status, "missing");
  });

  it("AI mode merges the gateway's verdicts into the headings", async () => {
    await clearDocsFor(topicB.topic_id);
    const docId = await makeDoc(topicB);
    await makeJob(docId, topicB.subject_id, presentation);
    process.env.LOVABLE_API_KEY = "test-gateway-key";
    stubReply = JSON.stringify({
      overall_summary: "Mostly there.",
      headings: [{ heading: "Plate Tectonics", status: "covered", matched_section_title: null, reason: "ok", suggested_slide_title: null }],
    });
    try {
      const r = await scan({ topic_id: topicB.topic_id, mode: "ai" });
      const row = r.body.topics[0];
      assert.equal(row.ai_feedback.overall_summary, "Mostly there.");
      const plate = row.headings_detail.find((h) => h.heading === "Plate Tectonics");
      assert.equal(plate.ai_status, "covered");
      assert.equal(plate.status, "fully_covered");
    } finally {
      stubReply = null;
      delete process.env.LOVABLE_API_KEY;
    }
  });

  it("AI mode reports a gateway failure in ai_feedback rather than failing the scan", async () => {
    await clearDocsFor(topicB.topic_id);
    const docId = await makeDoc(topicB);
    await makeJob(docId, topicB.subject_id, presentation);
    process.env.LOVABLE_API_KEY = "test-gateway-key";
    stubReply = null;
    try {
      const r = await scan({ topic_id: topicB.topic_id, mode: "ai" });
      assert.equal(r.status, 200);
      assert.match(r.body.topics[0].ai_feedback.error, /^AI 500/);
    } finally {
      delete process.env.LOVABLE_API_KEY;
    }
  });
});
