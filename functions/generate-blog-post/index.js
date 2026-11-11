// Port of supabase/functions/generate-blog-post. Writes one SEO blog post about an active course
// that was not blogged recently. Text comes from a provider chain (OpenRouter, Google, Lovable,
// OpenAI, in that order, with retries). Images come from a second chain, with curated Unsplash
// photos as the last resort. Images are stored on this server and linked by signed URL.
// Keys come from ai_settings 'ai_api_config' and from LOVABLE_API_KEY (env). Never logged.
// Auth: service key (x-service-key = SERVICE_KEY) or a valid user Bearer token.
import express from "express";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { query } from "../_shared/db.js";
import { upload, createSignedUrl } from "../_shared/storage.js";

export const router = express.Router();

// Test hook: lets tests stub every outbound call and skip the retry pauses.
export const hooks = {
  fetch: (...args) => fetch(...args),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

const BUCKET = "blog-images";
const IMAGE_URL_TTL_SEC = 10 * 365 * 24 * 60 * 60;

const UNSPLASH_BY_TOPIC = {
  physics: [
    "https://images.unsplash.com/photo-1635070041078-e363dbe005cb?w=800&q=80",
    "https://images.unsplash.com/photo-1636466497217-26a8cbeaf0aa?w=800&q=80",
    "https://images.unsplash.com/photo-1628595351029-c2bf17511435?w=800&q=80",
    "https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=800&q=80",
    "https://images.unsplash.com/photo-1507413245164-6160d8298b31?w=800&q=80",
  ],
  chemistry: [
    "https://images.unsplash.com/photo-1532094349884-543bc11b234d?w=800&q=80",
    "https://images.unsplash.com/photo-1603126857599-f6e157fa2fe6?w=800&q=80",
    "https://images.unsplash.com/photo-1616711906333-23cf8e024760?w=800&q=80",
    "https://images.unsplash.com/photo-1554475901-4538ddfbccc2?w=800&q=80",
    "https://images.unsplash.com/photo-1606206522398-44f24ebe5015?w=800&q=80",
  ],
  biology: [
    "https://images.unsplash.com/photo-1530026405186-ed1f139313f8?w=800&q=80",
    "https://images.unsplash.com/photo-1559757175-5700dde675bc?w=800&q=80",
    "https://images.unsplash.com/photo-1576086213369-97a306d36557?w=800&q=80",
    "https://images.unsplash.com/photo-1614935151651-0bea6508db6b?w=800&q=80",
    "https://images.unsplash.com/photo-1518152006812-edab29b069ac?w=800&q=80",
  ],
  math: [
    "https://images.unsplash.com/photo-1509228468518-180dd4864904?w=800&q=80",
    "https://images.unsplash.com/photo-1596495578065-6e0763fa1178?w=800&q=80",
    "https://images.unsplash.com/photo-1635372722656-389f87a941b7?w=800&q=80",
    "https://images.unsplash.com/photo-1518133910546-b6c2fb7d79e3?w=800&q=80",
    "https://images.unsplash.com/photo-1580489944761-15a19d654956?w=800&q=80",
  ],
  career: [
    "https://images.unsplash.com/photo-1521737711867-e3b97375f902?w=800&q=80",
    "https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?w=800&q=80",
    "https://images.unsplash.com/photo-1507679799987-c73779587ccf?w=800&q=80",
    "https://images.unsplash.com/photo-1486312338219-ce68d2c6f44d?w=800&q=80",
    "https://images.unsplash.com/photo-1573497491208-6b1acb260507?w=800&q=80",
  ],
  exam: [
    "https://images.unsplash.com/photo-1434030216411-0b793f4b4173?w=800&q=80",
    "https://images.unsplash.com/photo-1456513080510-7bf3a84b82f8?w=800&q=80",
    "https://images.unsplash.com/photo-1513258496099-48168024aec0?w=800&q=80",
    "https://images.unsplash.com/photo-1488190211105-8b0e65b80b4e?w=800&q=80",
    "https://images.unsplash.com/photo-1471107340929-a87cd0f5b5f3?w=800&q=80",
  ],
  study: [
    "https://images.unsplash.com/photo-1522202176988-66273c2fd55f?w=800&q=80",
    "https://images.unsplash.com/photo-1501504905252-473c47e087f8?w=800&q=80",
    "https://images.unsplash.com/photo-1427504494785-3a9ca7044f45?w=800&q=80",
    "https://images.unsplash.com/photo-1503676260728-1c00da094a0b?w=800&q=80",
  ],
  technology: [
    "https://images.unsplash.com/photo-1518770660439-4636190af475?w=800&q=80",
    "https://images.unsplash.com/photo-1550751827-4bd374c3f58b?w=800&q=80",
    "https://images.unsplash.com/photo-1485827404703-89b55fcc595e?w=800&q=80",
    "https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=800&q=80",
    "https://images.unsplash.com/photo-1504639725590-34d0984388bd?w=800&q=80",
  ],
  medical: [
    "https://images.unsplash.com/photo-1579684385127-1ef15d508118?w=800&q=80",
    "https://images.unsplash.com/photo-1576091160550-2173dba999ef?w=800&q=80",
    "https://images.unsplash.com/photo-1551076805-e1869033e561?w=800&q=80",
    "https://images.unsplash.com/photo-1582719471384-894fbb16564e?w=800&q=80",
    "https://images.unsplash.com/photo-1530497610245-94d3c16cda28?w=800&q=80",
  ],
  general: [
    "https://images.unsplash.com/photo-1497633762265-9d179a990aa6?w=800&q=80",
    "https://images.unsplash.com/photo-1524995997946-a1c2e315a42f?w=800&q=80",
    "https://images.unsplash.com/photo-1491841550275-ad7854e35ca6?w=800&q=80",
    "https://images.unsplash.com/photo-1456406644174-8ddd4cd52a06?w=800&q=80",
  ],
};

const TOPIC_KEYWORDS = {
  physics: ["physics", "force", "motion", "energy", "wave", "quantum", "mechanics", "electricity", "magnet", "optics", "thermodynamics"],
  chemistry: ["chemistry", "chemical", "reaction", "organic", "inorganic", "molecule", "atom", "element", "compound", "periodic"],
  biology: ["biology", "cell", "organism", "genetics", "evolution", "anatomy", "ecology", "botany", "zoology", "dna"],
  math: ["math", "calculus", "algebra", "geometry", "trigonometry", "equation", "integral", "differential", "probability", "statistics"],
  career: ["career", "job", "opportunity", "profession", "employment", "industry", "salary", "placement", "future", "scope"],
  exam: ["exam", "test", "preparation", "tips", "strategy", "practice", "revision", "score", "marks", "syllabus", "paper"],
  study: ["study", "learn", "education", "student", "lecture", "course", "overview", "platform", "simplelecture", "online"],
  technology: ["technology", "coding", "programming", "computer", "software", "digital", "engineering", "data", "algorithm", "ai"],
  medical: ["medical", "neet", "doctor", "health", "medicine", "clinical", "hospital", "disease", "patient", "pharmaceutical"],
};

const STYLE_VARIANTS = [
  "cinematic photograph, natural lighting, shallow depth of field",
  "editorial photography, warm golden-hour lighting, candid moment",
  "documentary photograph, soft daylight, authentic detail",
  "magazine-quality photo, vibrant colors, crisp focus",
  "lifestyle photograph, bright airy lighting, modern aesthetic",
  "professional photograph, dramatic side lighting, rich tones",
];

export function detectTopic(heading, courseName) {
  const text = `${heading} ${courseName}`.toLowerCase();
  let bestTopic = "general";
  let bestScore = 0;
  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    const score = keywords.filter((kw) => text.includes(kw)).length;
    if (score > bestScore) {
      bestScore = score;
      bestTopic = topic;
    }
  }
  return bestTopic;
}

