// Port of supabase/functions/ai-generate-solution. Writes a step-by-step solution for a pending parsed
// question and saves it to public.parsed_questions_pending.explanation.
//
// POST /functions/v1/ai-generate-solution
// body: { questionId }
import express from "express";
import { query } from "../_shared/db.js";
import { callAI, loadAiApiConfig, pickProvider } from "../_shared/ai-check-answer-helper.js";

export const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.post("/", async (req, res) => {
  try {
    const { questionId } = req.body ?? {};
    console.log("Generating solution for question:", questionId);

    if (typeof questionId !== "string" || !UUID_RE.test(questionId)) {
      throw new Error("JSON object requested, multiple (or no) rows returned");
    }

    // Same as supabase-js .single(): exactly one row, or an error.
    const { rows } = await query("SELECT * FROM public.parsed_questions_pending WHERE id = $1", [questionId]);
    if (rows.length !== 1) throw new Error("JSON object requested, multiple (or no) rows returned");
    const question = rows[0];

    const provider = pickProvider(await loadAiApiConfig());
    if (!provider) {
      console.error("No valid AI API configuration found");
      return res.status(503).json({
        error: "AI API not configured. Please go to Admin → Settings → AI Functions API Key Settings to add your API key.",
      });
    }

    const prompt = `You are an expert educator. Generate a clear, step-by-step solution for the following question:

Question: ${question.question_text}

Question Type: ${question.question_format}
Difficulty: ${question.difficulty}
${question.options ? `Options: ${JSON.stringify(question.options)}` : ""}
Correct Answer: ${question.correct_answer}

Provide a detailed explanation that:
1. Explains the concept involved
2. Shows step-by-step working
3. Explains why the correct answer is right
4. If applicable, explains why other options are wrong

Format the solution clearly with numbered steps and explanations.`;

    const aiResponse = await callAI(
      provider.apiUrl,
      provider.apiKey,
      provider.model,
      "You are an expert educator who provides clear, detailed explanations.",
      prompt,
      { temperature: null }
    );

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      console.error("AI error:", aiResponse.status, errorText.slice(0, 200));
      throw new Error(`AI generation failed: ${aiResponse.status}`);
    }

    const aiData = await aiResponse.json();
    const generatedSolution = aiData.choices[0].message.content;

    await query("UPDATE public.parsed_questions_pending SET explanation = $2, updated_at = now() WHERE id = $1", [
      questionId,
      generatedSolution,
    ]);

    return res.json({ success: true, solution: generatedSolution });
  } catch (error) {
    console.error("Error generating solution:", String(error?.message ?? error).slice(0, 200));
    return res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

export default router;
