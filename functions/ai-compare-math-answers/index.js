// Port of supabase/functions/ai-compare-math-answers. Batch-checks whether student math answers are
// equivalent to the correct answers, using the admin-configured AI provider.
//
// POST /functions/v1/ai-compare-math-answers
// body: { items: [{ id, user_answer, correct_answer }] }
// reply: { results: [{ id, is_equivalent }] }
import express from "express";
import { callAI, loadAiApiConfig, pickProvider } from "../_shared/ai-check-answer-helper.js";

export const router = express.Router();

const SYSTEM_PROMPT = `You are a math answer equivalence checker. Your ONLY job is to determine if two mathematical answers are equivalent.

Rules:
- Treat LaTeX notation and plain text as equivalent (e.g., "$5^2$" equals "5^2" equals "5²" equals "25")
- Treat fractions and decimals as equivalent (e.g., "1/2" equals "0.5")
- Treat different notations as equivalent (e.g., "×" equals "*", "÷" equals "/")
- Ignore whitespace differences
- Ignore case differences for variables
- Consider mathematical equivalence (e.g., "2x" equals "x*2" equals "x+x")
- DO NOT solve problems - only compare the given answers
- If answers are mathematically the same value or expression, they are equivalent

Respond with a JSON object containing a "results" array with objects having "id" and "is_equivalent" (boolean) for each comparison.`;

router.post("/", async (req, res) => {
  try {
    const items = req.body?.items;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "No items provided for comparison" });
    }

    const provider = pickProvider(await loadAiApiConfig());
    if (!provider) {
      console.error("No valid AI API configuration found");
      return res
        .status(503)
        .json({ error: "AI API not configured. Please configure your API key in Admin Settings." });
    }

    const comparisonsText = items
      .map(
        (item, idx) =>
          `${idx + 1}. ID: "${item.id}"\n   User Answer: "${item.user_answer}"\n   Correct Answer: "${item.correct_answer}"`
      )
      .join("\n\n");

    const userPrompt = `Compare each pair of answers and determine if they are mathematically equivalent:

${comparisonsText}

Respond ONLY with valid JSON in this exact format:
{"results": [{"id": "...", "is_equivalent": true/false}, ...]}`;

    console.log(`Comparing ${items.length} answer pairs via AI`);

    const response = await callAI(provider.apiUrl, provider.apiKey, provider.model, SYSTEM_PROMPT, userPrompt);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("AI Gateway error:", response.status, errorText.slice(0, 200));
      if (response.status === 429) {
        return res.status(429).json({ error: "Rate limit exceeded. Please try again later." });
      }
      if (response.status === 401 || response.status === 403) {
        return res.status(response.status).json({
          error: "Invalid or unauthorized API key. Please check your API key in Admin Settings.",
        });
      }
      return res.status(500).json({ error: "AI service error" });
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      console.error("No content in AI response");
      return res.status(500).json({ error: "Invalid AI response" });
    }

    let parsedResults;
    try {
      let jsonStr = content.trim();
      if (jsonStr.startsWith("```")) {
        jsonStr = jsonStr.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
      }
      parsedResults = JSON.parse(jsonStr);
    } catch {
      console.error("Failed to parse AI response");
      return res.status(500).json({ error: "Failed to parse AI response" });
    }

    return res.json(parsedResults);
  } catch (error) {
    console.error("Error in ai-compare-math-answers:", String(error?.message ?? error).slice(0, 200));
    return res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

export default router;
