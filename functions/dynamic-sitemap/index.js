// Port of supabase/functions/dynamic-sitemap. Public, read-only sitemap of the site's pages.
// GET /functions/v1/dynamic-sitemap -> application/xml. Lists active courses, subjects, blog posts and goals.
import express from "express";
import { query } from "../_shared/db.js";

const BASE_URL = "https://simplelecture.com";

// Public, non-auth-gated routes. Static pages get no lastmod. Auth-gated paths must not be added.
const STATIC_PAGES = [
  { path: "/", changefreq: "daily", priority: "1.0" },
  { path: "/programs", changefreq: "weekly", priority: "0.9" },
  { path: "/forum", changefreq: "daily", priority: "0.7" },
  { path: "/about", changefreq: "monthly", priority: "0.7" },
  { path: "/contact", changefreq: "monthly", priority: "0.6" },
  { path: "/support", changefreq: "monthly", priority: "0.6" },
  { path: "/privacy", changefreq: "monthly", priority: "0.4" },
  { path: "/terms", changefreq: "monthly", priority: "0.4" },
  { path: "/blog", changefreq: "weekly", priority: "0.7" },
  { path: "/how-it-works", changefreq: "monthly", priority: "0.6" },
  { path: "/success-stories", changefreq: "monthly", priority: "0.6" },
];

// Programmatic SEO landing pages (/learn/:slug). Keep in sync with src/lib/seo/landingPages.ts by hand.
const LANDING_SLUGS = [
  "jee-main-online-coaching",
  "neet-2026-online-coaching",
  "class-12-physics-online-classes",
  "class-11-physics-online-classes",
  "physics-online-classes",
  "online-coaching-india",
];

// Escapes the five XML special characters so slugs cannot break the document.
export function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// YYYY-MM-DD, or null when missing so lastmod is omitted.
const dateOnly = (value) => (value ? String(value).split("T")[0] : null);

function url(loc, lastmod, changefreq, priority) {
  const lastmodTag = lastmod ? `\n    <lastmod>${escapeXml(lastmod)}</lastmod>` : "";
  return `  <url>\n    <loc>${escapeXml(loc)}</loc>${lastmodTag}\n    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`;
}

export function buildSitemap({ courses, subjects, posts, goals }) {
  const staticUrls = STATIC_PAGES.map((p) => url(`${BASE_URL}${p.path}`, null, p.changefreq, p.priority)).join("\n");
  const landingUrls = LANDING_SLUGS.map((slug) => url(`${BASE_URL}/learn/${slug}`, null, "weekly", "0.85")).join("\n");
  const courseUrls = courses.filter((c) => c.slug).map((c) => url(`${BASE_URL}/course/${c.slug}`, null, "weekly", "0.8")).join("\n");
  const subjectUrls = subjects
    .filter((s) => s.slug)
    .map((s) => url(`${BASE_URL}/subject/${s.slug}`, dateOnly(s.updated_at), "weekly", "0.75"))
    .join("\n");
  const blogUrls = posts.filter((p) => p.slug).map((p) => url(`${BASE_URL}/blog/${p.slug}`, null, "monthly", "0.6")).join("\n");
  const goalUrls = goals
    .filter((g) => g.slug)
    .map((g) => url(`${BASE_URL}/explore/${g.slug}`, dateOnly(g.updated_at), "weekly", "0.7"))
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${staticUrls}
${landingUrls}
${courseUrls}
${subjectUrls}
${goalUrls}
${blogUrls}
</urlset>`;
}

export const router = express.Router();

router.get("/", async (_req, res) => {
  try {
    // courses: no updated_at (no lastmod). popular_subjects and explore_by_goal: updated_at for lastmod.
    // blog_posts: no updated_at (no lastmod).
    const [courses, subjects, posts, goals] = await Promise.all([
      query("SELECT slug FROM public.courses WHERE is_active = true ORDER BY sequence_order ASC NULLS LAST, id ASC"),
      query("SELECT slug, updated_at FROM public.popular_subjects WHERE is_active = true ORDER BY slug ASC"),
      query("SELECT slug FROM public.blog_posts WHERE status = 'published' ORDER BY slug ASC"),
      query("SELECT slug, updated_at FROM public.explore_by_goal WHERE is_active = true ORDER BY slug ASC"),
    ]);
    const xml = buildSitemap({ courses: courses.rows, subjects: subjects.rows, posts: posts.rows, goals: goals.rows });
    res.set({ "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    return res.send(xml);
  } catch (e) {
    console.error("Sitemap generation error:", e.message);
    res.set({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "300" });
    return res.status(503).send("Sitemap temporarily unavailable. Please retry later.");
  }
});
