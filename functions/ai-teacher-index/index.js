// Port of supabase/functions/ai-teacher-index. Keeps the AI Teacher knowledge index (knowledge_chunks and
// topic_routing_cards) in step with what is published.
//
// Admin only (Bearer JWT of a user with the "admin" role). POST { action, ... }
//   index_document { document_id | job_id, force? }  -> index one published lecture
//   remove_document { document_id | job_id }         -> drop its index once no published job remains
//   index_subject  { subject_id, max_docs?, force?, exclude_ids? } -> index pending lectures of one subject,
//                                                       time-boxed. Call again while `remaining` > 0.
//   coverage       {}                                -> per subject: published vs indexed lectures
//
// Source of truth: the markdown of each document with a published, completed video_generation_jobs row.
// The OpenRouter key comes from public.ai_settings ('ai_api_config').
import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../_shared/db.js";
import {
  chunkEmbedText,
  chunkMarkdown,
  cardEmbedText,
  embedTexts,
  makeRoutingCard,
  vecLiteral,
} from "../_shared/ai-teacher-index-helper.js";

export const router = express.Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME_BUDGET_MS = 90_000; // stop starting new documents after this

// The markdown is stored in full_content under either key. Same precedence as the original.
const DOC_MD_SQL = `COALESCE(NULLIF(full_content->>'content_markdown', ''), full_content->>'markdown', '')`;
const HAS_MD_SQL = `(COALESCE(full_content->>'content_markdown', '') <> '' OR COALESCE(full_content->>'markdown', '') <> '')`;

const fail = (res, status, body) => res.status(status).json(body);

// ---------------------------------------------------------------- helpers
// Verifies the Bearer token and the admin role. Returns the user id, or sends the error response and returns null.
async function requireAdmin(req, res) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  let userId = null;
  try {
    userId = jwt.verify(token, process.env.JWT_SECRET)?.sub || null;
  } catch {
    userId = null;
  }
  if (!userId) {
    fail(res, 401, { error: "Sign in as an admin." });
    return null;
  }
  const { rows } = await query("SELECT has_role($1::uuid, 'admin'::app_role) AS ok", [userId]);
  if (!rows[0]?.ok) {
    fail(res, 403, { error: "Admins only" });
    return null;
  }
  return userId;
}

async function openRouterKey() {
  const { rows } = await query("SELECT setting_value FROM public.ai_settings WHERE setting_key = $1 LIMIT 1", ["ai_api_config"]);
  const key = rows[0]?.setting_value?.openrouter_api_key;
  if (!key) throw new Error("No OpenRouter key configured in ai_settings (ai_api_config)");
  return key;
}

// Latest published, completed job id per document id. With documentIds, only those documents.
async function publishedJobs(documentIds) {
  const params = [];
  let filter = "";
  if (documentIds) {
    if (documentIds.length === 0) return new Map();
    params.push(documentIds);
    filter = "AND document_id = ANY($1::uuid[])";
  }
  const { rows } = await query(
    `SELECT DISTINCT ON (document_id) id, document_id
       FROM public.video_generation_jobs
      WHERE is_published = true AND status = 'completed' AND document_id IS NOT NULL ${filter}
      ORDER BY document_id, created_at DESC`,
    params
  );
  return new Map(rows.map((r) => [r.document_id, r.id]));
}

async function resolveDocumentId(body) {
  if (UUID.test(String(body.document_id || ""))) return body.document_id;
  if (UUID.test(String(body.job_id || ""))) {
    const { rows } = await query("SELECT document_id FROM public.video_generation_jobs WHERE id = $1", [body.job_id]);
    return rows[0]?.document_id ?? null;
  }
  return null;
}

