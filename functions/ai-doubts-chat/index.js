// Port of supabase/functions/ai-doubts-chat. Answers a student's doubt strictly from the subject's notes
// (published lecture presentations and uploaded documents), with fallbacks for the model and an optional
// general-AI service. Returns the answer, follow-up suggestions and important questions.
//
// POST /functions/v1/ai-doubts-chat
// body: { question, subjectId, messages?: [{ role, content }] }
//
// Environment: AI_TEACHING_CPU_BASE and AI_TEACHING_CPU_KEY, optional. When both are set, questions with
// no match in the notes are passed to that general-AI service first. The original hard-coded an IP and key
// here; those values must be configured through the environment instead.
import express from "express";
import { query } from "../_shared/db.js";
import { loadAiApiConfig } from "../_shared/ai-check-answer-helper.js";

export const router = express.Router();

// ---------- Presentation JSON -> plain text ----------
function collectDisplayText(dt) {
  if (!dt) return "";
  if (typeof dt === "string") return dt;
  if (Array.isArray(dt)) {
    return dt
      .map((item) => (typeof item === "string" ? item : item?.text || ""))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof dt === "object" && typeof dt.text === "string") return dt.text;
  return "";
}

function extractBeats(beats) {
  if (!Array.isArray(beats)) return "";
  const out = [];
  for (const b of beats) {
    const t = collectDisplayText(b?.display_text);
    if (t) out.push(t);
    if (b?.latex) out.push(String(b.latex));
  }
  return out.join("\n");
}

function extractNotesFromPresentation(presentationJson) {
  if (!presentationJson) return "";
  const sections = presentationJson.sections || presentationJson.slides || [];
  const parts = [];

  for (const section of sections) {
    if (section.title) parts.push(`### ${section.title}`);

    // Prefer full narration text; fall back to segments
    if (section.narration?.full_text && typeof section.narration.full_text === "string") {
      parts.push(section.narration.full_text);
    } else if (Array.isArray(section.narration?.segments)) {
      for (const seg of section.narration.segments) {
        if (seg?.text) parts.push(seg.text);
      }
    }

    if (Array.isArray(section.key_points) && section.key_points.length) {
      parts.push("Key points: " + section.key_points.join("; "));
    }
    if (section.summary && typeof section.summary === "string") {
      parts.push("Summary: " + section.summary);
    }

    const beatsA = extractBeats(section.visual_beats);
    if (beatsA) parts.push(beatsA);
    const beatsB = extractBeats(section.explanation_plan?.visual_beats);
    if (beatsB) parts.push(beatsB);

    // Legacy fields
    if (Array.isArray(section.bullet_points)) {
      parts.push(section.bullet_points.join(". "));
    } else if (typeof section.bullet_points === "string") {
      parts.push(section.bullet_points);
    }
    if (typeof section.content === "string") parts.push(section.content);
  }

  return parts.filter(Boolean).join("\n");
}

// ---------- Simple keyword retrieval ----------
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being", "of", "in", "on", "at", "to", "for", "from",
  "and", "or", "but", "if", "then", "so", "as", "by", "with", "about", "into", "this", "that", "these", "those",
  "i", "you", "he", "she", "it", "we", "they", "me", "my", "your", "our", "their", "what", "which", "who", "whom",
  "how", "why", "when", "where", "do", "does", "did", "can", "could", "should", "would", "will", "shall", "may",
  "have", "has", "had", "not", "no", "yes", "please", "tell", "explain", "define", "meaning", "means",
]);

function tokenize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