// Picks a curated image for the topic, not used yet in this post.
export function getFallbackImage(heading, courseName, usedUrls) {
  const topic = detectTopic(heading, courseName);
  const images = UNSPLASH_BY_TOPIC[topic] || UNSPLASH_BY_TOPIC.general;
  for (const img of images) {
    if (!usedUrls.has(img)) {
      usedUrls.add(img);
      return img;
    }
  }
  for (const img of UNSPLASH_BY_TOPIC.general) {
    if (!usedUrls.has(img)) {
      usedUrls.add(img);
      return img;
    }
  }
  const allImages = Object.values(UNSPLASH_BY_TOPIC).flat();
  const unused = allImages.filter((img) => !usedUrls.has(img));
  if (unused.length > 0) {
    const picked = unused[crypto.randomInt(unused.length)];
    usedUrls.add(picked);
    return picked;
  }
  return allImages[crypto.randomInt(allImages.length)];
}

function isAuthorised(req) {
  const svc = process.env.SERVICE_KEY || "";
  const got = req.get("x-service-key") || "";
  if (svc && got.length === svc.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(svc))) return true;
  const h = req.get("Authorization") || "";
  if (!h.startsWith("Bearer ")) return false;
  try {
    return Boolean(jwt.verify(h.slice(7), process.env.JWT_SECRET)?.sub);
  } catch {
    return false;
  }
}

