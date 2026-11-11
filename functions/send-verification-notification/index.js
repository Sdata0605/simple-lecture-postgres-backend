// Port of supabase/functions/send-verification-notification. Creates a verification_notifications row
// for every instructor (teacher) assigned to the document's subject. POST
// { documentId, notificationType, customMessage? }.
// Callers: the service key, or a user JWT whose role is admin or teacher.
import express from "express";
import { query } from "../_shared/db.js";
import { isServiceCall, jwtUserId, userHasRole } from "../_shared/send-verification-notification-helper.js";

export const router = express.Router();

function buildMessage(notificationType, fileName, subject, chapter) {
  switch (notificationType) {
    case "verification_needed":
      return `New document "${fileName}" uploaded for ${subject} > ${chapter}. Verification needed.`;
    case "verification_completed":
      return `Document "${fileName}" for ${subject} > ${chapter} has been verified and approved.`;
    case "issues_found":
      return `Issues found in document "${fileName}" for ${subject} > ${chapter}. Please review.`;
    default:
      return `Update on document "${fileName}" for ${subject} > ${chapter}.`;
  }
}

router.post("/", async (req, res) => {
  try {
    const { documentId, notificationType, customMessage } = req.body || {};

    if (!documentId || !notificationType) {
      return res.status(400).json({ error: "documentId and notificationType are required" });
    }

    if (!isServiceCall(req)) {
      const userId = jwtUserId(req);
      if (!userId || !(await userHasRole(userId, ["admin", "teacher"]))) {
        return res.status(401).json({ error: "Unauthorized" });
      }
    }

    const { rows: docRows } = await query(
      `SELECT d.subject_id, d.questions_file_name, d.file_name,
              ps.name AS subject_name, sc.title AS chapter_title
         FROM public.uploaded_question_documents d
         LEFT JOIN public.popular_subjects ps ON ps.id = d.subject_id
         LEFT JOIN public.subject_chapters sc ON sc.id = d.chapter_id
        WHERE d.id = $1`,
      [documentId]
    ).catch(() => ({ rows: [] }));
    const document = docRows[0];
    if (!document) throw new Error("Document not found");

    const { rows: instructors } = document.subject_id
      ? await query(
          `SELECT ins.instructor_id, p.full_name
             FROM public.instructor_subjects ins
             LEFT JOIN public.profiles p ON p.id = ins.instructor_id
            WHERE ins.subject_id = $1`,
          [document.subject_id]
        )
      : { rows: [] };

    if (instructors.length === 0) {
      console.log("No instructors found for subject");
      return res.json({ message: "No instructors assigned to this subject", notificationsSent: 0 });
    }

    const message = customMessage || buildMessage(
      notificationType,
      document.questions_file_name || document.file_name,
      document.subject_name || "Unknown Subject",
      document.chapter_title || "Unknown Chapter"
    );

    await query(
      `INSERT INTO public.verification_notifications (document_id, recipient_id, notification_type, message, is_read)
       SELECT $1, unnest($2::uuid[]), $3, $4, false`,
      [documentId, instructors.map((i) => i.instructor_id), notificationType, message]
    );

    return res.json({
      message: `Notifications sent to ${instructors.length} instructor(s)`,
      notificationsSent: instructors.length,
      recipients: instructors.map((i) => i.full_name || "Unknown"),
    });
  } catch (error) {
    console.error("Error in send-verification-notification:", error?.message);
    return res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

export default router;
