// Port of supabase/functions/ai-generate-podcast. Writes a podcast script with the admin-configured AI
// provider. No audio is produced (audio_url is always null), as in the original.
//
// POST /functions/v1/ai-generate-podcast
// body: { content, title, type? }
import express from "express";
import { callAI, loadAiApiConfig, pickProvider } from "../_shared/ai-check-answer-helper.js";

export const router = express.Router();

const SYSTEM_PROMPT = `You are an educational podcast creator. Generate an engaging podcast script that:
1. Has a conversational, friendly tone
2. Explains concepts clearly with real-world examples
3. Includes questions to encourage thinking
4. Has smooth transitions between topics
5. Includes timestamps and pacing notes

Format as structured JSON with: script, segments, duration_estimate, voice_notes.`;

router.post("/", async (req, res) => {
  try {
    const { content, title, type } = req.body ?? {};
    if (!content || !title) {
      throw new Error("Content and title are required");
    }

    const provider = pickProvider(await loadAiApiConfig());
    if (!provider) {
      console.error("No valid AI API configuration found");
      return res
        .status(503)
        .json({ error: "AI API not configured. Please configure your API key in Admin Settings." });
    }

    console.log(`Generating podcast for: ${title} (${type})`);

    const userPrompt = `Create a podcast episode script for this ${type || "educational"} content:

Title: ${title}

Content:
${content}

Make it conversational, engaging, and easy to follow. Include pacing notes and emphasis markers.`;

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
        temperature: 0.8,
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

    console.log("Podcast script generated successfully");

    return res.json({
      success: true,
      script: generatedContent,
      audio_url: null,
      metadata: {
        title,
        type,
        generated_at: new Date().toISOString(),
        status: "script_ready",
      },
    });
  } catch (error) {
    console.error("Error generating podcast:", String(error?.message ?? error).slice(0, 200));
    return res.status(500).json({ error: error?.message });
  }
});

export default router;
