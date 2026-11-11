// Port of supabase/functions/split-document-by-subtopic. Admin preview: splits an ai_assistant_documents
// row (markdown) into subtopic sections so the admin can review them before committing.
// POST { documentId } with an admin JWT (role admin) or the service key. The original relied on the
// gateway JWT only. Splits by numbered headings (1.1, 2.3.4 ...); falls back to an AI split when the
// heading split finds fewer than two sections and LOVABLE_API_KEY is set.
import express from "express";
import { query } from "../_shared/db.js";
import { isServiceCall, jwtUserId, userHasRole } from "../_shared/send-verification-notification-helper.js";

export const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEADING_RE = /^\s{0,3}(?:#{1,6}\s*)?(\*\*)?\s*(\d+(?:\.\d+)+)\s+([^\n*]+?)(\*\*)?\s*$/;

export function extractImages(md) {
  const urls = [];
  const re = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m;
  while ((m = re.exec(md)) !== null) urls.push(m[1]);
  return urls;
}

// Heading-based split. Each section runs from its numbered heading to the next one.
export function regexSplit(markdown) {
  const lines = markdown.split("\n");
  const sections = [];
  let current = null;
  const flush = () => {
    const body = current.lines.join("\n").trim();
    sections.push({ title: current.title, content_markdown: body, image_urls: extractImages(body) });
  };
  for (const line of lines) {
    const m = line.match(HEADING_RE);
    if (m) {
      if (current) flush();
      current = { title: `${m[2]} ${m[3].trim()}`, lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) flush();
  return sections;
}

async function aiSplit(markdown) {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) return [];
  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "system",
            content:
              'You split chapter markdown into per-subtopic sections. Reply ONLY as JSON: {"sections":[{"title":"...","content_markdown":"..."}]}. Keep original markdown verbatim (headings, lists, images).',
          },
          { role: "user", content: markdown.slice(0, 60000) },
        ],
      }),
    });
    if (!res.ok) return [];
    const json = await res.json();
    const txt = json.choices?.[0]?.message?.content || "";
    const match = txt.match(/\{[\s\S]*\}/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    return (parsed.sections || []).map((s) => ({
      title: String(s.title || "Untitled"),
      content_markdown: String(s.content_markdown || ""),
      image_urls: extractImages(String(s.content_markdown || "")),
    }));
  } catch {
    return [];
  }
}

router.post("/", async (req, res) => {
  try {
    if (!isServiceCall(req)) {
      const userId = jwtUserId(req);
      if (!userId || !(await userHasRole(userId, ["admin"]))) {
        return res.status(401).json({ error: "Unauthorized" });
      }
    }

    const { documentId } = req.body || {};
    if (!documentId) return res.status(400).json({ error: "documentId required" });

    const { rows } = UUID_RE.test(String(documentId))
      ? await query(
          "SELECT id, full_content, content_preview, source_url, file_name FROM public.ai_assistant_documents WHERE id = $1 LIMIT 1",
          [documentId]
        )
      : { rows: [] };
    const doc = rows[0];
    if (!doc) return res.status(404).json({ error: "Document not found" });

    let markdown = "";
    const fc = doc.full_content;
    if (typeof fc === "string") markdown = fc;
    else if (fc?.markdown) markdown = fc.markdown;
    else if (fc?.content) markdown = fc.content;
    else if (fc?.text) markdown = fc.text;
    if (!markdown && doc.content_preview) markdown = doc.content_preview;

    if (!markdown) {
      return res.status(422).json({ error: "No markdown content available for this document" });
    }

    let sections = regexSplit(markdown);
    if (sections.length < 2) {
      const ai = await aiSplit(markdown);
      if (ai.length >= 2) sections = ai;
    }

    return res.json({ sections, source: sections.length >= 2 ? "ok" : "none" });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

export default router;
