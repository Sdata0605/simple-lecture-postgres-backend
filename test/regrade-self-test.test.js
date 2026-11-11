import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { startServer, stopServer, makeUser, q } from "./helpers.js";
import { router } from "../functions/regrade-self-test/index.js";

// ai-check-answer and extract-answer-from-image are replaced by a local stub (PUBLIC_BASE_URL).
let stub;
let fnServer;
let fnBase;
const savedEnv = {};
const testIds = [];
const courseIds = [];
const adminIds = [];
const userIds = [];

async function call(body, headers = {}) {
  const res = await fetch(`${fnBase}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
const bearer = (u) => ({ Authorization: `Bearer ${u.access}` });

// One self test: MCQ worth 2 (answered right), MCQ worth 2 (answered wrong),
// written worth 5 (answered, grader gives 3), written worth 3 (no answer).
async function makeTest(owner) {
  const [ref] = await q("SELECT s.id AS subject_id FROM public.popular_subjects s LIMIT 1");
  const courseId = randomUUID();
  courseIds.push(courseId);
  await q("INSERT INTO public.courses (id, name, slug) VALUES ($1, 'Self test course', $2)", [courseId, `st-${courseId}`]);
  const testId = randomUUID();
  testIds.push(testId);
  await q(
    `INSERT INTO public.self_tests
       (id, student_id, course_id, subject_id, test_type, chapter_ids, topic_ids, title, scheduled_at, duration_minutes,
        total_questions, mcq_count, written_count, status)
     VALUES ($1, $2, $3, $4, 'chapter', '{}', '{}', 'Regrade test', now(), 30, 4, 2, 2, 'submitted')`,
    [testId, owner.id, courseId, ref.subject_id]
  );
  const mk = async (order, section, text, correct, marks) => {
    const id = randomUUID();
    await q(
      `INSERT INTO public.self_test_questions (id, self_test_id, order_number, section, question_text, correct_answer, marks)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, testId, order, section, text, correct, marks]
    );
    return id;
  };
  const mcqRight = await mk(1, "mcq", "2+2", "B", 2);
  const mcqWrong = await mk(2, "mcq", "3+3", "C", 2);
  const writtenGraded = await mk(3, "written", "Explain gravity", "Mass attracts mass", 5);
  const writtenBlank = await mk(4, "written", "Explain light", "Light is EM radiation", 3);
  const ans = async (qid, selected, text) => {
    await q(
      `INSERT INTO public.self_test_answers (self_test_id, self_test_question_id, student_id, selected_option, answer_text)
       VALUES ($1, $2, $3, $4, $5)`,
      [testId, qid, owner.id, selected, text]
    );
  };
  await ans(mcqRight, "B", null);
  await ans(mcqWrong, "A", null);
  await ans(writtenGraded, null, "Gravity is attraction between masses");
  await ans(writtenBlank, null, "   ");
  return testId;
}

describe("regrade-self-test", () => {
  before(async () => {
    await startServer();
    for (const k of ["PUBLIC_BASE_URL"]) savedEnv[k] = process.env[k];

    stub = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        if (req.url === "/functions/v1/ai-check-answer") {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ is_correct: true, marks_awarded: 3, feedback: "Good, but brief." }));
        }
        if (req.url === "/functions/v1/extract-answer-from-image") {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ extracted_text: "from image" }));
        }
        res.writeHead(404);
        res.end(JSON.stringify({ body }));
      });
    });
    stub.listen(0, "127.0.0.1");
    await once(stub, "listening");
    process.env.PUBLIC_BASE_URL = `http://127.0.0.1:${stub.address().port}`;

    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use("/", router);
    fnServer = app.listen(0, "127.0.0.1");
    await once(fnServer, "listening");
    fnBase = `http://127.0.0.1:${fnServer.address().port}`;
  });

  after(async () => {
    try {
      if (testIds.length) {
        await q("DELETE FROM public.self_tests WHERE id = ANY($1)", [testIds]);
      }
      if (adminIds.length) await q("DELETE FROM public.user_roles WHERE user_id = ANY($1) AND role = 'admin'", [adminIds]);
      if (courseIds.length) await q("DELETE FROM public.courses WHERE id = ANY($1)", [courseIds]);
    } finally {
      for (const k of Object.keys(savedEnv)) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
      await new Promise((r) => fnServer.close(r));
      await new Promise((r) => stub.close(r));
      await stopServer();
    }
  });

  it("401 without a token", async () => {
    assert.equal((await call({ self_test_id: randomUUID() })).status, 401);
  });

  it("401 for a forged token", async () => {
    assert.equal((await call({ self_test_id: randomUUID() }, { Authorization: "Bearer not.a.token" })).status, 401);
  });

  it("400 without self_test_id", async () => {
    const u = await makeUser();
    userIds.push(u.id);
    const r = await call({}, bearer(u));
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "self_test_id required");
  });

  it("404 for an unknown test", async () => {
    const u = await makeUser();
    userIds.push(u.id);
    const r = await call({ self_test_id: randomUUID() }, bearer(u));
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "Test not found");
  });

  it("403 for another student's test", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    userIds.push(owner.id, other.id);
    const testId = await makeTest(owner);
    const r = await call({ self_test_id: testId }, bearer(other));
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "Forbidden");
  });

  it("the owner regrades: MCQs locally, written answers via the grader", async () => {
    const owner = await makeUser();
    userIds.push(owner.id);
    const testId = await makeTest(owner);
    const r = await call({ self_test_id: testId }, bearer(owner));
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.equal(r.body.mcq_score, 2);
    assert.equal(r.body.written_score, 3);
    assert.equal(r.body.total_score, 5);
    assert.equal(r.body.total_max_marks, 12);
    assert.equal(r.body.percentage, 41.7);

    const [test] = await q("SELECT mcq_score, written_score, total_score, total_max_marks, percentage FROM public.self_tests WHERE id = $1", [testId]);
    assert.equal(Number(test.total_score), 5);
    assert.equal(Number(test.percentage), 41.7);

    const answers = await q(
      `SELECT a.is_correct, a.marks_awarded, a.ai_feedback FROM public.self_test_answers a
         JOIN public.self_test_questions qq ON qq.id = a.self_test_question_id
        WHERE a.self_test_id = $1 ORDER BY qq.order_number`,
      [testId]
    );
    assert.equal(answers[0].is_correct, true);
    assert.equal(answers[1].is_correct, false);
    assert.equal(answers[2].ai_feedback, "Good, but brief.");
    assert.equal(answers[3].ai_feedback, "No answer provided.");
  });

  it("an admin may regrade someone else's test", async () => {
    const owner = await makeUser();
    const admin = await makeUser();
    userIds.push(owner.id, admin.id);
    adminIds.push(admin.id);
    await q("INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')", [admin.id]);
    const testId = await makeTest(owner);
    const r = await call({ self_test_id: testId }, bearer(admin));
    assert.equal(r.status, 200);
    assert.equal(r.body.total_score, 5);
  });
});
