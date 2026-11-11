// Port of supabase/functions/approve-and-transfer-questions. Marks extracted questions as approved by the
// signed-in instructor, then moves each one into public.questions (updating an existing copy when found).
// POST { questionIds: string[] } with a Bearer token. Errors are returned as 500 { error }.
import express from "express";
import jwt from "jsonwebtoken";
import net from "node:net";
import { query } from "../_shared/db.js";

export const router = express.Router();

// jsonb columns need JSON text; arrays would otherwise be sent as PostgreSQL arrays.
const jsonb = (v) => (v === undefined || v === null ? null : JSON.stringify(v));

function userIdFrom(req) {
  const header = req.headers.authorization;
  if (!header) throw new Error("Unauthorized");
  try {
    const sub = jwt.verify(String(header).replace(/^Bearer\s+/i, "").trim(), process.env.JWT_SECRET)?.sub;
    if (!sub) throw new Error("no sub");
    return sub;
  } catch {
    throw new Error("Unauthorized");
  }
}

// Client IP as the original read it: first x-forwarded-for entry, then x-real-ip, else 'unknown'.
function clientIpFrom(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim() || "unknown";
  return req.headers["x-real-ip"] || "unknown";
}

// approved_ip_address is an inet column. Supabase's gateway always sets a forwarded IP, but a direct request does
// not, so 'unknown' (or any value that is not an IP address) is stored as NULL instead of failing the approval.
const inetOrNull = (ip) => (ip && net.isIP(String(ip)) ? String(ip) : null);

router.post("/", async (req, res) => {
  try {
    const clientIp = clientIpFrom(req);
    const questionIds = req.body?.questionIds;
    const userId = userIdFrom(req);
    if (!Array.isArray(questionIds)) return res.status(400).json({ error: "questionIds array is required" });

    const { rows: approvedQuestions } = await query(
      `UPDATE public.parsed_questions_pending
          SET is_approved = true, approved_by = $1, approved_at = $2, approved_ip_address = $3
        WHERE id = ANY($4::uuid[])
        RETURNING *`,
      [userId, new Date().toISOString(), inetOrNull(clientIp), questionIds]
    );

    const transferred = [];
    for (const question of approvedQuestions) {
      const { rows: existing } = await query(
        `SELECT id FROM public.questions WHERE source_document_id = $1 AND question_text = $2 LIMIT 1`,
        [question.document_id, question.question_text]
      );

      if (existing.length > 0) {
        // Already inserted during extraction: mark it verified and refresh the edited fields.
        try {
          await query(
            `UPDATE public.questions
                SET is_verified = true, verified_by = $2, difficulty = $3, correct_answer = $4,
                    explanation = $5, options = $6
              WHERE id = $1`,
            [existing[0].id, userId, question.difficulty, question.correct_answer, question.explanation, jsonb(question.options)]
          );
          await query(
            `UPDATE public.parsed_questions_pending
                SET transferred_to_question_bank = true, question_bank_id = $2, transferred_at = $3
              WHERE id = $1`,
            [question.id, existing[0].id, new Date().toISOString()]
          );
          transferred.push(existing[0].id);
        } catch {
          // Skipped, as in the original.
        }
      } else {
        // Older documents: insert a new question.
        try {
          const { rows: inserted } = await query(
            `INSERT INTO public.questions
               (topic_id, chapter_id, subtopic_id, question_text, question_format, question_type, difficulty, marks,
                options, correct_answer, explanation, question_image_url, option_images, contains_formula,
                source_document_id, is_ai_generated, is_verified, verified_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, true, true, $16)
             RETURNING id`,
            [
              question.topic_id,
              question.chapter_id,
              question.subtopic_id,
              question.question_text,
              question.question_format,
              question.question_type,
              question.difficulty,
              question.marks,
              jsonb(question.options),
              question.correct_answer,
              question.explanation,
              question.question_images?.[0] ?? null,
              jsonb(question.option_images),
              question.contains_formula,
              question.document_id,
              userId,
            ]
          );
          const newId = inserted[0].id;
          await query(
            `UPDATE public.parsed_questions_pending
                SET transferred_to_question_bank = true, question_bank_id = $2, transferred_at = $3
              WHERE id = $1`,
            [question.id, newId, new Date().toISOString()]
          );
          transferred.push(newId);
        } catch {
          // Skipped, as in the original.
        }
      }
    }

    return res.json({
      success: true,
      transferredCount: transferred.length,
      questionIds: transferred,
      approvedBy: userId,
      approvedFrom: clientIp,
    });
  } catch (error) {
    console.error("Error approving questions:", error?.message);
    return res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});
