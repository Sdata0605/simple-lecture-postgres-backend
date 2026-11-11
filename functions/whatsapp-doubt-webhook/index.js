// Port of supabase/functions/whatsapp-doubt-webhook. Receives an inbound WhatsApp message from Wacto,
// answers it with the first AI provider that returns text (OpenRouter, then Google Gemini, then the
// Lovable gateway), logs the exchange, and replies on WhatsApp with the answer and a web link.
// POST: the Wacto webhook payload (shape handled as in the original).
// If WHATSAPP_WEBHOOK_SECRET is set, the request must carry it in the x-webhook-secret header.
// Env: WACTO_API_TOKEN (required), WACTO_SENDER_ID (required), LOVABLE_API_KEY (optional),
//      PUBLIC_SITE_URL (default https://simplelecture.com).
import express from "express";
import crypto from "node:crypto";
import { query } from "../_shared/db.js";

export const router = express.Router();

const WACTO_BASE = "https://api.wacto.app/api/v1.0";
const DEFAULT_SITE = "https://simplelecture.com";

function secretMatches(given, expected) {
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function promptFor(studentName, questionText) {
  return `You are an expert tutor for Indian students. The student's name is ${studentName}. Answer the following question clearly and concisely. Use simple language. If it involves math or science, show step-by-step solutions. Keep the answer under 500 words.\n\nQuestion: ${questionText}`;
}

// Returns the AI answer text, or "" when no provider produced one.
async function answerQuestion({ aiCfg, googleApiKey, studentName, questionText }) {
  let aiAnswer = "";

  const openrouterKey = aiCfg?.openrouter_api_key || null;
  if (!aiAnswer && openrouterKey) {
    try {
      const orResp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openrouterKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": DEFAULT_SITE,
          "X-Title": "SimpleLecture",
        },
        body: JSON.stringify({
          model: aiCfg.default_model || "google/gemini-2.5-flash",
          messages: [{ role: "user", content: promptFor(studentName, questionText) }],
          temperature: 0.3,
        }),
      });
      if (orResp.ok) {
        const orData = await orResp.json();
        aiAnswer = orData.choices?.[0]?.message?.content || "";
      } else {
        console.error("OpenRouter error: HTTP", orResp.status);
      }
    } catch (e) {
      console.error("OpenRouter fetch failed:", e?.message);
    }
  }

  if (!aiAnswer && googleApiKey) {
    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${encodeURIComponent(googleApiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: promptFor(studentName, questionText) }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
        }),
      }
    );
    if (geminiResponse.ok) {
      const geminiData = await geminiResponse.json();
      aiAnswer = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "";
    } else {
      console.error("Gemini error: HTTP", geminiResponse.status);
    }
  }

  const lovableKey = process.env.LOVABLE_API_KEY;
  if (!aiAnswer && lovableKey) {
    const gatewayResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${lovableKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-pro",
        messages: [
          {
            role: "system",
            content: `You are an expert tutor for Indian students. The student's name is ${studentName}. Answer questions clearly and concisely. Use simple language. Show step-by-step solutions for math/science. Keep answers under 500 words.`,
          },
          { role: "user", content: questionText },
        ],
      }),
    });
    if (gatewayResponse.ok) {
      const data = await gatewayResponse.json();
      aiAnswer = data.choices?.[0]?.message?.content || "";
    } else {
      console.error("Gateway error: HTTP", gatewayResponse.status);
    }
  }

  return aiAnswer;
}

async function sendWacto(token, sender, body) {
  return fetch(`${WACTO_BASE}/messages/send/${encodeURIComponent(sender)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

router.post("/", async (req, res) => {
  try {
    const expectedSecret = process.env.WHATSAPP_WEBHOOK_SECRET;
    if (expectedSecret && !secretMatches(req.headers["x-webhook-secret"], expectedSecret)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const payload = req.body || {};
    // Extract the message from the Wacto webhook payload
    const message = payload?.message || payload?.messages?.[0] || payload;
    const phoneRaw = message?.from || message?.sender || message?.phone || payload?.from;
    const questionText = message?.text?.body || message?.body || message?.text || payload?.text?.body || payload?.body;

    if (!phoneRaw || !questionText) {
      return res.json({ status: "ignored", reason: "no phone or text" });
    }

    const phone = String(phoneRaw).replace(/\D/g, "");
    console.log("Received a WhatsApp question");

    const token = process.env.WACTO_API_TOKEN;
    if (!token) throw new Error("WACTO_API_TOKEN not configured");
    const sender = process.env.WACTO_SENDER_ID;
    if (!sender) throw new Error("WACTO_SENDER_ID not configured");

    // Student lookup by phone number
    const { rows: profiles } = await query(
      "SELECT id, full_name, phone_number FROM public.profiles WHERE phone_number = ANY($1::text[]) LIMIT 1",
      [[phone, phone.replace(/^91/, ""), `+${phone}`]]
    );
    const student = profiles[0];
    const studentName = student?.full_name || "Student";
    const studentId = student?.id || null;

    // AI configuration: ai_api_config row, then the legacy google_api_key row
    const { rows: cfgRows } = await query("SELECT setting_value FROM public.ai_settings WHERE setting_key = 'ai_api_config' LIMIT 1");
    const aiCfg = cfgRows[0]?.setting_value || {};
    const { rows: legacyRows } = await query("SELECT setting_value FROM public.ai_settings WHERE setting_key = 'google_api_key' LIMIT 1");
    const legacy = legacyRows[0]?.setting_value || {};
    const googleApiKey = aiCfg?.google_api_key || legacy?.key || legacy?.api_key || null;

    let aiAnswer = await answerQuestion({ aiCfg, googleApiKey, studentName, questionText });
    if (!aiAnswer) {
      aiAnswer = "Sorry, I couldn't process your question right now. Please try again later or contact support.";
    }

    const { rows: logRows } = await query(
      `INSERT INTO public.whatsapp_chat_logs (phone_number, student_id, direction, message_text, ai_answer)
       VALUES ($1, $2, 'inbound', $3, $4) RETURNING id`,
      [phone, studentId, String(questionText), aiAnswer]
    ).catch((e) => {
      console.error("Log insert error:", e?.message);
      return { rows: [] };
    });
    const logId = logRows[0]?.id;

    // WhatsApp caps messages at about 4000 characters
    const whatsappAnswer = aiAnswer.length > 3500
      ? aiAnswer.substring(0, 3500) + "...\n\n(Full answer available on the link below)"
      : aiAnswer;

    const recipientPhone = phone.startsWith("91") ? phone : `91${phone}`;
    await sendWacto(token, sender, { recipient: recipientPhone, type: "text", text: { body: whatsappAnswer } });

    if (logId) {
      await new Promise((r) => setTimeout(r, 1000));
      const siteUrl = (process.env.PUBLIC_SITE_URL || DEFAULT_SITE).replace(/\/$/, "");
      await sendWacto(token, sender, {
        recipient: recipientPhone,
        type: "text",
        text: { body: `📖 View the full answer with proper formatting on our website:\n${siteUrl}/doubt/${logId}` },
      });
    }

    return res.json({ success: true, logId });
  } catch (error) {
    console.error("Webhook error:", error?.message);
    return res.status(500).json({ error: error.message });
  }
});

export default router;
