// Port of supabase/functions/cloud-language-check. Forwards a batch of job strings to the language
// checker. The checker URL comes from CLOUD_LANGUAGE_CHECK_URL. Errors are returned with status 200,
// as the original did, so the client does not wrap them as HTTP failures.
import express from "express";

export const router = express.Router();
export const hooks = { fetch: null };

router.post("/", async (req, res) => {
  const jobs = Array.isArray(req.body?.jobs) ? req.body.jobs.filter((j) => typeof j === "string" && j) : [];
  if (jobs.length === 0) {
    return res.status(400).json({ error: "jobs (string[]) required" });
  }

  const checkerUrl = process.env.CLOUD_LANGUAGE_CHECK_URL;
  if (!checkerUrl) {
    return res.status(200).json({ error: "CLOUD_LANGUAGE_CHECK_URL is not configured", results: [] });
  }

  try {
    const upstream = await (hooks.fetch ?? fetch)(checkerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobs }),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await upstream.text();
    let payload = {};
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }

    if (!upstream.ok) {
      return res.status(200).json({
        error: "Upstream failed",
        upstream_status: upstream.status,
        details: payload,
        results: [],
      });
    }
    return res.status(200).json(payload);
  } catch (e) {
    return res.status(200).json({ error: e?.message || String(e), results: [] });
  }
});
