// Port of supabase/functions/split-document-to-docx. Commit step for a split: each confirmed section
// becomes a .docx (text plus embedded images), stored under uploaded-question-documents, and a child
// ai_assistant_documents row is created under the parent. Topics are created for the chapter when the
// parent has no topic. POST { documentId, sections: [{ title, content_markdown, include? }] }.
// Callers: an admin JWT (role admin) or the service key. The original relied on the gateway JWT only.
import express from "express";
import crypto from "node:crypto";
import { query } from "../_shared/db.js";
import { upload, createSignedUrl } from "../_shared/storage.js";
import { buildDocx } from "../_shared/split-document-to-docx-helper.js";
import { isServiceCall, jwtUserId, userHasRole } from "../_shared/send-verification-notification-helper.js";

export const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUCKET = "uploaded-question-documents";
const ONE_YEAR_SEC = 60 * 60 * 24 * 365;
const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function slugify(s) {
  return (
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "section"
  );
}

// Downloads an image for embedding. Returns { data, type } or null.
async function fetchImage(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    let type = "png";
    if (ct.includes("jpeg") || ct.includes("jpg") || /\.jpe?g$/i.test(url)) type = "jpg";
    else if (ct.includes("gif") || /\.gif$/i.test(url)) type = "gif";
    else if (ct.includes("bmp") || /\.bmp$/i.test(url)) type = "bmp";
    return { data: buf, type };
  } catch {
    return null;
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

    const { documentId, sections } = req.body || {};
    if (!documentId || !Array.isArray(sections) || sections.length === 0) {
      return res.status(400).json({ error: "documentId and sections required" });
    }

    const { rows: parentRows } = UUID_RE.test(String(documentId))
      ? await query(
          "SELECT id, subject_id, chapter_id, topic_id, display_name FROM public.ai_assistant_documents WHERE id = $1 LIMIT 1",
          [documentId]
        )
      : { rows: [] };
    const parent = parentRows[0];
    if (!parent) return res.status(404).json({ error: "Parent document not found" });

    const included = sections.filter((s) => s.include !== false);
    const created = [];

    // Next topic sequence number for the chapter
    let nextSeq = 1;
    if (parent.chapter_id) {
      const { rows: tops } = await query(
        "SELECT sequence_order FROM public.subject_topics WHERE chapter_id = $1 ORDER BY sequence_order DESC LIMIT 1",
        [parent.chapter_id]
      );
      if (tops.length > 0) nextSeq = Number(tops[0].sequence_order || 0) + 1;
    }

    for (const sec of included) {
      const safeTitle = (typeof sec.title === "string" && sec.title.trim()) || "Untitled section";
      const docx = await buildDocx(safeTitle, sec.content_markdown || "", fetchImage);
      const fileBase = `${slugify(safeTitle)}-${crypto.randomUUID().slice(0, 8)}`;
      const objectPath = `reels/${parent.chapter_id || parent.subject_id}/${fileBase}.docx`;

      try {
        await upload(BUCKET, objectPath, docx);
      } catch (upErr) {
        console.error("upload failed:", upErr?.message);
        continue;
      }

      let sourceUrl = "";
      try {
        sourceUrl = createSignedUrl(BUCKET, objectPath, ONE_YEAR_SEC);
      } catch {
        sourceUrl = "";
      }

      // A topic for this section under the parent chapter (best effort, as the original)
      let topicId = parent.topic_id || null;
      if (parent.chapter_id && !parent.topic_id) {
        try {
          const { rows: topicRows } = await query(
            `INSERT INTO public.subject_topics (chapter_id, title, topic_number, sequence_order)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [parent.chapter_id, safeTitle, String(nextSeq), nextSeq]
          );
          if (topicRows[0]?.id) topicId = topicRows[0].id;
        } catch (e) {
          console.error("topic insert failed:", e?.message);
        }
        nextSeq += 1;
      }

      try {
        const { rows: childRows } = await query(
          `INSERT INTO public.ai_assistant_documents
             (subject_id, chapter_id, topic_id, display_name, source_type, source_url, file_name,
              content_preview, full_content, parent_document_id, split_status, status)
           VALUES ($1, $2, $3, $4, 'docx', $5, $6, $7, $8::jsonb, $9, 'child', 'ready')
           RETURNING id`,
          [
            parent.subject_id,
            parent.chapter_id,
            topicId,
            safeTitle,
            sourceUrl,
            `${fileBase}.docx`,
            (sec.content_markdown || "").slice(0, 500),
            JSON.stringify({ markdown: sec.content_markdown || "" }),
            parent.id,
          ]
        );
        if (childRows[0]?.id) created.push({ id: childRows[0].id, title: safeTitle, source_url: sourceUrl });
      } catch (cErr) {
        console.error("insert child failed:", cErr?.message);
      }
    }

    await query("UPDATE public.ai_assistant_documents SET split_status = 'parent_split' WHERE id = $1", [parent.id]).catch(
      (e) => console.error("parent update failed:", e?.message)
    );

    return res.json({ created });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

export default router;
