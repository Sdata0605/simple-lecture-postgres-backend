// Port of supabase/functions/vimeo-resolve. Resolves a Vimeo video id to a progressive MP4 link.
// GET ?id=<id> (or ?debug=1), or POST { vimeo_url | url | id }. Public, as the original.
// Needs VIMEO_ACCESS_TOKEN (Vimeo token with the video_files scope).
import express from "express";

export const router = express.Router();

const VIMEO_API = "https://api.vimeo.com";

function jsonRes(res, status, body) {
  return res.status(status).json(body);
}

router.all("/", async (req, res) => {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "method not allowed" });
  }
  try {
    let videoId = typeof req.query.id === "string" ? req.query.id : null;
    if (!videoId && req.method === "POST") {
      const body = req.body || {};
      const v = body.vimeo_url || body.url || body.id;
      if (v) {
        const m = String(v).match(/(\d+)/);
        videoId = m ? m[1] : null;
      }
    }
    if (!videoId) return jsonRes(res, 400, { error: "missing id" });

    const token = process.env.VIMEO_ACCESS_TOKEN;
    if (!token) return jsonRes(res, 500, { error: "VIMEO_ACCESS_TOKEN not set" });

    const upstream = await fetch(`${VIMEO_API}/videos/${encodeURIComponent(videoId)}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.vimeo.*+json;version=3.4",
      },
    });
    if (!upstream.ok) {
      const text = await upstream.text();
      return jsonRes(res, 502, { error: "vimeo api failed", status: upstream.status, body: text });
    }
    const data = await upstream.json();

    // Prefer play.progressive[] (available on Pro+ plans)
    const progressive = data?.play?.progressive || data?.files || [];

    if (req.query.debug === "1") {
      return jsonRes(res, 200, {
        has_play: !!data?.play,
        play_keys: data?.play ? Object.keys(data.play) : [],
        play_progressive_len: data?.play?.progressive?.length ?? null,
        files_len: data?.files?.length ?? null,
        download_len: data?.download?.length ?? null,
        privacy: data?.privacy,
        user_account: data?.user?.account,
        top_keys: Object.keys(data),
      });
    }

    if (!progressive.length) {
      return jsonRes(res, 404, {
        error: "no progressive mp4 available (requires Vimeo Pro/Business+ plan with Video Files scope)",
        hint: "Ensure token has 'video_files' scope and account plan supports progressive downloads",
      });
    }

    const sorted = [...progressive].sort((a, b) => (b.height || 0) - (a.height || 0));
    const best = sorted[0];

    return jsonRes(res, 200, {
      video_id: videoId,
      mp4_url: best.link,
      width: best.width,
      height: best.height,
      rendition: best.rendition,
      qualities: sorted.map((f) => ({ link: f.link, height: f.height, width: f.width, rendition: f.rendition })),
    });
  } catch (e) {
    return jsonRes(res, 500, { error: String(e) });
  }
});

export default router;
