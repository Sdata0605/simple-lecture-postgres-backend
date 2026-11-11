// Port of supabase/functions/ai-generate-assignment. Drafts an assignment (a JSON array of questions) for a
// chapter or topic, using the chapter's reference documents and existing questions as context.
// Nothing is saved here.
//
// POST /functions/v1/ai-generate-assignment
// body: { subjectId, chapterId, topicId?, instructions?,
//         config: { difficultyMix: {easy, medium, hard}, questionTypes: [], totalMarks, durationMinutes } }
//
// Schema notes: the original read subject_chapters.name, subject_topics.name and questions.subject_id, which
// do not exist in this schema. Here the chapter/topic names come from title, and questions are filtered by
// chapter and topic only.
import express from "express";
import { query } from "../_shared/db.js";
import { callAI, loadAiApiConfig, pickProvider } from "../_shared/ai-check-answer-helper.js";

export const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (v) => (typeof v === "string" && UUID_RE.test(v) ? v : null);

const TYPE_LINES = {
  mcq: "- MCQ: Multiple choice with 4 options, mark correct answer",
  short_answer: "- Short Answer: 2-3 sentence responses",
  long_answer: "- Long Answer: Paragraph responses requiring explanation",
  true_false: "- True/False: Statement with correct answer",
  fill_blank: "- Fill in the Blanks: Sentence with blank to fill",
  diagram: "- Diagram Based: Questions requiring visual interpretation",
  case_study: "- Case Study: Scenario-based analytical questions",
  application: "- Real-world Application: Practical application questions",
};

// Runs a lookup and returns the rows, or [] when the lookup fails (the original ignored these errors).
async function rowsOrEmpty(sql, params) {
  try {
    return (await query(sql, params)).rows;
  } catch {
    return [];
  }
}

