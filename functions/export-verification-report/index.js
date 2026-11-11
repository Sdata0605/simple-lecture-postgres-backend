// Port of supabase/functions/export-verification-report. Admin-only. For one uploaded question
// document, returns a CSV file (format 'csv') or an HTML report that the admin UI prints to PDF
// (format 'pdf'). POST { documentId, format }.
import express from "express";
import { query } from "../_shared/db.js";
import { userIdFromBearer, isAdminUser } from "../_shared/cdn-presentation-refresh-start-helper.js";

export const router = express.Router();

const sendJson = (res, status, body) => res.status(status).type("application/json").send(JSON.stringify(body));

// Escapes text placed into the HTML report. The original did not escape it.
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

router.post("/", async (req, res) => {
  const userId = userIdFromBearer(req);
  if (!userId) return sendJson(res, 401, { error: "Unauthorized" });
  if (!(await isAdminUser(userId))) return sendJson(res, 403, { error: "Forbidden" });

  try {
    const { documentId, format } = req.body || {};
    if (!documentId || !format) {
      return sendJson(res, 400, { error: "documentId and format are required" });
    }
    if (!["csv", "pdf"].includes(format)) {
      return sendJson(res, 400, { error: "format must be csv or pdf" });
    }

    const { rows: docRows } = await query(
      `SELECT d.*,
              c.name AS category_name,
              ps.name AS subject_name,
              ch.title AS chapter_title,
              t.title AS topic_title,
              st.title AS subtopic_title,
              p.full_name AS verifier_name
         FROM public.uploaded_question_documents d
         LEFT JOIN public.categories c ON c.id = d.category_id
         LEFT JOIN public.popular_subjects ps ON ps.id = d.subject_id
         LEFT JOIN public.subject_chapters ch ON ch.id = d.chapter_id
         LEFT JOIN public.subject_topics t ON t.id = d.topic_id
         LEFT JOIN public.subtopics st ON st.id = d.subtopic_id
         LEFT JOIN public.profiles p ON p.id = d.verified_by_user_id
        WHERE d.id = $1`,
      [documentId]
    );
    const document = docRows[0];
    if (!document) throw new Error("Document not found");

    const { rows: questions } = await query(
      "SELECT * FROM public.parsed_questions_pending WHERE document_id = $1",
      [documentId]
    );

    // numeric columns come back from pg as strings
    const num = (v) => Number(v) || 0;
    const totalQuestions = questions.length;
    const verifiedQuestions = questions.filter((q) => q.llm_verified).length;
    const approvedQuestions = questions.filter((q) => q.is_approved).length;
    const avgConfidence = questions.reduce((sum, q) => sum + num(q.llm_confidence_score), 0) / totalQuestions || 0;
    const qualityScore = num(document.verification_quality_score) || avgConfidence * (approvedQuestions / totalQuestions);

    if (format === "csv") {
      const header = "Question #,Question Text,Type,Difficulty,LLM Verified,LLM Confidence,Is Approved,Chapter,Topic,Subtopic\n";
      const rows = questions
        .map((q, index) => {
          const questionText = String(q.question_text || "").replace(/"/g, '""').substring(0, 100);
          return `${index + 1},"${questionText}",${q.question_format},${q.difficulty},${q.llm_verified},${num(q.llm_confidence_score)},${q.is_approved},"${q.chapter_id || ""}","${q.topic_id || ""}","${q.subtopic_id || ""}"`;
        })
        .join("\n");

      res.status(200);
      res.set({
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="verification-report-${documentId}.csv"`,
      });
      return res.send(header + rows);
    }

    const scoreColor =
      qualityScore >= 0.86 ? "#2563eb" : qualityScore >= 0.71 ? "#16a34a" : qualityScore >= 0.41 ? "#eab308" : "#dc2626";
    const tableRows =
      questions.length === 0
        ? '<tr><td colspan="7">No questions found</td></tr>'
        : questions
            .map(
              (q, index) => `
        <tr>
          <td>${index + 1}</td>
          <td>${esc(String(q.question_text || "").substring(0, 80))}...</td>
          <td>${esc(q.question_format)}</td>
          <td>${esc(q.difficulty)}</td>
          <td>${q.llm_verified ? "✅" : "❌"}</td>
          <td>${(num(q.llm_confidence_score) * 100).toFixed(0)}%</td>
          <td>${q.is_approved ? "✅" : "⏳"}</td>
        </tr>`
            )
            .join("");

    const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Verification Report</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; }
    h1 { color: #333; }
    .header { background: #f5f5f5; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
    .metrics { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin: 20px 0; }
    .metric { background: #fff; border: 1px solid #ddd; padding: 10px; border-radius: 3px; }
    .metric-label { font-size: 12px; color: #666; }
    .metric-value { font-size: 24px; font-weight: bold; color: #333; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; font-size: 12px; }
    th { background-color: #f5f5f5; font-weight: bold; }
    .quality-score { font-size: 36px; font-weight: bold; color: ${scoreColor}; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Document Verification Report</h1>
    <p><strong>Document:</strong> ${esc(document.questions_file_name || document.file_name)}</p>
    <p><strong>Subject:</strong> ${esc(document.subject_name)} &gt; ${esc(document.chapter_title)} &gt; ${esc(document.topic_title || "")}</p>
    <p><strong>Uploaded:</strong> ${esc(new Date(document.created_at).toLocaleDateString())}</p>
    <p><strong>Verified By:</strong> ${esc(document.verifier_name || "Not yet verified")}</p>
    ${document.human_verified_at ? `<p><strong>Verified At:</strong> ${esc(new Date(document.human_verified_at).toLocaleString())}</p>` : ""}
  </div>

  <div class="metrics">
    <div class="metric">
      <div class="metric-label">Total Questions</div>
      <div class="metric-value">${totalQuestions}</div>
    </div>
    <div class="metric">
      <div class="metric-label">Verified by LLM</div>
      <div class="metric-value">${verifiedQuestions}</div>
    </div>
    <div class="metric">
      <div class="metric-label">Approved by Human</div>
      <div class="metric-value">${approvedQuestions}</div>
    </div>
    <div class="metric">
      <div class="metric-label">Quality Score</div>
      <div class="quality-score">${(qualityScore * 100).toFixed(1)}%</div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>Question Text (Preview)</th>
        <th>Type</th>
        <th>Difficulty</th>
        <th>LLM Verified</th>
        <th>Confidence</th>
        <th>Approved</th>
      </tr>
    </thead>
    <tbody>${tableRows}
    </tbody>
  </table>
</body>
</html>
      `;

    return sendJson(res, 200, { html });
  } catch (error) {
    console.error("Error in export-verification-report:", error.message);
    return sendJson(res, 500, { error: error instanceof Error ? error.message : "Unknown error" });
  }
});
