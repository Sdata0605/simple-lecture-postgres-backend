import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, call } from "./helpers.js";
import { escapeXml, buildSitemap } from "../functions/dynamic-sitemap/index.js";

describe("dynamic-sitemap", () => {
  before(startServer);
  after(stopServer);

  it("serves XML with the static and landing pages", async () => {
    const r = await call("GET", "/functions/v1/dynamic-sitemap");
    assert.equal(r.status, 200);
    assert.match(r.body, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
    assert.match(r.body, /<loc>https:\/\/simplelecture\.com\/programs<\/loc>/);
    assert.match(r.body, /<loc>https:\/\/simplelecture\.com\/learn\/jee-main-online-coaching<\/loc>/);
  });

  it("escapes XML special characters in slugs", () => {
    assert.equal(escapeXml(`a&b<c>"d"'e'`), "a&amp;b&lt;c&gt;&quot;d&quot;&apos;e&apos;");
    const xml = buildSitemap({
      courses: [{ slug: "x&y<z" }],
      subjects: [],
      posts: [],
      goals: [],
    });
    assert.match(xml, /<loc>https:\/\/simplelecture\.com\/course\/x&amp;y&lt;z<\/loc>/);
    assert.doesNotMatch(xml, /x&y<z/);
  });

  it("subjects and goals carry lastmod as a date only; static pages carry none", () => {
    const xml = buildSitemap({
      courses: [],
      subjects: [{ slug: "physics", updated_at: "2026-05-01T10:00:00Z" }],
      posts: [],
      goals: [{ slug: "jee", updated_at: "2026-06-02T00:00:00Z" }],
    });
    assert.match(xml, /<lastmod>2026-05-01<\/lastmod>/);
    assert.match(xml, /<lastmod>2026-06-02<\/lastmod>/);
    const homeBlock = xml.split("</url>").find((b) => b.includes("https://simplelecture.com/<") || b.includes("https://simplelecture.com/</loc>"));
    assert.ok(homeBlock && !homeBlock.includes("<lastmod>"));
  });
});
