import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSelect } from "../functions/_shared/rest/parse.js";

describe("parseSelect", () => {
  it("accepts embeds written without a space before the parenthesis", () => {
    const items = parseSelect("course_id,courses(id,name,slug)");
    assert.equal(items.length, 2);
    assert.equal(items[1].embed, "courses");
    assert.equal(items[1].children.length, 3);
  });

  it("accepts a space between the embedded table and its column list, like PostgREST", () => {
    const items = parseSelect("display_order,popular_subjects (id, name, slug, thumbnail_url)");
    assert.equal(items[1].embed, "popular_subjects");
    assert.equal(items[1].children.length, 4);
    const aliased = parseSelect("subject:popular_subjects (id, name)");
    assert.equal(aliased[0].embed, "popular_subjects");
    assert.equal(aliased[0].alias, "subject");
  });

  it("still rejects a malformed item", () => {
    assert.throws(() => parseSelect("courses id"), /invalid select item/);
  });
});
