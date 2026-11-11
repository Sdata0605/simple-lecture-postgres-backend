import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { q } from "./helpers.js";

// The AI teacher's note search calls these two functions. The app swallows errors from them (rowsOr), so if they are
// missing the chat silently answers from general knowledge instead of the course notes. This guards that.
describe("ai-teacher: note search functions exist", () => {
  for (const fn of ["search_topic_cards", "search_knowledge_chunks"]) {
    it(`public.${fn} exists`, async () => {
      const rows = await q("SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1", [fn]);
      assert.equal(rows.length, 1, `public.${fn} is missing; apply supabase/migrations/20261010120000_ai_teacher.sql`);
    });
  }
});
