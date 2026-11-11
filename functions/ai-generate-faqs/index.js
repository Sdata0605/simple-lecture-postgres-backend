// Port of supabase/functions/ai-generate-faqs. Generates 5-8 course FAQs with the admin-configured AI
// provider. Reply: { faqs: [{ question, answer }] }.
//
// POST /functions/v1/ai-generate-faqs
// body: { courseName, shortDescription?, detailedDescription?, subjects? : [{ name, description? }] }
import express from "express";
import { callAI, loadAiApiConfig, pickProvider } from "../_shared/ai-check-answer-helper.js";

export const router = express.Router();

const SYSTEM_PROMPT = `You are an educational course FAQ generator. Generate 5-8 frequently asked questions with comprehensive answers for educational courses. Focus on:
- Course content and curriculum
- Prerequisites and target audience
- Learning outcomes and benefits
- Study materials and resources
- Assessment and certification
- Support and guidance available

Make answers detailed, helpful, and student-focused.`;

router.post("/", async (req, res) => {
  try {
    const { courseName, shortDescription, detailedDescription, subjects } = req.body ?? {};

    const provider = pickProvider(await loadAiApiConfig());
    if (!provider) {
      console.error("No valid AI API configuration found");
      return res
        .status(503)
        .json({ error: "AI API not configured. Please configure your API key in Admin Settings." });
    }

    const subjectsContext =
      (Array.isArray(subjects) &&
        subjects.map((s) => `${s?.name}: ${s?.description || "No description"}`).join("\n")) ||
      "No subjects provided";

    const userPrompt = `Generate FAQs for this course:

Course Name: ${courseName}
Short Description: ${shortDescription || "Not provided"}
Detailed Description: ${detailedDescription || "Not provided"}

Subjects Covered:
${subjectsContext}

Return ONLY a valid JSON array of objects with this exact structure:
[
  {
    "question": "Question text here",
    "answer": "Detailed answer here"
  }
]`;

    console.log("Generating FAQs for course:", courseName);

    const response = await callAI(provider.apiUrl, provider.apiKey, provider.model, SYSTEM_PROMPT, userPrompt, {
      temperature: 0.7,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("AI API error:", response.status, errorText.slice(0, 200));
      throw new Error(`AI API error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("No content generated");

    let faqs;
    try {
      const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) || content.match(/```\s*([\s\S]*?)\s*```/);
      const jsonStr = jsonMatch ? jsonMatch[1] : content;
      faqs = JSON.parse(jsonStr);
    } catch {
      console.error("Failed to parse FAQs JSON");
      throw new Error("Failed to parse generated FAQs");
    }

    if (!Array.isArray(faqs)) throw new Error("Generated content is not an array");

    console.log(`Generated ${faqs.length} FAQs successfully`);
    return res.json({ faqs });
  } catch (error) {
    console.error("Error in ai-generate-faqs:", String(error?.message ?? error).slice(0, 200));
    return res.status(500).json({ error: error?.message || "Failed to generate FAQs" });
  }
});

export default router;
