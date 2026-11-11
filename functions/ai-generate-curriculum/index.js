// Port of supabase/functions/ai-generate-curriculum. Generates a chapter/topic/subtopic structure for a
// subject. The model is forced to call one tool (generate_curriculum), and its arguments are the result.
//
// POST /functions/v1/ai-generate-curriculum
// body: { subjectName, categoryName?, numberOfChapters? (default 10) }
import express from "express";
import { loadAiApiConfig, pickProvider } from "../_shared/ai-check-answer-helper.js";

export const router = express.Router();

const subtopicSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    description: { type: "string" },
    estimated_duration_minutes: { type: "integer" },
    sequence_order: { type: "integer" },
  },
  required: ["title", "description", "estimated_duration_minutes", "sequence_order"],
  additionalProperties: false,
};

const topicSchema = {
  type: "object",
  properties: {
    topic_number: { type: "integer" },
    title: { type: "string" },
    estimated_duration_minutes: { type: "integer" },
    content_markdown: { type: "string" },
    subtopics: { type: "array", items: subtopicSchema },
  },
  required: ["topic_number", "title", "estimated_duration_minutes"],
  additionalProperties: false,
};

const chapterSchema = {
  type: "object",
  properties: {
    chapter_number: { type: "integer" },
    title: { type: "string" },
    description: { type: "string" },
    topics: { type: "array", items: topicSchema },
  },
  required: ["chapter_number", "title", "description", "topics"],
  additionalProperties: false,
};

const CURRICULUM_TOOL = {
  type: "function",
  function: {
    name: "generate_curriculum",
    description: "Generate structured curriculum with chapters, topics, and subtopics",
    parameters: {
      type: "object",
      properties: { chapters: { type: "array", items: chapterSchema } },
      required: ["chapters"],
      additionalProperties: false,
    },
  },
};

const systemPromptFor = (n) => `You are an expert curriculum designer. Generate a comprehensive chapter structure for educational content.

Your output MUST be valid JSON following this exact structure:
{
  "chapters": [
    {
      "chapter_number": 1,
      "title": "Chapter Title",
      "description": "Brief description",
      "topics": [
        {
          "topic_number": 1,
          "title": "Topic Title",
          "estimated_duration_minutes": 60,
          "content_markdown": "Brief content overview",
          "subtopics": [
            {
              "title": "Subtopic Title",
              "description": "Brief description",
              "estimated_duration_minutes": 30,
              "sequence_order": 1
            }
          ]
        }
      ]
    }
  ]
}

Requirements:
- Generate ${n} chapters
- Each chapter should have 3-5 topics
- Each topic should have 2-4 subtopics
- Follow standard curriculum progression (basic to advanced)
- Include appropriate duration estimates
- Make content academically accurate`;

router.post("/", async (req, res) => {
  try {
    const { subjectName, categoryName, numberOfChapters = 10 } = req.body ?? {};

    if (!subjectName) {
      return res.status(400).json({ error: "Subject name is required" });
    }

    const provider = pickProvider(await loadAiApiConfig());
    if (!provider) {
      console.error("No valid AI API configuration found");
      return res
        .status(503)
        .json({ error: "AI API not configured. Please configure your API key in Admin Settings." });
    }

    const userPrompt = `Generate a comprehensive curriculum structure for "${subjectName}"${
      categoryName ? ` in the context of ${categoryName}` : ""
    }.

Follow standard educational curriculum guidelines and ensure logical progression from foundational to advanced concepts.`;

    console.log("Generating curriculum for:", subjectName);

    const response = await fetch(provider.apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [
          { role: "system", content: systemPromptFor(numberOfChapters) },
          { role: "user", content: userPrompt },
        ],
        tools: [CURRICULUM_TOOL],
        tool_choice: { type: "function", function: { name: "generate_curriculum" } },
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
      const errorText = await response.text();
      console.error("AI Gateway error:", response.status, errorText.slice(0, 200));
      throw new Error(`AI Gateway error: ${response.status}`);
    }

    const data = await response.json();
    console.log("AI Response received");

    const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall || !toolCall.function?.arguments) {
      throw new Error("No curriculum data generated");
    }

    const curriculum = JSON.parse(toolCall.function.arguments);
    console.log(`Generated ${curriculum.chapters?.length || 0} chapters`);

    return res.json({
      success: true,
      curriculum: curriculum.chapters || [],
      metadata: {
        subject: subjectName,
        category: categoryName,
        generatedAt: new Date().toISOString(),
        chaptersCount: curriculum.chapters?.length || 0,
      },
    });
  } catch (error) {
    console.error("Error in ai-generate-curriculum:", String(error?.message ?? error).slice(0, 200));
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to generate curriculum",
      details: error instanceof Error ? error.stack : undefined,
    });
  }
});

export default router;
