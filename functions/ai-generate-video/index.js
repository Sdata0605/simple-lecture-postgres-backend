// Port of supabase/functions/ai-generate-video. Writes a video script with the admin-configured AI
// provider (Google or OpenAI only, as in the original). No video is produced (video_url is always null).
//
// POST /functions/v1/ai-generate-video
// body: { content, title, type? }
import express from "express";
import { loadAiApiConfig, pickProvider } from "../_shared/ai-check-answer-helper.js";

export const router = express.Router();

const SYSTEM_PROMPT = `You are an educational content creator. Generate a detailed video script for educational content.
Include:
1. Engaging introduction (30 seconds)
2. Main content broken into clear sections with timestamps
3. Visual descriptions for each section
4. Conclusion with key takeaways
5. Suggested visuals, animations, and diagrams

Format the response as structured JSON with: script, sections, visuals, duration_estimate.`;

router.post("/", async (req, res) => {
  try {
    const { content, title, type } = req.body ?? {};
    if (!content || !title) {
      throw new Error("Content and title are required");
    }

    // This function never used OpenRouter, so it is not offered here.
    const config = await loadAiApiConfig();
    const provider = config?.provider === "openrouter" ? null : pickProvider(config);
    if (!provider) {
      console.error("No valid AI API configuration found");
      return res
        .status(503)
        .json({ error: "AI API not configured. Please configure your API key in Admin Settings." });
    }

    console.log(`Generating video for: ${title} (${type})`);

    const userPrompt = `Create a video script for this ${type || "educational"} content:

Title: ${title}

Content:
${content}

Make it engaging, clear, and suitable for students. Include timestamps and visual suggestions.`;

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
        max_tokens: 4000,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("AI API error:", errorText.slice(0, 200));
      throw new Error(`AI API error: ${response.status}`);
    }

    const data = await response.json();
    const generatedContent = data.choices[0].message.content;

    console.log("Video script generated successfully");

    return res.json({
      success: true,
      script: generatedContent,
      video_url: null,
      metadata: {
        title,
        type,
        generated_at: new Date().toISOString(),
        status: "script_ready",
      },
    });
  } catch (error) {
    console.error("Error generating video:", String(error?.message ?? error).slice(0, 200));
    return res.status(500).json({ error: error?.message });
  }
});

export default router;