// Insert-or-update of the topic's routing card (the table has no unique key on topic_id).
async function writeCard(apiKey, doc, subjectName, md) {
  const { rows: chRows } = doc.chapter_id
    ? await query("SELECT title FROM public.subject_chapters WHERE id = $1", [doc.chapter_id])
    : { rows: [] };
  const { rows: tpRows } = await query("SELECT title FROM public.subject_topics WHERE id = $1", [doc.topic_id]);
  const chapterTitle = chRows[0]?.title ?? null;
  const topicTitle = tpRows[0]?.title ?? null;

  const card = await makeRoutingCard(apiKey, { subject: subjectName, chapter: chapterTitle, topic: topicTitle, markdown: md });
  const [vec] = await embedTexts(apiKey, [cardEmbedText(chapterTitle, topicTitle, card)]);
  const now = new Date().toISOString();
  const updated = await query(
    `UPDATE public.topic_routing_cards
        SET subject_id = $2, chapter_id = $3, chapter_title = $4, topic_title = $5, summary = $6,
            keywords = $7, sample_questions = $8, embedding = $9::vector, updated_at = $10
      WHERE topic_id = $1`,
    [doc.topic_id, doc.subject_id, doc.chapter_id, chapterTitle, topicTitle, card.summary, card.keywords, card.sample_questions, vecLiteral(vec), now]
  );
  if (updated.rowCount === 0) {
    await query(
      `INSERT INTO public.topic_routing_cards
         (topic_id, subject_id, chapter_id, chapter_title, topic_title, summary, keywords, sample_questions, embedding, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector, $10)`,
      [doc.topic_id, doc.subject_id, doc.chapter_id, chapterTitle, topicTitle, card.summary, card.keywords, card.sample_questions, vecLiteral(vec), now]
    );
  }
}

// Indexes one document. Returns a result object (status: indexed | unchanged | skipped).
async function indexDocument(documentId, opts = {}) {
  const { rows: docRows } = await query(
    `SELECT id, subject_id, topic_id, chapter_id, ${DOC_MD_SQL} AS md FROM public.ai_assistant_documents WHERE id = $1`,
    [documentId]
  );
  const doc = docRows[0];
  if (!doc) return { document_id: documentId, status: "skipped", reason: "document not found" };

  const jobId = (await publishedJobs([documentId])).get(documentId);
  if (!jobId) return { document_id: documentId, status: "skipped", reason: "no published, completed job" };

  const md = String(doc.md || "");
  if (!md.trim()) return { document_id: documentId, status: "skipped", reason: "document has no markdown" };
  const chunks = chunkMarkdown(md);
  if (!chunks.length) return { document_id: documentId, status: "skipped", reason: "markdown produced no chunks" };

  const apiKey = opts.apiKey ?? (await openRouterKey());
  const { rows: subjRows } = await query("SELECT name FROM public.popular_subjects WHERE id = $1", [doc.subject_id]);
  const subjectName = subjRows[0]?.name ?? "";

  // Unchanged content: skip the paid embedding calls, only make sure the topic has its card.
  const { rows: existing } = await query(
    "SELECT heading_path, content FROM public.knowledge_chunks WHERE document_id = $1 ORDER BY chunk_index",
    [documentId]
  );
  const unchanged =
    !opts.force &&
    existing.length === chunks.length &&
    existing.every((e, i) => e.heading_path === chunks[i].path && e.content === chunks[i].text);

  let cardOk = false;
  if (doc.topic_id) {
    const { rows } = await query("SELECT topic_id FROM public.topic_routing_cards WHERE topic_id = $1 LIMIT 1", [doc.topic_id]);
    cardOk = rows.length > 0;
  }

  if (unchanged) {
    if (doc.topic_id && !cardOk) {
      await writeCard(apiKey, doc, subjectName, md);
      return { document_id: documentId, status: "indexed", chunks: chunks.length, card: true, reason: "card was missing" };
    }
    return { document_id: documentId, status: "unchanged", chunks: chunks.length, card: cardOk };
  }

  const vectors = await embedTexts(apiKey, chunks.map(chunkEmbedText));

  // Replace this document's chunks (embeddings are already computed, so the gap with no rows is short).
  await query("DELETE FROM public.knowledge_chunks WHERE document_id = $1", [documentId]);
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    await query(
      `INSERT INTO public.knowledge_chunks
         (subject_id, chapter_id, topic_id, document_id, job_id, chunk_index, heading_path, content, token_estimate, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::vector)`,
      [
        doc.subject_id,
        doc.chapter_id,
        doc.topic_id,
        documentId,
        jobId,
        i,
        c.path,
        c.text,
        Math.ceil(c.text.length / 4),
        vecLiteral(vectors[i]),
      ]
    );
  }

  let cardWritten = false;
  if (doc.topic_id) {
    await writeCard(apiKey, doc, subjectName, md);
    cardWritten = true;
  }
  return { document_id: documentId, status: "indexed", chunks: chunks.length, card: cardWritten };
}

