import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findRelation } from "../functions/_shared/rest/catalog.js";

const cat = {
  tables: new Map([
    ["course_subjects", { name: "course_subjects", columns: new Map(), pk: ["id"] }],
    ["popular_subjects", { name: "popular_subjects", columns: new Map(), pk: ["id"] }],
    ["courses", { name: "courses", columns: new Map(), pk: ["id"] }],
  ]),
  fkList: [
    { tbl: "course_subjects", col: "subject_id", con: "course_subjects_subject_id_fkey", ftbl: "popular_subjects", fcol: "id" },
    { tbl: "course_subjects", col: "course_id", con: "course_subjects_course_id_fkey", ftbl: "courses", fcol: "id" },
  ],
};

describe("findRelation", () => {
  it("embeds by table name", () => {
    const rel = findRelation(cat, "course_subjects", "popular_subjects");
    assert.equal(rel.target, "popular_subjects");
    assert.equal(rel.kind, "m2o");
    assert.equal(rel.baseCol, "subject_id");
  });

  it("embeds by the foreign-key column name, as PostgREST allows (alias:subject_id(...))", () => {
    const rel = findRelation(cat, "course_subjects", "subject_id");
    assert.equal(rel.target, "popular_subjects");
    assert.equal(rel.kind, "m2o");
    assert.equal(rel.baseCol, "subject_id");
    assert.equal(rel.targetCol, "id");
  });

  it("still rejects a name that is neither a table nor a foreign-key column", () => {
    assert.throws(() => findRelation(cat, "course_subjects", "display_order"), /could not find a relationship/);
  });
});
