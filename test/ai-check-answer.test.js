import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { q } from "./helpers.js";
import { router } from "../functions/ai-check-answer/index.js";
import { mountRouter, closeDb } from "./_group00-harness.js";

let app;
const ask = (body) => app.post("/", body);
let savedConfig;
let hadConfig;

describe("ai-check-answer", () => {
  before(async () => {
    app = await mountRouter("/", router);
    // No external AI may be called from tests: no gateway key, and AI config disabled.
    delete process.env.LOVABLE_API_KEY;
    const rows = await q("SELECT setting_value FROM public.ai_settings WHERE setting_key = 'ai_api_config'");
    hadConfig = rows.length > 0;
    savedConfig = hadConfig ? rows[0].setting_value : null;
    if (hadConfig) {
      await q("UPDATE public.ai_settings SET setting_value = '{\"enabled\": false}' WHERE setting_key = 'ai_api_config'");
    } else {
      await q("INSERT INTO public.ai_settings (setting_key, setting_value) VALUES ('ai_api_config', '{\"enabled\": false}')");
    }
  });
  after(async () => {
    if (hadConfig) {
      await q("UPDATE public.ai_settings SET setting_value = $1 WHERE setting_key = 'ai_api_config'", [savedConfig]);
    } else {
      await q("DELETE FROM public.ai_settings WHERE setting_key = 'ai_api_config'");
    }
    await app.close();
    await closeDb();
  });

  it("returns a fixed reply for an empty answer", async () => {
    const r = await ask({ question_text: "Q", correct_answer: "x", student_answer: "   " });
    assert.equal(r.status, 200);
    assert.equal(r.body.feedback, "No answer provided.");
    assert.equal(r.body.marks_awarded, 0);
  });

  it("skips grading for an image-extraction placeholder", async () => {
    const r = await ask({ question_text: "Q", correct_answer: "x", student_answer: "[Image answer uploaded: a.png]" });
    assert.equal(r.status, 200);
    assert.match(r.body.feedback, /Image could not be read/);
  });

  it("reports missing correct answer", async () => {
    const r = await ask({ question_text: "Q", correct_answer: "", student_answer: "abc" });
    assert.equal(r.body.feedback, "Unable to evaluate - no correct answer available.");
  });

  it("exact match (case and trim insensitive) awards full marks", async () => {
    const r = await ask({ question_text: "Q", correct_answer: "Water", student_answer: "  water ", max_marks: 3 });
    assert.deepEqual(r.body, { is_correct: true, marks_awarded: 3, similarity_score: 100, feedback: "Correct answer!" });
  });

  it("MCQ letter comparison", async () => {
    const ok = await ask({ question_type: "mcq", question_text: "Q", correct_answer: "B", student_answer: "(b)", max_marks: 2 });
    assert.equal(ok.body.is_correct, true);
    assert.equal(ok.body.marks_awarded, 2);
    const bad = await ask({ question_type: "mcq", question_text: "Q", correct_answer: "B", student_answer: "A", max_marks: 2 });
    assert.equal(bad.body.is_correct, false);
    assert.equal(bad.body.feedback, "Incorrect. The correct answer is B.");
  });

  it("numerical comparison within tolerance", async () => {
    const r = await ask({ question_type: "numerical", question_text: "Q", correct_answer: "2.5", student_answer: "2.5000", max_marks: 1 });
    assert.equal(r.body.is_correct, true);
    const bad = await ask({ question_type: "integer", question_text: "Q", correct_answer: "4", student_answer: "5", max_marks: 1 });
    assert.equal(bad.body.is_correct, false);
  });

  it("with no AI configured, falls back to word-overlap similarity", async () => {
    const partial = await ask({
      question_type: "short",
      question_text: "Q",
      correct_answer: "photosynthesis converts sunlight carbon dioxide water",
      student_answer: "plants use sunlight",
      max_marks: 5,
    });
    assert.equal(partial.status, 200);
    assert.equal(typeof partial.body.similarity_score, "number");
    assert.match(partial.body.feedback, /AI grading unavailable|keyword matching/);
  });
});
