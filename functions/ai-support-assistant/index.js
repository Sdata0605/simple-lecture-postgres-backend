// Port of supabase/functions/ai-support-assistant. Support chat for account, payment and platform
// questions. Academic questions are redirected to the Forum. The model's reply is streamed back as
// text/event-stream, as in the original.
//
// POST /functions/v1/ai-support-assistant
// body: { messages: [{ role: "user" | "assistant", content }], ticketId?, userId? }
import express from "express";
import { loadAiApiConfig, pickProvider } from "../_shared/ai-check-answer-helper.js";

export const router = express.Router();

const SYSTEM_PROMPT = `You are an AI Support Assistant for SimpleLecture LMS platform.

Your role:
- Help users with technical, account, payment, and platform-related issues.
- You must NOT answer academic, course subject, exam, or assignment questions.

Rules:
1. If a query is academic or course-related (like asking about a subject topic, exam answers, assignment solutions), politely redirect the user to the Forum: "This looks like a course-related question. Please use the Forum section for academic discussions where teachers and peers can help you better."
2. Provide clear, step-by-step solutions for support issues.
3. Ask the user if the issue is resolved at the end of your response.
4. If you are unsure or lack information, say so and indicate you'll escalate the ticket: "I'm not entirely sure about this. Let me escalate this to our support team for a more accurate response."
5. Do not guess or provide incorrect information.
6. Maintain a professional, polite, and concise tone.
7. Never claim to be human or replace admin authority.
8. Keep responses focused and actionable - don't be overly verbose.

You can help with:
- Login issues (password reset, access problems)
- Payment status (failed, pending, invoice)
- Course access issues
- App usage help
- Certificates, progress tracking
- General LMS navigation
- Technical issues (video not playing, app not loading)
- Account settings

Escalation Conditions:
- User indicates dissatisfaction
- You are unsure about the resolution
- Issue involves account security, payments, or system errors
- Complex issues requiring admin intervention

Response Format:
- Short explanation of the issue
- Clear action steps (numbered if multiple steps)
- Confirmation question

Example Ending:
"Please let me know if this resolves your issue. If not, I'll escalate this to our support team for further assistance."`;

router.post("/", async (req, res) => {
  try {
    const { messages, ticketId } = req.body ?? {};
    if (!messages || !Array.isArray(messages)) {
      throw new Error("Messages array is required");
    }

    const provider = pickProvider(await loadAiApiConfig());
    if (!provider) {
      console.error("[AI Support] No valid AI API configuration found");
      return res.status(503).json({
        error: "AI API not configured. Please go to Admin → Settings → AI Functions API Key Settings to add your API key.",
      });
    }

    console.log(`[AI Support] Processing request for ticket: ${ticketId}, messages: ${messages.length}`);

    const aiMessages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...messages.map((msg) => ({
        role: msg.role === "user" ? "user" : "assistant",
        content: msg.content,
      })),
    ];

    const response = await fetch(provider.apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: provider.model, messages: aiMessages, stream: true }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        console.error("[AI Support] Rate limit exceeded");
        return res.status(429).json({ error: "Rate limits exceeded, please try again later." });
      }
      if (response.status === 401 || response.status === 403) {
        console.error("[AI Support] Invalid API key");
        return res.status(response.status).json({
          error: "Invalid or unauthorized API key. Please check your API key in Admin Settings.",
        });
      }
      const errorText = await response.text();
      console.error("[AI Support] AI gateway error:", response.status, errorText.slice(0, 200));
      throw new Error(`AI gateway error: ${response.status}`);
    }

    console.log("[AI Support] Streaming response started");

    // Relay the provider's event stream as it arrives.
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.flushHeaders();
    try {
      for await (const chunk of response.body) {
        res.write(chunk);
      }
    } finally {
      res.end();
    }
    return undefined;
  } catch (error) {
    console.error("[AI Support] Error:", String(error?.message ?? error).slice(0, 200));
    if (res.headersSent) return res.end();
    return res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

export default router;
