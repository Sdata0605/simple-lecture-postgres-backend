// Port of supabase/functions/scan-topic-content-coverage.
// For each topic that has an uploaded document (ai_assistant_documents) and a published, completed
// video_generation_job, checks every "## " heading of the document:
//   structural  - does a section title in presentation_json match it (>= 60% keyword overlap)?
//   narration   - do its keywords appear in the narration text (>= 60% overlap)?
// mode "ai" (single topic only) adds a deeper review from the AI gateway.
//
// The original had no caller check, and it is kept that way (see the report). Config (env):
// LOVABLE_API_KEY and optional LOVABLE_API_URL.
import express from "express";
import { query } from "../_shared/db.js";

const DEFAULT_AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

const STOPWORDS = new Set([
  "the", "a", "an", "of", "and", "or", "to", "in", "on", "for", "with", "by", "is", "are",
  "as", "at", "from", "this", "that", "these", "those", "be", "been", "being", "it", "its",
  "into", "about", "how", "what", "why", "when", "which", "who", "whom", "whose", "not",
  "no", "do", "does", "did", "done", "have", "has", "had", "will", "would", "should", "can",
  "could", "may", "might", "must", "shall", "also", "such", "than", "then", "so", "if",
  "but", "because", "while", "between", "among", "other", "others", "any", "all", "each",
  "every", "some", "more", "most", "less", "few", "many", "much", "own", "same", "only",
  "just", "very", "up", "down", "out", "off", "over", "under", "again", "further", "once",
]);

const normalise = (s) => String(s).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

function extractHeadings(md) {
  const headings = [];
  for (const raw of String(md).split(/\r?\n/)) {
    const m = raw.match(/^\s{0,3}##\s+(.+?)\s*$/);
    if (!m) continue;
    const h = m[1].replace(/\*\*/g, "").replace(/^[\d.)\s]+/, "").replace(/:\s*$/, "").trim();
    if (h.length < 2) continue;
    headings.push(h);
  }
  return headings;
}

const keywordsOf = (heading) =>
  normalise(heading).split(" ").filter((w) => w.length > 2 && !STOPWORDS.has(w));

function keywordOverlap(kws, targetNorm) {
  if (kws.length === 0) return 1;
  let hits = 0;
  for (const kw of kws) if (targetNorm.includes(kw)) hits++;
  return hits / kws.length;
}

const docMarkdown = (d) => (d.full_content && d.full_content.content_markdown) || d.content_preview || "";

export const router = express.Router();

