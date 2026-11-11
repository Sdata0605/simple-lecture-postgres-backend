import "./helpers.js"; // loads .env and guards the test database
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { pool } from "../functions/_shared/db.js";
import { router, matchPath, rewriteShell, setShellForTests } from "../functions/seo-head/index.js";

const SHELL = `<!doctype html><html><head><title>Old</title><meta name="description" content="x" /><link rel="canonical" href="https://old/" /></head><body><div id="root"></div></body></html>`;

let server;
let base;

describe("seo-head", () => {
  before(async () => {
    setShellForTests(SHELL); // no network: the shell is supplied directly
    const app = express();
    app.use("/functions/v1/seo-head", router);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    setShellForTests(null);
    await new Promise((r) => server.close(r));
    await pool.end();
  });

  it("recognises course, subject and blog paths", () => {
    assert.deepEqual(matchPath("/course/jee-main/"), { kind: "course", slug: "jee-main", path: "/course/jee-main" });
    assert.deepEqual(matchPath("/programs/neet?x=1"), { kind: "course", slug: "neet", path: "/programs/neet" });
    assert.equal(matchPath("/learn/physics").kind, "subject");
    assert.equal(matchPath("/blog/post-1").kind, "blog");
    assert.equal(matchPath("/programs/a/b"), null);
    assert.equal(matchPath("/about"), null);
  });

  it("rewrites title, description, canonical and OG tags", () => {
    const html = rewriteShell(SHELL, {
      title: "Physics Course",
      description: "Learn <physics>",
      canonical: "https://simplelecture.com/course/physics",
      ogImage: "https://simplelecture.com/og.png",
      ogType: "website",
      h1: "Physics",
      lead: "Lead",
      jsonLd: [{ "@type": "Course", name: "Physics" }],
    });
    assert.match(html, /<title>Physics Course \| SimpleLecture<\/title>/);
    assert.ok(html.includes('<meta name="description" content="Learn &lt;physics>" />'));
    assert.match(html, /<link rel="canonical" href="https:\/\/simplelecture\.com\/course\/physics" \/>/);
    assert.match(html, /<meta property="og:image" content="https:\/\/simplelecture\.com\/og\.png" \/>/);
    assert.match(html, /<script type="application\/ld\+json">\{"@type":"Course","name":"Physics"\}<\/script>/);
    assert.match(html, /data-seo-fallback="1"/);
  });

  it("serves the plain shell with 200 for an unknown slug, without touching the database", async () => {
    const r = await fetch(`${base}/functions/v1/seo-head?path=/course/no-such-course-t5-xyz`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-seo-head"), "course:no-such-course-t5-xyz");
    assert.match(await r.text(), /<title>Old<\/title>/);
  });

  it("serves the shell for paths it does not know", async () => {
    const r = await fetch(`${base}/functions/v1/seo-head?path=/about`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-seo-head"), "shell");
  });
});
