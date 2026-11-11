import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, base } from "./helpers.js";

// Regression: course_thumbnails.course_id is UNIQUE, so an embed through it must be one object (or null), not a list.
// The Programs page reads course.course_thumbnails.storage_url; as a list, the image never showed.
describe("rest: embedding through a UNIQUE column returns one object", () => {
  before(startServer);
  after(stopServer);

  it("course_thumbnails is an object or null for each course", async () => {
    const r = await fetch(`${base}/rest/v1/courses?select=id,course_thumbnails(storage_url)&limit=20`, {
      headers: { apikey: "anon-placeholder", Authorization: "Bearer anon-placeholder" },
    });
    assert.equal(r.status, 200);
    const rows = await r.json();
    assert.ok(rows.length > 0);
    for (const row of rows) {
      const ct = row.course_thumbnails;
      assert.ok(ct === null || (typeof ct === "object" && !Array.isArray(ct)), `course ${row.id}: ${JSON.stringify(ct)}`);
    }
    const withImage = rows.find((row) => row.course_thumbnails?.storage_url);
    assert.ok(withImage, "at least one course has a storage_url");
  });

  it("one-to-many embeds (course_categories) are still lists", async () => {
    const r = await fetch(`${base}/rest/v1/courses?select=id,course_categories(category_id)&limit=5`, {
      headers: { apikey: "anon-placeholder", Authorization: "Bearer anon-placeholder" },
    });
    const rows = await r.json();
    assert.equal(r.status, 200);
    assert.ok(rows.every((row) => Array.isArray(row.course_categories)));
  });
});