router.post("/", async (req, res) => {
  try {
    const { subjectId, chapterId, topicId, config, instructions } = req.body ?? {};

    console.log("Generating AI Assignment:", { subjectId, chapterId, topicId });

    if (!subjectId || !chapterId) {
      return res.status(400).json({ error: "Subject ID and Chapter ID are required" });
    }

    const provider = pickProvider(await loadAiApiConfig());
    if (!provider) {
      console.error("No valid AI API configuration found");
      return res.status(503).json({
        error: "AI API not configured. Please go to Admin → Settings → AI Functions API Key Settings to add your API key.",
      });
    }

    const chapterUuid = uuidOrNull(chapterId);
    const topicUuid = uuidOrNull(topicId);
    const subjectUuid = uuidOrNull(subjectId);

    const chapter = chapterUuid
      ? (await rowsOrEmpty("SELECT title AS name FROM public.subject_chapters WHERE id = $1", [chapterUuid]))[0]
      : undefined;

    let topicName = "";
    if (topicUuid) {
      const topic = (await rowsOrEmpty("SELECT title AS name FROM public.subject_topics WHERE id = $1", [topicUuid]))[0];
      topicName = topic?.name || "";
    }

    // Reference documents for the chapter (and topic, when given).
    const documents = subjectUuid && chapterUuid
      ? await rowsOrEmpty(
          `SELECT display_name, content_preview, full_content FROM public.ai_assistant_documents
            WHERE subject_id = $1 AND chapter_id = $2 ${topicUuid ? "AND topic_id = $3" : ""}`,
          topicUuid ? [subjectUuid, chapterUuid, topicUuid] : [subjectUuid, chapterUuid]
        )
      : [];

    let documentContext = "";
    if (documents.length > 0) {
      documentContext = documents
        .map((doc) => {
          const content = doc.full_content
            ? typeof doc.full_content === "string"
              ? doc.full_content
              : JSON.stringify(doc.full_content)
            : doc.content_preview || "";
          return `Document: ${doc.display_name}\n${content.substring(0, 2000)}`;
        })
        .join("\n\n---\n\n");
    }

    // Existing questions, to avoid duplicates.
    const existingQuestions = chapterUuid
      ? await rowsOrEmpty(
          `SELECT question_text, options, correct_answer, difficulty, marks FROM public.questions
            WHERE chapter_id = $1 ${topicUuid ? "AND topic_id = $2" : ""} LIMIT 20`,
          topicUuid ? [chapterUuid, topicUuid] : [chapterUuid]
        )
      : [];

    const existingQuestionsContext = existingQuestions.length
      ? `\n\nExisting questions for reference (avoid duplicates):\n${existingQuestions
          .map((q) => `- ${q.question_text}`)
          .join("\n")}`
      : "";

    const { difficultyMix, questionTypes, totalMarks, durationMinutes } = config;

    const typeLines = questionTypes.map((t) => TYPE_LINES[t] ?? "").join("\n");

    const systemPrompt = `You are an expert educational content creator generating assignments for students.

ASSIGNMENT CREATION GUIDELINES:
1. Clear Objective - Each question should test specific learning outcomes from the chapter/topic
2. Syllabus Alignment - Stay within the chapter/topic scope provided
3. Difficulty Mix - Follow this distribution: Easy ${difficultyMix.easy}%, Medium ${difficultyMix.medium}%, Hard ${difficultyMix.hard}%
4. Question Variety - Include these types: ${questionTypes.join(", ")}
5. Time Appropriate - Total questions should fit within ${durationMinutes} minutes
6. Critical Thinking - Include "Why?", "What if?", "Compare/Analyze" questions for hard difficulty
7. Real-World Connection - Relate questions to daily life examples where applicable
8. Clear Format - Assign marks per question based on difficulty and type

DIFFICULTY LEVELS:
- Easy: Basic understanding, recall, definitions (1-2 marks typically)
- Medium: Application, problem-solving, explanations (3-4 marks typically)
- Hard: Analysis, synthesis, evaluation, critical thinking (5+ marks typically)

QUESTION TYPES TO GENERATE:
${typeLines}

OUTPUT FORMAT (JSON array):
[
  {
    "question": "Question text here",
    "type": "mcq|short_answer|long_answer|true_false|fill_blank|diagram|case_study|application",
    "difficulty": "easy|medium|hard",
    "marks": number,
    "options": ["A", "B", "C", "D"] (only for MCQ),
    "correct_answer": "Correct answer or option",
    "explanation": "Brief explanation of the answer"
  }
]

Generate questions totaling exactly ${totalMarks} marks.
${instructions ? `\nAdditional Instructions: ${instructions}` : ""}`;

    const userPrompt = `Create an assignment for:
Chapter: ${chapter?.name || "Unknown"}
${topicName ? `Topic: ${topicName}` : "Cover the entire chapter"}
Total Marks: ${totalMarks}
Duration: ${durationMinutes} minutes

${
  documentContext
    ? `REFERENCE MATERIAL:\n${documentContext}`
    : "No reference documents available. Generate based on general knowledge of the chapter/topic."
}
${existingQuestionsContext}

Generate a well-balanced assignment following all the guidelines. Output ONLY the JSON array.`;

    console.log("Sending to AI API...");

    const response = await callAI(provider.apiUrl, provider.apiKey, provider.model, systemPrompt, userPrompt, {
      temperature: null,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("AI API error:", response.status, errorText.slice(0, 200));
      const friendly =
        response.status === 429
          ? "Rate limit exceeded. Please wait a moment and try again."
          : response.status === 401 || response.status === 403
            ? "Invalid or unauthorized API key. Please check your API key in Admin Settings."
            : "AI provider error. Please try again.";
      return res.status(response.status).json({ error: friendly });
    }

    const data = await response.json();
    const content = data.choices[0]?.message?.content || "";

    let questions;
    try {
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error("No JSON array found in response");
      questions = JSON.parse(jsonMatch[0]);
    } catch {
      console.error("Failed to parse AI response");
      return res.status(500).json({ error: "Failed to parse AI-generated questions" });
    }

    const title = `${chapter?.name || "Chapter"}${topicName ? ` - ${topicName}` : ""} Assignment`;

    return res.json({
      success: true,
      title,
      questions,
      totalQuestions: questions.length,
      totalMarks: questions.reduce((sum, q) => sum + (q.marks || 0), 0),
    });
  } catch (error) {
    console.error("AI Assignment Generation Error:", String(error?.message ?? error).slice(0, 200));
    const errorMessage = error instanceof Error ? error.message : "Failed to generate assignment";
    return res.status(500).json({ error: errorMessage });
  }
});

export default router;