function scoreBlock(qTokens, block) {
  if (!qTokens.length) return 0;
  const titleText = `${block.chapterTitle} ${block.topicTitle || ""}`.toLowerCase();
  const bodyText = block.body.toLowerCase();
  let score = 0;
  for (const t of qTokens) {
    if (titleText.includes(t)) score += 5; // title boost
    // count occurrences in body (cap 5 per token)
    let idx = 0;
    let count = 0;
    while ((idx = bodyText.indexOf(t, idx)) !== -1 && count < 5) {
      count++;
      idx += t.length;
    }
    score += count;
  }
  return score;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SYLLABUS_FALLBACK_ANSWER =
  "This question doesn't seem to be part of your current syllabus, so I can't answer it from your notes. Try rephrasing it, or pick a topic from your chapters and I'll help you with that.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Calls the general-AI teaching service, if configured. Returns an answer string or null.
async function generalAiAnswer(question) {
  const base = process.env.AI_TEACHING_CPU_BASE;
  const key = process.env.AI_TEACHING_CPU_KEY;
  if (!base || !key) return null;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60_000);
  try {
    const upstream = await fetch(`${base.replace(/\/$/, "")}/ai-teaching-assistant`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": key },
      body: JSON.stringify({
        mode: "doubt",
        question,
        questionText: question,
        subjectName: undefined,
        language: "en-US",
      }),
      signal: controller.signal,
    });
    const text = await upstream.text();
    const cpu = text ? JSON.parse(text) : null;
    const cpuAnswer = cpu?.answer || cpu?.presentationSlides?.[0]?.narration || cpu?.presentationSlides?.[0]?.content;
    if (upstream.ok && cpuAnswer && cpuAnswer.trim().length > 0) return cpuAnswer;
    console.warn("[ai-doubts-chat] general-AI fallback returned no usable answer", {
      ok: upstream.ok,
      status: upstream.status,
    });
    return null;
  } catch (e) {
    console.warn("[ai-doubts-chat] general-AI fallback failed:", e?.message);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

router.post("/", async (req, res) => {
  try {
    const { question, subjectId, messages } = req.body ?? {};

    if (!question || !subjectId) {
      return res.status(400).json({ error: "Missing required fields: question and subjectId" });
    }
    // An id that is not a uuid matches nothing, as the original's failed lookups did.
    const validSubject = typeof subjectId === "string" && UUID_RE.test(subjectId);

    // 1. Chapters and topics (metadata only)
    const { rows: chapters } = validSubject
      ? await query(
          "SELECT id, title, chapter_number FROM public.subject_chapters WHERE subject_id = $1 ORDER BY chapter_number",
          [subjectId]
        )
      : { rows: [] };
    const chapterIds = chapters.map((c) => c.id);
    const chapterMap = new Map();
    chapters.forEach((c) => chapterMap.set(c.id, c));

    const { rows: topicList } = await query(
      "SELECT id, title, topic_number, chapter_id FROM public.subject_topics WHERE chapter_id = ANY($1::uuid[]) ORDER BY topic_number",
      [chapterIds]
    );
    const topicIds = topicList.map((t) => t.id);

    // 2. Uploaded documents for the subject
    const { rows: uploadedDocs } = validSubject
      ? await query(
          `SELECT id, display_name, chapter_id, topic_id, content_preview, full_content, status
             FROM public.ai_assistant_documents WHERE subject_id = $1`,
          [subjectId]
        )
      : { rows: [] };
    const docIds = uploadedDocs.map((d) => d.id);

    // 3. Published presentation JSON per document (the same source the Notes use)
    let publishedJobs = [];
    if (docIds.length) {
      const { rows: jobs } = await query(
        `SELECT id, document_id, presentation_json, updated_at, created_at, is_published, status
           FROM public.video_generation_jobs
          WHERE document_id = ANY($1::uuid[]) AND is_published = true AND status = 'completed'
            AND presentation_json IS NOT NULL
          ORDER BY created_at DESC`,
        [docIds]
      );
      publishedJobs = jobs;
    }

    // Latest published job per document
    const jobByDocId = new Map();
    for (const j of publishedJobs) {
      if (!jobByDocId.has(j.document_id)) jobByDocId.set(j.document_id, j);
    }

    // ---------- Per-topic and per-chapter blocks ----------
    const blocks = [];

    const extractDocText = (doc) => {
      if (!doc) return "";
      if (typeof doc.full_content === "string") return doc.full_content;
      if (doc.full_content && typeof doc.full_content === "object") {
        if (typeof doc.full_content.text === "string") return doc.full_content.text;
        if (typeof doc.full_content.content === "string") return doc.full_content.content;
        if (typeof doc.full_content.markdown === "string") return doc.full_content.markdown;
        try {
          return JSON.stringify(doc.full_content);
        } catch {
          return "";
        }
      }
      return doc.content_preview || "";
    };

    const docsByTopic = new Map();
    const docsByChapter = new Map();
    const subjectDocs = [];
    for (const d of uploadedDocs) {
      if (d.topic_id) {
        if (!docsByTopic.has(d.topic_id)) docsByTopic.set(d.topic_id, []);
        docsByTopic.get(d.topic_id).push(d);
      } else if (d.chapter_id) {
        if (!docsByChapter.has(d.chapter_id)) docsByChapter.set(d.chapter_id, []);
        docsByChapter.get(d.chapter_id).push(d);
      } else {
        subjectDocs.push(d);
      }
    }

    // Topic blocks: notes from published presentation JSON, plus topic documents
    for (const t of topicList) {
      const parts = [];
      for (const d of docsByTopic.get(t.id) || []) {
        const job = jobByDocId.get(d.id);
        const notes = extractNotesFromPresentation(job?.presentation_json);
        if (notes) parts.push(notes);
        const raw = extractDocText(d);
        if (raw) parts.push(raw);
      }
      if (!parts.length) continue;
      const chapter = chapterMap.get(t.chapter_id);
      blocks.push({
        chapterTitle: chapter?.title || "Chapter",
        topicTitle: t.title,
        chapterId: t.chapter_id || null,
        topicId: t.id,
        label: `## ${chapter ? `Chapter ${chapter.chapter_number}: ${chapter.title} › ` : ""}Topic ${t.topic_number}: ${t.title}`,
        body: parts.join("\n"),
      });
    }

    // Chapter-level documents (no topic)
    for (const c of chapters) {
      const cDocs = docsByChapter.get(c.id) || [];
      if (!cDocs.length) continue;
      const parts = [];
      for (const d of cDocs) {
        const job = jobByDocId.get(d.id);
        const notes = extractNotesFromPresentation(job?.presentation_json);
        if (notes) parts.push(notes);
        const raw = extractDocText(d);
        if (raw) parts.push(raw);
      }
      if (!parts.length) continue;
      blocks.push({
        chapterTitle: c.title,
        topicTitle: null,
        chapterId: c.id,
        topicId: null,
        label: `## Chapter ${c.chapter_number}: ${c.title}`,
        body: parts.join("\n"),
      });
    }

    // Subject-level uploaded documents
    for (const d of subjectDocs) {
      const raw = extractDocText(d);
      if (!raw) continue;
      blocks.push({
        chapterTitle: d.display_name || "Subject Material",
        topicTitle: null,
        chapterId: null,
        topicId: null,
        label: `## Subject Document: ${d.display_name || "Untitled"}`,
        body: raw,
      });
    }

    console.log(`[ai-doubts-chat] built ${blocks.length} content blocks for subject ${subjectId}`);

    // ---------- Retrieval ----------
    const qTokens = tokenize(question);
    const scored = blocks.map((b) => ({ b, s: scoreBlock(qTokens, b) })).sort((a, b) => b.s - a.s);

    const TOP_N = 6;
    const OVERALL_CAP = 45000;
    const PER_BLOCK_CAP = 9000;

    const picked = [];
    let used = 0;
    for (const { b, s } of scored) {
      if (picked.length >= TOP_N) break;
      if (s === 0 && picked.length > 0) break; // do not include irrelevant filler
      const body = b.body.length > PER_BLOCK_CAP ? b.body.substring(0, PER_BLOCK_CAP) + "…" : b.body;
      const size = b.label.length + body.length + 4;
      if (used + size > OVERALL_CAP) break;
      picked.push({ ...b, body });
      used += size;
    }

    console.log(`[ai-doubts-chat] retrieval: qTokens=${qTokens.length} picked=${picked.length} topScore=${scored[0]?.s ?? 0}`);

    // Guardrail: nothing relevant in the notes, so try the general AI service, then refuse.
    if (picked.length === 0 || scored[0]?.s === 0) {
      const cpuAnswer = await generalAiAnswer(question);
      if (cpuAnswer) {
        return res.json({ answer: cpuAnswer, suggestions: [], importantQuestions: [], sources: [], fromGeneralAI: true });
      }
      return res.json({
        answer: SYLLABUS_FALLBACK_ANSWER,
        suggestions: [],
        importantQuestions: [],
        sources: [],
        notFound: true,
      });
    }

    const notesContext = picked.map((b) => `${b.label}\n${b.body}`).join("\n\n");
    const sources = picked.map((b) => ({ chapterTitle: b.chapterTitle, topicTitle: b.topicTitle }));

    // ---------- Important questions from the question bank ----------
    const pickedChapterIds = [...new Set(picked.map((b) => b.chapterId).filter(Boolean))];
    const pickedTopicIds = [...new Set(picked.map((b) => b.topicId).filter(Boolean))];

    let importantQuestions = [];
    try {
      if (pickedChapterIds.length || pickedTopicIds.length) {
        // Topic matches first, then chapter matches (both as one OR filter).
        const { rows: iqRows } = await query(
          `SELECT id, question_text, chapter_id, topic_id, marks, difficulty
             FROM public.questions
            WHERE is_important = true
              AND (topic_id = ANY($1::uuid[]) OR chapter_id = ANY($2::uuid[]))
            LIMIT 20`,
          [pickedTopicIds, pickedChapterIds]
        );
        const topicIdSet = new Set(pickedTopicIds);
        const topicTitleById = new Map();
        const topicChapterById = new Map();
        for (const t of topicList) {
          topicTitleById.set(t.id, t.title);
          if (t.chapter_id) topicChapterById.set(t.id, t.chapter_id);
        }
        importantQuestions = iqRows
          .map((r) => {
            const chapterId = r.chapter_id || topicChapterById.get(r.topic_id) || null;
            const chapter = chapterId ? chapterMap.get(chapterId) : null;
            return {
              id: r.id,
              text: r.question_text,
              chapterTitle: chapter?.title || "Chapter",
              topicTitle: r.topic_id ? topicTitleById.get(r.topic_id) || null : null,
              marks: r.marks ?? null,
              difficulty: r.difficulty ?? null,
              _topicMatch: r.topic_id && topicIdSet.has(r.topic_id) ? 1 : 0,
            };
          })
          .sort((a, b) => b._topicMatch - a._topicMatch || (b.marks ?? 0) - (a.marks ?? 0))
          .slice(0, 5)
          .map(({ _topicMatch, ...rest }) => rest);
      }
    } catch (e) {
      console.warn("[ai-doubts-chat] importantQuestions error:", String(e?.message ?? e).slice(0, 200));
    }

    // ---------- AI config ----------
    const config = await loadAiApiConfig();
    let apiUrl;
    let apiKey;
    let model;
    if (config?.enabled && config?.provider === "openrouter" && config?.openrouter_api_key) {
      apiUrl = "https://openrouter.ai/api/v1/chat/completions";
      apiKey = config.openrouter_api_key;
      model = config.default_model || "google/gemini-2.5-flash";
    } else if (config?.enabled && config?.provider === "google" && config?.google_api_key) {
      apiUrl = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
      apiKey = config.google_api_key;
      model = config.default_model || "gemini-2.5-flash";
    } else if (config?.enabled && config?.provider === "openai" && config?.openai_api_key) {
      apiUrl = "https://api.openai.com/v1/chat/completions";
      apiKey = config.openai_api_key;
      model = config.default_model || "gpt-4o-mini";
    } else {
      return res.status(503).json({
        error: "AI API not configured. Please go to Admin → Settings → AI Functions API Key Settings.",
      });
    }

    const systemPrompt = `You are a strict subject tutor. You must answer ONLY using the NOTES provided below (extracted from the student's published lectures and uploaded study documents for this subject).

RULES (STRICT):
1. Answer strictly from the NOTES. Do NOT use outside/general knowledge.
2. If the answer is NOT clearly present in the NOTES, respond EXACTLY:
   "This question doesn't seem to be part of your current syllabus, so I can't answer it from your notes. Try rephrasing it, or pick a topic from your chapters and I'll help you with that."
   Do not attempt to answer from general knowledge in that case.
3. End your answer with a short citation line listing the chapter/topic you used, e.g. "Source: Chapter 2 › Newton's Laws".
4. Keep answers concise, structured, student-friendly.

Math, Chemistry & Physics formatting (STRICT — the UI renders KaTeX):
- ALWAYS wrap math/formulas in $...$ (inline) or $...$ on their own lines (block). Never emit bare LaTeX outside $...$.
- Use ONLY standard delimiters: $...$ and $...$. Do NOT use \\( \\), \\[ \\], HTML <sub>/<sup>, or uppercase commands like \\FRAC.
- Chemistry: $H_2O$, $CO_2$, $H_2SO_4$; arrows $\\rightarrow$; states $(aq)$, $(s)$ inside $...$.
- Physics: variables/units/Greek inside $...$ (e.g. $v = u + at$, $\\lambda$, $\\Omega$).
- Math: $\\frac{a}{b}$, $x^2$, $a_1$, $\\sqrt{x}$, $\\int_0^1 f(x)\\,dx$.

NOTES:
${notesContext}`;

    const chatMessages = [{ role: "system", content: systemPrompt }];
    if (Array.isArray(messages)) {
      for (const msg of messages) {
        if (msg?.role && msg?.content) chatMessages.push({ role: msg.role, content: msg.content });
      }
    }
    chatMessages.push({ role: "user", content: question });

    // ---------- Fallback chain ----------
    const GOOGLE_FALLBACK_CHAIN = [
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-flash-latest",
      "gemini-2.0-flash",
      "gemini-2.5-pro",
    ];
    const OPENROUTER_FALLBACK_CHAIN = [
      "google/gemini-2.5-flash",
      "google/gemini-2.0-flash-001",
      "google/gemini-2.5-pro",
      "openai/gpt-4o-mini",
    ];

    const isGoogle = config?.provider === "google";
    const isOpenRouter = config?.provider === "openrouter";
    const modelChain = isGoogle
      ? [...new Set([model, ...GOOGLE_FALLBACK_CHAIN])]
      : isOpenRouter
        ? [...new Set([model, ...OPENROUTER_FALLBACK_CHAIN])]
        : [model];

    // Tries each model in turn, with backoff on 429 and 5xx. Returns the first OK response.
    async function callWithFallback(bodyBuilder, opts = {}) {
      const maxAttempts = opts.maxAttemptsPerModel ?? 3;
      const backoffs = [1000, 2500, 5000];
      let lastStatus;
      let lastErr = "unknown error";
      const tag = opts.label ? ":" + opts.label : "";
      for (const m of modelChain) {
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          try {
            const resp = await fetch(apiUrl, {
              method: "POST",
              headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
              body: JSON.stringify(bodyBuilder(m)),
            });
            if (resp.ok) {
              console.log(`[ai-doubts-chat${tag}] answered by ${m} (attempt ${attempt + 1})`);
              return { response: resp, modelUsed: m };
            }
            lastStatus = resp.status;
            const errText = await resp.text();
            lastErr = errText;
            console.warn(`[ai-doubts-chat${tag}] ${m} attempt ${attempt + 1} failed: ${resp.status} ${errText.slice(0, 200)}`);
            if (resp.status === 400 || resp.status === 401 || resp.status === 403 || resp.status === 404) break;
            if (resp.status === 429 || resp.status >= 500) {
              if (attempt < maxAttempts - 1) {
                await sleep(backoffs[attempt] ?? 5000);
                continue;
              }
            } else {
              break;
            }
          } catch (e) {
            lastErr = e?.message || String(e);
            if (attempt < maxAttempts - 1) {
              await sleep(backoffs[attempt] ?? 5000);
              continue;
            }
          }
        }
      }
      return { error: lastErr, lastStatus };
    }

    const answerResult = await callWithFallback((m) => ({ model: m, messages: chatMessages, temperature: 0.2 }), {
      label: "answer",
      maxAttemptsPerModel: 3,
    });

    if ("error" in answerResult) {
      console.error("[ai-doubts-chat] all models exhausted:", String(answerResult.error).slice(0, 200));
      return res.status(200).json({
        answer: "Our AI is experiencing heavy load right now. Please try again in a few seconds.",
        suggestions: [],
        importantQuestions,
        sources,
        fallback: true,
        transient: true,
      });
    }

    const aiData = await answerResult.response.json();
    const answer = aiData.choices[0].message.content;

    // Suggestions, grounded in the same notes used for the answer.
    let suggestions = [];
    try {
      const allowedTopics = picked
        .map((b) => (b.topicTitle ? `${b.chapterTitle} › ${b.topicTitle}` : b.chapterTitle))
        .join("\n- ");
      const suggestionContext = picked.map((b) => `${b.label}\n${b.body.substring(0, 1500)}`).join("\n\n");

      const sResult = await callWithFallback(
        (m) => ({
          model: m,
          messages: [
            {
              role: "system",
              content:
                "You suggest 3 follow-up questions a student might ask NEXT, strictly within the subject syllabus. RULES: (1) Each suggestion MUST be answerable from the provided NOTES only. (2) Do NOT invent chapters/topics not present in ALLOWED_TOPICS. (3) Do NOT go outside the syllabus. (4) Same language as the student's question. (5) Max 14 words each. Output STRICT JSON only: {\"suggestions\":[{\"text\":\"...\",\"chapterTitle\":\"...\",\"topicTitle\":\"...\"}]}. Exactly 3 items. topicTitle may be null if the suggestion is chapter-level.",
            },
            {
              role: "user",
              content: `Student question: ${question}\n\nALLOWED_TOPICS:\n- ${allowedTopics}\n\nNOTES:\n${suggestionContext}`,
            },
          ],
          temperature: 0.4,
          response_format: { type: "json_object" },
        }),
        { label: "suggestions", maxAttemptsPerModel: 1 }
      );

      if (!("error" in sResult)) {
        const sData = await sResult.response.json();
        const raw = sData.choices?.[0]?.message?.content || "{}";
        const parsed = JSON.parse(raw);
        const allowedChapters = new Set(picked.map((b) => (b.chapterTitle || "").toLowerCase().trim()));
        const allowedTopicsSet = new Set(
          picked.filter((b) => b.topicTitle).map((b) => (b.topicTitle || "").toLowerCase().trim())
        );
        if (Array.isArray(parsed.suggestions)) {
          suggestions = parsed.suggestions
            .map((s) => {
              if (typeof s === "string") return { text: s };
              if (s && typeof s.text === "string") {
                return {
                  text: s.text,
                  chapterTitle: typeof s.chapterTitle === "string" ? s.chapterTitle : undefined,
                  topicTitle: typeof s.topicTitle === "string" ? s.topicTitle : null,
                };
              }
              return null;
            })
            .filter((s) => !!s && typeof s.text === "string" && s.text.trim().length > 0)
            .filter((s) => {
              // Syllabus check: the chapter must match one of the retrieved sources
              if (!s.chapterTitle) return true;
              const ch = s.chapterTitle.toLowerCase().trim();
              if (allowedChapters.has(ch)) return true;
              if (s.topicTitle && allowedTopicsSet.has(s.topicTitle.toLowerCase().trim())) return true;
              console.warn("[ai-doubts-chat] dropped off-syllabus suggestion");
              return false;
            })
            .slice(0, 3);
        }
      }
    } catch (e) {
      console.warn("Suggestion generation failed:", String(e?.message ?? e).slice(0, 200));
    }

    return res.json({
      answer,
      suggestions,
      importantQuestions,
      sources,
      modelUsed: answerResult.modelUsed,
    });
  } catch (error) {
    console.error("Error in ai-doubts-chat:", String(error?.message ?? error).slice(0, 200));
    return res.status(500).json({ error: error instanceof Error ? error.message : "An unexpected error occurred" });
  }
});

export default router;
