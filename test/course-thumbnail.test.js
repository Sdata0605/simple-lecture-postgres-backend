import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clampWidth, isAllowedSource } from "../functions/course-thumbnail/index.js";

describe("course-thumbnail: source and size checks", () => {
  it("accepts only the course-thumbnails path of the storage base", () => {
    assert.equal(isAllowedSource("https://supabase-proxy.utuberpraveen.workers.dev/storage/v1/object/public/course-thumbnails/a/b.png"), true);
    assert.equal(isAllowedSource("https://evil.example.com/storage/v1/object/public/course-thumbnails/a.png"), false);
    assert.equal(isAllowedSource("https://supabase-proxy.utuberpraveen.workers.dev/storage/v1/object/public/course-thumbnails/../secret.png"), false);
    assert.equal(isAllowedSource("http://127.0.0.1:8787/admin/api/logs"), false);
    assert.equal(isAllowedSource(""), false);
  });

  it("clamps the width to 120..1200 and defaults to 480", () => {
    assert.equal(clampWidth(undefined), 480);
    assert.equal(clampWidth("abc"), 480);
    assert.equal(clampWidth("10"), 120);
    assert.equal(clampWidth("5000"), 1200);
    assert.equal(clampWidth("640"), 640);
  });
});
