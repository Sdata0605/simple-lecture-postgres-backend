// Port of supabase/functions/ai-generate-topic-content. Generates a full learning pack for one topic
// (markdown content, worked examples, practice questions) as one JSON object, with the admin AI provider.
//
// POST /functions/v1/ai-generate-topic-content
// body: { topicTitle, topicDescription?, chapterTitle, chapterDescription?, subjectName, categoryName, estimatedDurationMinutes }
import express from "express";
import { callAI, loadAiApiConfig, pickProvider } from "../_shared/ai-check-answer-helper.js";

export const router = express.Router();

const SYSTEM_PROMPT = `You are an expert educational content creator specializing in creating comprehensive, student-friendly learning materials. Your goal is to generate detailed, accurate, and engaging educational content that helps students understand complex topics effectively.`;

router.post("/", async (req, res) => {
  try {
    const {
      topicTitle,
      topicDescription,
      chapterTitle,
      chapterDescription,
      subjectName,
      categoryName,
      estimatedDurationMinutes,
    } = req.body ?? {};

    console.log("Generating topic content for:", topicTitle);

    const provider = pickProvider(await loadAiApiConfig());
    if (!provider) {
      console.error("No valid AI API configuration found");
      return res
        .status(503)
        .json({ error: "AI API not configured. Please configure your API key in Admin Settings." });
    }

    const userPrompt = `Generate comprehensive learning content for the following topic:

**Topic**: ${topicTitle}
**Topic Description**: ${topicDescription || "Not provided"}
**Chapter**: ${chapterTitle}
**Chapter Description**: ${chapterDescription || "Not provided"}
**Subject**: ${subjectName}
**Category**: ${categoryName}
**Estimated Duration**: ${estimatedDurationMinutes} minutes

Please generate the following sections:

## 1. DETAILED CONTENT (Markdown format)
- Introduction to the topic (what it is and why it matters)
- Key concepts and definitions (clear, student-friendly explanations)
- Formulas and equations (use LaTeX format with $$...$$ for display math)
- Visual descriptions (describe what diagrams or charts would be helpful)
- Step-by-step explanations of processes or procedures
- Important notes, tips, and common misconceptions
- Summary of key takeaways

## 2. EXAMPLES (3-5 worked examples)
Each example should include:
- A clear problem statement
- Detailed step-by-step solution
- Final answer with explanation
- Difficulty level (easy/medium/hard)
- Real-world context where applicable

## 3. PRACTICE QUESTIONS (8-10 questions)
Mix of:
- 5-6 Multiple Choice Questions (MCQs) with 4 options each
- 2-3 Descriptive questions requiring detailed answers
Each question should include:
- Clear question text
- Options (for MCQs)
- Correct answer
- Detailed explanation of why the answer is correct
- Difficulty level (easy/medium/hard)

Format your response as a valid JSON object with this exact structure:
{
  "content": "# Topic Title\\n\\nDetailed markdown content here...",
  "examples": [
    {
      "title": "Example 1: Basic Application",
      "problem": "Problem statement here",
      "solution": "Step-by-step solution here",
      "difficulty": "easy"
    }
  ],
  "practiceQuestions": [
    {
      "type": "mcq",
      "question": "Question text",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correctAnswer": "Option A",
      "explanation": "Detailed explanation",
      "difficulty": "medium"
    },
    {
      "type": "descriptive",
      "question": "Question text",
      "correctAnswer": "Expected answer key points",
      "explanation": "Detailed explanation",
      "difficulty": "hard"
    }
  ]
}

Ensure all mathematical formulas use proper LaTeX notation and all content is accurate, well-structured, and pedagogically sound.`;

    const response = await callAI(provider.apiUrl, provider.apiKey, provider.model, SYSTEM_PROMPT, userPrompt, {
      temperature: 0.7,
    });

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
      throw new Error(`AI Gateway error: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("No content generated from AI");

    let parsedContent;
    try {
      const cleanContent = content.replace(/```json\n?/g, "").replace(/```\n?/g, "");
      parsedContent = JSON.parse(cleanContent);
    } catch {
      console.error("Failed to parse AI response");
      throw new Error("Failed to parse AI-generated content");
    }

    if (!parsedContent.content || !parsedContent.examples || !parsedContent.practiceQuestions) {
      throw new Error("Invalid content structure from AI");
    }

    console.log("Successfully generated topic content");
    return res.json(parsedContent);
  } catch (error) {
    console.error("Error in ai-generate-topic-content:", String(error?.message ?? error).slice(0, 200));
    const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
    return res.status(500).json({ error: errorMessage });
  }
});

export default router;