// Deletes a document's chunks, and its topic card if the topic has no chunks left.
async function dropDocumentIndex(documentId, topicId) {
  await query("DELETE FROM public.knowledge_chunks WHERE document_id = $1", [documentId]);
  if (topicId) {
    const { rows } = await query("SELECT count(*)::int AS n FROM public.knowledge_chunks WHERE topic_id = $1", [topicId]);
    if (!rows[0].n) await query("DELETE FROM public.topic_routing_cards WHERE topic_id = $1", [topicId]);
  }
}

// Subject-level view: documents, which are eligible (published with markdown), which are indexed, and which are stale.
async function subjectState(subjectId) {
  const { rows: docs } = await query("SELECT id, topic_id FROM public.ai_assistant_documents WHERE subject_id = $1 ORDER BY id", [subjectId]);
  const { rows: mdRows } = await query(
    `SELECT id FROM public.ai_assistant_documents WHERE subject_id = $1 AND ${HAS_MD_SQL}`,
    [subjectId]
  );
  const withMd = new Set(mdRows.map((d) => d.id));
  const published = await publishedJobs(docs.map((d) => d.id));
  const { rows: indexedRows } = await query(
    "SELECT document_id FROM public.knowledge_chunks WHERE subject_id = $1 AND chunk_index = 0",
    [subjectId]
  );
  const { rows: cards } = await query("SELECT topic_id FROM public.topic_routing_cards WHERE subject_id = $1", [subjectId]);

  const indexedDocIds = new Set(indexedRows.map((r) => r.document_id));
  const eligible = docs.filter((d) => withMd.has(d.id) && published.has(d.id));
  const eligibleIds = new Set(eligible.map((d) => d.id));
  const topicOf = new Map(docs.map((d) => [d.id, d.topic_id]));
  const stale = [...indexedDocIds]
    .filter((id) => !eligibleIds.has(id))
    .map((id) => ({ id, topic_id: topicOf.get(id) ?? null }));
  return { eligible, indexedDocIds, cardTopicIds: new Set(cards.map((c) => c.topic_id)), stale };
}

const isPending = (s, d) => !s.indexedDocIds.has(d.id) || (!!d.topic_id && !s.cardTopicIds.has(d.topic_id));

async function handleIndexSubject(req, res, body) {
  const subjectId = String(body.subject_id || "");
  if (!UUID.test(subjectId)) return fail(res, 400, { error: "Valid subject_id required" });
  const maxDocs = Math.min(Math.max(parseInt(body.max_docs, 10) || 8, 1), 25);
  const force = !!body.force;
  const started = Date.now();

  const state = await subjectState(subjectId);
  let pruned = 0;
  for (const s of state.stale) {
    await dropDocumentIndex(s.id, s.topic_id);
    pruned++;
  }

  // The caller loops until `remaining` is 0 and passes back every id it has attempted, so a document that
  // fails or is skipped is reported once and never blocks the ones behind it.
  const exclude = new Set(Array.isArray(body.exclude_ids) ? body.exclude_ids.map(String) : []);
  const queue = state.eligible.filter((d) => !exclude.has(d.id) && (force || isPending(state, d)));
  const apiKey = queue.length ? await openRouterKey() : "";
  const results = [];
  const failed = [];
  const attempted = [];
  for (const d of queue) {
    if (attempted.length >= maxDocs || Date.now() - started > TIME_BUDGET_MS) break;
    attempted.push(d.id);
    try {
      results.push(await indexDocument(d.id, { force, apiKey }));
    } catch (e) {
      console.error("[ai-teacher-index] index failed", d.id, e?.message);
      failed.push({ document_id: d.id, error: String(e?.message ?? e).slice(0, 300) });
    }
  }
  return res.json({
    ok: true,
    subject_id: subjectId,
    eligible: state.eligible.length,
    attempted,
    indexed: results.filter((r) => r.status === "indexed").length,
    unchanged: results.filter((r) => r.status === "unchanged").length,
    skipped: results.filter((r) => r.status === "skipped").map((r) => ({ document_id: r.document_id, reason: r.reason })),
    failed,
    pruned,
    remaining: queue.length - attempted.length,
  });
}

