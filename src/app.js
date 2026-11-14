import express from "express";
import cors from "cors";
import { corsOptions } from "./cors.js";
import { fileURLToPath } from "node:url";
import { log } from "../functions/_shared/log.js";
import { query } from "../functions/_shared/db.js";
import { newRequestId, logFromReq, requestContext, releaseHeld } from "../functions/_shared/system-log.js";
import { router as adminApi } from "../functions/admin-logs/index.js";
import { router as clientLogs } from "../functions/client-logs/index.js";
import { router as sendEmailOtp } from "../functions/send-email-otp/index.js";
import { router as verifyEmailOtp } from "../functions/verify-email-otp/index.js";
import { router as sendPhoneOtp } from "../functions/send-phone-otp/index.js";
import { router as verifyPhoneOtp } from "../functions/verify-phone-otp/index.js";
import { router as sendPasswordResetOtp } from "../functions/send-password-reset-otp/index.js";
import { router as verifyPasswordResetOtp } from "../functions/verify-password-reset-otp/index.js";
import { router as resetPasswordWithToken } from "../functions/reset-password-with-token/index.js";
import { router as authToken } from "../functions/auth-token/index.js";
import { router as authSignup } from "../functions/auth-signup/index.js";
import { router as authUser } from "../functions/auth-user/index.js";
import { router as authLogout } from "../functions/auth-logout/index.js";
import { router as restV1 } from "../functions/rest/index.js";
import { router as deleteMyAccount } from "../functions/delete-my-account/index.js";
import { router as aiTeacherKeys } from "../functions/ai-teacher-keys/index.js";
import { router as storageRouter } from "../functions/storage/index.js";
import { router as reminderCallAudio } from "../functions/reminder-call-audio/index.js";
import { router as reminderAudioPrefetch } from "../functions/reminder-audio-prefetch/index.js";
import { router as reminderPrepareNextDay } from "../functions/reminder-prepare-next-day/index.js";
import { router as enrollFreeCourse } from "../functions/enroll-free-course/index.js";
import { router as dynamicSitemap } from "../functions/dynamic-sitemap/index.js";
import { router as r_notes_backfill_presentation } from "../functions/notes-backfill-presentation/index.js";
import { router as r_offline_download_api } from "../functions/offline-download-api/index.js";
import { router as r_parse_pdf_to_json } from "../functions/parse-pdf-to-json/index.js";
import { router as r_pregen_answer } from "../functions/pregen-answer/index.js";
import { router as r_presentation_update_worker } from "../functions/presentation-update-worker/index.js";
import { router as r_process_educational_pdfs } from "../functions/process-educational-pdfs/index.js";
import { router as r_process_llm_extraction } from "../functions/process-llm-extraction/index.js";
import { router as r_public_topic_content } from "../functions/public-topic-content/index.js";
import { router as r_razorpay_webhook } from "../functions/razorpay-webhook/index.js";
import { router as r_reconcile_video_jobs } from "../functions/reconcile-video-jobs/index.js";
import { router as r_record_daily_attendance } from "../functions/record-daily-attendance/index.js";
import { router as r_dashboard } from "../functions/dashboard/index.js";
import { router as r_recover_pending_payments } from "../functions/recover-pending-payments/index.js";
import { router as r_regrade_self_test } from "../functions/regrade-self-test/index.js";
import { router as r_retry_failed_job } from "../functions/retry-failed-job/index.js";
import { router as r_sarvam_tts } from "../functions/sarvam-tts/index.js";
import { router as r_save_presentation_audio } from "../functions/save-presentation-audio/index.js";
import { router as r_scan_topic_content_coverage } from "../functions/scan-topic-content-coverage/index.js";
import { router as r_search_users_by_email } from "../functions/search-users-by-email/index.js";
import { router as r_send_class_reminders } from "../functions/send-class-reminders/index.js";
import { router as r_send_daily_motivation_email } from "../functions/send-daily-motivation-email/index.js";
import { router as r_send_purchase_reminder_email } from "../functions/send-purchase-reminder-email/index.js";
import { router as r_extract_json_to_questions } from "../functions/extract-json-to-questions/index.js";
import { router as r_extract_pyq_questions } from "../functions/extract-pyq-questions/index.js";
import { router as r_extract_questions_from_document } from "../functions/extract-questions-from-document/index.js";
import { router as r_extract_questions_preview } from "../functions/extract-questions-preview/index.js";
import { router as r_forum_ai_reply } from "../functions/forum-ai-reply/index.js";
import { router as r_gap_patcher_proxy } from "../functions/gap-patcher-proxy/index.js";
import { router as r_generate_blog_post } from "../functions/generate-blog-post/index.js";
import { router as r_generate_seed_images } from "../functions/generate-seed-images/index.js";
import { router as r_generate_story_video } from "../functions/generate-story-video/index.js";
import { router as r_generate_topic_notes_questions } from "../functions/generate-topic-notes-questions/index.js";
import { router as r_google_tts } from "../functions/google-tts/index.js";
import { router as r_homepage_data } from "../functions/homepage-data/index.js";
import { router as r_indic_parler_tts } from "../functions/indic-parler-tts/index.js";
import { router as r_kannada_queue_worker } from "../functions/kannada-queue-worker/index.js";
import { router as r_kie_ai_common } from "../functions/kie-ai-common/index.js";
import { router as r_language_generation_worker } from "../functions/language-generation-worker/index.js";
import { router as r_llm_verify_questions } from "../functions/llm-verify-questions/index.js";
import { router as r_llm_verify_single_question } from "../functions/llm-verify-single-question/index.js";
import { router as r_marketing_video_proxy } from "../functions/marketing-video-proxy/index.js";
import { router as r_migrate_category_icons } from "../functions/migrate-category-icons/index.js";
import { router as r_migrate_course_thumbnails } from "../functions/migrate-course-thumbnails/index.js";
import { router as r_notes_auto_pipeline } from "../functions/notes-auto-pipeline/index.js";
import { router as r_cdn_presentation_refresh_start } from "../functions/cdn-presentation-refresh-start/index.js";
import { router as r_cdn_presentation_refresh_worker } from "../functions/cdn-presentation-refresh-worker/index.js";
import { router as r_check_chapter_completion } from "../functions/check-chapter-completion/index.js";
import { router as r_check_replit_job_status } from "../functions/check-replit-job-status/index.js";
import { router as r_cloud_language_check } from "../functions/cloud-language-check/index.js";
import { router as r_counselor_avatar_proxy } from "../functions/counselor-avatar-proxy/index.js";
import { router as r_coverage_analyzer_proxy } from "../functions/coverage-analyzer-proxy/index.js";
import { router as r_create_instructor } from "../functions/create-instructor/index.js";
import { router as r_create_payment_order } from "../functions/create-payment-order/index.js";
import { router as r_create_self_test } from "../functions/create-self-test/index.js";
import { router as r_create_single_account } from "../functions/create-single-account/index.js";
import { router as r_create_test_accounts } from "../functions/create-test-accounts/index.js";
import { router as r_create_test_admin } from "../functions/create-test-admin/index.js";
import { router as r_create_topup_order } from "../functions/create-topup-order/index.js";
import { router as r_deduplicate_questions } from "../functions/deduplicate-questions/index.js";
import { router as r_dubbing_batch_tick } from "../functions/dubbing-batch-tick/index.js";
import { router as r_export_verification_report } from "../functions/export-verification-report/index.js";
import { router as r_extract_answer_from_image } from "../functions/extract-answer-from-image/index.js";
import { router as r_extract_dpp_answers } from "../functions/extract-dpp-answers/index.js";
import { router as r_extract_dpp_page } from "../functions/extract-dpp-page/index.js";
import { router as r_extract_dpp_questions } from "../functions/extract-dpp-questions/index.js";
import { router as r_admin_backfill_subject } from "../functions/admin-backfill-subject/index.js";
import { router as r_admin_delete_user } from "../functions/admin-delete-user/index.js";
import { router as r_admin_refresh_job_presentation } from "../functions/admin-refresh-job-presentation/index.js";
import { router as r_ai_check_answer } from "../functions/ai-check-answer/index.js";
import { router as r_ai_compare_math_answers } from "../functions/ai-compare-math-answers/index.js";
import { router as r_ai_doubt_clear } from "../functions/ai-doubt-clear/index.js";
import { router as r_ai_doubts_chat } from "../functions/ai-doubts-chat/index.js";
import { router as r_ai_generate_assignment } from "../functions/ai-generate-assignment/index.js";
import { router as r_ai_generate_course_content } from "../functions/ai-generate-course-content/index.js";
import { router as r_ai_generate_curriculum } from "../functions/ai-generate-curriculum/index.js";
import { router as r_ai_generate_dpp } from "../functions/ai-generate-dpp/index.js";
import { router as r_ai_generate_faqs } from "../functions/ai-generate-faqs/index.js";
import { router as r_ai_generate_image } from "../functions/ai-generate-image/index.js";
import { router as r_ai_generate_mcqs } from "../functions/ai-generate-mcqs/index.js";
import { router as r_ai_generate_podcast } from "../functions/ai-generate-podcast/index.js";
import { router as r_ai_generate_solution } from "../functions/ai-generate-solution/index.js";
import { router as r_ai_generate_topic_content } from "../functions/ai-generate-topic-content/index.js";
import { router as r_ai_generate_video } from "../functions/ai-generate-video/index.js";
import { router as r_ai_grade_assignment } from "../functions/ai-grade-assignment/index.js";
import { router as r_course_thumbnail } from "../functions/course-thumbnail/index.js";
import { router as r_ai_rephrase } from "../functions/ai-rephrase/index.js";
import { router as r_ai_sales_assistant } from "../functions/ai-sales-assistant/index.js";
import { router as r_ai_suggest_chapter_topic } from "../functions/ai-suggest-chapter-topic/index.js";
import { router as r_ai_support_assistant } from "../functions/ai-support-assistant/index.js";
import { router as r_ai_teacher } from "../functions/ai-teacher/index.js";
import { router as r_send_test_reminders } from "../functions/send-test-reminders/index.js";
import { router as r_send_timetable_reminders } from "../functions/send-timetable-reminders/index.js";
import { router as r_send_verification_notification } from "../functions/send-verification-notification/index.js";
import { router as r_send_welcome_email } from "../functions/send-welcome-email/index.js";
import { router as r_seo_head } from "../functions/seo-head/index.js";
import { router as r_split_document_by_subtopic } from "../functions/split-document-by-subtopic/index.js";
import { router as r_split_document_to_docx } from "../functions/split-document-to-docx/index.js";
import { router as r_streaming_api } from "../functions/streaming-api/index.js";
import { router as r_study_timetable_ai } from "../functions/study-timetable-ai/index.js";
import { router as r_sync_pregen_cache } from "../functions/sync-pregen-cache/index.js";
import { router as r_test_ai_connection } from "../functions/test-ai-connection/index.js";
import { router as r_transfer_recording } from "../functions/transfer-recording/index.js";
import { router as r_translate_text } from "../functions/translate-text/index.js";
import { router as r_update_instructor_password } from "../functions/update-instructor-password/index.js";
import { router as r_v3_player_proxy } from "../functions/v3-player-proxy/index.js";
import { router as r_v4_player_proxy } from "../functions/v4-player-proxy/index.js";
import { router as r_validate_promo_code } from "../functions/validate-promo-code/index.js";
import { router as r_verify_payment } from "../functions/verify-payment/index.js";
import { router as r_verify_topup_payment } from "../functions/verify-topup-payment/index.js";
import { router as r_video_generation_proxy } from "../functions/video-generation-proxy/index.js";
import { router as r_vimeo_resolve } from "../functions/vimeo-resolve/index.js";
import { router as r_voice_to_text } from "../functions/voice-to-text/index.js";
import { router as r_whatsapp_daily_nudge } from "../functions/whatsapp-daily-nudge/index.js";
import { router as r_whatsapp_doubt_webhook } from "../functions/whatsapp-doubt-webhook/index.js";
import { router as r_ai_teacher_index } from "../functions/ai-teacher-index/index.js";
import { router as r_ai_teaching_assistant } from "../functions/ai-teaching-assistant/index.js";
import { router as r_ai_teaching_proxy } from "../functions/ai-teaching-proxy/index.js";
import { router as r_ai_text_answer_proxy } from "../functions/ai-text-answer-proxy/index.js";
import { router as r_ai_tutor_chat } from "../functions/ai-tutor-chat/index.js";
import { router as r_allocate_topic_pyqs } from "../functions/allocate-topic-pyqs/index.js";
import { router as r_analyze_document_structure } from "../functions/analyze-document-structure/index.js";
import { router as r_api } from "../functions/api/index.js";
import { router as r_approve_and_transfer_questions } from "../functions/approve-and-transfer-questions/index.js";
import { router as r_athena_proxy } from "../functions/athena-proxy/index.js";
import { router as r_auto_pipeline_scanner } from "../functions/auto-pipeline-scanner/index.js";
import { router as r_auto_pipeline_worker } from "../functions/auto-pipeline-worker/index.js";
import { router as r_auto_publish_story_reels } from "../functions/auto-publish-story-reels/index.js";
import { router as r_auto_submission_tick } from "../functions/auto-submission-tick/index.js";
import { router as r_award_badge } from "../functions/award-badge/index.js";
import { router as r_b2_delete_file } from "../functions/b2-delete-file/index.js";
import { router as r_b2_get_download_url } from "../functions/b2-get-download-url/index.js";
import { router as r_b2_large_upload } from "../functions/b2-large-upload/index.js";
import { router as r_b2_list_files } from "../functions/b2-list-files/index.js";
import { router as r_b2_proxy_file } from "../functions/b2-proxy-file/index.js";
import { router as r_b2_upload } from "../functions/b2-upload/index.js";
import { router as r_backfill_question_images } from "../functions/backfill-question-images/index.js";
import { router as r_bbb_api } from "../functions/bbb-api/index.js";
import { router as r_bbb_webhooks } from "../functions/bbb-webhooks/index.js";
import { router as r_bharat_tts } from "../functions/bharat-tts/index.js";
import { router as r_bulk_auto_assign_chapters } from "../functions/bulk-auto-assign-chapters/index.js";

