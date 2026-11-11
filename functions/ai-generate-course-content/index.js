// Port of supabase/functions/ai-generate-course-content. Writes course copy (subject or course
// description, learning points, inclusions, FAQ answer) with the admin-configured AI provider.
//
// POST /functions/v1/ai-generate-course-content
// body: { type, context, prompt? }
//   type: subject_description | description | what_you_learn | course_includes | faq_answer
// reply: { content }  (an array for what_you_learn and course_includes, otherwise text)
import express from "express";
import { loadAiApiConfig, pickProvider } from "../_shared/ai-check-answer-helper.js";

export const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const { type, context, prompt } = req.body ?? {};

    const provider = pickProvider(await loadAiApiConfig());
    if (!provider) {
      console.error("No valid AI API configuration found");
      return res
        .status(503)
        .json({ error: "AI API not configured. Please configure your API key in Admin Settings." });
    }

    let systemPrompt = "";
    let userPrompt = "";

    switch (type) {
      case "subject_description":
        systemPrompt =
          "You are an expert education content writer specializing in creating engaging subject descriptions for online learning platforms.";
        userPrompt =
          prompt ||
          `Create a compelling, informative description for the subject "${context.subjectName}"${
            context.categoryName ? ` in the ${context.categoryName} category` : ""
          }.

The description should:
- Be between 400-500 characters (aim for 450-500 to maximize content)
- Be 3-4 well-crafted sentences
- Highlight why students should study this subject
- Mention key topics and concepts covered
- Emphasize practical applications and benefits
- Be engaging and motivational for students
- Use clear, accessible language

CRITICAL: The description must be at least 400 characters and MAXIMUM 500 characters. Aim for 450-500 characters to provide comprehensive content.
Return ONLY the description text, without any headings or formatting.`;
        break;

      case "description":
        systemPrompt =
          "You are an expert course description writer. Create engaging, clear, and compelling course descriptions.";
        userPrompt =
          prompt ||
          `Write a ${context.shortDescription ? "detailed" : "short"} description for a course named "${context.courseName}". ${
            context.shortDescription ? `The short description is: ${context.shortDescription}` : ""
          } Make it engaging and highlight the key benefits.`;
        break;

      case "what_you_learn":
        systemPrompt = "You are an expert at defining learning outcomes. List specific, actionable learning points.";
        userPrompt =
          prompt ||
          `List 6-8 specific things students will learn in the course "${context.courseName}". ${
            context.shortDescription ? `Course description: ${context.shortDescription}` : ""
          } Format as a JSON array of strings. Each point should start with an action verb and be concrete.`;
        break;

      case "course_includes":
        systemPrompt = "You are an expert at describing course features and inclusions.";
        userPrompt =
          prompt ||
          `List 5-7 features/inclusions for the course "${context.courseName}". ${
            context.shortDescription ? `Course description: ${context.shortDescription}` : ""
          } Format as a JSON array of objects with "icon" (lucide-react icon name like Video, Book, Clock, Award, Users, Download, MessageSquare) and "text" (feature description) properties.`;
        break;

      case "faq_answer":
        systemPrompt = "You are a helpful assistant answering frequently asked questions about courses.";
        userPrompt =
          prompt ||
          `Answer this FAQ for the course "${context.courseName}": ${context.question}. ${
            context.shortDescription ? `Course description: ${context.shortDescription}` : ""
          } Keep it concise and helpful.`;
        break;
    }

    const response = await fetch(provider.apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
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
      console.error("AI API Error:", response.status, errorText.slice(0, 200));
      throw new Error(`AI API error: ${response.status}`);
    }

    const aiResponse = await response.json();
    let content = aiResponse.choices[0].message.content;

    if (type === "what_you_learn" || type === "course_includes") {
      try {
        const jsonMatch = content.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
        content = JSON.parse(jsonMatch ? jsonMatch[1] : content);
      } catch {
        console.error("Failed to parse JSON");
        if (type === "what_you_learn") {
          content = content
            .split("\n")
            .filter((line) => line.trim().match(/^[\d\-*]/))
            .map((line) => line.replace(/^[\d\-*.)]\s*/, "").trim());
        }
      }
    }

    return res.json({ content });
  } catch (error) {
    console.error("Error:", String(error?.message ?? error).slice(0, 200));
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: errorMessage });
  }
});

export default router;