async function handleCoverage(res) {
  const [subjects, docs, withMdRows, published, indexedRows, cards, links] = await Promise.all([
    query("SELECT id, name FROM public.popular_subjects ORDER BY id"),
    query("SELECT id, subject_id, topic_id FROM public.ai_assistant_documents ORDER BY id"),
    query(`SELECT id FROM public.ai_assistant_documents WHERE ${HAS_MD_SQL}`),
    publishedJobs(null),
    query("SELECT document_id, subject_id FROM public.knowledge_chunks WHERE chunk_index = 0"),
    query("SELECT topic_id, subject_id FROM public.topic_routing_cards"),
    query("SELECT cs.subject_id, c.name FROM public.course_subjects cs JOIN public.courses c ON c.id = cs.course_id ORDER BY cs.id"),
  ]);
  const withMd = new Set(withMdRows.rows.map((d) => d.id));
  const indexed = new Set(indexedRows.rows.map((r) => r.document_id));
  const cardTopics = new Set(cards.rows.map((c) => c.topic_id));
  const cardsBySubject = new Map();
  for (const c of cards.rows) cardsBySubject.set(c.subject_id, (cardsBySubject.get(c.subject_id) ?? 0) + 1);
  const coursesBySubject = new Map();
  for (const l of links.rows) {
    if (!l.name) continue;
    if (!coursesBySubject.has(l.subject_id)) coursesBySubject.set(l.subject_id, new Set());
    coursesBySubject.get(l.subject_id).add(l.name);
  }

  const by = new Map();
  const slot = (id) => {
    if (!by.has(id)) by.set(id, { eligible: 0, indexed: 0, pending: 0, unpublished_with_markdown: 0, stale: 0 });
    return by.get(id);
  };
  for (const d of docs.rows) {
    const s = slot(d.subject_id);
    const isEligible = withMd.has(d.id) && published.has(d.id);
    if (isEligible) {
      s.eligible++;
      if (indexed.has(d.id)) s.indexed++;
      if (!indexed.has(d.id) || (d.topic_id && !cardTopics.has(d.topic_id))) s.pending++;
    } else {
      if (withMd.has(d.id)) s.unpublished_with_markdown++;
      if (indexed.has(d.id)) s.stale++;
    }
  }
  const nameOf = new Map(subjects.rows.map((s) => [s.id, String(s.name).trim()]));
  const list = [...by]
    .map(([id, v]) => ({
      subject_id: id,
      name: nameOf.get(id) ?? id,
      courses: [...(coursesBySubject.get(id) ?? [])].sort(),
      topics_indexed: cardsBySubject.get(id) ?? 0,
      ...v,
    }))
    .filter((s) => s.eligible > 0 || s.indexed > 0 || s.topics_indexed > 0 || s.unpublished_with_markdown > 0);
  list.sort((a, b) => a.name.localeCompare(b.name));
  return res.json({ subjects: list });
}

router.post("/", async (req, res) => {
  try {
    const adminId = await requireAdmin(req, res);
    if (!adminId) return;
    const body = req.body && typeof req.body === "object" ? req.body : {};
    switch (String(body.action || "")) {
      case "index_document": {
        const id = await resolveDocumentId(body);
        if (!id) return fail(res, 400, { error: "document_id or job_id required" });
        return res.json({ ok: true, ...(await indexDocument(id, { force: !!body.force })) });
      }
      case "remove_document": {
        const id = await resolveDocumentId(body);
        if (!id) return fail(res, 400, { error: "document_id or job_id required" });
        if ((await publishedJobs([id])).has(id)) {
          return res.json({ ok: true, status: "kept", reason: "another published job still exists" });
        }
        const { rows } = await query("SELECT topic_id FROM public.ai_assistant_documents WHERE id = $1", [id]);
        await dropDocumentIndex(id, rows[0]?.topic_id ?? null);
        return res.json({ ok: true, status: "removed" });
      }
      case "index_subject":
        return await handleIndexSubject(req, res, body);
      case "coverage":
        return await handleCoverage(res);
      default:
        return fail(res, 400, { error: "Unknown action" });
    }
  } catch (e) {
    console.error("[ai-teacher-index] unhandled", e?.message);
    return fail(res, 500, { error: String(e?.message ?? e).slice(0, 300) });
  }
});
