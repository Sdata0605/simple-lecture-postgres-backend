// Port of supabase/functions/seo-head. Runtime per-route head rewriter.
// GET /functions/v1/seo-head?path=/course/some-slug (also /subject/, /learn/, /programs/, /blog/)
// Returns the site's index.html shell with <title>, meta description, OG/Twitter tags, canonical and
// JSON-LD filled from the database for that path. Always 200 with HTML (unknown slugs get the plain shell).
// Env: PUBLIC_SITE_URL (default https://simplelecture.com). The shell is fetched from there and cached 5 minutes.
import express from "express";
import { query } from "../_shared/db.js";

export const router = express.Router();

const DEFAULT_SITE = "https://simplelecture.com";
const SITE_NAME = "SimpleLecture";
const SHELL_TTL_MS = 5 * 60 * 1000;

const siteUrl = () => (process.env.PUBLIC_SITE_URL || DEFAULT_SITE).replace(/\/$/, "");
const defaultOg = () => `${siteUrl()}/og-default.png`;

let shellCache = null;

// Tests use this to supply a shell without any network call.
export function setShellForTests(html) {
  shellCache = html === null ? null : { html, at: Date.now() };
}

async function getShell() {
  if (shellCache && Date.now() - shellCache.at < SHELL_TTL_MS) return shellCache.html;
  try {
    const res = await fetch(`${siteUrl()}/index.html`, { headers: { "User-Agent": "SimpleLecture-SEO-Head/1.0" } });
    if (res.ok) {
      const html = await res.text();
      shellCache = { html, at: Date.now() };
      return html;
    }
  } catch (e) {
    console.error("Shell fetch failed:", e?.message);
  }
  // Last-resort shell. The real one is used again after the next successful fetch.
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>SimpleLecture</title><meta name="description" content="SimpleLecture" /><link rel="canonical" href="${siteUrl()}/" /></head><body><div id="root"></div></body></html>`;
}

// ─── String helpers ──────────────────────────────────────────────────────

const escAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const escHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function truncate(str, n = 158) {
  if (!str) return "";
  const clean = String(str).replace(/[#*_`>\n\r]+/g, " ").replace(/\s+/g, " ").trim();
  return clean.length <= n ? clean : clean.slice(0, n - 1).replace(/\s+\S*$/, "") + "…";
}

function replaceMeta(html, attr, key, value) {
  const re = new RegExp(`<meta\\s+${attr}="${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>`, "i");
  const tag = `<meta ${attr}="${key}" content="${escAttr(value)}" />`;
  if (re.test(html)) return html.replace(re, tag);
  return html.replace(/<\/head>/i, `    ${tag}\n  </head>`);
}

