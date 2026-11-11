// Port of supabase/functions/ai-suggest-chapter-topic. Suggests the chapter, topic and subtopic a
// question belongs to, from the lists the caller sends. Reply is the model's JSON object.
//
// POST /functions/v1/ai-suggest-chapter-topic
// body: { questionText, subjectId, subjectName?, categoryName?, existingChapters?, existingTopics?, existingSubtopics? }
import express from "express";
import { loadAiApiConfig, pickProvider } from "../_shared/ai-check-answer-helper.js";

export const router = express.Router();

const SYSTEM_PROMPT = `You are an expert educational content classifier. Analyze the question and suggest the most appropriate chapter, topic, and subtopic from the provided options. If no exact match exists, suggest a new name that would be appropriate.

Return a JSON object with this structure:
{
  "suggestedChapter": {
    "id": "uuid or null if new",
    "title": "chapter title",
    "confidence": 0.0-1.0,
    "reasoning": "explanation"
  },
  "suggestedTopic": {
    "id": "uuid or null if new",
    "title": "topic title",
    "confidence": 0.0-1.0,
    "reasoning": "explanation"
  },
  "suggestedSubtopic": {
    "id": "uuid or null if new",
    "title": "subtopic title",
    "confidence": 0.0-1.0,
    "reasoning": "explanation"
  }
}`;

router.post("/", async (req, res) => {
  try {
    const { questionText, subjectId, subjectName, categoryName, existingChapters, existingTopics, existingSubtopics } =
      req.body ?? {};

    if (!questionText || !subjectId) {
      return res.status(400).json({ error: "questionText and subjectId are required" });
    }

    const provider = pickProvider(await loadAiApiConfig());
    if (!provider) {
      console.error("No valid AI API configuration found");
      return res
        .status(503)
        .json({ error: "AI API not configured. Please configure your API key in Admin Settings." });
    }

    const userPrompt = `Question: ${questionText}

Subject: ${subjectName}
Category: ${categoryName}

Available Chapters:
${JSON.stringify(existingChapters || [], null, 2)}

Available Topics:
${JSON.stringify(existingTopics || [], null, 2)}

Available Subtopics:
${JSON.stringify(existingSubtopics || [], null, 2)}

Suggest the best match or propose new names if no match exists. Consider the question's content, difficulty level, and educational context.`;

    // Same request as the original, which also asks for a JSON object.
    const response = await fetch(provider.apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.7,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return res.status(429).json({ error: "Rate limit exceeded. Please try again later." });
      }
      if (response.status === 401 || response.status === 403) {
        return res.status(response.status).json({
          error: "Invalid or unauthorized API key. Please check your API key in Admin Settings.",
        });
      }
      throw new Error(`AI API error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices[0].message.content;

    // Strip a markdown code fence if present.
    let cleanContent = content.trim();
    if (cleanContent.startsWith("```json")) {
      cleanContent = cleanContent.replace(/^```json\n/, "").replace(/\n```$/, "");
    } else if (cleanContent.startsWith("```")) {
      cleanContent = cleanContent.replace(/^```\n/, "").replace(/\n```$/, "");
    }

    return res.json(JSON.parse(cleanContent));
  } catch (error) {
    console.error("Error in ai-suggest-chapter-topic:", String(error?.message ?? error).slice(0, 200));
    return res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

export default router;