const b64ToBytes = (b64) => Buffer.from(b64, "base64");

async function uploadImageBytes(bytes, label, ext = "png") {
  const fileName = `blog_${Date.now()}_${label.replace(/[^a-z0-9]+/gi, "_")}_${crypto.randomBytes(3).toString("hex")}.${ext}`;
  try {
    await upload(BUCKET, fileName, bytes);
  } catch (upErr) {
    console.error(`[Image Gen] ${label}: upload failed`, upErr?.message);
    return null;
  }
  return createSignedUrl(BUCKET, fileName, IMAGE_URL_TTL_SEC);
}

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

router.post("/", async (req, res) => {
  try {
    if (!isAuthorised(req)) return res.status(401).json({ error: "Unauthorized" });

    const { rows: cfgRows } = await query(
      "SELECT setting_value FROM public.ai_settings WHERE setting_key = 'ai_api_config' LIMIT 1",
    );
    const config = cfgRows[0]?.setting_value;
    if (!config?.enabled) {
      return res.status(503).json({
        error: "AI API not configured. Please set it up in Admin → Settings → AI Functions API Key Settings.",
      });
    }

    const { rows: courses } = await query(
      "SELECT id, name, slug, description, short_description, category, subjects, what_you_learn FROM public.courses WHERE is_active = true",
    );
    if (courses.length === 0) return res.status(400).json({ error: "No active courses found" });

    const { rows: recentPosts } = await query(
      "SELECT course_id FROM public.blog_posts ORDER BY created_at DESC LIMIT $1",
      [Math.max(1, courses.length - 1)],
    );
    const recentCourseIds = new Set(recentPosts.map((p) => p.course_id));
    let selectedCourse = courses.find((c) => !recentCourseIds.has(c.id));
    if (!selectedCourse) selectedCourse = courses[crypto.randomInt(courses.length)];

    console.log(`Generating blog for course: ${selectedCourse.name}`);

    const blogPrompt = `You are an expert educational content writer for SimpleLecture, an online learning platform. Write an in-depth, SEO-optimized blog post about this course:

Course: ${selectedCourse.name}
Description: ${selectedCourse.description || selectedCourse.short_description || ""}
Category: ${selectedCourse.category || "Education"}
Subjects: ${JSON.stringify(selectedCourse.subjects || [])}
What You Learn: ${JSON.stringify(selectedCourse.what_you_learn || [])}

REQUIREMENTS:
1. Write 5-6 detailed sections covering different aspects: course overview, key subjects breakdown, study strategies, career opportunities, exam preparation tips, why SimpleLecture platform
2. Each section should be 150-250 words with proper H2 headings
3. Include relevant SEO keywords naturally
4. Write in an engaging, student-friendly tone
5. Include actionable tips and insights
6. Mention SimpleLecture platform benefits naturally

Return ONLY valid JSON (no markdown, no code blocks) in this exact format:
{
  "title": "SEO-optimized blog title (50-60 chars)",
  "meta_description": "Compelling meta description (150-160 chars)",
  "keywords": ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5", "keyword6", "keyword7", "keyword8"],
  "sections": [
    {"heading": "Section H2 heading", "content": "Full section content with paragraphs..."},
    {"heading": "Section H2 heading", "content": "Full section content with paragraphs..."}
  ]
}`;

    // ===== Text generation: provider chain with one retry on transient errors =====
    const sleep = (ms) => hooks.sleep(ms);
    const googleKey = config.google_api_key || null;
    const openaiKey = config.openai_api_key || null;
    const openrouterKey = config.openrouter_api_key || null;
    const lovableKey = process.env.LOVABLE_API_KEY || null;

    async function callGoogleText(model) {
      const r = await hooks.fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": googleKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: blogPrompt }] }],
          generationConfig: { temperature: 0.8, maxOutputTokens: 4096 },
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!r.ok) throw httpError(`Google ${model} ${r.status}: ${(await r.text()).slice(0, 200)}`, r.status);
      const data = await r.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    }

    async function callOpenAICompatText(baseUrl, key, model) {
      const r = await hooks.fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: "user", content: blogPrompt }], temperature: 0.8 }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!r.ok) throw httpError(`${baseUrl} ${model} ${r.status}: ${(await r.text()).slice(0, 200)}`, r.status);
      const data = await r.json();
      return data.choices?.[0]?.message?.content || "";
    }

    const OR = "https://openrouter.ai/api/v1/chat/completions";
    const LOVABLE = "https://ai.gateway.lovable.dev/v1/chat/completions";
    const textProviders = [];
    if (openrouterKey) {
      const orModel = config.default_model || "google/gemini-2.5-flash";
      textProviders.push({ name: `openrouter:${orModel}`, run: () => callOpenAICompatText(OR, openrouterKey, orModel) });
      textProviders.push({
        name: "openrouter:google/gemini-2.5-flash",
        run: () => callOpenAICompatText(OR, openrouterKey, "google/gemini-2.5-flash"),
      });
    }
    if (googleKey) {
      const gModel = config.default_model || "gemini-2.5-flash";
      textProviders.push({ name: `google:${gModel}`, run: () => callGoogleText(gModel) });
      textProviders.push({ name: "google:gemini-2.0-flash", run: () => callGoogleText("gemini-2.0-flash") });
    }
    if (lovableKey) {
      textProviders.push({ name: "lovable:google/gemini-2.5-flash", run: () => callOpenAICompatText(LOVABLE, lovableKey, "google/gemini-2.5-flash") });
      textProviders.push({
        name: "lovable:google/gemini-2.5-flash-lite",
        run: () => callOpenAICompatText(LOVABLE, lovableKey, "google/gemini-2.5-flash-lite"),
      });
    }
    if (openaiKey) {
      textProviders.push({
        name: "openai:gpt-4o-mini",
        run: () => callOpenAICompatText("https://api.openai.com/v1/chat/completions", openaiKey, "gpt-4o-mini"),
      });
    }

    let blogData = null;
    let lastTextErr = "";
    for (const p of textProviders) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const text = await p.run();
          const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
          blogData = JSON.parse(cleaned);
          console.log(`[Text Gen] ok ${p.name} (attempt ${attempt})`);
          break;
        } catch (e) {
          lastTextErr = e?.message || String(e);
          const retryable = /\b(429|500|502|503|504|overload|UNAVAILABLE)\b/i.test(lastTextErr);
          console.warn(`[Text Gen] failed ${p.name} attempt ${attempt}: ${lastTextErr.slice(0, 200)}`);
          if (attempt === 1 && retryable) {
            await sleep(2000);
            continue;
          }
          break;
        }
      }
      if (blogData) break;
    }

    if (!blogData) {
      return res.status(503).json({ error: `All text providers failed. Last: ${lastTextErr}` });
    }

    // ===== Image generation: provider chain, then curated Unsplash =====
    const sectionsWithImages = [];
    const usedFallbackUrls = new Set();
    const seed = crypto.randomInt(1_000_000);

    async function tryGoogleImage(model, prompt, label) {
      if (!googleKey) return null;
      const r = await hooks.fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": googleKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!r.ok) throw httpError(`google:${model} ${r.status}: ${(await r.text()).slice(0, 200)}`, r.status);
      const data = await r.json();
      const imgPart = (data.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData?.data);
      if (!imgPart) throw new Error(`google:${model} returned no image`);
      return uploadImageBytes(b64ToBytes(imgPart.inlineData.data), label);
    }

    async function tryLovableImage(model, prompt, label) {
      if (!lovableKey) return null;
      const r = await hooks.fetch(LOVABLE, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${lovableKey}` },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], modalities: ["image", "text"] }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!r.ok) throw httpError(`lovable:${model} ${r.status}: ${(await r.text()).slice(0, 200)}`, r.status);
      const data = await r.json();
      const imgUrl = data.choices?.[0]?.message?.images?.[0]?.image_url?.url;
      if (!imgUrl) throw new Error(`lovable:${model} returned no image`);
      const m = /^data:(image\/[^;]+);base64,(.+)$/.exec(imgUrl);
      if (!m) throw new Error(`lovable:${model} unexpected image format`);
      return uploadImageBytes(b64ToBytes(m[2]), label, m[1] === "image/jpeg" ? "jpg" : "png");
    }

    async function tryOpenAIImage(prompt, label) {
      if (!openaiKey) return null;
      const r = await hooks.fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiKey}` },
        body: JSON.stringify({ model: "gpt-image-1", prompt, size: "1024x1024", n: 1 }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!r.ok) throw httpError(`openai:gpt-image-1 ${r.status}: ${(await r.text()).slice(0, 200)}`, r.status);
      const data = await r.json();
      const b64 = data.data?.[0]?.b64_json;
      if (!b64) throw new Error("openai:gpt-image-1 returned no image");
      return uploadImageBytes(b64ToBytes(b64), label);
    }

    const imageProviders = [];
    if (googleKey) {
      imageProviders.push({ name: "google:gemini-2.5-flash-image", run: (p, l) => tryGoogleImage("gemini-2.5-flash-image", p, l) });
      imageProviders.push({
        name: "google:gemini-2.0-flash-exp-image-generation",
        run: (p, l) => tryGoogleImage("gemini-2.0-flash-exp-image-generation", p, l),
      });
    }
    if (lovableKey) {
      imageProviders.push({
        name: "lovable:google/gemini-2.5-flash-image-preview",
        run: (p, l) => tryLovableImage("google/gemini-2.5-flash-image-preview", p, l),
      });
    }
    if (openaiKey) imageProviders.push({ name: "openai:gpt-image-1", run: (p, l) => tryOpenAIImage(p, l) });

    async function generateImageWithFallback(prompt, label, fallbackHeading) {
      for (const p of imageProviders) {
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const url = await p.run(prompt, label);
            if (url) {
              console.log(`[Image Gen] ${label} ok ${p.name} (attempt ${attempt})`);
              return url;
            }
          } catch (e) {
            const msg = e?.message || String(e);
            const status = e?.status || 0;
            const retryable = status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || /overload|UNAVAILABLE/i.test(msg);
            const authErr = status === 401 || status === 403 || status === 402;
            console.warn(`[Image Gen] ${label} failed ${p.name} attempt ${attempt}: ${msg.slice(0, 200)}`);
            if (attempt === 1 && retryable && !authErr) {
              await sleep(1500);
              continue;
            }
            break;
          }
        }
      }
      const fallback = getFallbackImage(fallbackHeading, selectedCourse.name, usedFallbackUrls);
      console.log(`[Image Gen] ${label} using unsplash fallback`);
      return fallback;
    }

    function buildPrompt({ heading, excerpt, index, isHero = false }) {
      const style = STYLE_VARIANTS[(index + seed) % STYLE_VARIANTS.length];
      const hero = isHero ? "wide hero composition with strong focal point, " : "square or 16:9 composition, ";
      return [
        `Create a unique, photorealistic ${isHero ? "featured hero image" : "editorial image"} for a blog about "${blogData.title}".`,
        `Section: "${heading}".`,
        `Visual concept must reflect: ${excerpt}`,
        `Course context: ${selectedCourse.name} (${selectedCourse.category || "education"}).`,
        `Style: ${style}, ${hero}India-relevant student/study context where people appear (Indian students, modern Indian classroom or home study setting).`,
        `Strict rules: NO text, NO words, NO letters, NO logos, NO watermarks, NO UI elements, NO charts. The image must be visually distinct from generic stock photos and unique to this specific topic. Variation seed: ${seed}-${index}.`,
      ].join(" ");
    }

    const heroExcerpt = `${(blogData.meta_description || "").slice(0, 200)} — ${(blogData.sections[0]?.content || "").slice(0, 200)}`;
    const featuredImageUrl = await generateImageWithFallback(
      buildPrompt({ heading: blogData.title, excerpt: heroExcerpt, index: 0, isHero: true }),
      "hero",
      blogData.title,
    );

    for (let i = 0; i < blogData.sections.length; i++) {
      const section = blogData.sections[i];
      const excerpt = String(section.content || "").replace(/\s+/g, " ").slice(0, 240);
      const imageUrl = await generateImageWithFallback(
        buildPrompt({ heading: section.heading, excerpt, index: i + 1 }),
        `section_${i}`,
        section.heading,
      );
      sectionsWithImages.push({ heading: section.heading, content: section.content, image_url: imageUrl });
    }

    const slug =
      blogData.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") +
      "-" +
      Date.now().toString(36);

    let post;
    try {
      const { rows } = await query(
        `INSERT INTO public.blog_posts
           (title, slug, meta_description, keywords, course_id, sections, featured_image_url, status, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'published', now())
         RETURNING *`,
        [
          blogData.title,
          slug,
          blogData.meta_description,
          blogData.keywords || [],
          selectedCourse.id,
          JSON.stringify(sectionsWithImages),
          featuredImageUrl,
        ],
      );
      post = rows[0];
    } catch (insertError) {
      throw new Error(`Failed to insert blog post: ${insertError.message}`);
    }

    console.log(`Blog post created: ${post.title} (${post.slug})`);
    res.json({ success: true, post });
  } catch (error) {
    console.error("Error generating blog post:", error?.message);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});