export function rewriteShell(shell, meta) {
  const title = /\|\s*SimpleLecture\s*$/.test(meta.title) ? meta.title : `${meta.title} | ${SITE_NAME}`;
  const ogTitleRaw = meta.ogTitle || meta.title;
  const ogTitle = /\|\s*SimpleLecture\s*$/.test(ogTitleRaw) ? ogTitleRaw : `${ogTitleRaw} | ${SITE_NAME}`;
  const ogDesc = meta.ogDescription || meta.description;
  let html = shell;

  html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escHtml(title)}</title>`);
  html = replaceMeta(html, "name", "description", meta.description);
  if (meta.keywords) html = replaceMeta(html, "name", "keywords", meta.keywords);

  // Canonical: replace the first canonical link and drop any extra ones.
  const canonicalTag = `<link rel="canonical" href="${escAttr(meta.canonical)}" />`;
  if (/<link\s+rel="canonical"[^>]*>/i.test(html)) {
    html = html.replace(/<link\s+rel="canonical"[^>]*>/i, canonicalTag);
    html = html.replace(/<link\s+rel="canonical"[^>]*>/gi, (m, offset) => (offset === html.indexOf(canonicalTag) ? m : ""));
  } else {
    html = html.replace(/<\/head>/i, `    ${canonicalTag}\n  </head>`);
  }

  html = replaceMeta(html, "property", "og:title", ogTitle);
  html = replaceMeta(html, "property", "og:description", ogDesc);
  html = replaceMeta(html, "property", "og:type", meta.ogType);
  html = replaceMeta(html, "property", "og:url", meta.canonical);
  html = replaceMeta(html, "property", "og:image", meta.ogImage);
  html = replaceMeta(html, "name", "twitter:title", ogTitle);
  html = replaceMeta(html, "name", "twitter:description", ogDesc);
  html = replaceMeta(html, "name", "twitter:image", meta.ogImage);

  // Strip any existing JSON-LD, then add ours before </head>.
  html = html.replace(/<script[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi, "");
  if (meta.jsonLd.length) {
    const scripts = meta.jsonLd
      .map((obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/<\/script/gi, "<\\/script")}</script>`)
      .join("\n    ");
    html = html.replace(/<\/head>/i, `    ${scripts}\n  </head>`);
  }

  // No-JS body fallback inside #root.
  const fallback = `
      <noscript>
        <article style="max-width:760px;margin:2rem auto;padding:1rem;font-family:system-ui,sans-serif;">
          <h1>${escHtml(meta.h1)}</h1>
          <p>${escHtml(meta.lead)}</p>
          <p><a href="${escAttr(meta.canonical)}">Open SimpleLecture →</a></p>
        </article>
      </noscript>
      <div data-seo-fallback="1" style="position:absolute;left:-9999px;top:auto;width:1px;height:1px;overflow:hidden;">
        <h1>${escHtml(meta.h1)}</h1>
        <p>${escHtml(meta.lead)}</p>
      </div>`;
  if (!html.includes('data-seo-fallback="1"') && /<div\s+id="root"\s*>/i.test(html)) {
    html = html.replace(/<div\s+id="root"\s*>/i, (m) => `${m}${fallback}`);
  }

  return html;
}

// ─── Per-entity builders ─────────────────────────────────────────────────

function buildCourseMeta(course, path) {
  const canonical = (course.seo_canonical_url && String(course.seo_canonical_url).trim()) || `${siteUrl()}${path}`;
  const baseDesc =
    course.seo_description ||
    course.short_description ||
    `${course.name} — online coaching with live classes, recorded video lectures, AI doubt solver and mock tests on SimpleLecture.`;
  const desc = truncate(baseDesc);
  const ogImage =
    (course.og_image_url && !String(course.og_image_url).startsWith("data:") && course.og_image_url) ||
    (course.thumbnail_url && !String(course.thumbnail_url).startsWith("data:") && course.thumbnail_url) ||
    defaultOg();
  const title = (course.seo_title && String(course.seo_title).trim()) || `${course.name} — Online Coaching & Live Classes`;
  const keywords =
    (course.seo_keywords && String(course.seo_keywords).trim()) ||
    `${course.name}, ${course.name} online coaching, ${course.name} video lectures, ${course.name} mock test, ${SITE_NAME}`;
  return {
    title,
    description: desc,
    keywords,
    canonical,
    ogImage,
    ogType: "website",
    ogTitle: (course.og_title && String(course.og_title).trim()) || undefined,
    ogDescription: (course.og_description && String(course.og_description).trim()) || undefined,
    h1: `${course.name} — Online Coaching`,
    lead: truncate(baseDesc, 240),
    jsonLd: [
      {
        "@context": "https://schema.org",
        "@type": "Course",
        name: course.name,
        description: truncate(baseDesc, 300),
        provider: { "@type": "EducationalOrganization", name: SITE_NAME, url: siteUrl() },
        url: canonical,
        ...(ogImage !== defaultOg() ? { image: ogImage } : {}),
      },
      {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: `${siteUrl()}/` },
          { "@type": "ListItem", position: 2, name: "Programs", item: `${siteUrl()}/programs` },
          { "@type": "ListItem", position: 3, name: course.name, item: canonical },
        ],
      },
    ],
  };
}

