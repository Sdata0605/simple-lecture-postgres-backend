// Port of supabase/functions/test-ai-connection. Admin tool: checks an AI provider key with a tiny
// request. POST { provider: google|openai|openrouter, apiKey, model }.
// Callers: an admin JWT (role admin) or the service key. A failed provider call returns 200 with
// { error, status }, as the original did. The key is never logged or echoed back.
import express from "express";
import { isServiceCall, jwtUserId, userHasRole } from "../_shared/send-verification-notification-helper.js";

export const router = express.Router();

router.post("/", async (req, res) => {
  try {
    if (!isServiceCall(req)) {
      const userId = jwtUserId(req);
      if (!userId || !(await userHasRole(userId, ["admin"]))) {
        return res.status(401).json({ error: "Unauthorized" });
      }
    }

    const { provider, apiKey, model } = req.body || {};
    if (!provider || !apiKey || !model) {
      return res.status(400).json({ error: "Missing required fields: provider, apiKey, model" });
    }

    const baseBody = {
      model,
      messages: [{ role: "user", content: "Say 'Connection successful!' in exactly those words." }],
      max_tokens: 20,
    };
    const bearer = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };

    let apiUrl;
    let headers;
    if (provider === "google") {
      apiUrl = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
      headers = bearer;
    } else if (provider === "openai") {
      apiUrl = "https://api.openai.com/v1/chat/completions";
      headers = bearer;
    } else if (provider === "openrouter") {
      apiUrl = "https://openrouter.ai/api/v1/chat/completions";
      headers = { ...bearer, "HTTP-Referer": "https://simplelecture.com", "X-Title": "SimpleLecture" };
    } else {
      return res.status(400).json({ error: 'Invalid provider. Must be "google", "openai" or "openrouter"' });
    }

    console.log(`Testing ${provider} connection with model: ${model}`);

    const response = await fetch(apiUrl, { method: "POST", headers, body: JSON.stringify(baseBody) });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`API Error (${response.status})`);
      let errorMessage = "API connection failed";
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error?.message || errorJson.message || errorMessage;
      } catch {
        errorMessage = errorText.substring(0, 200);
      }
      return res.status(200).json({ error: errorMessage, status: response.status });
    }

    const data = await response.json();
    const responseText = data.choices?.[0]?.message?.content || "";
    console.log("Connection test successful.");

    return res.json({
      success: true,
      message: "Connection successful!",
      model_response: responseText,
      provider,
      model,
    });
  } catch (error) {
    console.error("Error testing AI connection:", error?.message);
    return res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error occurred" });
  }
});

export default router;
