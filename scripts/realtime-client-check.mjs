// End-to-end check with the UI's own supabase-js client: subscribe to student_lecture_notes as a signed-in
// student, insert a note row for that student directly in the test database, and expect the callback to fire.
// Uses the test database only. Prints PASS/FAIL.
import "dotenv/config";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import pg from "pg";

const uiDir = "C:/Users/dell/Desktop/simlecdbtesting/simple-lecture-web--main (6)/simple-lecture-web--main";
const { createClient } = await import(`file:///${uiDir}/node_modules/@supabase/supabase-js/dist/index.mjs`);

if (!/simplelecture_test/.test(process.env.DATABASE_URL || "")) throw new Error("refusing: test database only");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const user = (await pool.query("select id, email from auth.users where email = $1", ["pramod0605@gmail.com"])).rows[0];
const token = jwt.sign({ sub: user.id, email: user.email, role: "authenticated", aud: "authenticated" }, process.env.JWT_SECRET, { expiresIn: 600 });

const supabase = createClient("http://127.0.0.1:8787", "anon-placeholder", {
  global: { headers: { Authorization: `Bearer ${token}` } },
  auth: { persistSession: false, autoRefreshToken: false },
});

await supabase.realtime.setAuth(token);
const jobId = "uiRT-" + crypto.randomBytes(5).toString("hex");
const received = new Promise((resolve) => {
  const channel = supabase
    .channel(`student-lecture-note-${user.id}-${jobId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "student_lecture_notes", filter: `student_id=eq.${user.id}` }, (payload) => {
      if (payload.new?.job_id === jobId) resolve({ ok: true, payload });
    })
    .subscribe((status, err) => {
      console.log("subscribe status:", status, err ? err.message : "");
      if (status === "SUBSCRIBED") {
        pool.query("INSERT INTO public.student_lecture_notes (student_id, job_id, content) VALUES ($1, $2, $3)", [user.id, jobId, "live"]).catch((e) => console.log("insert failed", e.message));
      }
    });
  setTimeout(() => resolve({ ok: false }), 8000);
});

const result = await received;
console.log(result.ok ? "PASS: UI client received the INSERT" : "FAIL: no realtime event within 8s");
await pool.query("DELETE FROM public.student_lecture_notes WHERE job_id = $1", [jobId]);
await supabase.removeAllChannels();
await pool.end();
process.exit(result.ok ? 0 : 1);