function buildSubjectMeta(subject, path) {
  const canonical = `${siteUrl()}${path}`;
  const desc = truncate(
    subject.description ||
      `Learn ${subject.name} online with video lectures, chapter-wise notes, MCQ practice and AI doubt solver. Aligned to NEET, JEE & board syllabi.`
  );
  const ogImage = subject.thumbnail_url && !subject.thumbnail_url.startsWith("data:") ? subject.thumbnail_url : defaultOg();
  return {
    title: `${subject.name} Online Classes & Video Lectures`,
    description: desc,
    keywords: `${subject.name} online classes, ${subject.name} video lectures, ${subject.name} notes, ${subject.name} MCQ, ${SITE_NAME}`,
    canonical,
    ogImage,
    ogType: "website",
    h1: `${subject.name} Online Classes`,
    lead: truncate(subject.description || desc, 240),
    jsonLd: [
      {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: `${siteUrl()}/` },
          { "@type": "ListItem", position: 2, name: "Subjects", item: `${siteUrl()}/programs` },
          { "@type": "ListItem", position: 3, name: subject.name, item: canonical },
        ],
      },
    ],
  };
}

function buildBlogMeta(post, path) {
  const canonical = `${siteUrl()}${path}`;
  const desc = truncate(post.meta_description || post.title);
  const ogImage = post.featured_image_url || defaultOg();
  return {
    title: post.title,
    description: desc,
    canonical,
    ogImage,
    ogType: "article",
    h1: post.title,
    lead: truncate(post.meta_description || post.title, 240),
    jsonLd: [
      {
        "@context": "https://schema.org",
        "@type": "Article",
        headline: post.title,
        description: desc,
        url: canonical,
        ...(post.featured_image_url ? { image: post.featured_image_url } : {}),
        ...(post.created_at ? { datePublished: post.created_at } : {}),
        publisher: { "@type": "Organization", name: SITE_NAME, url: siteUrl() },
      },
    ],
  };
}

// ─── Path routing ────────────────────────────────────────────────────────

export function matchPath(input) {
  let path = String(input).split("?")[0].split("#")[0];
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

  let m;
  if ((m = path.match(/^\/course\/([^/]+)(?:\/preview)?$/))) return { kind: "course", slug: m[1], path };
  // Legacy course detail. Deeper /programs/:a/:b category routes are ignored.
  if ((m = path.match(/^\/programs\/([^/]+)$/))) return { kind: "course", slug: m[1], path };
  if ((m = path.match(/^\/subject\/([^/]+)$/))) return { kind: "subject", slug: m[1], path };
  if ((m = path.match(/^\/learn\/([^/]+)$/))) return { kind: "subject", slug: m[1], path };
  if ((m = path.match(/^\/blog\/([^/]+)$/))) return { kind: "blog", slug: m[1], path };
  return null;
}

async function lookup(match) {
  if (match.kind === "course") {
    const { rows } = await query(
      `SELECT name, slug, short_description, thumbnail_url, seo_title, seo_description, seo_keywords,
              og_title, og_description, og_image_url, seo_canonical_url
         FROM public.courses WHERE slug = $1 AND is_active = true LIMIT 1`,
      [match.slug]
    );
    return rows[0] ? buildCourseMeta(rows[0], `/course/${rows[0].slug}`) : null;
  }
  if (match.kind === "subject") {
    const { rows } = await query(
      "SELECT name, slug, description, thumbnail_url FROM public.popular_subjects WHERE slug = $1 LIMIT 1",
      [match.slug]
    );
    return rows[0] ? buildSubjectMeta(rows[0], `/subject/${rows[0].slug}`) : null;
  }
  const { rows } = await query(
    `SELECT title, slug, meta_description, featured_image_url, created_at
       FROM public.blog_posts WHERE slug = $1 AND status = 'published' LIMIT 1`,
    [match.slug]
  );
  if (!rows[0]) return null;
  const post = { ...rows[0], created_at: rows[0].created_at ? new Date(rows[0].created_at).toISOString() : null };
  return buildBlogMeta(post, `/blog/${post.slug}`);
}

router.get("/", async (req, res) => {
  const path = typeof req.query.path === "string" && req.query.path ? req.query.path : "/";
  const match = matchPath(path);
  const shell = await getShell();
  let html = shell;

  try {
    if (match) {
      const meta = await lookup(match);
      if (meta) html = rewriteShell(shell, meta);
    }
  } catch (e) {
    console.error("seo-head lookup failed:", e?.message);
  }

  res.set({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "public, max-age=300, s-maxage=600",
    "X-SEO-Head": match ? `${match.kind}:${match.slug}` : "shell",
  });
  return res.status(200).send(html);
});

export default router;