router.all("/", async (req, res) => {
  if (req.method === "OPTIONS") return res.status(200).send("ok");
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const subjectId = body.subjectId ?? null;
    const topicId = body.topic_id ?? body.topicId ?? null;
    const mode = body.mode === "ai" ? "ai" : "keyword";

    const conditions = ["topic_id IS NOT NULL"];
    const params = [];
    if (subjectId) {
      params.push(subjectId);
      conditions.push(`subject_id = $${params.length}`);
    }
    if (topicId) {
      params.push(topicId);
      conditions.push(`topic_id = $${params.length}`);
    }
    const { rows: docs } = await query(
      `SELECT id, topic_id, subject_id, chapter_id, file_name, full_content, content_preview
         FROM public.ai_assistant_documents WHERE ${conditions.join(" AND ")}`,
      params
    );
    if (docs.length === 0) return res.status(200).json({ topics: [], summary: { total: 0 } });

    const docIds = docs.map((d) => d.id);
    const { rows: jobs } = await query(
      `SELECT id, document_id, presentation_json, is_published, status, created_at
         FROM public.video_generation_jobs
        WHERE document_id = ANY($1::uuid[]) AND is_published = true AND status = 'completed'
        ORDER BY created_at DESC`,
      [docIds]
    );
    const jobByDoc = new Map();
    for (const j of jobs) if (!jobByDoc.has(j.document_id)) jobByDoc.set(j.document_id, j);

    const uniq = (xs) => [...new Set(xs.filter(Boolean))];
    const topicIds = uniq(docs.map((d) => d.topic_id));
    const subjectIds = uniq(docs.map((d) => d.subject_id));
    const chapterIds = uniq(docs.map((d) => d.chapter_id));
    const titles = async (table, col, ids) =>
      ids.length === 0 ? [] : (await query(`SELECT id, ${col} AS label FROM public.${table} WHERE id = ANY($1::uuid[])`, [ids])).rows;
    const topicMap = new Map((await titles("subject_topics", "title", topicIds)).map((t) => [t.id, t.label]));
    const subjMap = new Map((await titles("popular_subjects", "name", subjectIds)).map((s) => [s.id, s.label]));
    const chapMap = new Map((await titles("subject_chapters", "title", chapterIds)).map((c) => [c.id, c.label]));

    const results = [];
    for (const d of docs) {
      const job = jobByDoc.get(d.id);
      const headings = extractHeadings(docMarkdown(d));
      const base = {
        topic_id: d.topic_id,
        topic_title: topicMap.get(d.topic_id) || "(unknown)",
        subject_id: d.subject_id,
        subject_name: subjMap.get(d.subject_id) || "",
        chapter_id: d.chapter_id,
        chapter_title: chapMap.get(d.chapter_id) || "",
        file_name: d.file_name,
        headings_total: headings.length,
      };

      if (!job) {
        results.push({
          ...base,
          headings_detail: headings.map((h) => ({ heading: h, status: "missing", in_section_title: false, in_narration: false })),
          headings_missing: headings,
          headings_missing_slide: headings,
          section_count: 0,
          presentation_sections: [],
          structural_coverage_pct: 0,
          narration_coverage_pct: 0,
          coverage_pct: 0,
          has_published_lecture: false,
        });
        continue;
      }

      const sections = job.presentation_json?.sections || [];
      const sectionTitles = [];
      const narrationParts = [];
      for (const s of sections) {
        const title = String(s?.title || s?.slide?.title || s?.section_title || "").trim();
        const sid = String(s?.section_id || s?.id || "");
        if (title) sectionTitles.push({ section_id: sid, title, norm: normalise(title) });
        if (s?.summary) {
          const firstLine = String(s.summary).split(/\r?\n/)[0]?.trim();
          if (firstLine) sectionTitles.push({ section_id: sid, title: firstLine, norm: normalise(firstLine) });
        }

        for (const seg of s?.narration?.segments || []) if (seg?.text) narrationParts.push(String(seg.text));
        if (s?.narration?.full_text) narrationParts.push(String(s.narration.full_text));
        if (s?.summary) narrationParts.push(String(s.summary));
        if (Array.isArray(s?.key_points)) for (const kp of s.key_points) narrationParts.push(String(kp));
        for (const vb of s?.visual_beats || []) {
          if (typeof vb?.display_text === "string") narrationParts.push(vb.display_text);
          else if (Array.isArray(vb?.display_text)) narrationParts.push(vb.display_text.join(" "));
        }
      }
      const narrationNorm = normalise(narrationParts.join(" "));

      const headingsDetail = headings.map((h) => {
        const kws = keywordsOf(h);
        const matched = sectionTitles.find((st) => keywordOverlap(kws, st.norm) >= 0.6);
        const inSectionTitle = !!matched;
        const inNarration = keywordOverlap(kws, narrationNorm) >= 0.6;
        let status;
        if (inSectionTitle && inNarration) status = "fully_covered";
        else if (!inSectionTitle && inNarration) status = "mentioned_only";
        else if (inSectionTitle && !inNarration) status = "title_only";
        else status = "missing";
        return { heading: h, in_section_title: inSectionTitle, in_narration: inNarration, status, matched_section_title: matched?.title };
      });

      const withSlide = headingsDetail.filter((h) => h.in_section_title).length;
      const withNarration = headingsDetail.filter((h) => h.in_narration).length;
      const structuralPct = headings.length ? Math.round((withSlide / headings.length) * 100) : 100;
      const narrationPct = headings.length ? Math.round((withNarration / headings.length) * 100) : 100;

      results.push({
        ...base,
        headings_detail: headingsDetail,
        headings_missing: headingsDetail.filter((h) => h.status === "missing").map((h) => h.heading),
        headings_missing_slide: headingsDetail.filter((h) => !h.in_section_title).map((h) => h.heading),
        headings_covered: withSlide,
        section_count: sections.length,
        presentation_sections: sectionTitles
          .filter((s, i, arr) => arr.findIndex((x) => x.title === s.title) === i)
          .map((s) => ({ section_id: s.section_id, title: s.title })),
        structural_coverage_pct: structuralPct,
        narration_coverage_pct: narrationPct,
        coverage_pct: structuralPct,
        has_published_lecture: true,
      });
    }

    // Optional AI review, for a single topic only.
    if (mode === "ai" && topicId && results.length === 1 && results[0].has_published_lecture) {
      await addAiReview(results[0], docs[0]);
    }

    const summary = {
      total: results.length,
      published: results.filter((r) => r.has_published_lecture).length,
      unpublished: results.filter((r) => !r.has_published_lecture).length,
      fully_covered: results.filter((r) => r.has_published_lecture && r.headings_total > 0 && r.headings_missing_slide.length === 0).length,
      partially_covered: results.filter((r) => r.has_published_lecture && r.headings_missing_slide.length > 0 && r.structural_coverage_pct >= 50).length,
      poorly_covered: results.filter((r) => r.has_published_lecture && r.structural_coverage_pct < 50 && r.headings_total > 0).length,
      no_headings: results.filter((r) => r.headings_total === 0).length,
      total_headings_missing_slide: results.reduce((acc, r) => acc + (r.headings_missing_slide?.length || 0), 0),
      total_headings_mentioned_only: results.reduce(
        (acc, r) => acc + (r.headings_detail?.filter((h) => h.status === "mentioned_only").length || 0),
        0
      ),
    };
    return res.status(200).json({ topics: results, summary });
  } catch (e) {
    console.error("scan-topic-content-coverage error:", e?.message);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// Adds ai_feedback to the row and merges the AI verdicts into headings_detail. Never throws.
async function addAiReview(row, doc) {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) {
    row.ai_feedback = { error: "LOVABLE_API_KEY not configured" };
    return;
  }
  try {
    const md = docMarkdown(doc);
    const slidesForAI = row.presentation_sections.slice(0, 40);
    const truncatedDoc = md.slice(0, 40000);
    const sys = "You are a curriculum QA reviewer. Compare a source document's ## headings against a generated presentation's sections. Return STRICT JSON only, no prose.";
    const user = `SOURCE DOC HEADINGS (extracted):\n${row.headings_detail.map((h) => "- " + h.heading).join("\n")}\n\nPRESENTATION SECTION TITLES:\n${slidesForAI.map((s, i) => `${i + 1}. ${s.title}`).join("\n")}\n\nSOURCE DOC (markdown, may be truncated):\n${truncatedDoc}\n\nReturn JSON:\n{\n  "overall_summary": "one-sentence verdict",\n  "structural_coverage_pct": 0-100,\n  "headings": [{"heading":"","status":"covered|partial|missing","matched_section_title":"or null","reason":"short","suggested_slide_title":"or null"}],\n  "recommended_new_sections": ["title", ...]\n}`;

    const aiRes = await fetch(process.env.LOVABLE_API_URL || DEFAULT_AI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Lovable-API-Key": apiKey },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
      }),
    });
    if (!aiRes.ok) {
      const errTxt = await aiRes.text();
      row.ai_feedback = { error: `AI ${aiRes.status}: ${errTxt.slice(0, 300)}` };
      return;
    }

    const aiJson = await aiRes.json();
    const content = aiJson?.choices?.[0]?.message?.content || "{}";
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = { raw: content };
    }
    row.ai_feedback = parsed;

    if (Array.isArray(parsed?.headings)) {
      const aiMap = new Map(parsed.headings.map((h) => [String(h.heading || "").toLowerCase().trim(), h]));
      row.headings_detail = row.headings_detail.map((h) => {
        const ai = aiMap.get(h.heading.toLowerCase().trim());
        if (!ai) return h;
        let status = h.status;
        if (ai.status === "missing") status = "missing";
        else if (ai.status === "covered") status = "fully_covered";
        else if (ai.status === "partial") status = h.in_section_title ? "title_only" : "mentioned_only";
        return {
          ...h,
          status,
          ai_status: ai.status,
          ai_reason: ai.reason,
          ai_suggested_slide_title: ai.suggested_slide_title,
          matched_section_title: h.matched_section_title || ai.matched_section_title || undefined,
        };
      });
    }
  } catch (e) {
    row.ai_feedback = { error: String(e?.message || e) };
  }
}

export default router;
