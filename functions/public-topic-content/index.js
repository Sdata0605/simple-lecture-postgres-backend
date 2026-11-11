// Port of supabase/functions/public-topic-content.
// Public, read-only lookup: subject + chapter number + topic number -> the topic's parsed document
// and its questions. Inputs come from the query string or a JSON body (POST).
import express from "express";
import { query } from "../_shared/db.js";

export const router = express.Router();

const json = (res, status, body) => res.status(status).json(body);

// ILIKE pattern that matches the input literally (no % or _ wildcards), as a case-insensitive equality.
const literalIlike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const QUESTION_COLUMNS = [
  "id", "question_text", "question_type", "question_format", "options", "correct_answer", "explanation",
  "difficulty", "marks", "is_verified", "is_ai_generated", "question_image_url", "option_images",
  "chapter_id", "topic_id", "subtopic_id", "source_document_id", "source_document_purpose", "created_at",
];

router.all("/", async (req, res) => {
  if (req.method === "OPTIONS") return res.status(200).send("ok");
  try {
    let subjectRaw = req.query.subject ?? "";
    let chapterRaw = req.query.chapter ?? "";
    let topicRaw = req.query.topic ?? "";

    if (req.method === "POST" && req.body && typeof req.body === "object") {
      subjectRaw = req.body.subject ?? subjectRaw;
      chapterRaw = String(req.body.chapter ?? chapterRaw);
      topicRaw = String(req.body.topic ?? topicRaw);
    }

    const subject = String(subjectRaw).trim();
    const chapter = parseInt(String(chapterRaw).trim(), 10);
    const topic = String(topicRaw).trim();

    if (!subject || !Number.isFinite(chapter) || !topic) {
      return json(res, 400, {
        error: "Missing/invalid params. Required: subject (string), chapter (int), topic (string).",
        code: "bad_request",
      });
    }
    if (subject.length > 200 || topic.length > 50) {
      return json(res, 400, { error: "Input too long", code: "bad_request" });
    }

    // 1. Subject by name (case-insensitive), falling back to slug.
    let { rows: subjectRows } = await query(
      "SELECT id, name, slug FROM public.popular_subjects WHERE name ILIKE $1 ORDER BY name LIMIT 1",
      [literalIlike(subject)]
    );
    if (!subjectRows[0]) {
      ({ rows: subjectRows } = await query(
        "SELECT id, name, slug FROM public.popular_subjects WHERE slug ILIKE $1 ORDER BY slug LIMIT 1",
        [literalIlike(subject)]
      ));
    }
    const subjectRow = subjectRows[0];
    if (!subjectRow) {
      return json(res, 404, { error: `Subject not found: ${subject}`, code: "subject_not_found" });
    }

    // 2. Chapter
    const { rows: chapterRows } = await query(
      `SELECT id, chapter_number, title FROM public.subject_chapters
        WHERE subject_id = $1 AND chapter_number = $2 LIMIT 1`,
      [subjectRow.id, chapter]
    );
    const chapterRow = chapterRows[0];
    if (!chapterRow) {
      return json(res, 404, {
        error: `Chapter ${chapter} not found in subject "${subjectRow.name}"`,
        code: "chapter_not_found",
      });
    }

    // 3. Topic (topic_number is text)
    const { rows: topicRows } = await query(
      `SELECT id, topic_number, title FROM public.subject_topics
        WHERE chapter_id = $1 AND topic_number = $2 LIMIT 1`,
      [chapterRow.id, topic]
    );
    const topicRow = topicRows[0];
    if (!topicRow) {
      return json(res, 404, { error: `Topic "${topic}" not found in chapter ${chapter}`, code: "topic_not_found" });
    }

    // 4. Parsed document: prefer the topic-level one, fall back to the chapter-level one.
    const docColumns = "id, display_name, source_type, source_url, status, full_content, created_at";
    let { rows: docRows } = await query(
      `SELECT ${docColumns} FROM public.ai_assistant_documents
        WHERE topic_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [topicRow.id]
    );
    if (!docRows[0]) {
      ({ rows: docRows } = await query(
        `SELECT ${docColumns} FROM public.ai_assistant_documents
          WHERE chapter_id = $1 AND topic_id IS NULL ORDER BY created_at DESC LIMIT 1`,
        [chapterRow.id]
      ));
    }
    const docRow = docRows[0] ?? null;

    // 5. Questions for this topic
    const { rows: questions } = await query(
      `SELECT ${QUESTION_COLUMNS.join(", ")} FROM public.questions
        WHERE topic_id = $1 ORDER BY created_at ASC`,
      [topicRow.id]
    );

    return json(res, 200, {
      subject: { id: subjectRow.id, name: subjectRow.name, slug: subjectRow.slug },
      chapter: { id: chapterRow.id, chapter_number: chapterRow.chapter_number, title: chapterRow.title },
      topic: { id: topicRow.id, topic_number: topicRow.topic_number, title: topicRow.title },
      document: docRow
        ? {
            id: docRow.id,
            display_name: docRow.display_name,
            source_type: docRow.source_type,
            source_url: docRow.source_url,
            status: docRow.status,
            created_at: docRow.created_at,
            parsed_json: docRow.full_content,
          }
        : null,
      questions: questions.map((q) => ({
        id: q.id,
        question_text: q.question_text,
        question_type: q.question_type,
        question_format: q.question_format,
        options: q.options,
        option_images: q.option_images,
        question_image_url: q.question_image_url,
        correct_answer: q.correct_answer,
        explanation: q.explanation,
        difficulty: q.difficulty,
        marks: q.marks,
        is_verified: q.is_verified,
        is_ai_generated: q.is_ai_generated,
        created_at: q.created_at,
        source: {
          subject_id: subjectRow.id,
          chapter_id: q.chapter_id ?? chapterRow.id,
          topic_id: q.topic_id,
          subtopic_id: q.subtopic_id,
          source_document_id: q.source_document_id,
          source_document_purpose: q.source_document_purpose,
        },
      })),
      counts: { questions: questions.length },
    });
  } catch (err) {
    console.error("[public-topic-content] error", err?.message);
    return json(res, 500, { error: err?.message ?? "Internal error", code: "internal_error" });
  }
});

export default router;