const ADMIN_UI_DIR = fileURLToPath(new URL("../admin-ui", import.meta.url));

// Builds the Express app without listening, so tests can import it.
export function createApp() {
  const app = express();
  app.use(cors(corsOptions()));
  // Request ID and one stdout line plus one system_logs row per request (method, path without query, status, ms).
  app.use((req, res, next) => {
    const started = Date.now();
    req.requestId = newRequestId();
    res.setHeader("X-Request-Id", req.requestId);
    res.on("finish", () => {
      const b = req.body && typeof req.body === "object" ? req.body : {};
      const path = req.originalUrl.split("?")[0];
      const ms = Date.now() - started;
      log.info("http", {
        method: req.method,
        path,
        status: res.statusCode,
        ms,
        request_id: req.requestId,
        email: b.email ?? b.signup_data?.email,
        phone: b.phone ?? b.signup_data?.phone,
      });
      if (path.startsWith("/admin/")) return; // admin reads are not logged, to keep the log useful
      logFromReq(req, {
        category: "http",
        event: "request",
        outcome: res.statusCode >= 400 ? "failed" : "success",
        statusCode: res.statusCode,
        message: `${req.method} ${path} ${res.statusCode}`,
        durationMs: ms,
        details: { method: req.method, path },
      });
    });
    // Everything the request does (including async step logs) sees this request ID.
    // Event rows from this request are held until the response ends, then get its status code.
    const store = { requestId: req.requestId, held: [] };
    let released = false;
    const release = (statusCode) => {
      if (released) return;
      released = true;
      releaseHeld(store, statusCode);
    };
    res.on("finish", () => release(res.statusCode));
    res.on("close", () => release(null));
    requestContext.run(store, () => next());
  });
  // Razorpay signs the raw body, so this route must run before the JSON parser.
  app.use("/functions/v1/razorpay-webhook", r_razorpay_webhook);
  app.use(express.json({ limit: "1mb" }));
  // Malformed or oversized JSON gets a plain JSON error, never an HTML page with a stack trace.
  app.use((err, req, res, next) => {
    if (err && (err.type === "entity.parse.failed" || err.type === "entity.too.large")) {
      const status = err.type === "entity.too.large" ? 413 : 400;
      return res.status(status).json({ error: err.type === "entity.too.large" ? "payload_too_large" : "invalid_json" });
    }
    return next(err);
  });

  app.get("/health", async (_req, res) => {
    try {
      const { rows } = await query("SELECT current_database() AS db");
      res.json({ ok: true, db: rows[0].db });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Function paths match the Supabase function names the UI already calls.
  app.use("/functions/v1/send-email-otp", sendEmailOtp);
  app.use("/functions/v1/verify-email-otp", verifyEmailOtp);
  app.use("/functions/v1/send-phone-otp", sendPhoneOtp);
  app.use("/functions/v1/verify-phone-otp", verifyPhoneOtp);
  app.use("/functions/v1/send-password-reset-otp", sendPasswordResetOtp);
  app.use("/functions/v1/verify-password-reset-otp", verifyPasswordResetOtp);
  app.use("/functions/v1/reset-password-with-token", resetPasswordWithToken);

  app.use("/functions/v1/delete-my-account", deleteMyAccount);
  app.use("/functions/v1/ai-teacher-keys", aiTeacherKeys);

  app.use("/storage/v1", storageRouter);
  app.use("/functions/v1/reminder-call-audio", reminderCallAudio);
  app.use("/functions/v1/reminder-audio-prefetch", reminderAudioPrefetch);
  app.use("/functions/v1/reminder-prepare-next-day", reminderPrepareNextDay);
  app.use("/functions/v1/enroll-free-course", enrollFreeCourse);
  app.use("/functions/v1/dynamic-sitemap", dynamicSitemap);
  app.use("/functions/v1/notes-backfill-presentation", r_notes_backfill_presentation);
  app.use("/functions/v1/offline-download-api", r_offline_download_api);
  app.use("/functions/v1/parse-pdf-to-json", r_parse_pdf_to_json);
  app.use("/functions/v1/pregen-answer", r_pregen_answer);
  app.use("/functions/v1/presentation-update-worker", r_presentation_update_worker);
  app.use("/functions/v1/process-educational-pdfs", r_process_educational_pdfs);
  app.use("/functions/v1/process-llm-extraction", r_process_llm_extraction);
  app.use("/functions/v1/public-topic-content", r_public_topic_content);
  app.use("/functions/v1/reconcile-video-jobs", r_reconcile_video_jobs);
  app.use("/functions/v1/record-daily-attendance", r_record_daily_attendance);
  app.use("/functions/v1/dashboard", r_dashboard);
  app.use("/functions/v1/recover-pending-payments", r_recover_pending_payments);
  app.use("/functions/v1/regrade-self-test", r_regrade_self_test);
  app.use("/functions/v1/retry-failed-job", r_retry_failed_job);
  app.use("/functions/v1/sarvam-tts", r_sarvam_tts);
  app.use("/functions/v1/save-presentation-audio", r_save_presentation_audio);
  app.use("/functions/v1/scan-topic-content-coverage", r_scan_topic_content_coverage);
  app.use("/functions/v1/search-users-by-email", r_search_users_by_email);
  app.use("/functions/v1/send-class-reminders", r_send_class_reminders);
  app.use("/functions/v1/send-daily-motivation-email", r_send_daily_motivation_email);
  app.use("/functions/v1/send-purchase-reminder-email", r_send_purchase_reminder_email);
  app.use("/functions/v1/extract-json-to-questions", r_extract_json_to_questions);
  app.use("/functions/v1/extract-pyq-questions", r_extract_pyq_questions);
  app.use("/functions/v1/extract-questions-from-document", r_extract_questions_from_document);
  app.use("/functions/v1/extract-questions-preview", r_extract_questions_preview);
  app.use("/functions/v1/forum-ai-reply", r_forum_ai_reply);
  app.use("/functions/v1/gap-patcher-proxy", r_gap_patcher_proxy);
  app.use("/functions/v1/generate-blog-post", r_generate_blog_post);
  app.use("/functions/v1/generate-seed-images", r_generate_seed_images);
  app.use("/functions/v1/generate-story-video", r_generate_story_video);
  app.use("/functions/v1/generate-topic-notes-questions", r_generate_topic_notes_questions);
  app.use("/functions/v1/google-tts", r_google_tts);
  app.use("/functions/v1/homepage-data", r_homepage_data);
  app.use("/functions/v1/indic-parler-tts", r_indic_parler_tts);
  app.use("/functions/v1/kannada-queue-worker", r_kannada_queue_worker);
  app.use("/functions/v1/kie-ai-common", r_kie_ai_common);
  app.use("/functions/v1/language-generation-worker", r_language_generation_worker);
  app.use("/functions/v1/llm-verify-questions", r_llm_verify_questions);
  app.use("/functions/v1/llm-verify-single-question", r_llm_verify_single_question);
  app.use("/functions/v1/marketing-video-proxy", r_marketing_video_proxy);
  app.use("/functions/v1/migrate-category-icons", r_migrate_category_icons);
  app.use("/functions/v1/migrate-course-thumbnails", r_migrate_course_thumbnails);
  app.use("/functions/v1/notes-auto-pipeline", r_notes_auto_pipeline);
  app.use("/functions/v1/cdn-presentation-refresh-start", r_cdn_presentation_refresh_start);
  app.use("/functions/v1/cdn-presentation-refresh-worker", r_cdn_presentation_refresh_worker);
  app.use("/functions/v1/check-chapter-completion", r_check_chapter_completion);
  app.use("/functions/v1/check-replit-job-status", r_check_replit_job_status);
  app.use("/functions/v1/cloud-language-check", r_cloud_language_check);
  app.use("/functions/v1/counselor-avatar-proxy", r_counselor_avatar_proxy);
  app.use("/functions/v1/coverage-analyzer-proxy", r_coverage_analyzer_proxy);
  app.use("/functions/v1/create-instructor", r_create_instructor);
  app.use("/functions/v1/create-payment-order", r_create_payment_order);
  app.use("/functions/v1/create-self-test", r_create_self_test);
  app.use("/functions/v1/create-single-account", r_create_single_account);
  app.use("/functions/v1/create-test-accounts", r_create_test_accounts);
  app.use("/functions/v1/create-test-admin", r_create_test_admin);
  app.use("/functions/v1/create-topup-order", r_create_topup_order);
  app.use("/functions/v1/deduplicate-questions", r_deduplicate_questions);
  app.use("/functions/v1/dubbing-batch-tick", r_dubbing_batch_tick);
  app.use("/functions/v1/export-verification-report", r_export_verification_report);
  app.use("/functions/v1/extract-answer-from-image", r_extract_answer_from_image);
  app.use("/functions/v1/extract-dpp-answers", r_extract_dpp_answers);
  app.use("/functions/v1/extract-dpp-page", r_extract_dpp_page);
  app.use("/functions/v1/extract-dpp-questions", r_extract_dpp_questions);
  app.use("/functions/v1/admin-backfill-subject", r_admin_backfill_subject);
  app.use("/functions/v1/admin-delete-user", r_admin_delete_user);
  app.use("/functions/v1/admin-refresh-job-presentation", r_admin_refresh_job_presentation);
  app.use("/functions/v1/ai-check-answer", r_ai_check_answer);
  app.use("/functions/v1/ai-compare-math-answers", r_ai_compare_math_answers);
  app.use("/functions/v1/ai-doubt-clear", r_ai_doubt_clear);
  app.use("/functions/v1/ai-doubts-chat", r_ai_doubts_chat);
  app.use("/functions/v1/ai-generate-assignment", r_ai_generate_assignment);
  app.use("/functions/v1/ai-generate-course-content", r_ai_generate_course_content);
  app.use("/functions/v1/ai-generate-curriculum", r_ai_generate_curriculum);
  app.use("/functions/v1/ai-generate-dpp", r_ai_generate_dpp);
  app.use("/functions/v1/ai-generate-faqs", r_ai_generate_faqs);
  app.use("/functions/v1/ai-generate-image", r_ai_generate_image);
  app.use("/functions/v1/ai-generate-mcqs", r_ai_generate_mcqs);
  app.use("/functions/v1/ai-generate-podcast", r_ai_generate_podcast);
  app.use("/functions/v1/ai-generate-solution", r_ai_generate_solution);
  app.use("/functions/v1/ai-generate-topic-content", r_ai_generate_topic_content);
  app.use("/functions/v1/ai-generate-video", r_ai_generate_video);
  app.use("/functions/v1/ai-grade-assignment", r_ai_grade_assignment);
  app.use("/functions/v1/course-thumbnail", r_course_thumbnail);
  app.use("/functions/v1/ai-rephrase", r_ai_rephrase);
  app.use("/functions/v1/ai-sales-assistant", r_ai_sales_assistant);
  app.use("/functions/v1/ai-suggest-chapter-topic", r_ai_suggest_chapter_topic);
  app.use("/functions/v1/ai-support-assistant", r_ai_support_assistant);
  app.use("/functions/v1/ai-teacher", r_ai_teacher);
  app.use("/functions/v1/send-test-reminders", r_send_test_reminders);
  app.use("/functions/v1/send-timetable-reminders", r_send_timetable_reminders);
  app.use("/functions/v1/send-verification-notification", r_send_verification_notification);
  app.use("/functions/v1/send-welcome-email", r_send_welcome_email);
  app.use("/functions/v1/seo-head", r_seo_head);
  app.use("/functions/v1/split-document-by-subtopic", r_split_document_by_subtopic);
  app.use("/functions/v1/split-document-to-docx", r_split_document_to_docx);
  app.use("/functions/v1/streaming-api", r_streaming_api);
  app.use("/functions/v1/study-timetable-ai", r_study_timetable_ai);
  app.use("/functions/v1/sync-pregen-cache", r_sync_pregen_cache);
  app.use("/functions/v1/test-ai-connection", r_test_ai_connection);
  app.use("/functions/v1/transfer-recording", r_transfer_recording);
  app.use("/functions/v1/translate-text", r_translate_text);
  app.use("/functions/v1/update-instructor-password", r_update_instructor_password);
  app.use("/functions/v1/v3-player-proxy", r_v3_player_proxy);
  app.use("/functions/v1/v4-player-proxy", r_v4_player_proxy);
  app.use("/functions/v1/validate-promo-code", r_validate_promo_code);
  app.use("/functions/v1/verify-payment", r_verify_payment);
  app.use("/functions/v1/verify-topup-payment", r_verify_topup_payment);
  app.use("/functions/v1/video-generation-proxy", r_video_generation_proxy);
  app.use("/functions/v1/vimeo-resolve", r_vimeo_resolve);
  app.use("/functions/v1/voice-to-text", r_voice_to_text);
  app.use("/functions/v1/whatsapp-daily-nudge", r_whatsapp_daily_nudge);
  app.use("/functions/v1/whatsapp-doubt-webhook", r_whatsapp_doubt_webhook);
  app.use("/functions/v1/ai-teacher-index", r_ai_teacher_index);
  app.use("/functions/v1/ai-teaching-assistant", r_ai_teaching_assistant);
  app.use("/functions/v1/ai-teaching-proxy", r_ai_teaching_proxy);
  app.use("/functions/v1/ai-text-answer-proxy", r_ai_text_answer_proxy);
  app.use("/functions/v1/ai-tutor-chat", r_ai_tutor_chat);
  app.use("/functions/v1/allocate-topic-pyqs", r_allocate_topic_pyqs);
  app.use("/functions/v1/analyze-document-structure", r_analyze_document_structure);
  app.use("/api/v1", r_api);
  app.use("/functions/v1/approve-and-transfer-questions", r_approve_and_transfer_questions);
  app.use("/functions/v1/athena-proxy", r_athena_proxy);
  app.use("/functions/v1/auto-pipeline-scanner", r_auto_pipeline_scanner);
  app.use("/functions/v1/auto-pipeline-worker", r_auto_pipeline_worker);
  app.use("/functions/v1/auto-publish-story-reels", r_auto_publish_story_reels);
  app.use("/functions/v1/auto-submission-tick", r_auto_submission_tick);
  app.use("/functions/v1/award-badge", r_award_badge);
  app.use("/functions/v1/b2-delete-file", r_b2_delete_file);
  app.use("/functions/v1/b2-get-download-url", r_b2_get_download_url);
  app.use("/functions/v1/b2-large-upload", r_b2_large_upload);
  app.use("/functions/v1/b2-list-files", r_b2_list_files);
  app.use("/functions/v1/b2-proxy-file", r_b2_proxy_file);
  app.use("/functions/v1/b2-upload", r_b2_upload);
  app.use("/functions/v1/backfill-question-images", r_backfill_question_images);
  app.use("/functions/v1/bbb-api", r_bbb_api);
  app.use("/functions/v1/bbb-webhooks", r_bbb_webhooks);
  app.use("/functions/v1/bharat-tts", r_bharat_tts);
  app.use("/functions/v1/bulk-auto-assign-chapters", r_bulk_auto_assign_chapters);

  // Supabase Auth paths used by supabase-js.
  app.use("/auth/v1/token", authToken);
  app.use("/auth/v1/signup", authSignup);
  app.use("/auth/v1/user", authUser);
  app.use("/auth/v1/logout", authLogout);
  app.use("/rest/v1", restV1);

  // Frontend error reports (rate limited and size limited inside the router).
  app.use("/api/client-logs", clientLogs);
  // Admin log and provider API. Protected by the master key cookie inside the router.
  app.use("/admin/api", adminApi);
  // Admin log UI (static files, hash routing). /admin redirects to /admin/. Mounted after the API
  // so /admin/api always wins.
  app.use("/admin", express.static(ADMIN_UI_DIR, {
    index: "index.html",
    setHeaders(res) {
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Frame-Options", "DENY");
    },
  }));

  app.use((req, res) => res.status(404).json({ error: "not_found", path: req.path }));
  return app;
}
